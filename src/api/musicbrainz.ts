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

async function mbidFromSearch(artistName: string): Promise<string | null> {
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
async function genreWhitelist(): Promise<Set<string>> {
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

// Bulk Spotify-id -> genres lookup: batches the URL->MBID mapping and the
// genre fetch ~50 artists per request instead of 2-3 serial requests per
// artist. Rare URL-lookup misses still fall back to the per-artist name
// search (serial).
export type MbPhase = 'mapping' | 'searching' | 'fetching';

export async function lookupGenresBulk(
  artists: { id: string; name: string }[],
  onProgress?: (done: number, total: number) => void,
  onResult?: (id: string, genres: string[]) => void,
  opts: {
    nameSearch?: boolean;
    onPhase?: (phase: MbPhase, artistName?: string) => void;
    /** Spotify id -> MBID already known from elsewhere (Wikidata P434). These
     *  artists skip the /url mapping and the serial name search entirely —
     *  they go straight to the batched arid: fetch. */
    knownMbids?: Map<string, string>;
  } = {},
): Promise<Map<string, string[]>> {
  const { nameSearch = true, onPhase, knownMbids } = opts;
  const total = artists.length;
  const result = new Map<string, string[]>(artists.map((a) => [a.id, []]));
  if (total === 0) return result;

  let done = 0;
  const report = (n: number) => {
    done += n;
    onProgress?.(done, total);
  };

  onPhase?.('mapping');
  // 1. Bulk URL lookup: Spotify id -> MBID.
  const idToMbid = new Map<string, string>();
  for (const a of artists) {
    const known = knownMbids?.get(a.id);
    if (known) idToMbid.set(a.id, known);
  }
  for (const group of chunk(artists.filter((a) => !idToMbid.has(a.id)), BULK_CHUNK)) {
    try {
      const params = group.map((a) => `resource=${encodeURIComponent(spotifyArtistUrl(a.id))}`).join('&');
      // MB only wraps results in `urls` when 2+ resources are requested — a
      // single-resource chunk gets the bare shape `mbidFromSpotify` already
      // handles above (no `urls`, no `resource` echo to match against).
      const res = await mbFetch<
        { urls?: { resource: string; relations?: { artist?: { id: string } }[] }[] }
        & { relations?: { artist?: { id: string } }[] }
      >(`/url?${params}&inc=artist-rels&fmt=json`);
      if (group.length === 1) {
        const mbid = res.relations?.find((r) => r.artist)?.artist?.id;
        if (mbid) idToMbid.set(group[0].id, mbid);
      } else {
        for (const u of res.urls ?? []) {
          const mbid = u.relations?.find((r) => r.artist)?.artist?.id;
          if (mbid) idToMbid.set(spotifyIdFromResource(u.resource), mbid);
        }
      }
    } catch {
      // chunk failed — its artists have no MBID yet; name-search fallback below covers them
    }
  }

  // 2. Name-search fallback for URL-lookup misses (rare, serial, acceptable).
  for (const a of artists) {
    onPhase?.('searching', a.name);
    if (idToMbid.has(a.id)) continue;
    if (!nameSearch) {
      // Fast path: skip the ~1.1s serial name search and cache the [] result,
      // so warm reloads don't re-do this artist's batched URL lookup. A deep
      // resolve re-tries empty-genre artists by name (see resolveAllGenres).
      report(1);
      onResult?.(a.id, []);
      continue;
    }
    let mbid: string | null;
    try {
      mbid = await mbidFromSearch(a.name);
    } catch {
      // search itself errored (not just "no confident hit") — omit from the
      // map so resolveAllGenres doesn't cache this as a permanent 'none'.
      result.delete(a.id);
      report(1);
      onResult?.(a.id, []);
      continue;
    }
    if (mbid) {
      idToMbid.set(a.id, mbid);
    } else {
      report(1); // no MBID anywhere for this artist — permanently done with []
      onResult?.(a.id, []);
    }
  }

  // 3. Bulk genre fetch for everything with an MBID.
  onPhase?.('fetching');
  const resolved = artists.filter((a) => idToMbid.has(a.id));
  if (resolved.length === 0) return result;
  const whitelist = await genreWhitelist();

  for (const group of chunk(resolved, BULK_CHUNK)) {
    const mbidToIds = new Map<string, string[]>();
    for (const a of group) {
      const mbid = idToMbid.get(a.id)!;
      const ids = mbidToIds.get(mbid) ?? [];
      ids.push(a.id);
      mbidToIds.set(mbid, ids);
    }
    try {
      const query = encodeURIComponent(`arid:(${[...mbidToIds.keys()].join(' OR ')})`);
      const res = await mbFetch<{ artists?: { id: string; tags?: { name: string; count: number }[] }[] }>(
        `/artist?query=${query}&fmt=json&limit=${BULK_CHUNK}`,
      );
      for (const found of res.artists ?? []) {
        const ids = mbidToIds.get(found.id);
        if (!ids) continue;
        const genres = tagsToGenres(found.tags, whitelist);
        for (const id of ids) result.set(id, genres);
      }
    } catch {
      // chunk failed — omit its artists from the map so resolveAllGenres
      // doesn't cache them as permanent 'none'; other chunks still proceed.
      for (const a of group) result.delete(a.id);
    }
    // Fire per-artist as this chunk lands (success or failure) — a partial
    // enrichment flush upstream needs results before the whole bulk call returns.
    for (const a of group) onResult?.(a.id, result.get(a.id) ?? []);
    report(group.length);
  }

  return result;
}
