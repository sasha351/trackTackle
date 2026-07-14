import { getArtistGenres, getArtistGenresBatch } from '../api/spotify';
import { lookupArtistGenres } from '../api/musicbrainz';
import type { GenreInfo } from '../types';

const CACHE_KEY = 'kondo:genres:v1';

type GenreCache = Record<string, GenreInfo>;

function readCache(): GenreCache {
  const raw = localStorage.getItem(CACHE_KEY);
  return raw ? (JSON.parse(raw) as GenreCache) : {};
}

function writeCacheMany(entries: [string, GenreInfo][]): void {
  if (entries.length === 0) return;
  const cache = readCache();
  for (const [id, info] of entries) cache[id] = info;
  localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
}

function writeCache(id: string, info: GenreInfo): void {
  writeCacheMany([[id, info]]);
}

// Fresh Spotify apps may have lost artist-genre access entirely (Feb 2026
// removals). One failure flips this for the whole session.
let spotifyGenresAvailable = true;

export function resetResolverForTests(): void {
  spotifyGenresAvailable = true;
}

// Fills the cache for every artist Spotify knows a genre for, in 50-id batches.
// Whatever it can't answer (empty genres, or no Spotify genre access at all)
// falls through to the per-artist MusicBrainz path below.
export async function prefetchSpotifyGenres(artists: { id: string }[]): Promise<void> {
  if (!spotifyGenresAvailable) return;
  const cache = readCache();
  const missing = artists.map((a) => a.id).filter((id) => !cache[id]);
  if (missing.length === 0) return;

  try {
    const byId = await getArtistGenresBatch(missing);
    writeCacheMany(
      [...byId]
        .filter(([, genres]) => genres.length > 0)
        .map(([id, genres]) => [
          id,
          { genres: genres.map((g) => g.toLowerCase()), source: 'spotify' } satisfies GenreInfo,
        ]),
    );
  } catch {
    spotifyGenresAvailable = false;
  }
}

export async function resolveArtistGenres(artist: { id: string; name: string }): Promise<GenreInfo> {
  const cached = readCache()[artist.id];
  if (cached) return cached;

  if (spotifyGenresAvailable) {
    try {
      const genres = await getArtistGenres(artist.id);
      if (genres.length > 0) {
        const info: GenreInfo = { genres: genres.map((g) => g.toLowerCase()), source: 'spotify' };
        writeCache(artist.id, info);
        return info;
      }
    } catch {
      spotifyGenresAvailable = false;
    }
  }

  const mbGenres = await lookupArtistGenres(artist.name);
  const info: GenreInfo = mbGenres.length > 0
    ? { genres: mbGenres, source: 'musicbrainz' }
    : { genres: [], source: 'none' };
  writeCache(artist.id, info);
  return info;
}
