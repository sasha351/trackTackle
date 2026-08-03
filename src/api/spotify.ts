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

// Distinguishable from a generic API failure so the UI can show the countdown
// banner instead of an error screen, and so useLibrary knows to keep the
// cached library on screen rather than blanking it.
export class RateLimitedError extends SpotifyApiError {
  retryAt: number;
  constructor(retryAt: number) {
    super(
      'Spotify is rate-limiting this app. It resumes on its own — nothing was lost.',
      429,
    );
    this.name = 'RateLimitedError';
    this.retryAt = retryAt;
  }
}

// Spotify rate-limits the whole app, not single requests — when one call gets
// a 429, every in-flight caller must back off too or they stampede and extend
// the penalty. One shared timestamp gates them all.
//
// It lives in localStorage because the penalty outlives the page: a reload
// used to wipe this and immediately re-fire the whole mount burst, which is
// exactly what turns a 30-second cooldown into an hour-long one.
const GATE_KEY = 'kondo:ratelimit:v1';
let rateLimitedUntil = 0;
let gateLoaded = false;
const gateSubscribers = new Set<(until: number) => void>();

// Past this, parking the request is worse than failing it: the caller would
// hang for an hour with no explanation. The UI watches the gate instead.
const MAX_PARK_MS = 90_000;

function loadGate(): number {
  if (!gateLoaded) {
    gateLoaded = true;
    rateLimitedUntil = Number(localStorage.getItem(GATE_KEY)) || 0;
  }
  return rateLimitedUntil;
}

/** Epoch ms the penalty ends, or 0 when there is no live penalty. */
export function getRateLimitedUntil(): number {
  const until = loadGate();
  return until > Date.now() ? until : 0;
}

export function subscribeRateLimit(cb: (until: number) => void): () => void {
  gateSubscribers.add(cb);
  return () => {
    gateSubscribers.delete(cb);
  };
}

function setGate(until: number): void {
  loadGate();
  // Only ever extends. A fresh 429 after the old deadline passed pushes the
  // countdown out rather than making it flap.
  if (until <= rateLimitedUntil) return;
  rateLimitedUntil = until;
  try {
    localStorage.setItem(GATE_KEY, String(until));
  } catch {
    // Storage full — the in-memory gate still holds for this session.
  }
  // setGate runs inside request()'s 429 branch with no surrounding try/catch,
  // so an uncaught subscriber error would reject spotifyFetch's promise with
  // the subscriber's error instead of the clean RateLimitedError callers
  // expect — and would stop notifying whichever subscribers hadn't run yet.
  for (const cb of gateSubscribers) {
    try {
      cb(until);
    } catch {
      // Contained — see comment above.
    }
  }
}

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

function acquireSlot(priority: boolean): Promise<void> | undefined {
  if (inFlight < MAX_IN_FLIGHT) {
    inFlight += 1;
    return;
  }
  return new Promise<void>((resolve) => {
    // Only ~6 requests hold slots at once, so a 100-deep background queue is
    // what makes an interactive add wait ten-plus seconds. The token bucket
    // needs no equivalent: it refills continuously, so its wait scales with
    // how many callers are already awake rather than with queue depth — no
    // ordering guarantee, but nothing like the ten seconds above.
    if (priority) waiting.unshift(resolve);
    else waiting.push(resolve);
  });
}

function releaseSlot(): void {
  // Hand the slot straight to the next waiter rather than decrementing and
  // letting it re-acquire — a decrement here would let a fresh caller slip in
  // before the woken waiter resumes, putting us over the cap.
  const next = waiting.shift();
  if (next) next();
  else inFlight -= 1;
}

// The pool above bounds concurrency; this bounds *rate*. Six slots at ~150ms
// latency sustain ~40 req/s, and Spotify's limiter is a rolling window — the
// pool alone never stopped a full-library mount from tripping it. Capacity
// exceeds the refill rate so a handful of interactive requests after an idle
// stretch still go out instantly.
const REFILL_PER_SEC = 8;
const BUCKET_CAPACITY = 20;
let tokens = BUCKET_CAPACITY;
let lastRefill = Date.now();

function refill(): void {
  const now = Date.now();
  tokens = Math.min(BUCKET_CAPACITY, tokens + ((now - lastRefill) / 1000) * REFILL_PER_SEC);
  lastRefill = now;
}

async function takeToken(): Promise<void> {
  // Re-check after each sleep: several waiters wake together, and only the
  // one that gets to the synchronous decrement first actually spends it.
  for (;;) {
    refill();
    if (tokens >= 1) {
      tokens -= 1;
      return;
    }
    await sleep(Math.ceil(((1 - tokens) / REFILL_PER_SEC) * 1000));
  }
}

export function resetRateLimitForTests(): void {
  rateLimitedUntil = 0;
  gateLoaded = false; // forces a re-read of localStorage, i.e. simulates a reload
  gateSubscribers.clear();
  inFlight = 0;
  waiting.length = 0;
  tokens = BUCKET_CAPACITY;
  lastRefill = Date.now();
}

export async function spotifyFetch<T>(
  pathOrUrl: string,
  init: RequestInit = {},
  opts: { priority?: boolean } = {},
): Promise<T> {
  await acquireSlot(opts.priority === true);
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
    const until = getRateLimitedUntil();
    const gateWait = until - Date.now();
    // Park on the gate rather than failing — but only so long. Past the bound
    // the UI's countdown is a better answer than a request that hangs.
    if (gateWait > MAX_PARK_MS) throw new RateLimitedError(until);
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
    // Inside the retry loop on purpose: a retry is a real request and must
    // cost a real token, or a 429 storm bypasses the governor entirely.
    await takeToken();
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
      setGate(Date.now() + retryAfterMs);
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
  throw new RateLimitedError(Math.max(getRateLimitedUntil(), Date.now()));
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

export interface SpotifyImage { url: string; width?: number | null; height?: number | null }

/** Spotify returns 640/300/64 for album covers and 640/300/60 for playlists.
 *  Take the largest entry — the gallery skin draws these up to ~300px on a
 *  desktop card, and 640px is still a small file, so there is no bandwidth
 *  case for serving a blurrier thumbnail. Playlist mosaics report
 *  `width: null` and sort last regardless — still the only entry to pick. */
export function pickCover(images?: SpotifyImage[] | null): string | null {
  if (!images || images.length === 0) return null;
  const bySize = [...images].sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  return bySize[bySize.length - 1].url;
}

interface RawTrack {
  id: string; uri: string; name: string;
  artists: { id: string; name: string }[];
  album: { name: string; release_date?: string; images?: SpotifyImage[] | null };
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
      albumArt: pickCover(i.track.album.images),
    }));
}

export async function getMyPlaylists(): Promise<Playlist[]> {
  const me = await getMe();
  type RawPlaylist = {
    id: string; name: string; description?: string | null; owner: { id: string }; collaborative?: boolean;
    // Feb 2026 migration renamed tracks → items; either can be absent.
    items?: { total: number } | null;
    tracks?: { total: number } | null;
    images?: SpotifyImage[] | null;
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
      id: p.id, name: p.name, description: p.description ?? null,
      trackCount: p.items?.total ?? p.tracks?.total ?? 0,
      image: pickCover(p.images),
    }));
}

// Feb 2026 migration: /playlists/{id}/tracks became /playlists/{id}/items and
// each entry's track object now lives under `item`.
export async function getPlaylistTracks(playlistId: string): Promise<PlaylistTrack[]> {
  const fields = encodeURIComponent('items(item(id,name,artists(id,name),album(release_date),external_ids(isrc))),next');
  const items = await getAllPages<{ item: RawTrack | null }>(
    `/playlists/${playlistId}/items?limit=100&fields=${fields}`,
  );
  return items
    .filter((i): i is { item: RawTrack } => i.item != null)
    .map((i) => ({
      id: i.item.id,
      name: i.item.name,
      artists: i.item.artists.map((a) => ({ id: a.id, name: a.name })),
      releaseYear: yearOf(i.item.album.release_date),
      isrc: i.item.external_ids?.isrc ?? null,
    }));
}

// The four calls below are user actions, not background traffic — they jump
// the slot queue so a click never waits out a full-library load.
const USER_ACTION = { priority: true };

export async function addTracksToPlaylist(playlistId: string, uris: string[]): Promise<void> {
  await spotifyFetch(`/playlists/${playlistId}/items`, {
    method: 'POST',
    body: JSON.stringify({ uris }),
  }, USER_ACTION);
}

export async function removeTracksFromPlaylist(playlistId: string, uris: string[]): Promise<void> {
  await spotifyFetch(`/playlists/${playlistId}/items`, {
    method: 'DELETE',
    body: JSON.stringify({ items: uris.map((uri) => ({ uri })) }),
  }, USER_ACTION);
}

// Feb 2026 migration: PUT/DELETE /me/tracks became /me/library, addressed by
// URI via query param (max 40 per call — the app only ever sends one).
export async function removeSavedTracks(uris: string[]): Promise<void> {
  await spotifyFetch(`/me/library?uris=${encodeURIComponent(uris.join(','))}`, {
    method: 'DELETE',
  }, USER_ACTION);
}

export async function saveTracks(uris: string[]): Promise<void> {
  await spotifyFetch(`/me/library?uris=${encodeURIComponent(uris.join(','))}`, {
    method: 'PUT',
  }, USER_ACTION);
}

// Feb 2026 migration: POST /users/{user_id}/playlists was removed — creation
// is scoped to the current user only, via /me/playlists.
export async function createPlaylist(name: string): Promise<{ id: string }> {
  return spotifyFetch('/me/playlists', {
    method: 'POST',
    body: JSON.stringify({ name }),
  }, USER_ACTION);
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
