// Challenger to musicbrainz.ts's MB fallback (see
// docs/superpowers/specs/2026-08-03-wikipedia-genre-resolver-design.md). Two
// independent Wikimedia services, joined the same way MB's `/url?resource=`
// join works: key off the Spotify artist id so we never have to disambiguate
// by name.
//
// 1. WDQS (Wikidata Query Service) — one SPARQL query maps every Spotify id
//    (property P1902) to its Wikidata entity, English Wikipedia article title,
//    and any P136 (genre) statements, in a single request for the whole batch.
// 2. Action API (en.wikipedia.org) — per-title lead-wikitext fetch
//    (`rvsection=0`) so the `{{Infobox musical artist}}` genre field can be
//    parsed for subgenre labels P136 rarely carries.
//
// ponytail: no User-Agent header here either — same forbidden-header wall
// musicbrainz.ts documents. Wikimedia's anonymous Action API traffic has no
// documented per-second cap (Finding 3 in the design doc), which is why this
// module runs a concurrency pool for the infobox phase instead of MB's single
// serial queue.

import { normalizeWikidataGenre } from '../genre/normalize';

const WD_SPARQL = 'https://query.wikidata.org/sparql';
const WP_API = 'https://en.wikipedia.org/w/api.php';

// Every Action API request needs `origin=*` in the query string (not a header)
// for anonymous cross-origin reads — omitting it turns into an opaque browser
// failure, not a diagnosable HTTP error. WDQS is exempt: it already sends
// `Access-Control-Allow-Origin: *` unconditionally.
const ORIGIN_PARAM = 'origin=*';

// Measured: 150-id chunks ran serially at ~4.4 s each (~110 s for 3685
// artists — docs/wikipedia-genre-benchmark.md). Query *evaluation* dominates,
// so smaller chunks cost proportionally less each and parallelise; WDQS allows
// up to 5 concurrent queries per IP, so 4 leaves headroom for a retry.
// ponytail: chunk/concurrency are reasoned, not yet re-measured — re-run the
// Settings join-hit probe and tune here if wall-clock disappoints.
const JOIN_CHUNK = 50;
const JOIN_CONCURRENCY = 4;
const INFOBOX_CONCURRENCY = 4; // Finding 3: no per-second cap to respect here, unlike MB's MIN_SPACING_MS

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// -- Title cache --------------------------------------------------------------
// Spotify id -> { enwiki title, P136 genres }, so a repeat deep run skips the
// WDQS join entirely (the join is one request for the whole library either
// way, but the cache also survives a page reload). Infobox genres are NOT
// cached here — the infobox phase re-fetches every time infobox is requested,
// since there's no separate freshness story for article prose yet.

// v2: genres are normalized (no " music" suffix) and entries carry the P434
// MBID. v1 entries had neither, so they're dropped rather than migrated — the
// join is cheap to redo and v1 is deleted on first load.
const TITLE_CACHE_KEY = 'tracktackle:wd-titles:v2';
const LEGACY_TITLE_CACHE_KEY = 'tracktackle:wd-titles:v1';

/** Any artist Wikidata has an entity for. `title` is absent when the entity
 *  has no enwiki sitelink — such an entry still carries P136/P434 data. */
interface TitleCacheEntry { title?: string; genres: string[]; mbid?: string }
type TitleCache = Record<string, TitleCacheEntry>;

let titleCacheMem: TitleCache | null = null;

function loadTitleCache(): TitleCache {
  if (titleCacheMem) return titleCacheMem;
  localStorage.removeItem(LEGACY_TITLE_CACHE_KEY);
  const raw = localStorage.getItem(TITLE_CACHE_KEY);
  titleCacheMem = raw ? (JSON.parse(raw) as TitleCache) : {};
  return titleCacheMem;
}

function persistTitleCache(cache: TitleCache): void {
  titleCacheMem = cache;
  localStorage.setItem(TITLE_CACHE_KEY, JSON.stringify(cache));
}

/** What the join last learned about an artist, if WDQS has ever answered for
 *  it. `undefined` means "no Wikidata entity known" — either it has none, or
 *  no join has covered it yet. Read-only; never triggers a fetch. */
export function cachedWikidataEntry(spotifyId: string): Readonly<TitleCacheEntry> | undefined {
  return loadTitleCache()[spotifyId];
}

export function resetWikipediaForTests(): void {
  titleCacheMem = null;
}

// -- WDQS join ------------------------------------------------------------

const escapeSparqlString = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

function buildSparqlQuery(ids: string[]): string {
  const values = ids.map((id) => `"${escapeSparqlString(id)}"`).join(' ');
  // P1902 = "Spotify artist ID", P136 = "genre", P434 = "MusicBrainz artist
  // ID". The OPTIONAL clauses mean an artist with a Wikidata entity but no
  // enwiki sitelink (or no P136 / P434 claims) still comes back with whichever
  // parts are available. P434 lets MusicBrainz skip its /url mapping and its
  // 1.1 s-per-artist name search for every join hit that has no P136 genre.
  return `SELECT ?spotifyId ?article ?genreLabel ?mbid WHERE {
  VALUES ?spotifyId { ${values} }
  ?artist wdt:P1902 ?spotifyId .
  OPTIONAL {
    ?article schema:about ?artist ;
             schema:isPartOf <https://en.wikipedia.org/> .
  }
  OPTIONAL {
    ?artist wdt:P136 ?genreItem .
    ?genreItem rdfs:label ?genreLabel .
    FILTER(lang(?genreLabel) = "en")
  }
  OPTIONAL { ?artist wdt:P434 ?mbid . }
}`;
}

// Article URLs use underscores for spaces (`/wiki/David_Bowie`) — the Action
// API's `titles=` param wants the human-readable form back.
function titleFromArticleUrl(url: string): string {
  const marker = '/wiki/';
  const idx = url.indexOf(marker);
  const raw = idx >= 0 ? url.slice(idx + marker.length) : url;
  return decodeURIComponent(raw).replace(/_/g, ' ');
}

interface JoinEntry { title?: string; genres: Set<string>; mbid?: string }

async function sparqlJoin(ids: string[]): Promise<Map<string, JoinEntry>> {
  const query = buildSparqlQuery(ids);
  // `format=json` as a query param (not an Accept header) — a custom header
  // here would add a CORS preflight for no benefit; WDQS already sends
  // Access-Control-Allow-Origin: * on the plain GET.
  const res = await fetch(`${WD_SPARQL}?query=${encodeURIComponent(query)}&format=json`);
  if (!res.ok) throw new Error(`WDQS ${res.status}`);
  const body = await res.json() as {
    results?: {
      bindings?: {
        spotifyId?: { value: string }; article?: { value: string };
        genreLabel?: { value: string }; mbid?: { value: string };
      }[];
    };
  };
  const out = new Map<string, JoinEntry>();
  for (const b of body.results?.bindings ?? []) {
    const id = b.spotifyId?.value;
    if (!id) continue;
    const entry = out.get(id) ?? { genres: new Set<string>() };
    if (b.article?.value && !entry.title) entry.title = titleFromArticleUrl(b.article.value);
    if (b.genreLabel?.value) {
      const g = normalizeWikidataGenre(b.genreLabel.value);
      if (g) entry.genres.add(g);
    }
    if (b.mbid?.value && !entry.mbid) entry.mbid = b.mbid.value;
    out.set(id, entry);
  }
  return out;
}

// -- Name search (opt-in fallback for join misses) -----------------------

async function wikiTitleFromSearch(name: string): Promise<string | null> {
  const url = `${WP_API}?action=query&list=search&srlimit=1&srsearch=${encodeURIComponent(name)}&format=json&${ORIGIN_PARAM}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Wikipedia search ${res.status}`);
  const body = await res.json() as { query?: { search?: { title: string }[] } };
  return body.query?.search?.[0]?.title ?? null;
}

// -- Infobox fetch ----------------------------------------------------------

async function fetchLeadWikitext(title: string): Promise<string | null> {
  // rvsection=0 gets only the lead section (where the infobox lives), ~2-8KB
  // instead of the 100-400KB a full major-artist article would cost.
  const url = `${WP_API}?action=query&prop=revisions&rvslots=main&rvprop=content&rvsection=0`
    + `&titles=${encodeURIComponent(title)}&format=json&${ORIGIN_PARAM}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Wikipedia ${res.status} for ${title}`);
  const body = await res.json() as {
    query?: {
      pages?: Record<string, {
        missing?: string;
        revisions?: { slots?: { main?: { '*'?: string; content?: string } } }[];
      }>;
    };
  };
  const page = Object.values(body.query?.pages ?? {})[0];
  if (!page || page.missing !== undefined) return null;
  const slot = page.revisions?.[0]?.slots?.main;
  // Different API response shapes use `*` (legacy) or `content` — accept either.
  return slot?.['*'] ?? slot?.content ?? null;
}

// -- Infobox wikitext parsing -------------------------------------------------
// Highest-risk code in this module — see Finding 4 in the design doc. A naive
// `/\|\s*genre\s*=([^|]*)/` breaks on `{{hlist|a|b}}`, whose internal pipes
// are not field separators. Every splitter here tracks `{{ }}` / `[[ ]]`
// depth instead of matching on characters alone.

// Splits `text` on `sep` only where brace/bracket depth is 0, so `{{...|...}}`
// and `[[...|...]]` survive intact as a single part. Depth is clamped at 0 —
// unbalanced input degrades to "everything after the last real close is one
// part" rather than throwing or going negative.
function splitTopLevel(text: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < text.length; i++) {
    if (text.startsWith('{{', i) || text.startsWith('[[', i)) {
      depth++;
      current += text.slice(i, i + 2);
      i++;
      continue;
    }
    if (text.startsWith('}}', i) || text.startsWith(']]', i)) {
      depth = Math.max(0, depth - 1);
      current += text.slice(i, i + 2);
      i++;
      continue;
    }
    if (text[i] === sep && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += text[i];
    }
  }
  parts.push(current);
  return parts;
}

// Finds the `{{...}}` block starting at `start`, tracking only brace depth
// (bracket links inside don't affect it). Returns null — never throws — if
// the braces never balance before the string ends.
function findBalancedBraces(text: string, start: number): string | null {
  let depth = 0;
  let i = start;
  while (i < text.length) {
    if (text.startsWith('{{', i)) {
      depth++;
      i += 2;
      continue;
    }
    if (text.startsWith('}}', i)) {
      depth--;
      i += 2;
      if (depth === 0) return text.slice(start, i);
      continue;
    }
    i++;
  }
  return null; // malformed wikitext — caller must not throw
}

function extractInfobox(wikitext: string): string | null {
  const m = /\{\{\s*infobox/i.exec(wikitext);
  if (!m) return null;
  return findBalancedBraces(wikitext, m.index);
}

function stripNoise(value: string): string {
  return value
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<ref[^>]*\/>/gi, '')
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '');
}

// [[Target|Display]] -> Display, [[Target]] -> Target.
function unwrapLinks(text: string): string {
  return text.replace(
    /\[\[([^[\]|]+)(?:\|([^[\]]+))?\]\]/g,
    (_match: string, target: string, display?: string) => display ?? target,
  );
}

// ponytail: one level of {{flatlist|...}} / {{hlist|...}} unwrapping — a list
// template nesting another template inside one of its items would not split
// correctly. Real `genre` fields don't do this; every shape in Finding 4 is
// one level deep.
function extractGenreItems(rawValue: string): string[] {
  const listMatch = /^\{\{\s*(?:flatlist|hlist)\b([\s\S]*)\}\}$/i.exec(rawValue);
  let chunks: string[];
  if (listMatch) {
    const body = listMatch[1].startsWith('|') ? listMatch[1].slice(1) : listMatch[1];
    chunks = splitTopLevel(body, '|'); // hlist items are pipe-separated; flatlist yields one bulleted blob
  } else {
    chunks = rawValue.split(','); // plain comma list, e.g. "[[Alternative rock]], [[grunge]]"
  }
  return chunks
    .flatMap((c) => c.split('\n')) // flatlist's blob is `\n`-separated `* [[X]]` lines
    .map((s) => s.replace(/^\s*\*+\s*/, '').trim()) // strip a leading list-marker bullet
    .filter(Boolean);
}

function normalizeGenreItems(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const cleaned = unwrapLinks(raw)
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
      .replace(/\s+music$/, ''); // "hip hop music" -> "hip hop"
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
}

/** Pure parser: lead wikitext -> normalized genre labels from the `genre =`
 *  infobox field. No infobox, no `genre` field, or unbalanced braces all
 *  return `[]` — this must never throw, since it runs on arbitrary fetched
 *  article text. Deliberately NOT filtered against MB's canonical genre list
 *  (Finding 5) — the infobox field is already curated by editors, not a tag
 *  cloud, and filtering it would throw away the specific subgenre labels that
 *  motivate this whole module. */
export function parseInfoboxGenres(wikitext: string): string[] {
  try {
    const block = extractInfobox(wikitext);
    if (!block) return [];
    const inner = block.slice(2, -2); // strip the outer {{ }} so field-splitting starts at depth 0
    const fields = splitTopLevel(inner, '|');
    for (const field of fields.slice(1)) { // fields[0] is the template name itself
      const eq = field.indexOf('=');
      if (eq < 0) continue;
      const key = field.slice(0, eq).trim().toLowerCase();
      if (key !== 'genre') continue;
      const rawValue = stripNoise(field.slice(eq + 1)).trim();
      return normalizeGenreItems(extractGenreItems(rawValue));
    }
    return [];
  } catch {
    return []; // malformed wikitext must never crash the caller
  }
}

// -- Bulk lookup --------------------------------------------------------------

export type WikiPhase = 'joining' | 'searching' | 'fetching';

// Signature-compatible with musicbrainz.ts's `lookupGenresBulk` so
// resolver.ts can swap providers behind one option, and the benchmark can
// drive both through the same code path.
//
// Absent vs empty follows MB's contract exactly: an id absent from the
// returned map is a transient failure (leave it uncached, retry later); an id
// mapped to `[]` is a durable "nothing there" (a real, answered query — cache
// it as `none`).
export async function lookupGenresBulk(
  artists: { id: string; name: string }[],
  onProgress?: (done: number, total: number) => void,
  onResult?: (id: string, genres: string[]) => void,
  opts: {
    nameSearch?: boolean;
    infobox?: boolean;
    onPhase?: (phase: WikiPhase, artistName?: string) => void;
    /** Filled with Spotify id -> MusicBrainz MBID (Wikidata P434) for every
     *  artist the join (or the cache) knows one for. resolver.ts hands these
     *  to MusicBrainz so it can skip URL mapping and name search. */
    mbidsOut?: Map<string, string>;
  } = {},
): Promise<Map<string, string[]>> {
  const { nameSearch = false, infobox = false, onPhase, mbidsOut } = opts;
  const total = artists.length;
  const result = new Map<string, string[]>();
  if (total === 0) return result;

  let done = 0;
  const report = () => {
    done += 1;
    onProgress?.(done, total);
  };
  // genres === undefined means "transient failure, don't cache" (omitted from
  // `result`) but a UI still gets an onResult call so it can render "no genre
  // yet" without that becoming a permanent answer — same as MB's name-search
  // failure path.
  const emit = (id: string, genres: string[] | undefined) => {
    if (genres !== undefined) result.set(id, genres);
    report();
    onResult?.(id, genres ?? []);
  };

  const cache = loadTitleCache();
  const idToTitle = new Map<string, string>();
  const idToGenres = new Map<string, Set<string>>();
  const needJoin: { id: string; name: string }[] = [];
  for (const a of artists) {
    const cached = cache[a.id];
    if (cached) {
      if (cached.title) idToTitle.set(a.id, cached.title);
      idToGenres.set(a.id, new Set(cached.genres));
      if (cached.mbid) mbidsOut?.set(a.id, cached.mbid);
    } else {
      needJoin.push(a);
    }
  }

  onPhase?.('joining');
  // Ids whose SPARQL chunk errored outright. WDQS never answered for these, so
  // they are NOT the same as "Wikidata has nothing" — without this set the fast
  // path below would emit `[]` for them, which resolver.ts caches as a durable
  // 'none'. One WDQS 503 would then permanently poison a whole library.
  const joinFailed = new Set<string>();
  // Ids WDQS answered with an entity for — the cache key set below.
  const joinedIds = new Set<string>();
  const joinMbids = new Map<string, string>();
  const groups = chunk(needJoin, JOIN_CHUNK)[Symbol.iterator]();
  const joinWorker = async () => {
    for (let next = groups.next(); !next.done; next = groups.next()) {
      const group = next.value;
      try {
        const joined = await sparqlJoin(group.map((a) => a.id));
        for (const [id, entry] of joined) {
          joinedIds.add(id);
          if (entry.title) idToTitle.set(id, entry.title);
          idToGenres.set(id, entry.genres);
          if (entry.mbid) {
            joinMbids.set(id, entry.mbid);
            mbidsOut?.set(id, entry.mbid);
          }
        }
      } catch {
        // whole chunk failed — its artists stay unknown here; the name-search
        // fallback (or the fast path) below still gets a chance at them
        for (const a of group) joinFailed.add(a.id);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(JOIN_CONCURRENCY, Math.ceil(needJoin.length / JOIN_CHUNK)) }, joinWorker),
  );

  // Persist every entity the join found (title or not) so a repeat deep run
  // skips the join for it. An artist with no entity at all isn't cached here —
  // resolver.ts caches the final answer for it anyway.
  let cacheDirty = false;
  for (const id of joinedIds) {
    cache[id] = {
      ...(idToTitle.has(id) ? { title: idToTitle.get(id) } : {}),
      genres: [...(idToGenres.get(id) ?? [])],
      ...(joinMbids.has(id) ? { mbid: joinMbids.get(id) } : {}),
    };
    cacheDirty = true;
  }
  if (cacheDirty) persistTitleCache(cache);

  // Name-search fallback (opt-in) + fast path for join misses. Artists with a
  // title (from cache, the join, or a successful search) that need the
  // infobox phase are queued into `forInfobox`; everything else is settled now.
  const forInfobox: { id: string; name: string }[] = [];
  for (const a of artists) {
    const known = idToGenres.get(a.id);
    if (idToTitle.has(a.id)) {
      if (infobox) forInfobox.push(a);
      else emit(a.id, [...(known ?? [])]);
      continue;
    }
    onPhase?.('searching', a.name);
    if (!nameSearch) {
      // Fast path: no join title, not searching — settle with whatever P136
      // already gave us (possibly none) rather than pay for a serial search.
      // Unless the join never ran for this artist: that is a transient failure,
      // and `undefined` keeps it out of the map so the next run retries it.
      emit(a.id, joinFailed.has(a.id) ? undefined : [...(known ?? [])]);
      continue;
    }
    let title: string | null;
    try {
      title = await wikiTitleFromSearch(a.name);
    } catch {
      emit(a.id, undefined); // search itself errored — transient, don't cache
      continue;
    }
    if (!title) {
      emit(a.id, [...(known ?? [])]); // confident: no Wikipedia article at all
      continue;
    }
    idToTitle.set(a.id, title);
    if (infobox) forInfobox.push(a);
    else emit(a.id, [...(known ?? [])]); // article exists but we were never asked to read it
  }

  // Infobox phase — concurrency-4 pool (Finding 3: no per-second cap to
  // respect here, unlike MB's serial queue). Infobox genres are unioned with
  // any P136 genres already known for that artist.
  if (forInfobox.length > 0) {
    onPhase?.('fetching');
    const iter = forInfobox[Symbol.iterator]();
    const worker = async () => {
      for (let next = iter.next(); !next.done; next = iter.next()) {
        const a = next.value;
        const title = idToTitle.get(a.id)!;
        const base = idToGenres.get(a.id) ?? new Set<string>();
        try {
          const wikitext = await fetchLeadWikitext(title);
          const infoboxGenres = wikitext ? parseInfoboxGenres(wikitext) : [];
          const merged = new Set(base);
          for (const g of infoboxGenres) merged.add(g);
          emit(a.id, [...merged]);
        } catch {
          // Fetch failed: keep whatever P136 already answered rather than
          // discarding a real (if coarser) answer; only omit when we truly
          // have nothing yet, so a retry can still complete the picture.
          if (base.size > 0) emit(a.id, [...base]);
          else emit(a.id, undefined);
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(INFOBOX_CONCURRENCY, forInfobox.length) }, worker),
    );
  }

  return result;
}
