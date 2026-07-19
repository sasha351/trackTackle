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

// MB stores Spotify artist pages as URL relations — an exact-ID lookup that is
// immune to transliterated names ("Bravo" on Spotify vs "Браво" on MB) and to
// homonym artists that wreck name search.
async function mbidFromSpotify(spotifyId: string): Promise<string | null> {
  try {
    const resource = encodeURIComponent(`https://open.spotify.com/artist/${spotifyId}`);
    const url = await mbFetch<{ relations?: { artist?: { id: string } }[] }>(
      `/url?resource=${resource}&inc=artist-rels&fmt=json`,
    );
    return url.relations?.find((r) => r.artist)?.artist?.id ?? null;
  } catch {
    return null; // 404: MB has no record of this Spotify link — fall back to name search
  }
}

async function mbidFromSearch(artistName: string): Promise<string | null> {
  const query = encodeURIComponent(`artist:"${artistName}"`);
  const search = await mbFetch<{ artists?: { id: string; score: number }[] }>(
    `/artist?query=${query}&fmt=json&limit=1`,
  );
  const top = search.artists?.[0];
  return top && top.score >= 90 ? top.id : null;
}

export async function lookupArtistGenres(artist: { id: string; name: string }): Promise<string[]> {
  const mbid = (await mbidFromSpotify(artist.id)) ?? (await mbidFromSearch(artist.name));
  if (!mbid) return [];
  const detail = await mbFetch<{ genres?: { name: string; count: number }[] }>(
    `/artist/${mbid}?inc=genres&fmt=json`,
  );
  return (detail.genres ?? [])
    .filter((g) => g.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map((g) => g.name.toLowerCase());
}
