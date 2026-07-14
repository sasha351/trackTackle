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

function mbFetch<T>(path: string): Promise<T> {
  const run = async (): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      const wait = lastRequestAt + MIN_SPACING_MS - Date.now();
      if (wait > 0) await sleep(wait);
      lastRequestAt = Date.now();
      const res = await fetch(`${MB}${path}`);
      if (res.ok) return res.json();
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

export async function lookupArtistGenres(artistName: string): Promise<string[]> {
  const query = encodeURIComponent(`artist:"${artistName}"`);
  const search = await mbFetch<{ artists?: { id: string; score: number }[] }>(
    `/artist?query=${query}&fmt=json&limit=1`,
  );
  const top = search.artists?.[0];
  if (!top || top.score < 90) return [];
  const artist = await mbFetch<{ genres?: { name: string; count: number }[] }>(
    `/artist/${top.id}?inc=genres&fmt=json`,
  );
  return (artist.genres ?? [])
    .filter((g) => g.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map((g) => g.name.toLowerCase());
}
