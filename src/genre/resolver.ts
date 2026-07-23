import { getArtistGenres, SpotifyApiError } from '../api/spotify';
import { lookupGenresBulk } from '../api/musicbrainz';
import type { GenreInfo } from '../types';

const CACHE_KEY = 'kondo:genres:v3';
const V2_KEY = 'kondo:genres:v2';
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
      const v2 = localStorage.getItem(V2_KEY);
      if (v2) {
        // v2 'none' conflated "MB confirmed nothing" with "never asked MB" —
        // the old fast path wrote 'none' without calling MB at all. Migrate
        // them all to retryable 'unresolved'; a deep run re-confirms real ones.
        cache = Object.fromEntries(
          Object.entries(JSON.parse(v2) as GenreCache).map(([id, i]) => [
            id,
            i.source === 'none' ? ({ genres: [], source: 'unresolved' } as GenreInfo) : i,
          ]),
        );
        // Persist NOW — writeCache's debounced timer only starts on the next
        // resolution; closing the tab before that would lose the migration.
        localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
        localStorage.removeItem(V2_KEY);
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
  }
  return cache;
}

export function cachedGenres(id: string): string[] | undefined {
  return getCache()[id]?.genres;
}

export interface GenreCoverage { spotify: number; musicbrainz: number; none: number; unresolved: number }

/** Cache-source counts for a set of artist ids. A missing cache entry counts
 *  as 'unresolved' — same retry semantics either way. */
export function genreCoverage(ids: string[]): GenreCoverage {
  const c = getCache();
  const out: GenreCoverage = { spotify: 0, musicbrainz: 0, none: 0, unresolved: 0 };
  for (const id of ids) out[c[id]?.source ?? 'unresolved'] += 1;
  return out;
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

const SPOTIFY_POOL_CONCURRENCY = 6;

// Orchestrates the cache -> Spotify -> (optional deep) MusicBrainz waterfall
// for a whole library at once: cache hits settle immediately, uncached
// artists get a concurrency-6 Spotify pool, and whatever the pool can't
// resolve goes to lookupGenresBulk in one shot instead of per-artist MB calls.
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
    // A deep run re-tries only 'unresolved' (never asked MB). A durable 'none'
    // (MB confirmed nothing) is NOT retried — that's the distinction the two
    // source values exist for.
    if (cached && !(opts.deep && cached.source === 'unresolved')) {
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
    // Default (non-deep) runs NEVER call MusicBrainz — not even when Spotify
    // genre access is revoked (403). Misses are cached as retryable
    // 'unresolved'; the user triggers the MB pass explicitly (deepResolveAll),
    // which is the only place nameSearch runs.
    if (opts.deep) {
      // onResult forwards straight to sink — chunk results land (and get
      // reported) well before the whole bulk call returns, which is what makes
      // a mid-run partial flush possible during the (usually long) MB phase.
      const mbResults = await lookupGenresBulk(forBulk, (done) => {
        onProgress(resolved + done, total);
      }, sink, { nameSearch: true });
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
        writeCache(a.id, { genres: [], source: 'unresolved' });
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
