import { getArtistGenres } from '../api/spotify';
import { lookupArtistGenres } from '../api/musicbrainz';
import type { GenreInfo } from '../types';

const CACHE_KEY = 'kondo:genres:v1';

type GenreCache = Record<string, GenreInfo>;

function readCache(): GenreCache {
  const raw = localStorage.getItem(CACHE_KEY);
  return raw ? (JSON.parse(raw) as GenreCache) : {};
}

function writeCache(id: string, info: GenreInfo): void {
  const cache = readCache();
  cache[id] = info;
  localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
}

// Fresh Spotify apps may have lost artist-genre access entirely (Feb 2026
// removals). One failure flips this for the whole session.
let spotifyGenresAvailable = true;

export function resetResolverForTests(): void {
  spotifyGenresAvailable = true;
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
