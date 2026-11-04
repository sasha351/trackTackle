import { afterEach, beforeEach, expect, it, vi } from 'vitest';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

// Fresh module instance per test so the join cache's module-level variable
// never leaks between tests (mirrors musicbrainz.test.ts's freshMb helper).
async function freshWd() {
  vi.resetModules();
  const mod = await import('./wikidata');
  mod.resetWikidataForTests();
  return mod;
}

const json = (body: object) => new Response(JSON.stringify(body), { status: 200 });

function mockSparql(sparql: (ids: string[]) => object | Response) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (!url.includes('query.wikidata.org')) throw new Error(`unexpected fetch: ${url}`);
    const q = decodeURIComponent(url.match(/query=([^&]+)/)?.[1] ?? '');
    const body = sparql([...q.matchAll(/"([^"]+)"/g)].map((m) => m[1]));
    return body instanceof Response ? body : json(body);
  });
}

const bindings = (rows: { id: string; genre?: string; mbid?: string }[]) => ({
  results: {
    bindings: rows.map((r) => ({
      spotifyId: { value: r.id },
      ...(r.mbid ? { mbid: { value: r.mbid } } : {}),
      ...(r.genre ? { genreLabel: { value: r.genre } } : {}),
    })),
  },
});

const wdCalls = (spy: ReturnType<typeof mockSparql>) =>
  spy.mock.calls.filter((c) => String(c[0]).includes('query.wikidata.org')).length;

it('resolves P136 genres and maps an id with no entity to a durable []', async () => {
  const { joinWikidata } = await freshWd();
  mockSparql(() => bindings([{ id: 'sp-Radiohead', genre: 'alternative rock' }]));

  const result = await joinWikidata(['sp-Radiohead', 'sp-Ghost']);

  expect(result.get('sp-Radiohead')).toEqual(['alternative rock']);
  expect(result.get('sp-Ghost')).toEqual([]);
});

it('never asks for the enwiki article — only the infobox path needed it', async () => {
  const { joinWikidata } = await freshWd();
  const spy = mockSparql(() => bindings([]));
  await joinWikidata(['sp-A']);
  expect(decodeURIComponent(String(spy.mock.calls[0][0]))).not.toContain('schema:about');
});

it('omits a whole chunk from the map when the SPARQL request fails (transient, not a confident miss)', async () => {
  const { joinWikidata } = await freshWd();
  mockSparql(() => new Response('', { status: 500 }));

  const result = await joinWikidata(['sp-Alpha', 'sp-Beta']);

  // resolver.ts treats [] as durable; one WDQS 503 must not poison a chunk.
  expect(result.has('sp-Alpha')).toBe(false);
  expect(result.has('sp-Beta')).toBe(false);
});

it('caches every entity so a repeat call skips the WDQS request', async () => {
  const { joinWikidata } = await freshWd();
  const spy = mockSparql(() => bindings([{ id: 'sp-Cached', genre: 'rock' }]));

  await joinWikidata(['sp-Cached']);
  const again = await joinWikidata(['sp-Cached']);

  expect(wdCalls(spy)).toBe(1);
  expect(again.get('sp-Cached')).toEqual(['rock']);
});

it('strips the " music" suffix from P136 labels so they match MB/Spotify genres', async () => {
  const { joinWikidata } = await freshWd();
  mockSparql(() => bindings([
    { id: 'sp-A', genre: 'Hip hop music' },
    { id: 'sp-A', genre: 'hip hop' }, // dedupes after normalizing
    { id: 'sp-A', genre: 'trip hop' },
  ]));

  expect((await joinWikidata(['sp-A'])).get('sp-A')).toEqual(['hip hop', 'trip hop']);
});

it('reports P434 MBIDs through mbidsOut, including for entities with no P136, and from cache', async () => {
  const { joinWikidata } = await freshWd();
  const spy = mockSparql(() => bindings([{ id: 'sp-NoGenre', mbid: 'mbid-1' }]));

  const mbids = new Map<string, string>();
  expect((await joinWikidata(['sp-NoGenre'], { mbidsOut: mbids })).get('sp-NoGenre')).toEqual([]);
  expect(mbids.get('sp-NoGenre')).toBe('mbid-1');

  const again = new Map<string, string>();
  await joinWikidata(['sp-NoGenre'], { mbidsOut: again });
  expect(again.get('sp-NoGenre')).toBe('mbid-1');
  expect(wdCalls(spy)).toBe(1);
});

it('runs join chunks concurrently, under WDQS\'s 5-per-IP cap', async () => {
  const { joinWikidata } = await freshWd();
  let inFlight = 0;
  let peak = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    return json({ results: { bindings: [] } });
  });

  const result = await joinWikidata(Array.from({ length: 200 }, (_, i) => `n${i}`));

  expect(peak).toBeGreaterThan(1);
  expect(peak).toBeLessThanOrEqual(4);
  expect(result.size).toBe(200);
});

it('reads v2 entries written by the old infobox-era code (extra `title` ignored)', async () => {
  localStorage.setItem('tracktackle:wd-titles:v2', JSON.stringify({ 'sp-Old': { title: 'Old', genres: ['rock'], mbid: 'm' } }));
  const { joinWikidata } = await freshWd();
  const spy = mockSparql(() => bindings([]));
  const mbids = new Map<string, string>();

  expect((await joinWikidata(['sp-Old'], { mbidsOut: mbids })).get('sp-Old')).toEqual(['rock']);
  expect(mbids.get('sp-Old')).toBe('m');
  expect(wdCalls(spy)).toBe(0);
});

it('drops the v1 cache, whose genres were unnormalized and lacked MBIDs', async () => {
  localStorage.setItem('tracktackle:wd-titles:v1', JSON.stringify({ 'sp-Old': { title: 'Old', genres: ['rock music'] } }));
  const { joinWikidata } = await freshWd();
  mockSparql(() => bindings([{ id: 'sp-Old', genre: 'rock music' }]));

  expect((await joinWikidata(['sp-Old'])).get('sp-Old')).toEqual(['rock']);
  expect(localStorage.getItem('tracktackle:wd-titles:v1')).toBeNull();
});
