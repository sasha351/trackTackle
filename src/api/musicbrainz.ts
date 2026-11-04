const MB = 'https://musicbrainz.org/ws/2';
// ponytail: no User-Agent header — it's a forbidden header, browsers drop it silently.
// Identifying the app to MusicBrainz needs a server-side proxy; without one we share the
// anonymous-browser rate-limit pool, so 503s are routine and we lean on the retry below.
const MIN_SPACING_MS = 1100;
const MAX_ATTEMPTS = 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let lastRequestAt = 0;
let queue: Promise<unknown> = Promise.resolve();

// Throttled (503) and rate-limited (429) responses carry a Retry-After in seconds.
const retryAfterMs = (res: Response, attempt: number) => {
  const header = Number(res.headers.get('Retry-After'));
  return Number.isFinite(header) && header > 0
    ? header * 1000
    : MIN_SPACING_MS * 2 ** attempt;
};

// Shared queue/retry runner — mbFetch (JSON) and mbFetchText (plain text, for
// the `fmt=txt` genre-whitelist endpoint) both go through this so batching
// never bypasses the rate limit.
function mbQueue<T>(path: string, parse: (res: Response) => Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      const wait = lastRequestAt + MIN_SPACING_MS - Date.now();
      if (wait > 0) await sleep(wait);
      lastRequestAt = Date.now();
      const res = await fetch(`${MB}${path}`);
      if (res.ok) return parse(res);
      const retryable = res.status === 503 || res.status === 429;
      if (!retryable || attempt >= MAX_ATTEMPTS - 1) {
        throw new Error(`MusicBrainz ${res.status} for ${path}`);
      }
      await sleep(retryAfterMs(res, attempt));
    }
  };
  const p = queue.then(run);
  queue = p.catch(() => {}); // one failure must not poison the queue
  return p;
}

function mbFetch<T>(path: string): Promise<T> {
  return mbQueue(path, (res) => res.json());
}

function mbFetchText(path: string): Promise<string> {
  return mbQueue(path, (res) => res.text());
}

/** One confident MBID for a name, or null. Serial on the 1.1 s queue and
 *  name-keyed (common names like "Bush" or "Low" can land on the wrong
 *  artist), so the resolver spends it last. Throws on a request failure —
 *  "search errored" is not the durable "no confident match". */
export async function searchArtistMbid(artistName: string): Promise<string | null> {
  const query = encodeURIComponent(`artist:"${artistName}"`);
  const search = await mbFetch<{ artists?: { id: string; score: number }[] }>(
    `/artist?query=${query}&fmt=json&limit=1`,
  );
  const top = search.artists?.[0];
  return top && top.score >= 90 ? top.id : null;
}

const GENRE_WHITELIST_KEY = 'tracktackle:mb-genres:v1';
let genreWhitelistCache: Set<string> | null = null;

// The bulk arid: search returns raw folksonomy tags ("seen live", "usa")
// alongside real genres — filter against MB's canonical genre list. An empty
// set (fetch failed, nothing cached yet) means "don't filter" rather than
// "reject everything".
export async function genreWhitelist(): Promise<Set<string>> {
  if (genreWhitelistCache) return genreWhitelistCache;
  const cached = localStorage.getItem(GENRE_WHITELIST_KEY);
  if (cached) {
    genreWhitelistCache = new Set(cached.split('\n').filter(Boolean));
    return genreWhitelistCache;
  }
  try {
    const text = await mbFetchText('/genre/all?fmt=txt');
    const genres = text.split('\n').map((g) => g.trim().toLowerCase()).filter(Boolean);
    localStorage.setItem(GENRE_WHITELIST_KEY, genres.join('\n'));
    genreWhitelistCache = new Set(genres);
    return genreWhitelistCache;
  } catch {
    return new Set(); // not cached — a later call can retry
  }
}

/** Synchronous read of whatever's already cached — never triggers a fetch.
 *  Empty until some MB lookup has run at least once this session or before. */
export function cachedGenreVocabulary(): Set<string> {
  if (genreWhitelistCache) return genreWhitelistCache;
  const cached = localStorage.getItem(GENRE_WHITELIST_KEY);
  if (!cached) return new Set();
  genreWhitelistCache = new Set(cached.split('\n').filter(Boolean));
  return genreWhitelistCache;
}

const BULK_CHUNK = 50;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const spotifyArtistUrl = (id: string) => `https://open.spotify.com/artist/${id}`;
// MB echoes back the resource URL verbatim — the Spotify id is its last path segment.
const spotifyIdFromResource = (resource: string) => resource.split('/').filter(Boolean).pop() ?? resource;

function tagsToGenres(tags: { name: string; count: number }[] | undefined, whitelist: Set<string>): string[] {
  return (tags ?? [])
    .filter((t) => t.count > 0 && (whitelist.size === 0 || whitelist.has(t.name.toLowerCase())))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map((t) => t.name.toLowerCase());
}

// Bulk Spotify-id -> genres lookup: the /url mapping and the arid: tag fetch,
// ~50 artists per request. Built from the two helpers below so there is one
// copy of each request shape.
//
// No name search in here, on purpose: it costs 1.1 s per artist on the serial
// MB queue, and it used to sit *between* mapping and the tag fetch — so every
// mapped artist's genres waited for every unmapped artist's search. The
// resolver now runs it last, in src/genre/enrich.ts, only for the artists the
// cheaper sources (ISRC album tags, Last.fm) could not answer.
export type MbPhase = 'mapping' | 'fetching';

export async function lookupGenresBulk(
  artists: { id: string; name: string }[],
  onProgress?: (done: number, total: number) => void,
  onResult?: (id: string, genres: string[]) => void,
  opts: {
    onPhase?: (phase: MbPhase) => void;
    /** Spotify id -> MBID already known from elsewhere (Wikidata P434). These
     *  artists skip the /url mapping and go straight to the arid: fetch. */
    knownMbids?: Map<string, string>;
    /** Filled with Spotify id -> MBID for every artist this run mapped, so a
     *  later phase (ISRC / ListenBrainz enrichment) needn't map them again. */
    mbidsOut?: Map<string, string>;
  } = {},
): Promise<Map<string, string[]>> {
  const { onPhase, knownMbids, mbidsOut } = opts;
  const total = artists.length;
  // [] = durable "MB has nothing" (no MBID via /url, or an MBID with no
  // whitelisted tags); an id ABSENT from the map = its tag chunk failed.
  const result = new Map<string, string[]>(artists.map((a) => [a.id, []]));
  if (total === 0) return result;

  let done = 0;
  const settle = (id: string) => {
    done += 1;
    onProgress?.(done, total);
    onResult?.(id, result.get(id) ?? []);
  };

  onPhase?.('mapping');
  const idToMbid = new Map<string, string>();
  for (const a of artists) {
    const known = knownMbids?.get(a.id);
    if (known) idToMbid.set(a.id, known);
  }
  const mapped = await mapSpotifyArtistsToMbids(artists.filter((a) => !idToMbid.has(a.id)).map((a) => a.id));
  for (const [id, mbid] of mapped) idToMbid.set(id, mbid);
  if (mbidsOut) for (const [id, mbid] of idToMbid) mbidsOut.set(id, mbid);
  // Unmapped artists are settled now with [] — the name search that might
  // still find them is the caller's call to make.
  for (const a of artists) if (!idToMbid.has(a.id)) settle(a.id);

  onPhase?.('fetching');
  const idsByMbid = new Map<string, string[]>();
  for (const [id, mbid] of idToMbid) idsByMbid.set(mbid, [...(idsByMbid.get(mbid) ?? []), id]);
  const failed = new Set<string>();
  await artistTagSummaries([...idsByMbid.keys()], {
    failed,
    // Settle per chunk as it lands, not after the whole call — a partial
    // enrichment flush upstream needs results mid-run.
    onChunk: (mbids, tags) => {
      for (const mbid of mbids) {
        for (const id of idsByMbid.get(mbid) ?? []) {
          if (failed.has(mbid)) result.delete(id);
          else result.set(id, tags.get(mbid)?.genres ?? []);
          settle(id);
        }
      }
    },
  });
  return result;
}

// -- Batched lookups ------------------------------------------------------------
// Shared by lookupGenresBulk, the enrichment phases (src/genre/enrich.ts) and
// the genre-gap diagnostic (src/dev/genreGaps.ts). Each goes through mbFetch,
// so all of them share the one 1.1 s queue above.

/** Spotify artist id -> MBID via the `/url?resource=` relation, 50 per
 *  request. An id absent from the map either has no Spotify URL relation in
 *  MB or sat in a chunk that failed — callers that need to tell the two apart
 *  must not treat absence as durable. */
export async function mapSpotifyArtistsToMbids(spotifyIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const group of chunk(spotifyIds, BULK_CHUNK)) {
    try {
      const params = group.map((id) => `resource=${encodeURIComponent(spotifyArtistUrl(id))}`).join('&');
      const res = await mbFetch<
        { urls?: { resource: string; relations?: { artist?: { id: string } }[] }[] }
        & { relations?: { artist?: { id: string } }[] }
      >(`/url?${params}&inc=artist-rels&fmt=json`);
      // MB only wraps results in `urls` when 2+ resources are requested — a
      // single-resource chunk gets the bare shape (no `urls`, no `resource`
      // echo to match against).
      if (group.length === 1) {
        const mbid = res.relations?.find((r) => r.artist)?.artist?.id;
        if (mbid) out.set(group[0], mbid);
      } else {
        for (const u of res.urls ?? []) {
          const mbid = u.relations?.find((r) => r.artist)?.artist?.id;
          if (mbid) out.set(spotifyIdFromResource(u.resource), mbid);
        }
      }
    } catch {
      // chunk failed — its ids stay absent
    }
  }
  return out;
}

export interface MbTagSummary {
  /** Folksonomy tags with count > 0, before the genre whitelist, top 5 by
   *  count — enough to see whether the whitelist is what dropped them. */
  rawTags: string[];
  /** Whitelisted genres, as tagsToGenres returns them. */
  genres: string[];
}

/** MBID -> tag summary via the batched `arid:` search. Keeps the raw-tag
 *  count, so a caller can tell "MB has no tags" from "MB has tags, but the
 *  whitelist dropped all of them". An MBID in a failed chunk is absent from
 *  the map and, when `failed` is passed, added to it; `onChunk` fires as each
 *  chunk lands (success or failure). */
export async function artistTagSummaries(
  mbids: string[],
  { failed, onChunk }: {
    failed?: Set<string>;
    onChunk?: (mbids: string[], tags: Map<string, MbTagSummary>) => void;
  } = {},
): Promise<Map<string, MbTagSummary>> {
  const out = new Map<string, MbTagSummary>();
  const unique = [...new Set(mbids)];
  if (unique.length === 0) return out;
  const whitelist = await genreWhitelist();
  for (const group of chunk(unique, BULK_CHUNK)) {
    try {
      const query = encodeURIComponent(`arid:(${group.join(' OR ')})`);
      const res = await mbFetch<{ artists?: { id: string; tags?: { name: string; count: number }[] }[] }>(
        `/artist?query=${query}&fmt=json&limit=${BULK_CHUNK}`,
      );
      for (const a of res.artists ?? []) {
        out.set(a.id, {
          rawTags: (a.tags ?? [])
            .filter((t) => t.count > 0)
            .sort((x, y) => y.count - x.count)
            .slice(0, 5)
            .map((t) => t.name.toLowerCase()),
          genres: tagsToGenres(a.tags, whitelist),
        });
      }
    } catch {
      // chunk failed — absent, so callers never read it as "MB has nothing"
      for (const m of group) failed?.add(m);
    }
    onChunk?.(group, out);
  }
  return out;
}

// Lucene ORs of ~13-char ISRCs. 25 per query keeps the URL short and, at
// limit=100, leaves room for an ISRC that maps to several MB recordings
// (remasters, the same take on a single and an album).
const ISRC_CHUNK = 25;

export interface IsrcRecording {
  recordingId: string;
  /** Whitelisted genres tagged on the recording itself (usually sparse). */
  genres: string[];
  releaseGroupIds: string[];
  /** Credited artists' MBIDs — recovers an MBID for an artist whose MB entry
   *  has no Spotify URL relation, which /url can never find. */
  artistMbids: string[];
}

export interface IsrcLookup {
  byIsrc: Map<string, IsrcRecording[]>;
  /** ISRCs whose chunk errored — unknown, not "MB has nothing". */
  failed: Set<string>;
  /** Recordings returned with no `isrcs` field in a multi-ISRC chunk — they
   *  can't be attributed. Non-zero means the search response shape is not
   *  what this code assumes; the diagnostic prints it so a real run says so. */
  unattributed: number;
}

/** ISRC -> MB recordings via the batched recording search. ISRCs are matched
 *  case-insensitively (MB stores them upper-case; Spotify mostly does too). */
export async function lookupIsrcs(isrcs: string[]): Promise<IsrcLookup> {
  const byIsrc = new Map<string, IsrcRecording[]>();
  const failed = new Set<string>();
  let unattributed = 0;
  const unique = [...new Set(isrcs.map((i) => i.toUpperCase()))];
  if (unique.length === 0) return { byIsrc, failed, unattributed };
  const whitelist = await genreWhitelist();
  for (const group of chunk(unique, ISRC_CHUNK)) {
    const wanted = new Set(group);
    try {
      const query = encodeURIComponent(`isrc:(${group.join(' OR ')})`);
      const res = await mbFetch<{
        recordings?: {
          id: string;
          isrcs?: string[];
          tags?: { name: string; count: number }[];
          'artist-credit'?: { artist?: { id: string } }[];
          releases?: { 'release-group'?: { id: string } }[];
        }[];
      }>(`/recording?query=${query}&fmt=json&limit=100`);
      for (const r of res.recordings ?? []) {
        const rec: IsrcRecording = {
          recordingId: r.id,
          genres: tagsToGenres(r.tags, whitelist),
          releaseGroupIds: [...new Set((r.releases ?? []).flatMap((rel) => rel['release-group']?.id ?? []))],
          artistMbids: [...new Set((r['artist-credit'] ?? []).flatMap((c) => c.artist?.id ?? []))],
        };
        const keys = r.isrcs
          ? r.isrcs.map((i) => i.toUpperCase()).filter((i) => wanted.has(i))
          : group.length === 1 ? group : [];
        if (keys.length === 0) unattributed += 1;
        for (const k of keys) {
          const list = byIsrc.get(k) ?? [];
          list.push(rec);
          byIsrc.set(k, list);
        }
      }
    } catch {
      // chunk failed — transient, not "MB has nothing"
      for (const i of group) failed.add(i);
    }
  }
  return { byIsrc, failed, unattributed };
}

/** Release-group MBID -> whitelisted genres via the batched `rgid:` search.
 *  Album-level tags are where MB taggers put most of their effort, so this is
 *  the dense half of the ISRC path. */
export async function releaseGroupGenres(
  rgids: string[],
): Promise<{ byId: Map<string, string[]>; failed: Set<string> }> {
  const out = new Map<string, string[]>();
  const failed = new Set<string>();
  const unique = [...new Set(rgids)];
  if (unique.length === 0) return { byId: out, failed };
  const whitelist = await genreWhitelist();
  for (const group of chunk(unique, BULK_CHUNK)) {
    try {
      const query = encodeURIComponent(`rgid:(${group.join(' OR ')})`);
      const res = await mbFetch<{ 'release-groups'?: { id: string; tags?: { name: string; count: number }[] }[] }>(
        `/release-group?query=${query}&fmt=json&limit=${BULK_CHUNK}`,
      );
      for (const rg of res['release-groups'] ?? []) out.set(rg.id, tagsToGenres(rg.tags, whitelist));
    } catch {
      for (const id of group) failed.add(id);
    }
  }
  return { byId: out, failed };
}
