import { ARTIST_BATCH, getArtistGenresBatch, SpotifyApiError } from '../api/spotify';
import { lookupGenresBulk as lookupGenresBulkMb, type MbPhase } from '../api/musicbrainz';
import { lookupGenresBulk as lookupGenresBulkWikipedia, type WikiPhase } from '../api/wikipedia';
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

export function cachedSource(id: string): GenreInfo['source'] | undefined {
  return getCache()[id]?.source;
}

export interface GenreCoverage { spotify: number; musicbrainz: number; wikipedia: number; none: number; unresolved: number }

/** Cache-source counts for a set of artist ids. A missing cache entry counts
 *  as 'unresolved' — same retry semantics either way. */
export function genreCoverage(ids: string[]): GenreCoverage {
  const c = getCache();
  const out: GenreCoverage = { spotify: 0, musicbrainz: 0, wikipedia: 0, none: 0, unresolved: 0 };
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
  opts: {
    deep?: boolean;
    /** Which provider a deep run's bulk phase uses. MusicBrainz is the
     *  benchmarked, shipped default — 'wikipedia' is a challenger opt-in
     *  (see docs/superpowers/plans/2026-08-03-wikipedia-genre-resolver.md)
     *  and must never change behaviour unless explicitly requested. */
    fallback?: 'musicbrainz' | 'wikipedia';
    // Kept as MbPhase (not MbPhase | WikiPhase) so existing callers — typed
    // against MB's phase names before this option existed — stay
    // byte-for-byte assignable with no changes on their end. 'searching' and
    // 'fetching' are shared with WikiPhase; only MB's 'mapping' has no
    // Wikipedia analogue ('joining' takes its place, see the wikipedia() call
    // below) — a UI that just displays the phase name degrades harmlessly.
    onPhase?: (phase: MbPhase, artistName?: string) => void;
  } = {},
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
    // One request per 50 artists, not per artist. A library with 2500 uncached
    // artists went from 2500 Spotify calls to 50 — the difference between
    // "app-wide 429 for an hour" and a normal load.
    const chunks: { id: string; name: string }[][] = [];
    for (let i = 0; i < pending.length; i += ARTIST_BATCH) {
      chunks.push(pending.slice(i, i + ARTIST_BATCH));
    }
    const iterator = chunks[Symbol.iterator]();
    const worker = async () => {
      for (let next = iterator.next(); !next.done; next = iterator.next()) {
        const chunk = next.value;
        if (!spotifyGenresAvailable) {
          forBulk.push(...chunk); // flag flipped by another worker — skip straight to MB
          continue;
        }
        let found: Map<string, string[]>;
        try {
          found = await getArtistGenresBatch(chunk.map((a) => a.id));
        } catch (e) {
          if (!(e instanceof SpotifyApiError)) throw e;
          if (e.status === 403) spotifyGenresAvailable = false;
          forBulk.push(...chunk);
          continue;
        }
        for (const a of chunk) {
          // Absent id or empty genres both mean "Spotify has nothing" here —
          // either way the artist falls through to the MB path, which is the
          // same outcome the per-artist version produced.
          const genres = found.get(a.id)?.map((g) => g.toLowerCase()) ?? [];
          if (genres.length === 0) {
            forBulk.push(a);
            continue;
          }
          const info: GenreInfo = { genres, source: 'spotify' };
          writeCache(a.id, info);
          result.set(a.id, info.genres);
          sink?.(a.id, info.genres);
          resolved += 1;
        }
        onProgress(resolved, total);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(SPOTIFY_POOL_CONCURRENCY, chunks.length) }, worker),
    );
  } else {
    forBulk.push(...pending);
  }

  // Which provider a deep run's bulk phase used — only meaningful (and only
  // reported below) when forBulk was non-empty and opts.deep was set.
  const providerName: 'musicbrainz' | 'wikipedia' = opts.fallback === 'wikipedia' ? 'wikipedia' : 'musicbrainz';
  const providerLabel = providerName === 'wikipedia' ? 'Wikipedia' : 'MusicBrainz';

  let wikiSupplementHits = 0;
  if (forBulk.length > 0) {
    // Default (non-deep) runs NEVER call the bulk provider — not even when
    // Spotify genre access is revoked (403). Misses are cached as retryable
    // 'unresolved'; the user triggers the deep pass explicitly (deepResolveAll),
    // which is the only place nameSearch runs.
    if (opts.deep) {
      // Wikidata join-only supplement (docs/wikipedia-genre-benchmark.md):
      // one fast batched SPARQL pass, no name search, no infobox parse (that
      // combo's precision/recall measured too weak to trust — the join alone
      // is Wikidata's own curated P136 statements, ID-keyed like MB's /url
      // lookup so it never has to disambiguate by name). Real-library
      // measurement: 46.9% hit rate (1727/3685 artists), ~110s for a
      // 3685-artist library, run from Settings' dev probe. Only ever ADDS
      // genres — a miss is never cached here, so the artist still falls
      // through to the chosen provider below exactly as before. Skipped when
      // that provider IS wikipedia: lookupGenresBulkWikipedia already runs
      // this same join as its own first phase, so doing it twice would just
      // waste a request.
      let remaining = forBulk;
      if (providerName === 'musicbrainz') {
        const joinOnly = await lookupGenresBulkWikipedia(forBulk, undefined, undefined, {
          nameSearch: false, infobox: false,
        });
        const hitIds = new Set<string>();
        for (const a of forBulk) {
          const genres = joinOnly.get(a.id);
          if (!genres || genres.length === 0) continue;
          hitIds.add(a.id);
          const info: GenreInfo = { genres, source: 'wikipedia' };
          writeCache(a.id, info);
          result.set(a.id, info.genres);
          sink?.(a.id, info.genres);
          resolved += 1;
        }
        wikiSupplementHits = hitIds.size;
        if (hitIds.size > 0) {
          onProgress(resolved, total);
          remaining = forBulk.filter((a) => !hitIds.has(a.id));
        }
      }

      // onResult forwards straight to sink — chunk results land (and get
      // reported) well before the whole bulk call returns, which is what makes
      // a mid-run partial flush possible during the (usually long) bulk phase.
      // opts.onPhase is typed against MbPhase (see the opts type above) —
      // 'searching'/'fetching' apply equally to Wikipedia's phases, so this
      // cast just widens the domain it's actually called with at runtime.
      const wikiOnPhase = opts.onPhase as ((phase: WikiPhase, artistName?: string) => void) | undefined;
      const bulkResults = remaining.length === 0
        ? new Map<string, string[]>()
        : providerName === 'wikipedia'
        ? await lookupGenresBulkWikipedia(remaining, (done) => {
            onProgress(resolved + done, total);
          }, sink, { nameSearch: true, infobox: true, onPhase: wikiOnPhase })
        : await lookupGenresBulkMb(remaining, (done) => {
            onProgress(resolved + done, total);
          }, sink, { nameSearch: true, onPhase: opts.onPhase });
      for (const a of remaining) {
        const genres = bulkResults.get(a.id);
        result.set(a.id, genres ?? []);
        // Absent from the map = a transient chunk/search failure, not a real
        // "provider has nothing" — leave it uncached so the next run retries it.
        if (genres === undefined) continue;
        const info: GenreInfo = genres.length > 0
          ? { genres, source: providerName }
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

  // ponytail: dev diagnostic — one line so we can see Spotify-vs-bulk-provider split and wall-clock.
  console.info(
    `kondo genres: ${total} artists, ${total - pending.length} cached, ` +
    `${pending.length - forBulk.length} via Spotify, ${wikiSupplementHits} via Wikidata join, ` +
    `${forBulk.length - wikiSupplementHits} via ${providerLabel}`,
  );

  return result;
}
