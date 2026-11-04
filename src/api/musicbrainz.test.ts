import { afterEach, expect, it, vi } from 'vitest';

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
  urlLookup?: (resources: string[]) => object | Response;
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
      const body = opts.urlLookup ? opts.urlLookup(resources) : { urls: [] };
      return body instanceof Response ? body : json(body);
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

// -- lookupGenresBulk -------------------------------------------------------

it('chunks the url-lookup at 50 resources and maps each resource back to its Spotify id', async () => {
  const { lookupGenresBulk } = await freshMb();
  const artists = Array.from({ length: 51 }, (_, i) => artist(`Bulk${i}`));
  const spy = mockMb({
    // MB only wraps results in `urls` for 2+ resources; a lone 51st artist
    // gets the bare `{ relations }` shape (same as the single-artist lookup).
    urlLookup: (resources) => (resources.length === 1
      ? { relations: [{ artist: { id: `mbid-${resources[0].split('/').pop()}` } }] }
      : {
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
    // A single-resource url-lookup gets the bare `{ relations }` shape, no `urls` wrapper.
    urlLookup: () => ({ relations: [{ artist: { id: 'mbid-1' } }] }),
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
    // A single-resource url-lookup gets the bare `{ relations }` shape, no `urls` wrapper.
    urlLookup: () => ({ relations: [{ artist: { id: 'mbid-1' } }] }),
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

it('never name-searches: a URL-lookup miss settles as [] for the caller to search later', async () => {
  const { lookupGenresBulk } = await freshMb();
  const nameSearch = vi.fn((name: string) => ({ artists: [{ id: `mbid-${name}`, score: 95 }] }));
  mockMb({
    urlLookup: (resources) => ({
      urls: resources
        .filter((r) => r.endsWith('sp-Known'))
        .map((r) => ({ resource: r, relations: [{ artist: { id: 'mbid-known' } }] })),
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

  expect(nameSearch).not.toHaveBeenCalled();          // the 1.1s-per-artist tail lives in enrich.ts now
  expect(result.get('sp-Known')).toEqual(['rock']);
  expect(result.get('sp-Unknown')).toEqual([]);
});

it('settles mapped artists\' tags before any later phase — unmapped ones never hold them up', async () => {
  const { lookupGenresBulk } = await freshMb();
  mockMb({
    urlLookup: (resources) => ({
      urls: resources
        .filter((r) => r.endsWith('sp-Known'))
        .map((r) => ({ resource: r, relations: [{ artist: { id: 'mbid-known' } }] })),
    }),
    genreAll: 'rock',
    aridSearch: (mbids) => ({ artists: mbids.map((id) => ({ id, tags: [{ name: 'Rock', count: 3 }] })) }),
  });
  const spy = vi.mocked(globalThis.fetch);
  const onResult = vi.fn();

  vi.useFakeTimers();
  const resultPromise = lookupGenresBulk([artist('Known'), ...Array.from({ length: 5 }, (_, i) => artist(`U${i}`))], undefined, onResult);
  await vi.runAllTimersAsync();
  await resultPromise;
  vi.useRealTimers();

  // /url, /genre/all, arid: — three requests whatever the number of misses.
  expect(spy.mock.calls).toHaveLength(3);
  expect(onResult).toHaveBeenCalledWith('sp-Known', ['rock']);
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

  const onResult = vi.fn();

  vi.useFakeTimers();
  const resultPromise = lookupGenresBulk(artists, undefined, onResult);
  await vi.runAllTimersAsync();
  const result = await resultPromise;
  vi.useRealTimers();

  // Failed chunk's artists are omitted entirely — not cached as permanent 'none'.
  expect(result.has(artists[0].id)).toBe(false);
  expect(result.has(artists[49].id)).toBe(false);
  expect(result.get(artists[50].id)).toEqual(['rock']);
  expect(result.get(artists[59].id)).toEqual(['rock']);
  // Failed chunk's artists still get an onResult call — with the [] they landed with.
  expect(onResult).toHaveBeenCalledWith(artists[0].id, []);
  expect(onResult).toHaveBeenCalledWith(artists[49].id, []);
  expect(onResult).toHaveBeenCalledWith(artists[50].id, ['rock']);
  expect(onResult).toHaveBeenCalledWith(artists[59].id, ['rock']);
  expect(onResult).toHaveBeenCalledTimes(60); // every artist reported exactly once
});

it('searchArtistMbid accepts only a confident match and throws on a request failure', async () => {
  const { searchArtistMbid } = await freshMb();
  const spy = vi.spyOn(globalThis, 'fetch');
  spy.mockResolvedValueOnce(json({ artists: [{ id: 'mbid-hi', score: 95 }] }));
  spy.mockResolvedValueOnce(json({ artists: [{ id: 'mbid-lo', score: 80 }] }));
  spy.mockResolvedValueOnce(new Response('', { status: 500 }));

  expect(await runQueued(searchArtistMbid('Hi'))).toBe('mbid-hi');
  expect(await runQueued(searchArtistMbid('Lo'))).toBeNull();
  // An errored search is not "no confident match" — the caller must not
  // treat it as durable.
  const boom = searchArtistMbid('Boom');
  const settled = boom.then(() => 'resolved', (e: Error) => e.message);
  expect(await runQueued(settled)).toContain('500');
});

it('invokes onResult per artist as each arid-search chunk lands, not only after the whole bulk call returns', async () => {
  const { lookupGenresBulk } = await freshMb();
  const artists = Array.from({ length: 60 }, (_, i) => artist(`Chunk${i}`));
  const spy = mockMb({
    urlLookup: (resources) => ({
      urls: resources.map((r) => ({ resource: r, relations: [{ artist: { id: `mbid-${r.split('/').pop()}` } }] })),
    }),
    genreAll: 'rock',
    aridSearch: (mbids) => ({ artists: mbids.map((id) => ({ id, tags: [{ name: 'Rock', count: 4 }] })) }),
  });
  const fetchCountAtCall: number[] = [];
  const onResult = vi.fn(() => fetchCountAtCall.push(spy.mock.calls.length));

  vi.useFakeTimers();
  const resultPromise = lookupGenresBulk(artists, undefined, onResult);
  await vi.runAllTimersAsync();
  await resultPromise;
  vi.useRealTimers();

  expect(onResult).toHaveBeenCalledTimes(60); // every artist reported exactly once
  const totalFetches = spy.mock.calls.length; // 2 url chunks + 2 arid chunks (50 + 10)
  // The first arid chunk's 50 onResult calls must land while the second arid
  // chunk's request hasn't gone out yet — i.e. genuinely per-chunk, not batched
  // until the very end of the bulk call.
  expect(Math.min(...fetchCountAtCall)).toBeLessThan(totalFetches);
});

it('includes every input id in the result, even when MB has no record of the artist', async () => {
  const { lookupGenresBulk } = await freshMb();
  mockMb({
    urlLookup: () => ({ urls: [] }),
  });
  const onResult = vi.fn();

  vi.useFakeTimers();
  const resultPromise = lookupGenresBulk([artist('Ghost1'), artist('Ghost2')], undefined, onResult);
  await vi.runAllTimersAsync();
  const result = await resultPromise;
  vi.useRealTimers();

  expect([...result.keys()]).toEqual(['sp-Ghost1', 'sp-Ghost2']);
  expect(result.get('sp-Ghost1')).toEqual([]);
  expect(result.get('sp-Ghost2')).toEqual([]);
  // URL-lookup misses report their [] result right after mapping, not at the end.
  expect(onResult).toHaveBeenCalledWith('sp-Ghost1', []);
  expect(onResult).toHaveBeenCalledWith('sp-Ghost2', []);
});

it('fires onPhase mapping, then fetching', async () => {
  const { lookupGenresBulk } = await freshMb();
  mockMb({
    urlLookup: (resources) => ({ urls: resources.map((r) => ({ resource: r, relations: [{ artist: { id: 'mbid-known' } }] })) }),
    genreAll: 'rock',
    aridSearch: (mbids) => ({ artists: mbids.map((id) => ({ id, tags: [{ name: 'Rock', count: 3 }] })) }),
  });
  const phases: string[] = [];

  vi.useFakeTimers();
  const resultPromise = lookupGenresBulk([artist('Known')], undefined, undefined, { onPhase: (p) => phases.push(p) });
  await vi.runAllTimersAsync();
  await resultPromise;
  vi.useRealTimers();

  expect(phases).toEqual(['mapping', 'fetching']);
});

it('reports progress for both URL-lookup misses and genre-chunk landings', async () => {
  const { lookupGenresBulk } = await freshMb();
  mockMb({
    urlLookup: (resources) => ({
      urls: resources
        .filter((r) => r.endsWith('sp-Found'))
        .map((r) => ({ resource: r, relations: [{ artist: { id: 'mbid-found' } }] })),
    }),
    genreAll: 'rock',
    aridSearch: (mbids) => ({ artists: mbids.map((id) => ({ id, tags: [{ name: 'Rock', count: 2 }] })) }),
  });
  const onProgress = vi.fn();

  vi.useFakeTimers();
  const resultPromise = lookupGenresBulk([artist('Found'), artist('Missing')], onProgress);
  await vi.runAllTimersAsync();
  await resultPromise;
  vi.useRealTimers();

  expect(onProgress).toHaveBeenCalledWith(1, 2); // "Missing" done via URL-lookup miss
  expect(onProgress).toHaveBeenCalledWith(2, 2); // "Found" done via genre chunk landing
});

// -- cachedGenreVocabulary ---------------------------------------------------

it('cachedGenreVocabulary reads the persisted whitelist synchronously, without fetching', async () => {
  const { cachedGenreVocabulary } = await freshMb();
  const spy = mockMb({ genreAll: 'trip hop\ndowntempo' });
  localStorage.setItem('tracktackle:mb-genres:v1', 'trip hop\ndowntempo');

  expect(cachedGenreVocabulary()).toEqual(new Set(['trip hop', 'downtempo']));
  expect(spy).not.toHaveBeenCalled();
});

it('cachedGenreVocabulary is empty before any MB lookup has ever populated it', async () => {
  const { cachedGenreVocabulary } = await freshMb();
  expect(cachedGenreVocabulary()).toEqual(new Set());
});

it('artists with a knownMbids entry skip /url mapping, going straight to arid:', async () => {
  const { lookupGenresBulk } = await freshMb();
  const spy = mockMb({
    urlLookup: (resources) => ({ relations: resources.length === 1 ? [{ artist: { id: 'mbid-mapped' } }] : [] }),
    genreAll: 'rock\njazz',
    aridSearch: (mbids) => ({
      artists: mbids.map((id) => ({ id, tags: [{ name: id === 'mbid-wd' ? 'Jazz' : 'Rock', count: 3 }] })),
    }),
  });

  vi.useFakeTimers();
  const resultPromise = lookupGenresBulk(
    [artist('FromWikidata'), artist('Other')], undefined, undefined,
    { knownMbids: new Map([['sp-FromWikidata', 'mbid-wd']]) },
  );
  await vi.runAllTimersAsync();
  const result = await resultPromise;
  vi.useRealTimers();

  expect(result.get('sp-FromWikidata')).toEqual(['jazz']);
  expect(result.get('sp-Other')).toEqual(['rock']);
  const urlCalls = spy.mock.calls.filter((c) => String(c[0]).includes('/url?'));
  expect(urlCalls).toHaveLength(1);
  expect(String(urlCalls[0][0])).not.toContain('FromWikidata');
});

// -- ISRC / release-group / tag-summary lookups ------------------------------

async function runQueued<T>(p: Promise<T>): Promise<T> {
  vi.useFakeTimers();
  try {
    await vi.runAllTimersAsync();
    return await p;
  } finally {
    vi.useRealTimers();
  }
}

it('lookupIsrcs attributes recordings to ISRCs and collects album ids and artist credits', async () => {
  const { lookupIsrcs } = await freshMb();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes('/genre/all')) return new Response('shoegaze', { status: 200 });
    expect(decodeURIComponent(url)).toContain('isrc:(GBAAA0000001 OR GBAAA0000002)');
    return json({
      recordings: [
        {
          id: 'rec-1', isrcs: ['GBAAA0000001'], tags: [{ name: 'Shoegaze', count: 2 }, { name: 'loud', count: 9 }],
          'artist-credit': [{ artist: { id: 'art-1' } }],
          releases: [{ 'release-group': { id: 'rg-1' } }, { 'release-group': { id: 'rg-1' } }],
        },
        { id: 'rec-x' }, // no isrcs[] in a multi-ISRC chunk: unattributable
      ],
    });
  });
  const res = await runQueued(lookupIsrcs(['gbaaa0000001', 'GBAAA0000002']));
  expect(res.byIsrc.get('GBAAA0000001')).toEqual([
    { recordingId: 'rec-1', genres: ['shoegaze'], releaseGroupIds: ['rg-1'], artistMbids: ['art-1'] },
  ]);
  expect(res.byIsrc.has('GBAAA0000002')).toBe(false);
  expect(res.unattributed).toBe(1);
});

it('releaseGroupGenres filters album tags through the whitelist and leaves failed chunks absent', async () => {
  const { releaseGroupGenres } = await freshMb();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes('/genre/all')) return new Response('city pop', { status: 200 });
    return json({ 'release-groups': [{ id: 'rg-1', tags: [{ name: 'City Pop', count: 1 }, { name: 'japan', count: 4 }] }] });
  });
  const res = await runQueued(releaseGroupGenres(['rg-1', 'rg-2']));
  expect(res.byId.get('rg-1')).toEqual(['city pop']);
  expect(res.byId.has('rg-2')).toBe(false); // answered, just not in MB
  expect(res.failed.size).toBe(0);
});

it('artistTagSummaries keeps raw tags so a whitelist drop is visible', async () => {
  const { artistTagSummaries } = await freshMb();
  mockMb({
    genreAll: 'rock',
    aridSearch: () => ({ artists: [{ id: 'm1', tags: [{ name: 'Seen Live', count: 3 }, { name: 'zero', count: 0 }] }] }),
  });
  const res = await runQueued(artistTagSummaries(['m1']));
  expect(res.get('m1')).toEqual({ rawTags: ['seen live'], genres: [] });
});
