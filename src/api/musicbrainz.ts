const MB = 'https://musicbrainz.org/ws/2';
const UA = 'spotifyKondo/0.1.0 (alexshikhanovich@gmail.com)';
const MIN_SPACING_MS = 1100;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let lastRequestAt = 0;
let queue: Promise<unknown> = Promise.resolve();

function mbFetch<T>(path: string): Promise<T> {
  const run = async (): Promise<T> => {
    const wait = lastRequestAt + MIN_SPACING_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    const res = await fetch(`${MB}${path}`, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`MusicBrainz ${res.status} for ${path}`);
    return res.json();
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
