// Wikidata join: one SPARQL query maps up to 50 Spotify artist ids (property
// P1902) to their P136 (genre) statements and P434 (MusicBrainz artist ID) —
// keyed on the Spotify id, like MB's `/url?resource=` lookup, so it never has
// to disambiguate by name. The first bulk step of a deep run (resolver.ts):
// P136 answers ~47% of a real library outright, and P434 lets MusicBrainz
// skip its /url mapping and serial name search for many of the rest.
//
// The name-search + Wikipedia-infobox challenger that used to live here was
// benchmarked and not adopted (docs/wikipedia-genre-benchmark.md); git
// history has it.
//
// ponytail: no User-Agent header — same forbidden-header wall musicbrainz.ts
// documents.

import { normalizeWikidataGenre } from '../genre/normalize';

const WD_SPARQL = 'https://query.wikidata.org/sparql';

// Measured: 150-id chunks ran serially at ~4.4 s each (~110 s for 3685
// artists — docs/wikipedia-genre-benchmark.md). Query *evaluation* dominates,
// so smaller chunks cost proportionally less each and parallelise; WDQS allows
// up to 5 concurrent queries per IP, so 4 leaves headroom for a retry.
// ponytail: chunk/concurrency are reasoned, not yet re-measured — re-run the
// Settings join-hit probe and tune here if wall-clock disappoints.
const JOIN_CHUNK = 50;
const JOIN_CONCURRENCY = 4;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// -- Join cache ---------------------------------------------------------------
// Spotify id -> { P136 genres, P434 MBID } for every artist WDQS has answered
// with an entity, so a repeat deep run (or a page reload) skips the join.
// The key still says "titles": entries written while the infobox path existed
// also carry a `title`, which is now ignored — renaming the key would only
// force every library to redo the join for no new data.
const JOIN_CACHE_KEY = 'tracktackle:wd-titles:v2';
// v1 held unnormalized genres and no MBIDs; deleted on first load.
const LEGACY_CACHE_KEY = 'tracktackle:wd-titles:v1';

interface JoinEntry { genres: string[]; mbid?: string }
type JoinCache = Record<string, JoinEntry>;

let cacheMem: JoinCache | null = null;

function loadCache(): JoinCache {
  if (cacheMem) return cacheMem;
  localStorage.removeItem(LEGACY_CACHE_KEY);
  const raw = localStorage.getItem(JOIN_CACHE_KEY);
  cacheMem = raw ? (JSON.parse(raw) as JoinCache) : {};
  return cacheMem;
}

/** What the join last learned about an artist, if WDQS has ever answered for
 *  it. `undefined` means "no Wikidata entity known" — either it has none, or
 *  no join has covered it yet. Read-only; never triggers a fetch. */
export function cachedWikidataEntry(spotifyId: string): Readonly<JoinEntry> | undefined {
  return loadCache()[spotifyId];
}

export function resetWikidataForTests(): void {
  cacheMem = null;
}

// -- WDQS join ------------------------------------------------------------

const escapeSparqlString = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

function buildSparqlQuery(ids: string[]): string {
  const values = ids.map((id) => `"${escapeSparqlString(id)}"`).join(' ');
  // P1902 = "Spotify artist ID", P136 = "genre", P434 = "MusicBrainz artist
  // ID". OPTIONAL so an entity with only one of the two still comes back.
  return `SELECT ?spotifyId ?genreLabel ?mbid WHERE {
  VALUES ?spotifyId { ${values} }
  ?artist wdt:P1902 ?spotifyId .
  OPTIONAL {
    ?artist wdt:P136 ?genreItem .
    ?genreItem rdfs:label ?genreLabel .
    FILTER(lang(?genreLabel) = "en")
  }
  OPTIONAL { ?artist wdt:P434 ?mbid . }
}`;
}

async function sparqlJoin(ids: string[]): Promise<Map<string, { genres: Set<string>; mbid?: string }>> {
  // `format=json` as a query param (not an Accept header) — a custom header
  // would add a CORS preflight for no benefit; WDQS already sends
  // Access-Control-Allow-Origin: * on the plain GET.
  const res = await fetch(`${WD_SPARQL}?query=${encodeURIComponent(buildSparqlQuery(ids))}&format=json`);
  if (!res.ok) throw new Error(`WDQS ${res.status}`);
  const body = await res.json() as {
    results?: { bindings?: { spotifyId?: { value: string }; genreLabel?: { value: string }; mbid?: { value: string } }[] };
  };
  const out = new Map<string, { genres: Set<string>; mbid?: string }>();
  for (const b of body.results?.bindings ?? []) {
    const id = b.spotifyId?.value;
    if (!id) continue;
    const entry = out.get(id) ?? { genres: new Set<string>() };
    if (b.genreLabel?.value) {
      const g = normalizeWikidataGenre(b.genreLabel.value);
      if (g) entry.genres.add(g);
    }
    if (b.mbid?.value && !entry.mbid) entry.mbid = b.mbid.value;
    out.set(id, entry);
  }
  return out;
}

/** Spotify id -> P136 genres for every id, from cache or the join. Same
 *  absent-vs-empty contract as musicbrainz.ts: `[]` is a real "Wikidata has
 *  no genre", an id ABSENT from the map sat in a chunk WDQS never answered
 *  (transient — must not become a durable 'none'). `mbidsOut` is filled with
 *  every P434 MBID known, cached or fresh. */
export async function joinWikidata(
  ids: string[],
  opts: { mbidsOut?: Map<string, string> } = {},
): Promise<Map<string, string[]>> {
  const { mbidsOut } = opts;
  const cache = loadCache();
  const result = new Map<string, string[]>();
  const needJoin: string[] = [];
  for (const id of ids) {
    const hit = cache[id];
    if (!hit) {
      needJoin.push(id);
      continue;
    }
    result.set(id, hit.genres);
    if (hit.mbid) mbidsOut?.set(id, hit.mbid);
  }

  const failed = new Set<string>();
  let dirty = false;
  const groups = chunk(needJoin, JOIN_CHUNK)[Symbol.iterator]();
  const worker = async () => {
    for (let next = groups.next(); !next.done; next = groups.next()) {
      const group = next.value;
      try {
        for (const [id, entry] of await sparqlJoin(group)) {
          cache[id] = { genres: [...entry.genres], ...(entry.mbid ? { mbid: entry.mbid } : {}) };
          dirty = true;
        }
      } catch {
        for (const id of group) failed.add(id);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(JOIN_CONCURRENCY, Math.ceil(needJoin.length / JOIN_CHUNK)) }, worker),
  );
  // An artist with no entity at all isn't cached here — resolver.ts caches
  // the final answer for it anyway.
  if (dirty) localStorage.setItem(JOIN_CACHE_KEY, JSON.stringify(cache));

  for (const id of needJoin) {
    if (failed.has(id)) continue;
    const entry = cache[id];
    result.set(id, entry?.genres ?? []);
    if (entry?.mbid) mbidsOut?.set(id, entry.mbid);
  }
  return result;
}
