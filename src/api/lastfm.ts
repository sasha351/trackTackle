// Last.fm artist top tags: listener folksonomy, which reaches long-tail indie
// artists MusicBrainz editors never tag. Currently measured by the DEV
// genre-gap diagnostic only — not a resolver source yet, so it is not on the
// privacy page or in the CSP. Both must change before it ships.
//
// ponytail: the API key ships in the client bundle. Fine for read-only
// methods (Last.fm treats them as public); a write method would need a
// backend this app deliberately doesn't have.

const LASTFM = 'https://ws.audioscrobbler.com/2.0/';
// Last.fm asks for "not more than 5 requests per second" per IP; 250 ms keeps
// well under it without a retry ladder.
const SPACING_MS = 250;

export interface LastFmTag { name: string; count: number }
export interface LastFmTopTags {
  /** The artist Last.fm actually answered for — differs from the query when
   *  autocorrect or a name collision redirected it; that's the precision risk. */
  matchedName: string;
  by: 'mbid' | 'name';
  tags: LastFmTag[];
}

export class LastFmError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(`Last.fm ${status}: ${message.slice(0, 160)}`);
    this.status = status;
  }
}

// Error 6 = "artist not found"; anything else is a real failure.
const NOT_FOUND = 6;

let chain: Promise<unknown> = Promise.resolve();
let lastAt = 0;

export function resetLastFmForTests(): void {
  chain = Promise.resolve();
  lastAt = 0;
}

function spaced<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const wait = lastAt + SPACING_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastAt = Date.now();
    return fn();
  });
  chain = run.catch(() => {});
  return run;
}

async function query(params: Record<string, string>, apiKey: string): Promise<{ tags: LastFmTag[]; matchedName: string } | null> {
  const qs = new URLSearchParams({ method: 'artist.gettoptags', format: 'json', api_key: apiKey, ...params });
  return spaced(async () => {
    const res = await fetch(`${LASTFM}?${qs}`);
    const body = (await res.json().catch(() => ({}))) as {
      error?: number; message?: string;
      toptags?: { tag?: { name?: unknown; count?: unknown }[] | { name?: unknown; count?: unknown }; '@attr'?: { artist?: string } };
    };
    if (body.error === NOT_FOUND) return null;
    if (!res.ok || body.error) throw new LastFmError(body.error ?? res.status, body.message ?? res.statusText);
    // A single tag comes back as an object, not a one-element array.
    const raw = body.toptags?.tag;
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const tags = list
      .filter((t) => typeof t.name === 'string')
      .map((t) => ({ name: (t.name as string).trim().toLowerCase(), count: Number(t.count) || 0 }));
    return { tags, matchedName: body.toptags?.['@attr']?.artist ?? '' };
  });
}

/** Top tags by MBID first (unambiguous), falling back to the name — Last.fm's
 *  MBID index is patchy, and 40% of the artists this is for have no MBID.
 *  null = Last.fm has no such artist, or knows it but has no tags. */
export async function artistTopTags(
  artist: { name: string; mbid?: string },
  apiKey: string,
): Promise<LastFmTopTags | null> {
  if (artist.mbid) {
    const r = await query({ mbid: artist.mbid }, apiKey);
    if (r && r.tags.length > 0) return { ...r, by: 'mbid' };
  }
  const r = await query({ artist: artist.name, autocorrect: '1' }, apiKey);
  return r && r.tags.length > 0 ? { ...r, by: 'name' } : null;
}

/** Tags → genres: whitelisted (an empty whitelist means "don't filter", as in
 *  musicbrainz.ts), at least `minCount` of Last.fm's 0–100 relative weight,
 *  top `max`. */
export function genresFromLastFmTags(
  tags: LastFmTag[],
  whitelist: Set<string>,
  { minCount = 10, max = 3 } = {},
): string[] {
  return tags
    .filter((t) => t.count >= minCount && (whitelist.size === 0 || whitelist.has(t.name)))
    .sort((a, b) => b.count - a.count)
    .slice(0, max)
    .map((t) => t.name);
}
