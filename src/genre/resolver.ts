import { ARTIST_BATCH, getArtistGenresBatch, SpotifyApiError } from '../api/spotify';
import { lookupGenresBulk as lookupGenresBulkMb, type MbPhase } from '../api/musicbrainz';
import { joinWikidata } from '../api/wikidata';
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

// Orchestrates the whole waterfall for a library at once. Default run:
// cache -> Spotify (50 ids/request, pool of 6), misses cached 'unresolved'.
// Deep run, for whatever Spotify missed, cheapest and most precise first:
//   Wikidata join (P136 + P434, 4 parallel)  -> MB /url + arid: tags (batched)
//   -> enrich.ts: ISRC album tags -> Last.fm -> MB name search -> ListenBrainz
// Every batched, ID-keyed step runs before any per-artist, name-keyed one, so
// the bulk of the library's genres land (and flush to the UI) within the
// first minute, and the serial 1.1 s MB name search only sees the residue.
export type DeepPhase = MbPhase | 'joining' | EnrichPhase;

export async function resolveAllGenres(
  artists: { id: string; name: string }[],
  onProgress: (resolved: number, total: number) => void,
  sink?: (id: string, genres: string[]) => void,
  opts: {
    deep?: boolean;
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

  let wikiHits = 0;
  let mbHits = 0;
  let enrichHits = 0;
  if (forBulk.length > 0) {
    // Default (non-deep) runs NEVER go past Spotify — not even when Spotify
    // genre access is revoked (403). Misses are cached as retryable
    // 'unresolved'; the user triggers the deep pass explicitly
    // (deepResolveAll).
    if (opts.deep) {
      const land = (id: string, info: GenreInfo) => {
        writeCache(id, info);
        result.set(id, info.genres);
        sink?.(id, info.genres);
      };

      // 1. Wikidata join (docs/wikipedia-genre-benchmark.md): Wikidata's own
      // curated P136 statements, keyed on the Spotify id. Real library:
      // 46.9% hit rate. A miss is never cached here — it just falls through.
      // P434 MBIDs for the rest let MB skip /url for them.
      opts.onPhase?.('joining');
      const knownMbids = new Map<string, string>();
      const joined = await joinWikidata(forBulk.map((a) => a.id), { mbidsOut: knownMbids });
      const remaining: typeof forBulk = [];
      for (const a of forBulk) {
        const genres = joined.get(a.id);
        if (genres && genres.length > 0) {
          land(a.id, { genres, source: 'wikipedia' });
          wikiHits += 1;
        } else {
          remaining.push(a);
        }
      }
      resolved += wikiHits;
      if (wikiHits > 0) onProgress(resolved, total);

      // 2. MusicBrainz /url mapping + arid: tags, batched. onResult forwards
      // to sink per chunk so a mid-run partial flush can pick results up.
      const allMbids = new Map<string, string>();
      const mbResults = await lookupGenresBulkMb(remaining, (done) => {
        onProgress(resolved + done, total);
      }, sink, { onPhase: opts.onPhase, knownMbids, mbidsOut: allMbids });
      const empty: string[] = [];
      for (const a of remaining) {
        const genres = mbResults.get(a.id);
        result.set(a.id, genres ?? []);
        // Absent from the map = a transient chunk failure, not a real
        // "MB has nothing" — leave it uncached so the next run retries it.
        if (genres === undefined) continue;
        if (genres.length > 0) {
          writeCache(a.id, { genres, source: 'musicbrainz' });
          mbHits += 1;
        } else {
          empty.push(a.id);
        }
      }

      // 3. Last-chance, per-artist sources (enrich.ts) for whatever has no
      // genre yet. The artist's earlier sink/progress already fired with []
      // above, so a hit here re-sinks it — the next partial flush or the
      // final build picks it up. A request failure leaves a non-durable
      // 'none' (no `checked`), which isStaleNone sends back through the next
      // deep run.
      if (empty.length > 0) {
        const enriched = await enrichEmptyArtists(
          empty, opts.recordingsByArtist ?? new Map(), allMbids,
          (phase, name) => opts.onPhase?.(phase, name),
          { names: new Map(remaining.map((a) => [a.id, a.name])), lastFmKey: lastFmApiKey(), noNameSearch: recheck },
        );
        for (const id of empty) {
          const hit = enriched.found.get(id);
          if (hit) {
            land(id, hit);
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

  // ponytail: dev diagnostic — one line so we can see the per-source split.
  console.info(
    `track tackle genres: ${total} artists, ${total - pending.length} cached, ` +
    `${pending.length - forBulk.length} via Spotify, ${wikiHits} via Wikidata, ` +
    `${mbHits} via MusicBrainz tags, ${enrichHits} via recordings/Last.fm/name search/neighbours`,
  );

  return result;
}
