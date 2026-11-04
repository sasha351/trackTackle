// Last-chance sources for artists the main waterfall (Spotify → Wikidata →
// MusicBrainz artist tags) found nothing for. Only a deep run calls this.
// Chosen by the genre-gap diagnostic (src/dev/genreGaps.ts) on a real
// library: neither source is large, but they barely overlap and their
// answers checked out by eye.
//
// 1. Recordings: the artist's own tracks' ISRCs → MB recordings → recording
//    and album (release-group) tags. Album tags are where MB taggers spend
//    their effort, so this often answers for an artist page nobody tagged.
//    A solo credit on the recording also recovers an MBID that MB's /url
//    lookup can't find (no Spotify link on the MB artist), feeding step 2.
// 2. Neighbours: ListenBrainz similar artists (listening-session
//    co-occurrence — the free analogue of Spotify's own signal) → their MB
//    tags → genres ≥2 of the top 10 agree on.
// 3. Last.fm: the artist's top tags (by MBID, else by name), filtered through
//    MB's genre whitelist. Listener tags reach the long tail the first two
//    can't: on a real library it rescued 14 of the 24 artists left after
//    them. Skipped when the build has no VITE_LASTFM_API_KEY.
//
// ponytail: a Last.fm *name* lookup can land on a namesake (two "Ryan
// Scott"s blended). Accepted — a song with no genres gets no suggestion at
// all, so a plausible wrong genre costs less than none. If it proves noisy,
// down-weight 'lastfm' in the engine like 'neighbours' below.
//
// ponytail: borrowed genres carry the same weight in matching as an artist's
// own tags. If neighbour genres prove noisy on real libraries, the source is
// on the cache entry — down-weight 'neighbours' in the engine, don't drop it.

import { genresFromNeighbours, similarArtists, type SimilarArtist } from '../api/listenbrainz';
import { artistTagSummaries, genreWhitelist, lookupIsrcs, releaseGroupGenres } from '../api/musicbrainz';
import { artistTopTags, genresFromLastFmTags, isFatalLastFmError } from '../api/lastfm';

/** One of the artist's own tracks; `solo` = the artist is its only credit. */
export interface ArtistRecording { isrc: string; solo: boolean }

export type EnrichPhase = 'recordings' | 'neighbours' | 'lastfm';

export interface EnrichResult {
  found: Map<string, { genres: string[]; source: 'recordings' | 'neighbours' | 'lastfm' }>;
  /** Artists a request failed for — their "nothing found" is not durable. */
  failed: Set<string>;
}

// A few tracks per artist are enough to find its albums; capping keeps a
// big library's ISRC phase at ⌈artists·3/25⌉ MB requests.
const ISRCS_PER_ARTIST = 3;
const LB_CONCURRENCY = 2;
const KEEP = 3; // borrowed/recording genres kept per artist — the tail is where the noise lives

function topByCount(counts: Map<string, number>): string[] {
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, KEEP).map(([g]) => g);
}

export async function enrichEmptyArtists(
  ids: string[],
  recordingsByArtist: Map<string, ArtistRecording[]>,
  mbids: Map<string, string>,
  onPhase?: (phase: EnrichPhase) => void,
  { names = new Map<string, string>(), lastFmKey }: { names?: Map<string, string>; lastFmKey?: string } = {},
): Promise<EnrichResult> {
  const found: EnrichResult['found'] = new Map();
  const failed = new Set<string>();
  if (ids.length === 0) return { found, failed };
  const mbidOf = new Map(mbids);

  // -- 1. Recordings ----------------------------------------------------------
  onPhase?.('recordings');
  const recs = new Map(ids.map((id) => [id, (recordingsByArtist.get(id) ?? []).slice(0, ISRCS_PER_ARTIST)]));
  const isrc = await lookupIsrcs([...recs.values()].flat().map((r) => r.isrc));
  const rgids = [...isrc.byIsrc.values()].flat().flatMap((r) => r.releaseGroupIds);
  const rg = await releaseGroupGenres(rgids);

  for (const id of ids) {
    const counts = new Map<string, number>();
    let unsure = false;
    for (const t of recs.get(id) ?? []) {
      const key = t.isrc.toUpperCase();
      if (isrc.failed.has(key)) unsure = true;
      for (const r of isrc.byIsrc.get(key) ?? []) {
        // An ISRC shared by a different artist's recording (compilations,
        // bad data) must not lend its tags: when we know this artist's MBID,
        // require it in the credits.
        const known = mbidOf.get(id);
        if (known && !r.artistMbids.includes(known)) continue;
        if (!known && t.solo && r.artistMbids.length === 1) mbidOf.set(id, r.artistMbids[0]);
        const genres = [...r.genres];
        for (const g of r.releaseGroupIds) {
          if (rg.failed.has(g)) unsure = true;
          genres.push(...(rg.byId.get(g) ?? []));
        }
        for (const g of genres) counts.set(g, (counts.get(g) ?? 0) + 1);
      }
    }
    if (counts.size > 0) found.set(id, { genres: topByCount(counts), source: 'recordings' });
    else if (unsure) failed.add(id);
  }

  // -- 2. Neighbours ------------------------------------------------------------
  const askLb = ids.filter((id) => !found.has(id) && mbidOf.has(id));
  if (askLb.length > 0) await neighbourPhase(askLb, mbidOf, found, failed, onPhase);

  // -- 3. Last.fm ---------------------------------------------------------------
  const askLfm = ids.filter((id) => !found.has(id) && (mbidOf.has(id) || names.has(id)));
  if (lastFmKey && askLfm.length > 0) {
    onPhase?.('lastfm');
    const whitelist = await genreWhitelist();
    // Unfiltered Last.fm tags are "russia", "seen live", "usa" — without the
    // list nothing durable may be concluded, so leave them retryable.
    if (whitelist.size === 0) {
      askLfm.forEach((id) => failed.add(id));
      return { found, failed };
    }
    for (const [k, id] of askLfm.entries()) {
      try {
        const r = await artistTopTags({ name: names.get(id) ?? '', mbid: mbidOf.get(id) }, lastFmKey);
        const genres = r ? genresFromLastFmTags(r.tags, whitelist, { max: KEEP }) : [];
        if (genres.length > 0) {
          found.set(id, { genres, source: 'lastfm' });
          failed.delete(id);
        }
      } catch (e) {
        failed.add(id);
        // A bad key / CORS / rate limit fails every remaining artist the same
        // way — stop instead of spending 250 ms each to learn that.
        if (isFatalLastFmError(e)) {
          askLfm.slice(k + 1).forEach((rest) => failed.add(rest));
          break;
        }
      }
    }
  }
  return { found, failed };
}

async function neighbourPhase(
  askLb: string[],
  mbidOf: Map<string, string>,
  found: EnrichResult['found'],
  failed: Set<string>,
  onPhase?: (phase: EnrichPhase) => void,
): Promise<void> {
  onPhase?.('neighbours');
  const neighboursOf = new Map<string, SimilarArtist[]>();
  const queue = askLb[Symbol.iterator]();
  const worker = async () => {
    for (let n = queue.next(); !n.done; n = queue.next()) {
      try {
        neighboursOf.set(n.value, await similarArtists(mbidOf.get(n.value)!));
      } catch {
        failed.add(n.value); // labs API hiccup or CORS — retry on a later deep run
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(LB_CONCURRENCY, askLb.length) }, worker));

  const neighbourTags = await artistTagSummaries(
    [...neighboursOf.values()].flatMap((ns) => ns.slice(0, 10).map((n) => n.mbid)),
  );
  for (const [id, ns] of neighboursOf) {
    const genres = genresFromNeighbours(ns, (m) => neighbourTags.get(m)?.genres).slice(0, KEEP);
    if (genres.length > 0) {
      found.set(id, { genres, source: 'neighbours' });
      failed.delete(id);
    }
  }
}
