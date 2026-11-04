import { ARTIST_BATCH, getArtistGenresBatch, SpotifyApiError } from '../api/spotify';
import { lookupGenresBulk as lookupGenresBulkMb, type MbPhase } from '../api/musicbrainz';
import { lookupGenresBulk as lookupGenresBulkWikipedia } from '../api/wikipedia';
import { lastFmApiKey } from '../api/lastfm';
import type { GenreInfo } from '../types';
import { enrichEmptyArtists, type ArtistRecording, type EnrichPhase } from './enrich';
import { normalizeWikidataGenre } from './normalize';

// Bump when a deep run gains a source that could rescue an artist an earlier
// run gave up on — every 'none' below this version is re-checked once.
// 2 = recordings-by-ISRC + ListenBrainz neighbours (src/genre/enrich.ts).
// 3 = Last.fm artist top tags — only when the build has a Last.fm key.
export const NONE_SOURCES_VERSION = 3;
/** The version a deep run actually delivers. A keyless build never runs
 *  Last.fm, so it must neither stamp its 'none's as 3 (they'd never see
 *  Last.fm once a key exists) nor treat every 2 as stale (a re-check button
 *  that can never do anything). */
export function noneSourcesVersion(): number {
  return lastFmApiKey() ? NONE_SOURCES_VERSION : 2;
}
// MB and ListenBrainz keep growing; a 'none' is "nothing *yet*", not forever.
const NONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** A durable 'none' a deep run should look at again: reached before the
 *  current sources existed, or long enough ago that the sources may have
 *  caught up. */
export function isStaleNone(info: GenreInfo | undefined, now = Date.now()): boolean {
  if (info?.source !== 'none') return false;
  if ((info.checked ?? 1) < noneSourcesVersion()) return true;
  return info.at !== undefined && now - info.at > NONE_TTL_MS;
}

const CACHE_KEY = 'tracktackle:genres:v3';

type GenreCache = Record<string, GenreInfo>;

let cache: GenreCache | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

// ponytail: no migration path. The v1→v2→v3 ladder that used to live here died
// with the `kondo:` → `tracktackle:` key rename — no browser has ever held a
// `tracktackle:genres:v1` or `:v2`, so every one of those branches was dead. A
// v4 would need a fresh one; bump CACHE_KEY and write it then, not before.
function getCache(): GenreCache {
  if (!cache) {
    const raw = localStorage.getItem(CACHE_KEY);
    cache = raw ? (JSON.parse(raw) as GenreCache) : {};
    // Wikidata-sourced entries written before the join normalized its labels
    // still say "rock music" and never match MB/Spotify's "rock". Normalizing
    // on read is idempotent and in-memory only — the next writeCache persists
    // it — so no key bump (and none of the migration ladder the ponytail
    // above warns about) is needed.
    for (const info of Object.values(cache)) {
      if (info.source === 'wikipedia') {
        info.genres = [...new Set(info.genres.map(normalizeWikidataGenre).filter(Boolean))];
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

export interface GenreCoverage {
  spotify: number; musicbrainz: number; wikipedia: number; recordings: number; neighbours: number; lastfm: number;
  none: number; unresolved: number;
  /** Subset of `none` a deep run would re-check (isStaleNone). */
  stale: number;
}

/** Cache-source counts for a set of artist ids. A missing cache entry counts
 *  as 'unresolved' — same retry semantics either way. */
export function genreCoverage(ids: string[]): GenreCoverage {
  const c = getCache();
  const out: GenreCoverage = {
    spotify: 0, musicbrainz: 0, wikipedia: 0, recordings: 0, neighbours: 0, lastfm: 0, none: 0, unresolved: 0, stale: 0,
  };
  const now = Date.now();
  for (const id of ids) {
    out[c[id]?.source ?? 'unresolved'] += 1;
    if (isStaleNone(c[id], now)) out.stale += 1;
  }
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
export type DeepPhase = MbPhase | 'joining' | EnrichPhase;

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
    // 'joining' added explicitly (rather than the full WikiPhase union) so
    // existing callers stay assignable with minimal change: it's the one
    // Wikipedia phase with no MB analogue, fired both by the join-only
    // supplement ahead of MusicBrainz and by a full Wikipedia bulk run.
    // 'searching'/'fetching' are shared between the two providers already.
    onPhase?: (phase: DeepPhase, artistName?: string) => void;
    /** Each artist's own tracks (ISRC + solo-credit flag), for the deep run's
     *  recordings phase. Artists absent here just skip that phase. */
    recordingsByArtist?: Map<string, ArtistRecording[]>;
  } = {},
): Promise<Map<string, string[]>> {
  const total = artists.length;
  const result = new Map<string, string[]>();
  let resolved = 0;

  const pending: { id: string; name: string }[] = [];
  // Stale 'none' artists re-checked by this deep run. They already had their
  // serial MB name search, so they skip it (the batched phases are cheap).
  const recheck = new Set<string>();
  const now = Date.now();
  for (const a of artists) {
    const cached = getCache()[a.id];
    // A deep run re-tries 'unresolved' (never asked MB) and a *stale* 'none'
    // (see isStaleNone). A current 'none' is NOT retried — that's the
    // distinction the two source values exist for.
    const stale = opts.deep && isStaleNone(cached, now);
    if (stale) recheck.add(a.id);
    if (cached && !(opts.deep && cached.source === 'unresolved') && !stale) {
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
  let enrichHits = 0;
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
      // Wikidata P434 MBIDs for join hits that had no P136 genre — handed to
      // MB so those artists skip its /url mapping and 1.1 s name search.
      const knownMbids = new Map<string, string>();
      // Every MBID either provider learned, for the enrichment phase below.
      const allMbids = new Map<string, string>();
      if (providerName === 'musicbrainz') {
        const joinOnly = await lookupGenresBulkWikipedia(forBulk, undefined, undefined, {
          nameSearch: false, infobox: false, onPhase: opts.onPhase, mbidsOut: knownMbids,
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
      const bulkResults = remaining.length === 0
        ? new Map<string, string[]>()
        : providerName === 'wikipedia'
        ? await lookupGenresBulkWikipedia(remaining, (done) => {
            onProgress(resolved + done, total);
          }, sink, { nameSearch: true, infobox: true, onPhase: opts.onPhase })
        : await lookupGenresBulkMb(remaining, (done) => {
            onProgress(resolved + done, total);
          }, sink, {
            nameSearch: true, onPhase: opts.onPhase, knownMbids, mbidsOut: allMbids, noNameSearch: recheck,
          });
      for (const [id, mbid] of knownMbids) if (!allMbids.has(id)) allMbids.set(id, mbid);
      const empty: string[] = [];
      for (const a of remaining) {
        const genres = bulkResults.get(a.id);
        result.set(a.id, genres ?? []);
        // Absent from the map = a transient chunk/search failure, not a real
        // "provider has nothing" — leave it uncached so the next run retries it.
        if (genres === undefined) continue;
        if (genres.length > 0) writeCache(a.id, { genres, source: providerName });
        else empty.push(a.id);
      }

      // Last-chance sources for whatever the provider had nothing for. The
      // artist's earlier sink/progress already fired with [] above, so a hit
      // here re-sinks it — the next partial flush or the final build picks
      // it up. A request failure leaves a non-durable 'none' (no `checked`),
      // which isStaleNone sends back through the next deep run.
      if (empty.length > 0) {
        const enriched = await enrichEmptyArtists(
          empty, opts.recordingsByArtist ?? new Map(), allMbids,
          (phase) => opts.onPhase?.(phase),
          { names: new Map(remaining.map((a) => [a.id, a.name])), lastFmKey: lastFmApiKey() },
        );
        for (const id of empty) {
          const hit = enriched.found.get(id);
          if (hit) {
            writeCache(id, hit);
            result.set(id, hit.genres);
            sink?.(id, hit.genres);
            enrichHits += 1;
          } else if (enriched.failed.has(id)) {
            writeCache(id, { genres: [], source: 'none' });
          } else {
            writeCache(id, { genres: [], source: 'none', checked: noneSourcesVersion(), at: now });
          }
        }
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
    `track tackle genres: ${total} artists, ${total - pending.length} cached, ` +
    `${pending.length - forBulk.length} via Spotify, ${wikiSupplementHits} via Wikidata join, ` +
    `${forBulk.length - wikiSupplementHits} via ${providerLabel}, ${enrichHits} via recordings/neighbours/Last.fm`,
  );

  return result;
}
