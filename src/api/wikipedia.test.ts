import { afterEach, beforeEach, expect, it, vi } from 'vitest';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

// Fresh module instance per test so the title cache's module-level variable
// never leaks between tests (mirrors musicbrainz.test.ts's freshMb helper).
async function freshWiki() {
  vi.resetModules();
  const mod = await import('./wikipedia');
  mod.resetWikipediaForTests();
  return mod;
}

const json = (body: object) => new Response(JSON.stringify(body), { status: 200 });
const artist = (name: string) => ({ id: `sp-${name}`, name });

const article = (title: string) => `https://en.wikipedia.org/wiki/${title.replace(/ /g, '_')}`;

// Routes mocked fetch calls by endpoint shape, not call order, so tests don't
// have to hardcode chunk counts.
function mockWiki(opts: {
  sparql?: (ids: string[]) => object | Response;
  search?: (name: string) => object | Response;
  revisions?: (title: string) => object | Response;
}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes('query.wikidata.org')) {
      const q = decodeURIComponent(url.match(/query=([^&]+)/)?.[1] ?? '');
      const ids = [...q.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      const body = opts.sparql ? opts.sparql(ids) : { results: { bindings: [] } };
      return body instanceof Response ? body : json(body);
    }
    if (url.includes('list=search')) {
      const name = decodeURIComponent(url.match(/srsearch=([^&]+)/)?.[1] ?? '');
      const body = opts.search ? opts.search(name) : { query: { search: [] } };
      return body instanceof Response ? body : json(body);
    }
    if (url.includes('prop=revisions')) {
      const title = decodeURIComponent(url.match(/titles=([^&]+)/)?.[1] ?? '');
      const body = opts.revisions ? opts.revisions(title) : { query: { pages: {} } };
      return body instanceof Response ? body : json(body);
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

const sparqlBindings = (rows: { id: string; title?: string; genre?: string; mbid?: string }[]) => ({
  results: {
    bindings: rows.map((r) => ({
      spotifyId: { value: r.id },
      ...(r.mbid ? { mbid: { value: r.mbid } } : {}),
      ...(r.title ? { article: { value: article(r.title) } } : {}),
      ...(r.genre ? { genreLabel: { value: r.genre } } : {}),
    })),
  },
});

const revisionsFor = (wikitext: string | null) => ({
  query: {
    pages: wikitext === null
      ? { '-1': { title: 'Missing', missing: '' } }
      : { '123': { title: 'X', revisions: [{ slots: { main: { '*': wikitext } } }] } },
  },
});

// -- parseInfoboxGenres -------------------------------------------------------

it('parses a {{flatlist|...}} genre field with bulleted wikilinks', async () => {
  const { parseInfoboxGenres } = await freshWiki();
  const wikitext = `{{Infobox musical artist
| name = Test
| genre = {{flatlist|
* [[Electronic music|Electronic]]
* [[Ambient music|Ambient]]
}}
| years_active = 1990-present
}}`;
  expect(parseInfoboxGenres(wikitext)).toEqual(['electronic', 'ambient']);
});

it('parses a {{hlist|...}} genre field, treating internal pipes as list items not field separators', async () => {
  const { parseInfoboxGenres } = await freshWiki();
  const wikitext = `{{Infobox musical artist
| genre = {{hlist|[[Hip hop music|Hip hop]]|[[Trap music (hip hop)|Trap]]}}
| label = Test Records
}}`;
  expect(parseInfoboxGenres(wikitext)).toEqual(['hip hop', 'trap']);
});

it('parses a comma-separated list of bare wikilinks', async () => {
  const { parseInfoboxGenres } = await freshWiki();
  const wikitext = `{{Infobox musical artist
| genre = [[Alternative rock]], [[grunge]]
}}`;
  expect(parseInfoboxGenres(wikitext)).toEqual(['alternative rock', 'grunge']);
});

it('unwraps [[Target|Display]] to the display text and [[Target]] to the target', async () => {
  const { parseInfoboxGenres } = await freshWiki();
  const wikitext = `{{Infobox musical artist
| genre = [[K-pop]]
}}`;
  expect(parseInfoboxGenres(wikitext)).toEqual(['k-pop']);
});

it('strips <ref>...</ref> and self-closing <ref name="x"/> tags from the genre field', async () => {
  const { parseInfoboxGenres } = await freshWiki();
  const wikitext = `{{Infobox musical artist
| genre = [[K-pop]]<ref name="billboard"/>, [[R&B]]<ref>{{cite web|title=Foo|url=https://example.com}}</ref>
}}`;
  expect(parseInfoboxGenres(wikitext)).toEqual(['k-pop', 'r&b']);
});

it('strips <!-- comment --> markup from the genre field', async () => {
  const { parseInfoboxGenres } = await freshWiki();
  const wikitext = `{{Infobox musical artist
| genre = [[Rock music|Rock]]<!-- do not add subgenres --> , [[pop music]]
}}`;
  expect(parseInfoboxGenres(wikitext)).toEqual(['rock', 'pop']);
});

it('normalizes case, whitespace and a trailing " music" suffix', async () => {
  const { parseInfoboxGenres } = await freshWiki();
  const wikitext = `{{Infobox musical artist
| genre = [[Country music]],   [[Alternative   Rock]]
}}`;
  expect(parseInfoboxGenres(wikitext)).toEqual(['country', 'alternative rock']);
});

it('dedupes genres that normalize to the same label', async () => {
  const { parseInfoboxGenres } = await freshWiki();
  const wikitext = `{{Infobox musical artist
| genre = [[Rock music|Rock]], [[Rock]]
}}`;
  expect(parseInfoboxGenres(wikitext)).toEqual(['rock']);
});

it('returns [] when the genre field is missing', async () => {
  const { parseInfoboxGenres } = await freshWiki();
  const wikitext = `{{Infobox musical artist
| name = Test
| years_active = 1990-present
}}`;
  expect(parseInfoboxGenres(wikitext)).toEqual([]);
});

it('returns [] when there is no infobox at all', async () => {
  const { parseInfoboxGenres } = await freshWiki();
  expect(parseInfoboxGenres("'''Test''' is an artist with no infobox.")).toEqual([]);
});

it('returns [] and never throws on unbalanced/malformed braces', async () => {
  const { parseInfoboxGenres } = await freshWiki();
  expect(() => parseInfoboxGenres('{{Infobox musical artist | genre = [[Rock]]')).not.toThrow();
  expect(parseInfoboxGenres('{{Infobox musical artist | genre = [[Rock]]')).toEqual([]);
  expect(parseInfoboxGenres('{{{{{{ garbage }} not a real template')).toEqual([]);
});

// -- lookupGenresBulk ---------------------------------------------------------

it('resolves genres for a join-phase hit via P1902/P136, without any name search or infobox fetch', async () => {
  const { lookupGenresBulk } = await freshWiki();
  const spy = mockWiki({
    sparql: () => sparqlBindings([{ id: 'sp-Radiohead', title: 'Radiohead', genre: 'alternative rock' }]),
  });

  const result = await lookupGenresBulk([artist('Radiohead')]);

  expect(result.get('sp-Radiohead')).toEqual(['alternative rock']);
  expect(spy.mock.calls.some((c) => String(c[0]).includes('prop=revisions'))).toBe(false);
});

it('falls back to name search for a join miss when nameSearch is enabled, caching [] when no article is found', async () => {
  const { lookupGenresBulk } = await freshWiki();
  const search = vi.fn((name: string) => (
    name === 'Known' ? { query: { search: [{ title: 'Known Artist' }] } } : { query: { search: [] } }
  ));
  mockWiki({
    sparql: () => sparqlBindings([]), // join finds nobody
    search,
  });

  const result = await lookupGenresBulk(
    [artist('Known'), artist('Unknown')], undefined, undefined, { nameSearch: true },
  );

  expect(search).toHaveBeenCalledTimes(2);
  expect(result.get('sp-Known')).toEqual([]); // article found, but infobox not requested
  expect(result.get('sp-Unknown')).toEqual([]); // confident: no article at all
});

it('skips name search for join misses when nameSearch is false, caching them as empty (fast path)', async () => {
  const { lookupGenresBulk } = await freshWiki();
  const search = vi.fn(() => ({ query: { search: [{ title: 'Whatever' }] } }));
  mockWiki({ sparql: () => sparqlBindings([]), search });

  const result = await lookupGenresBulk([artist('Unknown')]); // nameSearch defaults to false

  expect(search).not.toHaveBeenCalled();
  expect(result.get('sp-Unknown')).toEqual([]);
});

it('merges infobox genres with P136 genres from the join, unioning and deduping', async () => {
  const { lookupGenresBulk } = await freshWiki();
  mockWiki({
    sparql: () => sparqlBindings([{ id: 'sp-Bjork', title: 'Björk', genre: 'art pop' }]),
    revisions: () => revisionsFor(`{{Infobox musical artist
| genre = {{hlist|[[Art pop]]|[[Experimental music|Experimental]]}}
}}`),
  });

  const result = await lookupGenresBulk([artist('Bjork')], undefined, undefined, { infobox: true });

  expect(result.get('sp-Bjork')).toEqual(expect.arrayContaining(['art pop', 'experimental']));
  expect(result.get('sp-Bjork')).toHaveLength(2); // "art pop" from both sources dedupes to one entry
});

it('keeps a join-phase-only answer when infobox is off, never fetching revisions', async () => {
  const { lookupGenresBulk } = await freshWiki();
  const spy = mockWiki({
    sparql: () => sparqlBindings([{ id: 'sp-Bjork', title: 'Björk', genre: 'art pop' }]),
  });

  const result = await lookupGenresBulk([artist('Bjork')]); // infobox defaults to false

  expect(result.get('sp-Bjork')).toEqual(['art pop']);
  expect(spy.mock.calls.some((c) => String(c[0]).includes('prop=revisions'))).toBe(false);
});

it('omits an artist from the map when the name search request itself errors (transient, not a confident miss)', async () => {
  const { lookupGenresBulk } = await freshWiki();
  const onResult = vi.fn();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes('query.wikidata.org')) return json({ results: { bindings: [] } });
    if (url.includes('list=search')) return new Response('', { status: 500 });
    throw new Error(`unexpected fetch: ${url}`);
  });

  const result = await lookupGenresBulk(
    [artist('Boom')], undefined, onResult, { nameSearch: true },
  );

  expect(result.has('sp-Boom')).toBe(false); // omitted — search errored, not a confident answer
  expect(onResult).toHaveBeenCalledWith('sp-Boom', []); // still surfaced for UI, just not cached
});

it('omits an artist from the map when the infobox fetch fails and no P136 genres were already known', async () => {
  const { lookupGenresBulk } = await freshWiki();
  const onResult = vi.fn();
  mockWiki({
    sparql: () => sparqlBindings([{ id: 'sp-Nobody', title: 'Nobody' }]), // title, no P136 genre
    revisions: () => new Response('', { status: 500 }),
  });

  const result = await lookupGenresBulk(
    [artist('Nobody')], undefined, onResult, { infobox: true },
  );

  expect(result.has('sp-Nobody')).toBe(false);
  expect(onResult).toHaveBeenCalledWith('sp-Nobody', []);
});

it('keeps the P136 answer when the infobox fetch fails but a join genre was already known', async () => {
  const { lookupGenresBulk } = await freshWiki();
  mockWiki({
    sparql: () => sparqlBindings([{ id: 'sp-Partial', title: 'Partial', genre: 'jazz' }]),
    revisions: () => new Response('', { status: 500 }),
  });

  const result = await lookupGenresBulk([artist('Partial')], undefined, undefined, { infobox: true });

  expect(result.get('sp-Partial')).toEqual(['jazz']); // infobox failure doesn't discard a real answer
});

it('omits a whole join chunk from the map when the SPARQL request itself fails (transient, not a confident miss)', async () => {
  const { lookupGenresBulk } = await freshWiki();
  const onResult = vi.fn();
  mockWiki({ sparql: () => new Response('', { status: 500 }) });

  const result = await lookupGenresBulk([artist('Alpha'), artist('Beta')], undefined, onResult);

  // WDQS never answered, so these are absent-not-empty: resolver.ts caches an
  // id mapped to [] as a DURABLE 'none'. Emitting [] here would let a single
  // WDQS 503 permanently poison every artist in the chunk.
  expect(result.has('sp-Alpha')).toBe(false);
  expect(result.has('sp-Beta')).toBe(false);
  // onResult still fires with [] so a UI can render "no genre yet" — it just
  // never becomes a cached answer.
  expect(onResult).toHaveBeenCalledWith('sp-Alpha', []);
  expect(onResult).toHaveBeenCalledWith('sp-Beta', []);
});

it('includes every input id in the result even when the join finds nobody and nameSearch is off', async () => {
  const { lookupGenresBulk } = await freshWiki();
  mockWiki({ sparql: () => sparqlBindings([]) });

  const result = await lookupGenresBulk([artist('Ghost1'), artist('Ghost2')]);

  expect([...result.keys()]).toEqual(['sp-Ghost1', 'sp-Ghost2']);
  expect(result.get('sp-Ghost1')).toEqual([]);
  expect(result.get('sp-Ghost2')).toEqual([]);
});

it('fires onPhase joining then fetching, and onProgress up to total, for an infobox run', async () => {
  const { lookupGenresBulk } = await freshWiki();
  mockWiki({
    sparql: () => sparqlBindings([{ id: 'sp-Known', title: 'Known Artist', genre: 'rock' }]),
    revisions: () => revisionsFor('{{Infobox musical artist | genre = [[Rock]] }}'),
  });
  const phases: string[] = [];
  const onPhase = vi.fn((phase: string) => phases.push(phase));
  const onProgress = vi.fn();

  const result = await lookupGenresBulk(
    [artist('Known')], onProgress, undefined, { infobox: true, onPhase },
  );

  expect(phases[0]).toBe('joining');
  expect(phases).toContain('fetching');
  expect(onProgress).toHaveBeenCalledWith(1, 1);
  expect(result.get('sp-Known')).toEqual(['rock']);
});

it('invokes onResult exactly once per artist', async () => {
  const { lookupGenresBulk } = await freshWiki();
  mockWiki({
    sparql: () => sparqlBindings([
      { id: 'sp-A', title: 'A', genre: 'rock' },
      { id: 'sp-B', title: 'B' },
    ]),
    revisions: (title) => revisionsFor(title === 'A' ? '{{Infobox musical artist | genre = [[Rock]] }}' : null),
  });
  const onResult = vi.fn();

  await lookupGenresBulk([artist('A'), artist('B')], undefined, onResult, { infobox: true });

  expect(onResult).toHaveBeenCalledTimes(2);
  expect(onResult).toHaveBeenCalledWith('sp-A', expect.arrayContaining(['rock']));
  expect(onResult).toHaveBeenCalledWith('sp-B', []);
});

it('resolves an artist with a P1902 entity but no enwiki sitelink using only its P136 genre', async () => {
  const { lookupGenresBulk } = await freshWiki();
  mockWiki({
    sparql: () => sparqlBindings([{ id: 'sp-NoArticle', genre: 'ambient' }]), // no `title`
  });

  const result = await lookupGenresBulk([artist('NoArticle')], undefined, undefined, { infobox: true });

  // No title means no infobox fetch is possible — the P136 genre from the
  // join must not be discarded just because there's nothing to fetch.
  expect(result.get('sp-NoArticle')).toEqual(['ambient']);
});

it('every Action API URL carries origin=*', async () => {
  const { lookupGenresBulk } = await freshWiki();
  const spy = mockWiki({
    sparql: () => sparqlBindings([]),
    search: () => ({ query: { search: [{ title: 'Found' }] } }),
    revisions: () => revisionsFor('{{Infobox musical artist | genre = [[Rock]] }}'),
  });

  await lookupGenresBulk([artist('X')], undefined, undefined, { nameSearch: true, infobox: true });

  const actionApiCalls = spy.mock.calls.filter((c) => String(c[0]).includes('en.wikipedia.org/w/api.php'));
  expect(actionApiCalls.length).toBeGreaterThan(0);
  for (const call of actionApiCalls) expect(String(call[0])).toMatch(/[?&]origin=\*/);
});

it('caches the join-derived title so a repeat call skips the WDQS request', async () => {
  const { lookupGenresBulk } = await freshWiki();
  const spy = mockWiki({
    sparql: () => sparqlBindings([{ id: 'sp-Cached', title: 'Cached Artist', genre: 'rock' }]),
  });

  await lookupGenresBulk([artist('Cached')]);
  const firstCallCount = spy.mock.calls.filter((c) => String(c[0]).includes('query.wikidata.org')).length;
  expect(firstCallCount).toBe(1);

  await lookupGenresBulk([artist('Cached')]);
  const secondCallCount = spy.mock.calls.filter((c) => String(c[0]).includes('query.wikidata.org')).length;
  expect(secondCallCount).toBe(1); // no new SPARQL request — title came from the cache
});

it('strips the " music" suffix from Wikidata P136 labels so they match MB/Spotify genres', async () => {
  const { lookupGenresBulk } = await freshWiki();
  mockWiki({
    sparql: () => sparqlBindings([
      { id: 'sp-A', title: 'A', genre: 'Hip hop music' },
      { id: 'sp-A', title: 'A', genre: 'hip hop' }, // dedupes after normalizing
      { id: 'sp-A', title: 'A', genre: 'trip hop' },
    ]),
  });

  const result = await lookupGenresBulk([artist('A')]);

  expect(result.get('sp-A')).toEqual(['hip hop', 'trip hop']);
});

it('reports P434 MBIDs through mbidsOut, including for entities with no P136 and no article, and from cache', async () => {
  const { lookupGenresBulk } = await freshWiki();
  const spy = mockWiki({ sparql: () => sparqlBindings([{ id: 'sp-NoGenre', mbid: 'mbid-1' }]) });

  const mbids = new Map<string, string>();
  const result = await lookupGenresBulk([artist('NoGenre')], undefined, undefined, { mbidsOut: mbids });
  expect(result.get('sp-NoGenre')).toEqual([]);
  expect(mbids.get('sp-NoGenre')).toBe('mbid-1');

  // Entity-without-title is cached now, so the MBID survives a repeat run
  // with no second SPARQL request.
  const again = new Map<string, string>();
  await lookupGenresBulk([artist('NoGenre')], undefined, undefined, { mbidsOut: again });
  expect(again.get('sp-NoGenre')).toBe('mbid-1');
  expect(spy.mock.calls.filter((c) => String(c[0]).includes('query.wikidata.org'))).toHaveLength(1);
});

it('runs join chunks concurrently rather than one after another', async () => {
  const { lookupGenresBulk } = await freshWiki();
  let inFlight = 0;
  let peak = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    return json({ results: { bindings: [] } });
  });

  const many = Array.from({ length: 200 }, (_, i) => artist(`n${i}`));
  const result = await lookupGenresBulk(many);

  expect(peak).toBeGreaterThan(1);
  expect(peak).toBeLessThanOrEqual(4); // stays under WDQS's 5-concurrent-per-IP cap
  expect(result.size).toBe(200);
});

it('drops the v1 title cache, whose genres were unnormalized and lacked MBIDs', async () => {
  localStorage.setItem('tracktackle:wd-titles:v1', JSON.stringify({ 'sp-Old': { title: 'Old', genres: ['rock music'] } }));
  const { lookupGenresBulk } = await freshWiki();
  mockWiki({ sparql: () => sparqlBindings([{ id: 'sp-Old', title: 'Old', genre: 'rock music' }]) });

  const result = await lookupGenresBulk([artist('Old')]);

  expect(result.get('sp-Old')).toEqual(['rock']);
  expect(localStorage.getItem('tracktackle:wd-titles:v1')).toBeNull();
});
