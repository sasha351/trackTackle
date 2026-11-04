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

it('skips name search for url-lookup misses when nameSearch is false, caching them as empty', async () => {
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
  const resultPromise = lookupGenresBulk([artist('Known'), artist('Unknown')], undefined, undefined, { nameSearch: false });
  await vi.runAllTimersAsync();
  const result = await resultPromise;
  vi.useRealTimers();

  expect(nameSearch).not.toHaveBeenCalled();          // the 1.1s tail is skipped
  expect(result.get('sp-Known')).toEqual(['rock']);   // url-lookup hits still resolve
  expect(result.get('sp-Unknown')).toEqual([]);       // cached as [] → warm reloads skip it; deep resolve retries
});

it('falls back to name search for every artist in a url-lookup chunk that 5xxs outright', async () => {
  const { lookupGenresBulk } = await freshMb();
  const nameSearch = vi.fn((name: string) => ({ artists: [{ id: `mbid-${name}`, score: 95 }] }));
  mockMb({
    urlLookup: () => new Response('', { status: 500 }), // whole chunk fails, not just a miss
    genreAll: 'rock',
    nameSearch,
    aridSearch: (mbids) => ({ artists: mbids.map((id) => ({ id, tags: [{ name: 'Rock', count: 3 }] })) }),
  });

  vi.useFakeTimers();
  const resultPromise = lookupGenresBulk([artist('Alpha'), artist('Beta')]);
  await vi.runAllTimersAsync();
  const result = await resultPromise;
  vi.useRealTimers();

  expect(nameSearch).toHaveBeenCalledTimes(2);
  expect(nameSearch).toHaveBeenCalledWith('Alpha');
  expect(nameSearch).toHaveBeenCalledWith('Beta');
  expect(result.get('sp-Alpha')).toEqual(['rock']);
  expect(result.get('sp-Beta')).toEqual(['rock']);
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

it('does not let a name-search failure reject the whole bulk call — that artist is a miss, omitted from the map', async () => {
  const { lookupGenresBulk } = await freshMb();
  const onResult = vi.fn();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes('/genre/all')) return notFound();
    if (url.includes('/url?')) return json({ urls: [] }); // no MBID via URL — falls to name search
    return new Response('', { status: 500 }); // name search 500s — not retryable, mbidFromSearch rejects
  });

  vi.useFakeTimers();
  const resultPromise = lookupGenresBulk([artist('Boom')], undefined, onResult);
  await vi.runAllTimersAsync();
  const result = await resultPromise; // must not reject the whole bulk call
  vi.useRealTimers();

  expect(result.has('sp-Boom')).toBe(false); // omitted — search errored, not a confident miss
  expect(onResult).toHaveBeenCalledWith('sp-Boom', []);
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
    nameSearch: () => ({ artists: [] }), // no confident match either
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
  // Name-search-fallback misses report their [] result immediately, not at the end.
  expect(onResult).toHaveBeenCalledWith('sp-Ghost1', []);
  expect(onResult).toHaveBeenCalledWith('sp-Ghost2', []);
});

it('fires onPhase in order — mapping, searching (per artist name), then fetching', async () => {
  const { lookupGenresBulk } = await freshMb();
  mockMb({
    urlLookup: (resources) => ({
      urls: resources
        .filter((r) => r.endsWith('sp-Known'))
        .map((r) => ({ resource: r, relations: [{ artist: { id: 'mbid-known' } }] })),
    }),
    genreAll: 'rock',
    nameSearch: (name) => ({ artists: [{ id: `mbid-${name}`, score: 95 }] }),
    aridSearch: (mbids) => ({ artists: mbids.map((id) => ({ id, tags: [{ name: 'Rock', count: 3 }] })) }),
  });
  const phases: [string, string | undefined][] = [];
  const onPhase = vi.fn((phase: string, name?: string) => phases.push([phase, name]));

  vi.useFakeTimers();
  const resultPromise = lookupGenresBulk(
    [artist('Known'), artist('Unknown')], undefined, undefined, { onPhase },
  );
  await vi.runAllTimersAsync();
  await resultPromise;
  vi.useRealTimers();

  expect(phases[0]).toEqual(['mapping', undefined]);
  expect(phases).toContainEqual(['searching', 'Known']);
  expect(phases).toContainEqual(['searching', 'Unknown']);
  // fetching fires after both searching calls, not interleaved with them
  const fetchingIndex = phases.findIndex(([p]) => p === 'fetching');
  const lastSearchingIndex = phases.map(([p]) => p).lastIndexOf('searching');
  expect(fetchingIndex).toBeGreaterThan(lastSearchingIndex);
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

it('artists with a knownMbids entry skip /url mapping and name search, going straight to arid:', async () => {
  const { lookupGenresBulk } = await freshMb();
  const spy = mockMb({
    urlLookup: (resources) => ({ relations: resources.length === 1 ? [{ artist: { id: 'mbid-mapped' } }] : [] }),
    genreAll: 'rock\njazz',
    nameSearch: () => ({ artists: [{ id: 'mbid-wrong', score: 99 }] }),
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
  expect(spy.mock.calls.some((c) => decodeURIComponent(String(c[0])).includes('artist:"'))).toBe(false);
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
  expect(res.get('rg-1')).toEqual(['city pop']);
  expect(res.has('rg-2')).toBe(false);
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
