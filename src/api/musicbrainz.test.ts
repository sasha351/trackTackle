import { afterEach, expect, it, vi } from 'vitest';
import { lookupArtistGenres } from './musicbrainz';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

const json = (body: object) => new Response(JSON.stringify(body), { status: 200 });
const notFound = () => new Response('', { status: 404 });
const artist = (name: string) => ({ id: `sp-${name}`, name });

// Fresh module instance per test so `genreWhitelist`'s module-level cache
// (and the request queue) never leaks between tests.
async function freshMb() {
  vi.resetModules();
  return import('./musicbrainz');
}

// Routes mocked fetch calls by endpoint shape instead of call order, so tests
// don't have to hardcode how many chunks a given input produces.
function mockMb(opts: {
  urlLookup?: (resources: string[]) => object;
  genreAll?: string; // omit to simulate the whitelist fetch failing (404)
  aridSearch?: (mbids: string[]) => object | Response;
  nameSearch?: (name: string) => object;
}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes('/genre/all')) {
      return opts.genreAll !== undefined ? new Response(opts.genreAll, { status: 200 }) : notFound();
    }
    if (url.includes('/url?')) {
      const resources = [...url.matchAll(/resource=([^&]+)/g)].map((m) => decodeURIComponent(m[1]));
      return json(opts.urlLookup ? opts.urlLookup(resources) : { urls: [] });
    }
    const queryMatch = url.match(/query=([^&]+)/);
    const query = queryMatch ? decodeURIComponent(queryMatch[1]) : '';
    const aridMatch = query.match(/^arid:\((.+)\)$/);
    if (aridMatch) {
      const mbids = aridMatch[1].split(' OR ');
      const body = opts.aridSearch ? opts.aridSearch(mbids) : { artists: [] };
      return body instanceof Response ? body : json(body);
    }
    const nameMatch = query.match(/^artist:"(.+)"$/);
    return json(opts.nameSearch ? opts.nameSearch(nameMatch?.[1] ?? '') : { artists: [] });
  });
}

it('resolves via the Spotify URL relation without touching name search', async () => {
  const spy = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(json({ relations: [{ artist: { id: 'mbid-bravo' } }] }))
    .mockResolvedValueOnce(json({ genres: [{ name: 'Rock', count: 7 }] }));
  // Transliterated Spotify name — name search would miss or mismatch this artist.
  const genres = await lookupArtistGenres(artist('Bravo'));
  expect(genres).toEqual(['rock']);
  expect(String(spy.mock.calls[0][0])).toContain('/ws/2/url?resource=');
  expect(String(spy.mock.calls[0][0])).toContain(encodeURIComponent('spotify.com/artist/sp-Bravo'));
  expect(String(spy.mock.calls[1][0])).toContain('/ws/2/artist/mbid-bravo?inc=genres');
});

it('falls back to name search when MB has no Spotify link, then fetches genres', async () => {
  const spy = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(notFound()) // url lookup: unknown resource
    .mockResolvedValueOnce(json({ artists: [{ id: 'mbid-1', score: 100 }] }))
    .mockResolvedValueOnce(json({
      genres: [
        { name: 'Downtempo', count: 5 },
        { name: 'trip hop', count: 9 },
        { name: 'zero votes', count: 0 },
      ],
    }));
  const genres = await lookupArtistGenres(artist('Portishead'));
  expect(genres).toEqual(['trip hop', 'downtempo']); // sorted by count, lowercased, count>0 only
  expect(String(spy.mock.calls[1][0])).toContain('/ws/2/artist?query=');
  expect(String(spy.mock.calls[2][0])).toContain('/ws/2/artist/mbid-1?inc=genres');
});

it('returns [] when the top search hit is not confident', async () => {
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(notFound())
    .mockResolvedValueOnce(json({ artists: [{ id: 'mbid-2', score: 60 }] }));
  expect(await lookupArtistGenres(artist('Some Obscure Name'))).toEqual([]);
});

it('retries a 503 after Retry-After, then succeeds', async () => {
  vi.useFakeTimers();
  const spy = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response('', { status: 503, headers: { 'Retry-After': '2' } }))
    .mockResolvedValueOnce(json({ relations: [{ artist: { id: 'mbid-3' } }] }))
    .mockResolvedValueOnce(json({ genres: [{ name: 'Jazz', count: 3 }] }));
  const genres = lookupArtistGenres(artist('Alice Coltrane'));
  await vi.runAllTimersAsync();
  await expect(genres).resolves.toEqual(['jazz']);
  expect(spy).toHaveBeenCalledTimes(3); // url lookup retried once, then genres
  vi.useRealTimers();
});

it('gives up on persistent 503 — url lookup exhausts, then search exhausts and throws', async () => {
  vi.useFakeTimers();
  const spy = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response('', { status: 503 }));
  const genres = lookupArtistGenres(artist('Anyone'));
  const assertion = expect(genres).rejects.toThrow('MusicBrainz 503');
  await vi.runAllTimersAsync();
  await assertion;
  expect(spy).toHaveBeenCalledTimes(6); // 3 attempts each for url lookup and search
  vi.useRealTimers();
});

it('spaces consecutive requests by at least 1.1s', async () => {
  vi.useFakeTimers();
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(json({})));
  const t0 = Date.now();
  let done1 = 0;
  let done2 = 0;
  lookupArtistGenres(artist('A')).then(() => { done1 = Date.now() - t0; });
  lookupArtistGenres(artist('B')).then(() => { done2 = Date.now() - t0; });
  await vi.runAllTimersAsync();
  expect(done2 - done1).toBeGreaterThanOrEqual(1100);
  vi.useRealTimers();
});

// -- lookupGenresBulk -------------------------------------------------------

it('chunks the url-lookup at 50 resources and maps each resource back to its Spotify id', async () => {
  const { lookupGenresBulk } = await freshMb();
  const artists = Array.from({ length: 51 }, (_, i) => artist(`Bulk${i}`));
  const spy = mockMb({
    urlLookup: (resources) => ({
      urls: resources.map((r) => ({
        resource: r,
        relations: [{ artist: { id: `mbid-${r.split('/').pop()}` } }],
      })),
    }),
    genreAll: 'rock\njazz',
    aridSearch: (mbids) => ({ artists: mbids.map((id) => ({ id, tags: [{ name: 'Rock', count: 5 }] })) }),
  });

  vi.useFakeTimers();
  const resultPromise = lookupGenresBulk(artists);
  await vi.runAllTimersAsync();
  const result = await resultPromise;
  vi.useRealTimers();

  const urlCalls = spy.mock.calls.filter((c) => String(c[0]).includes('/url?'));
  expect(urlCalls).toHaveLength(2); // 51 artists -> chunks of 50 + 1
  expect((String(urlCalls[0][0]).match(/resource=/g) ?? []).length).toBe(50);
  expect((String(urlCalls[1][0]).match(/resource=/g) ?? []).length).toBe(1);

  expect(result.size).toBe(51);
  expect(result.get(artists[0].id)).toEqual(['rock']);
  expect(result.get(artists[50].id)).toEqual(['rock']);
});

it('filters genre tags against the MusicBrainz whitelist, dropping folksonomy junk', async () => {
  const { lookupGenresBulk } = await freshMb();
  mockMb({
    urlLookup: () => ({
      urls: [{ resource: 'https://open.spotify.com/artist/sp-Portishead', relations: [{ artist: { id: 'mbid-1' } }] }],
    }),
    genreAll: 'trip hop\ndowntempo',
    aridSearch: () => ({
      artists: [{
        id: 'mbid-1',
        tags: [
          { name: 'Trip Hop', count: 9 },
          { name: 'seen live', count: 20 }, // high-count folksonomy junk, not a real genre
          { name: 'Downtempo', count: 5 },
        ],
      }],
    }),
  });

  vi.useFakeTimers();
  const resultPromise = lookupGenresBulk([artist('Portishead')]);
  await vi.runAllTimersAsync();
  const result = await resultPromise;
  vi.useRealTimers();

  expect(result.get('sp-Portishead')).toEqual(['trip hop', 'downtempo']);
});

it('passes tags through unfiltered when the genre whitelist is unavailable', async () => {
  const { lookupGenresBulk } = await freshMb();
  mockMb({
    urlLookup: () => ({
      urls: [{ resource: 'https://open.spotify.com/artist/sp-Portishead', relations: [{ artist: { id: 'mbid-1' } }] }],
    }),
    // genreAll omitted -> whitelist fetch 404s -> empty whitelist -> pass tags through
    aridSearch: () => ({
      artists: [{ id: 'mbid-1', tags: [{ name: 'Trip Hop', count: 9 }, { name: 'seen live', count: 20 }] }],
    }),
  });

  vi.useFakeTimers();
  const resultPromise = lookupGenresBulk([artist('Portishead')]);
  await vi.runAllTimersAsync();
  const result = await resultPromise;
  vi.useRealTimers();

  expect(result.get('sp-Portishead')).toEqual(['seen live', 'trip hop']); // sorted by count, unfiltered
});

it('falls back to name search only for artists the URL lookup missed', async () => {
  const { lookupGenresBulk } = await freshMb();
  const nameSearch = vi.fn((name: string) => ({ artists: [{ id: `mbid-${name}`, score: 95 }] }));
  mockMb({
    urlLookup: (resources) => ({
      urls: resources
        .filter((r) => r.endsWith('sp-Known'))
        .map((r) => ({ resource: r, relations: [{ artist: { id: 'mbid-known' } }] })),
      // sp-Unknown gets no entry at all -> a miss that must fall back to name search
    }),
    genreAll: 'rock',
    nameSearch,
    aridSearch: (mbids) => ({ artists: mbids.map((id) => ({ id, tags: [{ name: 'Rock', count: 3 }] })) }),
  });

  vi.useFakeTimers();
  const resultPromise = lookupGenresBulk([artist('Known'), artist('Unknown')]);
  await vi.runAllTimersAsync();
  const result = await resultPromise;
  vi.useRealTimers();

  expect(nameSearch).toHaveBeenCalledTimes(1);
  expect(nameSearch).toHaveBeenCalledWith('Unknown');
  expect(result.get('sp-Known')).toEqual(['rock']);
  expect(result.get('sp-Unknown')).toEqual(['rock']);
});

it('limits a chunk error to that chunk — other chunks still resolve', async () => {
  const { lookupGenresBulk } = await freshMb();
  const artists = Array.from({ length: 60 }, (_, i) => artist(`Err${i}`));
  mockMb({
    urlLookup: (resources) => ({
      urls: resources.map((r) => ({ resource: r, relations: [{ artist: { id: `mbid-${r.split('/').pop()}` } }] })),
    }),
    genreAll: 'rock',
    aridSearch: (mbids) => (mbids.length === 50
      ? new Response('', { status: 500 }) // first chunk (50 mbids) fails entirely
      : { artists: mbids.map((id) => ({ id, tags: [{ name: 'Rock', count: 4 }] })) }),
  });

  vi.useFakeTimers();
  const resultPromise = lookupGenresBulk(artists);
  await vi.runAllTimersAsync();
  const result = await resultPromise;
  vi.useRealTimers();

  expect(result.get(artists[0].id)).toEqual([]);
  expect(result.get(artists[49].id)).toEqual([]);
  expect(result.get(artists[50].id)).toEqual(['rock']);
  expect(result.get(artists[59].id)).toEqual(['rock']);
});

it('includes every input id in the result, even when MB has no record of the artist', async () => {
  const { lookupGenresBulk } = await freshMb();
  mockMb({
    urlLookup: () => ({ urls: [] }),
    nameSearch: () => ({ artists: [] }), // no confident match either
  });

  vi.useFakeTimers();
  const resultPromise = lookupGenresBulk([artist('Ghost1'), artist('Ghost2')]);
  await vi.runAllTimersAsync();
  const result = await resultPromise;
  vi.useRealTimers();

  expect([...result.keys()]).toEqual(['sp-Ghost1', 'sp-Ghost2']);
  expect(result.get('sp-Ghost1')).toEqual([]);
  expect(result.get('sp-Ghost2')).toEqual([]);
});

it('reports progress for both fallback misses and genre-chunk landings', async () => {
  const { lookupGenresBulk } = await freshMb();
  mockMb({
    urlLookup: (resources) => ({
      urls: resources
        .filter((r) => r.endsWith('sp-Found'))
        .map((r) => ({ resource: r, relations: [{ artist: { id: 'mbid-found' } }] })),
    }),
    genreAll: 'rock',
    nameSearch: () => ({ artists: [] }), // sp-Missing never resolves
    aridSearch: (mbids) => ({ artists: mbids.map((id) => ({ id, tags: [{ name: 'Rock', count: 2 }] })) }),
  });
  const onProgress = vi.fn();

  vi.useFakeTimers();
  const resultPromise = lookupGenresBulk([artist('Found'), artist('Missing')], onProgress);
  await vi.runAllTimersAsync();
  await resultPromise;
  vi.useRealTimers();

  expect(onProgress).toHaveBeenCalledWith(1, 2); // "Missing" done via fallback miss
  expect(onProgress).toHaveBeenCalledWith(2, 2); // "Found" done via genre chunk landing
});
