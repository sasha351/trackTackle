// DEV-only: answers "why are these songs still untagged, and which new source
// would fix them?" on a real library, because nothing about the long tail can
// be learned from fixtures. It does three things:
//
// 1. Counts untagged tracks and artists, split by resolver cache source. Many
//    `unresolved` means a deep run was never done, not that sources are thin.
// 2. Buckets a sample of untagged artists by *why* they have no genres: no
//    MBID anywhere, an MBID but no MB tags, or MB tags the genre whitelist
//    dropped. Each bucket wants a different fix.
// 3. Measures the candidate fixes: option 1 (the user's own playlists — see
//    librarySignals.ts, all untagged artists, no network), then on the sample:
//    - option 3, MB tags on the artist's *recordings and albums*, by ISRC
//      (also recovers MBIDs /url can't find, from the recording credits);
//    - option 2, ListenBrainz similar artists → borrowed neighbour genres.
//    It prints hit rates and examples, so precision can be eyeballed.
//
// Writes nothing to the genre cache: the numbers must describe the library
// as it is, and a diagnostic that quietly fixed things would hide its own
// result on the second run. (The Wikidata join it may run does fill that
// module's own title cache — the same thing a deep run would do.)
//
// ponytail: samples SAMPLE artists (and LB_SAMPLE for ListenBrainz) rather
// than the whole library — ~1–2 min instead of ~10 at MB's 1.1 s/request.
// Rates extrapolate; examples are what decide precision. Raise both for a
// tighter number.

import {
  artistTagSummaries,
  lookupIsrcs,
  mapSpotifyArtistsToMbids,
  releaseGroupGenres,
  type MbTagSummary,
} from '../api/musicbrainz';
import { genresFromNeighbours, ListenBrainzError, similarArtists, type SimilarArtist } from '../api/listenbrainz';
import { cachedWikidataEntry, lookupGenresBulk as wikiLookupGenresBulk } from '../api/wikipedia';
import { cachedGenres, cachedSource } from '../genre/resolver';
import { readSnapshot } from '../storage/librarySnapshot';
import { measureLibrarySignals } from './librarySignals';
import type { Track } from '../types';

const SAMPLE = 200;
const LB_SAMPLE = 60;
const LB_CONCURRENCY = 2;
const MAX_ISRCS = 400;
const NEIGHBOURS = 10;
const EXAMPLES = 8;

const pct = (n: number, d: number) => (d === 0 ? '—' : `${((n / d) * 100).toFixed(1)}%`);
const frac = (n: number, d: number) => `${n} / ${d} (${pct(n, d)})`;

export async function runGenreGapDiagnostic(
  tracks: Track[],
  genresByTrack: Map<string, string[]>,
  onStatus: (s: string) => void = () => {},
): Promise<string[]> {
  const lines: string[] = [];
  const t0 = Date.now();
  const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`;

  // -- 1. What is untagged ----------------------------------------------------
  const untaggedTracks = tracks.filter((t) => (genresByTrack.get(t.id) ?? []).length === 0);
  const artistById = new Map<string, string>();
  const tracksByArtist = new Map<string, Track[]>();
  for (const t of untaggedTracks) {
    for (const a of t.artists) {
      artistById.set(a.id, a.name);
      const list = tracksByArtist.get(a.id) ?? [];
      list.push(t);
      tracksByArtist.set(a.id, list);
    }
  }
  const untaggedArtists = [...artistById.keys()];
  const bySource: Record<string, number> = {};
  for (const id of untaggedArtists) {
    const s = cachedSource(id) ?? 'missing';
    bySource[s] = (bySource[s] ?? 0) + 1;
  }

  lines.push('== Untagged');
  lines.push(`tracks with no genres: ${frac(untaggedTracks.length, tracks.length)}`);
  lines.push(`artists on those tracks: ${untaggedArtists.length}`
    + ` — by cache source: ${Object.entries(bySource).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  if ((bySource.unresolved ?? 0) + (bySource.missing ?? 0) > 0) {
    lines.push('  note: unresolved/missing artists were never asked MusicBrainz — run a deep resolve,'
      + ' then re-run this, before trusting the buckets below.');
  }
  if (untaggedArtists.length === 0) return lines;

  // -- Option 1 first: network-free, so it prints even if MB/LB fail below ----
  const snap = readSnapshot();
  const playlistNames = new Map((snap?.playlists ?? []).map((p) => [p.id, p.name]));
  lines.push(...measureLibrarySignals({
    tracks,
    untaggedTracks,
    items: snap?.items ?? {},
    playlistName: (id) => playlistNames.get(id) ?? id,
    lenderGenres: (id) => (cachedSource(id) === 'neighbours' ? undefined : cachedGenres(id)),
    artistName: (id) => artistById.get(id) ?? snap?.artistNames[id] ?? id,
  }));

  // Spotify ids are random base62, so sorting by id is an unbiased sample
  // that is also stable between runs.
  const sample = untaggedArtists.sort().slice(0, SAMPLE).map((id) => ({ id, name: artistById.get(id)! }));
  const name = (id: string) => artistById.get(id) ?? id;

  // -- 2. Why: MBIDs and MB artist tags ----------------------------------------
  onStatus(`Wikidata join for ${sample.length} sampled artists…`);
  const wdMbids = new Map<string, string>();
  await wikiLookupGenresBulk(sample, undefined, undefined, { nameSearch: false, infobox: false, mbidsOut: wdMbids });
  const onWikidata = sample.filter((a) => cachedWikidataEntry(a.id) !== undefined).length;

  onStatus(`MusicBrainz /url mapping… (${elapsed()})`);
  const urlMbids = await mapSpotifyArtistsToMbids(sample.filter((a) => !wdMbids.has(a.id)).map((a) => a.id));
  const mbidOf = new Map<string, string>([...wdMbids, ...urlMbids]);

  onStatus(`MusicBrainz artist tags… (${elapsed()})`);
  const tags = await artistTagSummaries([...mbidOf.values()]);

  const noMbid: string[] = [];
  const tagged: string[] = [];
  const whitelistDropped: string[] = [];
  const noTags: string[] = [];
  const mbidUnknown: string[] = [];
  for (const a of sample) {
    const mbid = mbidOf.get(a.id);
    if (!mbid) { noMbid.push(a.id); continue; }
    const s: MbTagSummary | undefined = tags.get(mbid);
    if (!s) mbidUnknown.push(a.id);
    else if (s.genres.length > 0) tagged.push(a.id);
    else if (s.rawTags.length > 0) whitelistDropped.push(a.id);
    else noTags.push(a.id);
  }

  lines.push('', `== Why (sample of ${sample.length} untagged artists, ${elapsed()})`);
  lines.push(`on Wikidata at all: ${frac(onWikidata, sample.length)}`);
  lines.push(`MBID from Wikidata P434: ${wdMbids.size}, from MB /url: ${urlMbids.size}`);
  lines.push(`no MBID anywhere:            ${frac(noMbid.length, sample.length)}`);
  lines.push(`MBID, MB has no tags:        ${frac(noTags.length, sample.length)}`);
  lines.push(`MBID, tags all non-genre:    ${frac(whitelistDropped.length, sample.length)}`);
  lines.push(`MBID, MB HAS genres (stale): ${frac(tagged.length, sample.length)}`);
  if (mbidUnknown.length > 0) lines.push(`MBID not found by arid: search (merged/failed): ${mbidUnknown.length}`);
  for (const id of whitelistDropped.slice(0, EXAMPLES)) {
    lines.push(`  dropped: ${name(id)} → ${tags.get(mbidOf.get(id)!)!.rawTags.join(', ')}`);
  }
  for (const id of tagged.slice(0, 3)) {
    lines.push(`  stale: ${name(id)} → ${tags.get(mbidOf.get(id)!)!.genres.join(', ')}`);
  }

  // -- 3a. Option 2 (ListenBrainz) fetches run alongside 3b's MB queue ---------
  // Different hosts, independent limits; only the neighbours' tag lookup has
  // to wait for MB.
  const lbTargets = sample.filter((a) => mbidOf.has(a.id) && !tagged.includes(a.id)).slice(0, LB_SAMPLE);
  const neighboursOf = new Map<string, SimilarArtist[]>();
  const lbErrors = new Map<string, number>();
  let firstLbError = '';
  const lbFetch = async () => {
    const queue = lbTargets[Symbol.iterator]();
    const worker = async () => {
      for (let n = queue.next(); !n.done; n = queue.next()) {
        try {
          neighboursOf.set(n.value.id, await similarArtists(mbidOf.get(n.value.id)!));
        } catch (e) {
          const key = e instanceof ListenBrainzError ? String(e.status) : 'network/CORS';
          lbErrors.set(key, (lbErrors.get(key) ?? 0) + 1);
          firstLbError ||= (e as Error).message;
        }
      }
    };
    await Promise.all(Array.from({ length: LB_CONCURRENCY }, worker));
  };

  // -- 3b. Option 3 (ISRC → recording + release-group tags) --------------------
  const isrcFetch = async () => {
    const isrcs = [...new Set(sample.flatMap((a) => (tracksByArtist.get(a.id) ?? []).flatMap((t) => t.isrc ?? [])))]
      .slice(0, MAX_ISRCS);
    onStatus(`MusicBrainz ISRC lookup, ${isrcs.length} ISRCs… (${elapsed()})`);
    const isrc = await lookupIsrcs(isrcs);
    const rgids = [...isrc.byIsrc.values()].flat().flatMap((r) => r.releaseGroupIds);
    onStatus(`MusicBrainz release-group tags, ${new Set(rgids).size} albums… (${elapsed()})`);
    const { byId: rgGenres } = await releaseGroupGenres(rgids);
    return { isrcs, isrc, rgGenres };
  };

  const [{ isrcs, isrc, rgGenres }] = await Promise.all([isrcFetch(), lbFetch()]);

  let recTagged = 0;
  let rgTagged = 0;
  const viaIsrc = new Map<string, Set<string>>();
  const recoveredMbid = new Map<string, string>();
  for (const a of sample) {
    const got = new Set<string>();
    for (const t of tracksByArtist.get(a.id) ?? []) {
      const recs = t.isrc ? isrc.byIsrc.get(t.isrc.toUpperCase()) ?? [] : [];
      for (const r of recs) {
        r.genres.forEach((g) => got.add(g));
        for (const rg of r.releaseGroupIds) rgGenres.get(rg)?.forEach((g) => got.add(g));
        // Only a solo credit maps unambiguously back to this Spotify artist.
        if (!mbidOf.has(a.id) && t.artists.length === 1 && r.artistMbids.length === 1) {
          recoveredMbid.set(a.id, r.artistMbids[0]);
        }
      }
    }
    if (got.size > 0) viaIsrc.set(a.id, got);
  }
  for (const recs of isrc.byIsrc.values()) {
    if (recs.some((r) => r.genres.length > 0)) recTagged += 1;
    if (recs.some((r) => r.releaseGroupIds.some((rg) => (rgGenres.get(rg) ?? []).length > 0))) rgTagged += 1;
  }

  const isrcGain = sample.filter((a) => !tagged.includes(a.id) && viaIsrc.has(a.id));
  lines.push('', `== Option 3: MB recordings/albums by ISRC (${elapsed()})`);
  lines.push(`ISRCs found in MB: ${frac(isrc.byIsrc.size, isrcs.length)}`
    + (isrc.unattributed > 0 ? `  (WARNING: ${isrc.unattributed} recordings came back without isrcs[] — shape assumption wrong)` : ''));
  lines.push(`  …with recording-level genres: ${recTagged}, with album-level genres: ${rgTagged}`);
  lines.push(`artists that would gain genres: ${frac(isrcGain.length, sample.length - tagged.length)}`);
  lines.push(`  of those with no MBID before: ${isrcGain.filter((a) => noMbid.includes(a.id)).length}`);
  lines.push(`MBIDs recovered from recording credits (no-MBID artists): ${frac(recoveredMbid.size, noMbid.length)}`);
  for (const a of isrcGain.slice(0, EXAMPLES)) {
    lines.push(`  ${a.name} → ${[...viaIsrc.get(a.id)!].slice(0, 5).join(', ')}`);
  }

  // -- 3c. Option 2 scoring: neighbour genres need MB tags ---------------------
  const neighbourMbids = [...new Set([...neighboursOf.values()].flatMap((ns) => ns.slice(0, NEIGHBOURS).map((n) => n.mbid)))];
  onStatus(`MusicBrainz tags for ${neighbourMbids.length} ListenBrainz neighbours… (${elapsed()})`);
  const neighbourTags = await artistTagSummaries(neighbourMbids);
  const viaLb = new Map<string, string[]>();
  for (const [id, ns] of neighboursOf) {
    const genres = genresFromNeighbours(ns, (m) => neighbourTags.get(m)?.genres, { topN: NEIGHBOURS });
    if (genres.length > 0) viaLb.set(id, genres);
  }
  const withNeighbours = [...neighboursOf.values()].filter((ns) => ns.length > 0).length;

  lines.push('', `== Option 2: ListenBrainz similar artists (${elapsed()})`);
  lines.push(`queried: ${lbTargets.length} untagged artists with an MBID`
    + ` (no-MBID artists can't be asked — ${noMbid.length} in sample)`);
  if (lbErrors.size > 0) {
    lines.push(`errors: ${[...lbErrors].map(([k, v]) => `${k}×${v}`).join(', ')} — first: ${firstLbError}`);
  }
  lines.push(`had any neighbours: ${frac(withNeighbours, lbTargets.length)}`);
  lines.push(`would gain genres (≥2 of top ${NEIGHBOURS} agree): ${frac(viaLb.size, lbTargets.length)}`);
  for (const [id, g] of [...viaLb].slice(0, EXAMPLES)) {
    const ns = neighboursOf.get(id)!.slice(0, 3).map((n) => n.name).join(', ');
    lines.push(`  ${name(id)} → ${g.join(', ')}   (like: ${ns})`);
  }

  // -- Summary -----------------------------------------------------------------
  const lbRate = lbTargets.length ? viaLb.size / lbTargets.length : 0;
  const eligibleForLb = sample.filter((a) => mbidOf.has(a.id) && !tagged.includes(a.id)).length;
  const lbProjected = Math.round(lbRate * eligibleForLb);
  const both = isrcGain.filter((a) => viaLb.has(a.id)).length;
  lines.push('', `== Summary (sample ${sample.length}, ${elapsed()} total)`);
  lines.push(`option 3 (ISRC) rescues ${isrcGain.length} artists; option 2 (LB) projects ~${lbProjected}`
    + ` (measured ${viaLb.size} of ${lbTargets.length} queried); overlap among queried: ${both}`);
  lines.push(`scale to library: ×${(untaggedArtists.length / sample.length).toFixed(1)}`);
  return lines;
}
