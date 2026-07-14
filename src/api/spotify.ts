import { expireAccessToken, getValidAccessToken } from '../auth/token';
import type { Playlist, PlaylistTrack, Track } from '../types';

const BASE = 'https://api.spotify.com/v1';

let clientId = '';

export function configureSpotify(id: string): void {
  clientId = id;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function spotifyFetch<T>(pathOrUrl: string, init: RequestInit = {}): Promise<T> {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : BASE + pathOrUrl;
  let retried401 = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    const token = await getValidAccessToken(clientId);
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    if (init.body) headers.set('Content-Type', 'application/json');
    const res = await fetch(url, { ...init, headers });
    if (res.status === 429) {
      await sleep((Number(res.headers.get('Retry-After') ?? '1') + 0.5) * 1000);
      continue;
    }
    if (res.status === 401 && !retried401) {
      retried401 = true;
      expireAccessToken(); // next getValidAccessToken call runs the refresh grant
      continue;
    }
    if (!res.ok) throw new Error(`Spotify API ${res.status} for ${url}`);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
  throw new Error(`Spotify API gave up after retries: ${url}`);
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
    tracks: { total: number };
  } | null;
  const items = await getAllPages<RawPlaylist>('/me/playlists?limit=50');
  return items
    // Spotify puts null and partially-populated entries in this list.
    // Keep playlists I own or collaborate on; drop ones I merely follow.
    .filter((p): p is NonNullable<RawPlaylist> =>
      (p?.owner?.id === me.id || p?.collaborative === true) && p.tracks != null)
    .map((p) => ({ id: p.id, name: p.name, trackCount: p.tracks.total }));
}

export async function getPlaylistTracks(playlistId: string): Promise<PlaylistTrack[]> {
  const fields = encodeURIComponent('items(track(artists(id,name),album(release_date))),next');
  const items = await getAllPages<{ track: RawTrack | null }>(
    `/playlists/${playlistId}/tracks?limit=100&fields=${fields}`,
  );
  return items
    .filter((i): i is { track: RawTrack } => i.track != null)
    .map((i) => ({
      artists: i.track.artists.map((a) => ({ id: a.id, name: a.name })),
      releaseYear: yearOf(i.track.album.release_date),
    }));
}

export async function addTracksToPlaylist(playlistId: string, uris: string[]): Promise<void> {
  await spotifyFetch(`/playlists/${playlistId}/tracks`, {
    method: 'POST',
    body: JSON.stringify({ uris }),
  });
}

export async function removeTracksFromPlaylist(playlistId: string, uris: string[]): Promise<void> {
  await spotifyFetch(`/playlists/${playlistId}/tracks`, {
    method: 'DELETE',
    body: JSON.stringify({ tracks: uris.map((uri) => ({ uri })) }),
  });
}

export async function removeSavedTracks(ids: string[]): Promise<void> {
  await spotifyFetch('/me/tracks', { method: 'DELETE', body: JSON.stringify({ ids }) });
}

export async function saveTracks(ids: string[]): Promise<void> {
  await spotifyFetch('/me/tracks', { method: 'PUT', body: JSON.stringify({ ids }) });
}

export async function getArtistGenres(artistId: string): Promise<string[]> {
  const artist = await spotifyFetch<{ genres?: string[] }>(`/artists/${artistId}`);
  return artist.genres ?? [];
}

// /artists takes 50 ids per call — the difference between one request per
// artist and one per fifty is the whole first-run wait.
export async function getArtistGenresBatch(ids: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const res = await spotifyFetch<{ artists: ({ id: string; genres?: string[] } | null)[] }>(
      `/artists?ids=${chunk.join(',')}`,
    );
    for (const a of res.artists) if (a) out.set(a.id, a.genres ?? []);
  }
  return out;
}
