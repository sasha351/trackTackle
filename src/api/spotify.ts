import { expireAccessToken, getValidAccessToken } from '../auth/token';
import type { Playlist, PlaylistTrack, Track } from '../types';

const BASE = 'https://api.spotify.com/v1';

let clientId = '';

export function configureSpotify(id: string): void {
  clientId = id;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class SpotifyApiError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'SpotifyApiError';
    this.status = status;
  }
}

// Spotify rate-limits the whole app, not single requests — when one call gets
// a 429, every in-flight caller must back off too or they stampede and extend
// the penalty. One shared timestamp gates them all.
let rateLimitedUntil = 0;
const MAX_RETRY_AFTER_MS = 60_000;

// rateLimitedUntil is *reactive* — it only engages after Spotify has already
// said 429, by which point the damage is done and the penalty scales with how
// far we overshot. This cap is the proactive half: callers that hand
// Promise.all a hundred pages at once (getSavedTracks, enrichLibrary's
// per-playlist fan-out) would otherwise put all hundred on the wire in one
// tick, which is exactly what trips a rolling-window limiter hardest. Gating
// inside spotifyFetch means every caller is covered without each one growing
// its own pool.
const MAX_IN_FLIGHT = 6;
let inFlight = 0;
const waiting: (() => void)[] = [];

function acquireSlot(): Promise<void> | undefined {
  if (inFlight < MAX_IN_FLIGHT) {
    inFlight += 1;
    return;
  }
  return new Promise<void>((resolve) => waiting.push(resolve));
}

function releaseSlot(): void {
  // Hand the slot straight to the next waiter rather than decrementing and
  // letting it re-acquire — a decrement here would let a fresh caller slip in
  // before the woken waiter resumes, putting us over the cap.
  const next = waiting.shift();
  if (next) next();
  else inFlight -= 1;
}

export function resetRateLimitForTests(): void {
  rateLimitedUntil = 0;
  inFlight = 0;
  waiting.length = 0;
}

export async function spotifyFetch<T>(pathOrUrl: string, init: RequestInit = {}): Promise<T> {
  await acquireSlot();
  try {
    return await request<T>(pathOrUrl, init);
  } finally {
    releaseSlot();
  }
}

async function request<T>(pathOrUrl: string, init: RequestInit): Promise<T> {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : BASE + pathOrUrl;
  let retried401 = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    const gateWait = rateLimitedUntil - Date.now();
    if (gateWait > 0) await sleep(gateWait);
    let token: string;
    try {
      token = await getValidAccessToken(clientId);
    } catch (err) {
      if (attempt < 4) {
        await sleep(2 ** attempt * 1000);
        continue;
      }
      throw new SpotifyApiError(`token refresh failed: ${String(err)}`);
    }
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    if (init.body) headers.set('Content-Type', 'application/json');
    let res: Response;
    try {
      res = await fetch(url, { ...init, headers });
    } catch (err) {
      if (attempt < 4) {
        await sleep(2 ** attempt * 1000);
        continue;
      }
      throw new SpotifyApiError(`Network failure fetching ${url}: ${String(err)}`);
    }
    if (res.status === 429) {
      // Spotify omits Access-Control-Expose-Headers, so in a browser
      // Retry-After is unreadable (null) — back off exponentially instead:
      // 1s, 2s, 4s, 8s across the remaining attempts.
      const retryAfter = res.headers.get('Retry-After');
      const retryAfterMs = retryAfter != null
        ? (Number(retryAfter) + 0.5) * 1000
        : 2 ** attempt * 1000;
      if (retryAfterMs > MAX_RETRY_AFTER_MS) {
        // A long penalty means Spotify wants us gone for a while — say so
        // instead of hanging or burning retries.
        throw new SpotifyApiError(
          `Spotify rate limit hit — try again in ~${Math.ceil(retryAfterMs / 60_000)} min`,
          429,
        );
      }
      rateLimitedUntil = Math.max(rateLimitedUntil, Date.now() + retryAfterMs);
      continue;
    }
    if (res.status === 401 && !retried401) {
      retried401 = true;
      expireAccessToken(); // next getValidAccessToken call runs the refresh grant
      continue;
    }
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      // Transient upstream errors — e.g. a just-connected playback device
      // isn't registered as active on Spotify's backend yet, and that
      // resolves in ms, not seconds. Short fixed ramp, unlike the 429 path's
      // exponential seconds (a real rate limit needs the longer cooldown).
      if (attempt === 4) throw new SpotifyApiError(`Spotify API ${res.status} for ${url}`, res.status);
      await sleep(Math.min(300 * 2 ** attempt, 1200));
      continue;
    }
    if (!res.ok) throw new SpotifyApiError(`Spotify API ${res.status} for ${url}`, res.status);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
  throw new SpotifyApiError(
    'Spotify is rate-limiting this app (429). Wait a few minutes and reload — ' +
    'after heavy use the penalty can last an hour or more.',
    429,
  );
}

interface Page<T> {
  items: T[];
  next: string | null;
}

export async function getAllPages<T>(firstPath: string): Promise<T[]> {
  const items: T[] = [];
  let url: string | null = firstPath;
  while (url) {
    const page: Page<T> = await spotifyFetch<Page<T>>(url);
    items.push(...page.items);
    url = page.next;
  }
  return items;
}

interface RawTrack {
  id: string; uri: string; name: string;
  artists: { id: string; name: string }[];
  album: { name: string; release_date?: string };
  external_ids?: { isrc?: string };
}

const yearOf = (releaseDate?: string): number | null => {
  const y = Number(releaseDate?.slice(0, 4));
  return Number.isFinite(y) && y > 0 ? y : null;
};

export async function getMe(): Promise<{ id: string }> {
  return spotifyFetch('/me');
}

const SAVED_TRACKS_PAGE_SIZE = 50;

// Unlike getPlaylistTracks, saved-tracks pages don't feed anything else that
// needs cursor order, and Spotify hands back `total` up front — so after the
// first page we know every remaining offset and can fetch them all at once
// instead of walking `next` one page at a time. The shared rateLimitedUntil
// gate (above) keeps this from stampeding.
export async function getSavedTracks(): Promise<Track[]> {
  type SavedTracksPage = Page<{ added_at: string; track: RawTrack | null }> & { total: number };
  const first = await spotifyFetch<SavedTracksPage>(`/me/tracks?limit=${SAVED_TRACKS_PAGE_SIZE}`);
  const items = [...first.items];
  if (first.next && first.total > items.length) {
    const offsets: number[] = [];
    for (let o = items.length; o < first.total; o += SAVED_TRACKS_PAGE_SIZE) offsets.push(o);
    const rest = await Promise.all(
      offsets.map((offset) =>
        spotifyFetch<SavedTracksPage>(`/me/tracks?limit=${SAVED_TRACKS_PAGE_SIZE}&offset=${offset}`),
      ),
    );
    for (const page of rest) items.push(...page.items);
  }
  return items
    .filter((i): i is { added_at: string; track: RawTrack } => i.track?.id != null)
    .map((i) => ({
      id: i.track.id,
      uri: i.track.uri,
      name: i.track.name,
      artists: i.track.artists.map((a) => ({ id: a.id, name: a.name })),
      albumName: i.track.album.name,
      releaseYear: yearOf(i.track.album.release_date),
      isrc: i.track.external_ids?.isrc ?? null,
      addedAt: i.added_at,
    }));
}

export async function getMyPlaylists(): Promise<Playlist[]> {
  const me = await getMe();
  type RawPlaylist = {
    id: string; name: string; owner: { id: string }; collaborative?: boolean;
    // Feb 2026 migration renamed tracks → items; either can be absent.
    items?: { total: number } | null;
    tracks?: { total: number } | null;
  } | null;
  const items = await getAllPages<RawPlaylist>('/me/playlists?limit=50');
  return items
    // Spotify puts null and partially-populated entries in this list, and the
    // count field is only present for owned/collaborative playlists — a
    // missing count must not disqualify a playlist. Keep playlists I own or
    // collaborate on; drop ones I merely follow.
    .filter((p): p is NonNullable<RawPlaylist> =>
      p?.owner?.id === me.id || p?.collaborative === true)
    .map((p) => ({
      id: p.id, name: p.name, trackCount: p.items?.total ?? p.tracks?.total ?? 0,
    }));
}

// Feb 2026 migration: /playlists/{id}/tracks became /playlists/{id}/items and
// each entry's track object now lives under `item`.
export async function getPlaylistTracks(playlistId: string): Promise<PlaylistTrack[]> {
  const fields = encodeURIComponent('items(item(name,artists(id,name),album(release_date),external_ids(isrc))),next');
  const items = await getAllPages<{ item: RawTrack | null }>(
    `/playlists/${playlistId}/items?limit=100&fields=${fields}`,
  );
  return items
    .filter((i): i is { item: RawTrack } => i.item != null)
    .map((i) => ({
      name: i.item.name,
      artists: i.item.artists.map((a) => ({ id: a.id, name: a.name })),
      releaseYear: yearOf(i.item.album.release_date),
      isrc: i.item.external_ids?.isrc ?? null,
    }));
}

export async function addTracksToPlaylist(playlistId: string, uris: string[]): Promise<void> {
  await spotifyFetch(`/playlists/${playlistId}/items`, {
    method: 'POST',
    body: JSON.stringify({ uris }),
  });
}

export async function removeTracksFromPlaylist(playlistId: string, uris: string[]): Promise<void> {
  await spotifyFetch(`/playlists/${playlistId}/items`, {
    method: 'DELETE',
    body: JSON.stringify({ items: uris.map((uri) => ({ uri })) }),
  });
}

// Feb 2026 migration: PUT/DELETE /me/tracks became /me/library, addressed by
// URI via query param (max 40 per call — the app only ever sends one).
export async function removeSavedTracks(uris: string[]): Promise<void> {
  await spotifyFetch(`/me/library?uris=${encodeURIComponent(uris.join(','))}`, {
    method: 'DELETE',
  });
}

export async function saveTracks(uris: string[]): Promise<void> {
  await spotifyFetch(`/me/library?uris=${encodeURIComponent(uris.join(','))}`, {
    method: 'PUT',
  });
}

export async function getArtistGenres(artistId: string): Promise<string[]> {
  const artist = await spotifyFetch<{ genres?: string[] }>(`/artists/${artistId}`);
  return artist.genres ?? [];
}

// Up to 50 artists per request — the single biggest lever on this app's Spotify
// request count, since genre resolution is per unique artist and a real library
// has thousands. Callers must chunk to ARTIST_BATCH; Spotify 400s past 50.
// An id Spotify doesn't know comes back as a null entry, so the returned map is
// "what Spotify actually had" — a missing id is not the same as no genres.
export const ARTIST_BATCH = 50;

export async function getArtistGenresBatch(ids: string[]): Promise<Map<string, string[]>> {
  const res = await spotifyFetch<{ artists: ({ id: string; genres?: string[] } | null)[] }>(
    `/artists?ids=${ids.join(',')}`,
  );
  const out = new Map<string, string[]>();
  for (const a of res.artists ?? []) if (a?.id) out.set(a.id, a.genres ?? []);
  return out;
}
