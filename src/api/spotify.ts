import { expireAccessToken, getValidAccessToken } from '../auth/token';
import type { Playlist, PlaylistTrack, Track } from '../types';

const BASE = 'https://api.spotify.com/v1';

let clientId = '';

export function configureSpotify(id: string): void {
  clientId = id;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Spotify rate-limits the whole app, not single requests — when one call gets
// a 429, every in-flight caller must back off too or they stampede and extend
// the penalty. One shared timestamp gates them all.
let rateLimitedUntil = 0;
const MAX_RETRY_AFTER_MS = 60_000;

export function resetRateLimitForTests(): void {
  rateLimitedUntil = 0;
}

export async function spotifyFetch<T>(pathOrUrl: string, init: RequestInit = {}): Promise<T> {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : BASE + pathOrUrl;
  let retried401 = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    const gateWait = rateLimitedUntil - Date.now();
    if (gateWait > 0) await sleep(gateWait);
    const token = await getValidAccessToken(clientId);
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    if (init.body) headers.set('Content-Type', 'application/json');
    const res = await fetch(url, { ...init, headers });
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
        throw new Error(
          `Spotify rate limit hit — try again in ~${Math.ceil(retryAfterMs / 60_000)} min`,
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
      // isn't registered as active on Spotify's backend yet. Same backoff
      // schedule as the 429 path.
      if (attempt === 4) throw new Error(`Spotify API ${res.status} for ${url}`);
      await sleep(2 ** attempt * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`Spotify API ${res.status} for ${url}`);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
  throw new Error(
    'Spotify is rate-limiting this app (429). Wait a few minutes and reload — ' +
    'after heavy use the penalty can last an hour or more.',
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

export async function getSavedTracks(): Promise<Track[]> {
  const items = await getAllPages<{ added_at: string; track: RawTrack | null }>('/me/tracks?limit=50');
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
  const fields = encodeURIComponent('items(item(artists(id,name),album(release_date))),next');
  const items = await getAllPages<{ item: RawTrack | null }>(
    `/playlists/${playlistId}/items?limit=100&fields=${fields}`,
  );
  return items
    .filter((i): i is { item: RawTrack } => i.item != null)
    .map((i) => ({
      artists: i.item.artists.map((a) => ({ id: a.id, name: a.name })),
      releaseYear: yearOf(i.item.album.release_date),
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
