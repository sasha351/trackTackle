import { getArtistGenres, SpotifyApiError } from '../api/spotify';
import { lookupArtistGenres, lookupGenresBulk } from '../api/musicbrainz';
import type { GenreInfo } from '../types';

const CACHE_KEY = 'kondo:genres:v2';
const V1_KEY = 'kondo:genres:v1';

type GenreCache = Record<string, GenreInfo>;

let cache: GenreCache | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function getCache(): GenreCache {
  if (!cache) {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) {
      cache = JSON.parse(raw) as GenreCache;
    } else {
      // v1 MB entries were resolved by name search, which misses transliterated
      // artists — keep only Spotify-sourced entries, re-resolve the rest via
      // the Spotify-URL lookup.
      const v1 = localStorage.getItem(V1_KEY);
      cache = v1
        ? Object.fromEntries(
            Object.entries(JSON.parse(v1) as GenreCache).filter(([, i]) => i.source === 'spotify'),
          )
        : {};
      localStorage.removeItem(V1_KEY);
    }
  }
  return cache;
}

export function cachedGenres(id: string): string[] | undefined {
  return getCache()[id]?.genres;
}

function writeCache(id: string, info: GenreInfo): void {
  getCache()[id] = info;
  if (!persistTimer) {
    persistTimer = setTimeout(() => {
      persistTimer = null;
      localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    }, 1000);
  }
}

// Fresh Spotify apps may have lost artist-genre access entirely (Feb 2026
// removals). One failure flips this for the whole session.
let spotifyGenresAvailable = true;

export function resetResolverForTests(): void {
  spotifyGenresAvailable = true;
  cache = null;
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
}

export async function resolveArtistGenres(artist: { id: string; name: string }): Promise<GenreInfo> {
  const cached = getCache()[artist.id];
  if (cached) return cached;

  if (spotifyGenresAvailable) {
    try {
      const genres = await getArtistGenres(artist.id);
      if (genres.length > 0) {
        const info: GenreInfo = { genres: genres.map((g) => g.toLowerCase()), source: 'spotify' };
        writeCache(artist.id, info);
        return info;
      }
    } catch (e) {
      // Only a 403 means Spotify has actually revoked genre access for the
      // session — 404s and transient errors are per-artist, not systemic.
      if (e instanceof SpotifyApiError && e.status === 403) {
        spotifyGenresAvailable = false;
      }
    }
  }

  const mbGenres = await lookupArtistGenres(artist);
  const info: GenreInfo = mbGenres.length > 0
    ? { genres: mbGenres, source: 'musicbrainz' }
    : { genres: [], source: 'none' };
  writeCache(artist.id, info);
  return info;
}

const SPOTIFY_POOL_CONCURRENCY = 6;

// Orchestrates the same cache -> Spotify -> MusicBrainz waterfall as
// resolveArtistGenres, but for a whole library at once: cache hits settle
// immediately, uncached artists get a concurrency-6 Spotify pool (moved here
// from useLibrary's old per-artist loop), and whatever the pool can't resolve
// goes to lookupGenresBulk in one shot instead of per-artist MB calls.
export async function resolveAllGenres(
  artists: { id: string; name: string }[],
  onProgress: (resolved: number, total: number) => void,
  sink?: (id: string, genres: string[]) => void,
  opts: { deep?: boolean } = {},
): Promise<Map<string, string[]>> {
  const total = artists.length;
  const result = new Map<string, string[]>();
  let resolved = 0;

  const pending: { id: string; name: string }[] = [];
  for (const a of artists) {
    const cached = getCache()[a.id];
    // A deep run re-tries anything the fast pass gave up on (cached as []) —
    // that's the whole point of "deeper search".
    if (cached && !(opts.deep && cached.genres.length === 0)) {
      result.set(a.id, cached.genres);
      sink?.(a.id, cached.genres);
      resolved += 1;
    } else {
      pending.push(a);
    }
  }
  onProgress(resolved, total); // cache hits count up front, before any fetch

  const forBulk: { id: string; name: string }[] = [];
  if (spotifyGenresAvailable && pending.length > 0) {
    const iterator = pending[Symbol.iterator]();
    const worker = async () => {
      for (let next = iterator.next(); !next.done; next = iterator.next()) {
        const a = next.value;
        if (!spotifyGenresAvailable) {
          forBulk.push(a); // flag flipped by another worker — skip straight to MB
          continue;
        }
        try {
          const genres = await getArtistGenres(a.id);
          if (genres.length > 0) {
            const info: GenreInfo = { genres: genres.map((g) => g.toLowerCase()), source: 'spotify' };
            writeCache(a.id, info);
            result.set(a.id, info.genres);
            sink?.(a.id, info.genres);
            resolved += 1;
            onProgress(resolved, total);
          } else {
            forBulk.push(a);
          }
        } catch (e) {
          if (e instanceof SpotifyApiError && e.status === 403) {
            spotifyGenresAvailable = false;
          }
          forBulk.push(a);
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(SPOTIFY_POOL_CONCURRENCY, pending.length) }, worker),
    );
  } else {
    forBulk.push(...pending);
  }

  if (forBulk.length > 0) {
    // Fast (non-deep) runs skip the expensive MusicBrainz bulk phase to keep
    // startup snappy: unresolved artists are cached as a durable 'none' and
    // can be retried later in a deep run. Deep runs perform the full MB bulk
    // lookup and write the results back to the cache.
    // If deep was requested, or Spotify turned off for the session during
    // the Spotify pool phase, call MusicBrainz. Otherwise mark unresolved as
    // durable none to keep startup snappy.
    if (opts.deep || !spotifyGenresAvailable) {
      // onResult forwards straight to sink — chunk results land (and get
      // reported) well before the whole bulk call returns, which is what makes
      // a mid-run partial flush possible during the (usually long) MB phase.
      const mbResults = await lookupGenresBulk(forBulk, (done) => {
        onProgress(resolved + done, total);
      }, sink, { nameSearch: !!opts.deep });
      for (const a of forBulk) {
        const genres = mbResults.get(a.id);
        result.set(a.id, genres ?? []);
        // Absent from the map = a transient chunk/search failure, not a real
        // "MB has nothing" — leave it uncached so the next run retries it.
        if (genres === undefined) continue;
        const info: GenreInfo = genres.length > 0
          ? { genres, source: 'musicbrainz' }
          : { genres: [], source: 'none' };
        writeCache(a.id, info);
      }
    } else {
      for (const a of forBulk) {
        result.set(a.id, []);
        writeCache(a.id, { genres: [], source: 'none' });
        resolved += 1;
        onProgress(resolved, total);
        sink?.(a.id, []);
      }
    }
  }

  // ponytail: dev diagnostic — one line so we can see Spotify-vs-MB split and wall-clock.
  console.info(
    `kondo genres: ${total} artists, ${total - pending.length} cached, ` +
    `${pending.length - forBulk.length} via Spotify, ${forBulk.length} via MusicBrainz`,
  );

  return result;
}
