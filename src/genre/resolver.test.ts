import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  resolveAllGenres, resetResolverForTests, cachedGenres, cachedSource, genreCoverage, isStaleNone, NONE_SOURCES_VERSION,
} from './resolver';
import * as enrich from './enrich';
import * as spotify from '../api/spotify';
import * as mb from '../api/musicbrainz';
import * as wikidata from '../api/wikidata';
import { SpotifyApiError } from '../api/spotify';

vi.mock('../api/spotify', async () => {
  const actual = await vi.importActual<typeof import('../api/spotify')>('../api/spotify');
  return { getArtistGenresBatch: vi.fn(), ARTIST_BATCH: 50, SpotifyApiError: actual.SpotifyApiError };
});
vi.mock('../api/musicbrainz', () => ({ lookupGenresBulk: vi.fn() }));
vi.mock('../api/wikidata', () => ({ joinWikidata: vi.fn() }));
vi.mock('./enrich', () => ({ enrichEmptyArtists: vi.fn() }));

// The resolver asks Spotify for up to 50 artists per call, but these tests
// reason per-artist — so express the mock as a per-id function and let this
// wrap it back into the batch shape.
const spotifyGenres = (fn: (id: string) => string[]) =>
  vi.mocked(spotify.getArtistGenresBatch).mockImplementation(
    async (ids) => new Map(ids.map((id) => [id, fn(id)])),
  );

const artist = { id: 'a1', name: 'Portishead' };

// A deep run always runs the Wikidata join ahead of MusicBrainz (see
// resolver.ts) — default every test to "no hits" so the MB-path tests don't
// have to know about it; the tests that care about the join override this.
// Same for the last-chance recordings/neighbours pass: "found nothing,
// nothing failed" unless a test says otherwise.
beforeEach(() => {
  vi.mocked(wikidata.joinWikidata).mockResolvedValue(new Map());
  vi.mocked(enrich.enrichEmptyArtists).mockResolvedValue({ found: new Map(), failed: new Set() });
});

afterEach(() => {
  localStorage.clear();
  resetResolverForTests();
  vi.clearAllMocks();
});

it('cachedGenres reads resolved genres back out of the cache', async () => {
  spotifyGenres(() => ['Trip Hop']);
  await resolveAllGenres([artist], () => {});
  expect(cachedGenres('a1')).toEqual(['trip hop']);
  expect(cachedGenres('missing')).toBeUndefined();
});

it('cachedSource reports where an artist\'s genres came from', async () => {
  spotifyGenres(() => ['Trip Hop']);
  await resolveAllGenres([artist], () => {});
  expect(cachedSource('a1')).toBe('spotify');
  expect(cachedSource('missing')).toBeUndefined();
});

// -- resolveAllGenres --------------------------------------------------------

it('resolves cached artists immediately, counting them up front, without any fetches', async () => {
  spotifyGenres(() => ['Trip Hop']);
  await resolveAllGenres([artist], () => {}); // warms the cache
  vi.mocked(spotify.getArtistGenresBatch).mockClear();

  const onProgress = vi.fn();
  const result = await resolveAllGenres([artist], onProgress);

  expect(result.get('a1')).toEqual(['trip hop']);
  expect(spotify.getArtistGenresBatch).not.toHaveBeenCalled();
  expect(mb.lookupGenresBulk).not.toHaveBeenCalled();
  expect(onProgress).toHaveBeenCalledWith(1, 1); // cache hit counted up front
  expect(onProgress).toHaveBeenLastCalledWith(1, 1);
});

it('resolves uncached artists via the Spotify pool, skipping MB entirely on success', async () => {
  spotifyGenres((id) => (id === 'a1' ? ['Trip Hop'] : ['Rock']));

  const artists = [artist, { id: 'a2', name: 'Other' }];
  const onProgress = vi.fn();
  const result = await resolveAllGenres(artists, onProgress);

  expect(result.get('a1')).toEqual(['trip hop']);
  expect(result.get('a2')).toEqual(['rock']);
  expect(spotify.getArtistGenresBatch).toHaveBeenCalledTimes(1); // both artists in one batch
  expect(mb.lookupGenresBulk).not.toHaveBeenCalled();
  expect(onProgress).toHaveBeenLastCalledWith(2, 2);

  // Cached now — a second run touches neither API.
  vi.mocked(spotify.getArtistGenresBatch).mockClear();
  await resolveAllGenres(artists, () => {});
  expect(spotify.getArtistGenresBatch).not.toHaveBeenCalled();
});

it('sends artists with no Spotify genres to bulk MB, tagging results by source', async () => {
  spotifyGenres(() => []); // no genres on Spotify for anyone
  vi.mocked(mb.lookupGenresBulk).mockImplementation(async (as, onProgress) => {
    onProgress?.(as.length, as.length);
    return new Map(as.map((a: { id: string }) => [a.id, a.id === 'a1' ? ['trip hop'] : []]));
  });

  const artists = [artist, { id: 'a2', name: 'Other' }];
  const onProgress = vi.fn();
  // bulk MB is only used in deep runs — request deep:true to exercise MB path
  const result = await resolveAllGenres(artists, onProgress, undefined, { deep: true });

  expect(result.get('a1')).toEqual(['trip hop']);
  expect(result.get('a2')).toEqual([]);
  expect(mb.lookupGenresBulk).toHaveBeenCalledTimes(1);
  const bulkArgs = vi.mocked(mb.lookupGenresBulk).mock.calls[0][0];
  expect(bulkArgs.map((a: { id: string }) => a.id).sort()).toEqual(['a1', 'a2']);
  expect(onProgress).toHaveBeenLastCalledWith(2, 2);

  // a1 cached as musicbrainz, a2 cached as none — re-run touches nothing.
  vi.mocked(spotify.getArtistGenresBatch).mockClear();
  vi.mocked(mb.lookupGenresBulk).mockClear();
  await resolveAllGenres(artists, () => {});
  expect(spotify.getArtistGenresBatch).not.toHaveBeenCalled();
  expect(mb.lookupGenresBulk).not.toHaveBeenCalled();
});

it('flips spotifyGenresAvailable on a 403 mid-run but never auto-routes to MusicBrainz (fast route)', async () => {
  // 7 chunks of 50 uncached artists: pool concurrency is 6, so the 7th chunk
  // sits in the queue until a worker frees up — it must never attempt Spotify
  // once the flag flips.
  const artists = Array.from({ length: 7 * 50 }, (_, i) => ({ id: `a${i}`, name: `Artist${i}` }));
  const resolvers: ((v: Map<string, string[]>) => void)[] = [];
  const rejecters: ((e: unknown) => void)[] = [];
  vi.mocked(spotify.getArtistGenresBatch).mockImplementation(() => new Promise((resolve, reject) => {
    resolvers.push(resolve);
    rejecters.push(reject);
  }));

  const onProgress = vi.fn();
  const resultPromise = resolveAllGenres(artists, onProgress);

  // Let the pool's first 6 workers dispatch their calls.
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(spotify.getArtistGenresBatch).toHaveBeenCalledTimes(6); // 7th chunk not yet attempted — pool is full

  // The first chunk's Spotify call 403s -> flips the flag off for the session.
  rejecters[0](new SpotifyApiError('Spotify API 403', 403));
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

  // Resolve the other in-flight chunks with genres so they succeed via Spotify.
  for (let i = 1; i < 6; i++) {
    resolvers[i](new Map(artists.slice(i * 50, (i + 1) * 50).map((a) => [a.id, ['rock']])));
  }
  await resultPromise;

  // The 7th chunk was freed up only after the flag flipped off — never attempted.
  expect(spotify.getArtistGenresBatch).toHaveBeenCalledTimes(6);
  expect(mb.lookupGenresBulk).not.toHaveBeenCalled(); // MB never runs in a non-deep sweep, even after a 403
  const coverage = genreCoverage(['a0', 'a300']);
  expect(coverage.unresolved).toBe(2); // a0: in the 403'd chunk; a300: in the skipped 7th — both left retryable
});

it('calls sink for every resolved artist — cache hits, Spotify successes, and MB bulk results', async () => {
  spotifyGenres(() => ['Trip Hop']);
  await resolveAllGenres([artist], () => {}); // warms cache for a1 via spotify
  vi.mocked(spotify.getArtistGenresBatch).mockClear();
  spotifyGenres((id) => (id === 'a2' ? ['Rock'] : []));
  vi.mocked(mb.lookupGenresBulk).mockImplementation(async (as, _onProgress, onResult) => {
    const map = new Map(as.map((a: { id: string }) => [a.id, a.id === 'a3' ? ['jazz'] : []]));
    for (const [id, genres] of map) onResult?.(id, genres); // mirrors the real per-chunk onResult contract
    return map;
  });

  const artists = [artist, { id: 'a2', name: 'Two' }, { id: 'a3', name: 'Three' }];
  const sink = vi.fn();
  // exercise MB bulk via deep run
  await resolveAllGenres(artists, () => {}, sink, { deep: true });

  expect(sink).toHaveBeenCalledWith('a1', ['trip hop']); // cache hit
  expect(sink).toHaveBeenCalledWith('a2', ['rock']); // Spotify pool success
  expect(sink).toHaveBeenCalledWith('a3', ['jazz']); // MB bulk result
});

it('does not cache ids missing from the bulk map — a chunk failure leaves them uncached for retry', async () => {
  spotifyGenres(() => []); // no Spotify genres for anyone
  // Simulates lookupGenresBulk omitting a1 because its arid chunk (or name-search) errored.
  vi.mocked(mb.lookupGenresBulk).mockResolvedValueOnce(new Map());

  const result = await resolveAllGenres([artist], () => {}, undefined, { deep: true });
  expect(result.get('a1')).toEqual([]); // this run still sees [] in-memory

  // Nothing was written to the cache, so a second run sends a1 to bulk MB again.
  vi.mocked(mb.lookupGenresBulk).mockClear();
  vi.mocked(mb.lookupGenresBulk).mockResolvedValueOnce(new Map([['a1', ['rock']]]));
  const result2 = await resolveAllGenres([artist], () => {}, undefined, { deep: true });
  expect(mb.lookupGenresBulk).toHaveBeenCalledTimes(1); // retried — not served from cache
  expect(result2.get('a1')).toEqual(['rock']);
});

it('does not call bulk MB by default (fast route)', async () => {
  spotifyGenres(() => []); // everyone falls to MB
  vi.mocked(mb.lookupGenresBulk).mockResolvedValue(new Map([['a1', []]]));
  await resolveAllGenres([artist], () => {});
  expect(mb.lookupGenresBulk).not.toHaveBeenCalled();
});

it('a deep run runs batched MB before enrichment, which owns the MB name search', async () => {
  spotifyGenres(() => []);
  vi.mocked(mb.lookupGenresBulk).mockResolvedValue(new Map([['a1', []]]));
  await resolveAllGenres([artist], () => {}, undefined, { deep: true });
  expect(vi.mocked(mb.lookupGenresBulk).mock.invocationCallOrder[0])
    .toBeLessThan(vi.mocked(enrich.enrichEmptyArtists).mock.invocationCallOrder[0]);
  expect(vi.mocked(enrich.enrichEmptyArtists).mock.calls[0][4]?.names?.get('a1')).toBe('Portishead');
});

it('hands Wikidata P434 MBIDs from the join to MusicBrainz', async () => {
  spotifyGenres(() => []);
  // a1 has a Wikidata entity with an MBID but no P136 genre: a join miss that
  // still saves MB its /url mapping and name search.
  vi.mocked(wikidata.joinWikidata).mockImplementation(async (_ids, opts) => {
    opts?.mbidsOut?.set('a1', 'mbid-portishead');
    return new Map([['a1', []]]);
  });
  vi.mocked(mb.lookupGenresBulk).mockResolvedValue(new Map([['a1', ['trip hop']]]));

  await resolveAllGenres([artist], () => {}, undefined, { deep: true });

  const mbOpts = vi.mocked(mb.lookupGenresBulk).mock.calls[0][3];
  expect(mbOpts?.knownMbids?.get('a1')).toBe('mbid-portishead');
  expect(cachedSource('a1')).toBe('musicbrainz');
});

it('normalizes Wikidata-sourced genres already in the cache ("rock music" -> "rock")', () => {
  localStorage.setItem('tracktackle:genres:v3', JSON.stringify({
    a1: { genres: ['Rock music', 'rock', 'trip hop'], source: 'wikipedia' },
    a2: { genres: ['chamber music'], source: 'spotify' }, // other sources untouched
  }));
  expect(cachedGenres('a1')).toEqual(['rock', 'trip hop']);
  expect(cachedGenres('a2')).toEqual(['chamber music']);
});

it('a deep run retries artists the fast pass left unresolved; a normal run trusts the cache', async () => {
  spotifyGenres(() => []);
  vi.mocked(mb.lookupGenresBulk).mockResolvedValue(new Map([['a1', []]]));
  await resolveAllGenres([artist], () => {});          // fast pass caches 'unresolved'
  vi.mocked(mb.lookupGenresBulk).mockClear();

  await resolveAllGenres([artist], () => {});          // warm reload: no work
  expect(mb.lookupGenresBulk).not.toHaveBeenCalled();

  vi.mocked(mb.lookupGenresBulk).mockResolvedValue(new Map([['a1', ['rock']]]));
  const deep = await resolveAllGenres([artist], () => {}, undefined, { deep: true });
  expect(deep.get('a1')).toEqual(['rock']);
  expect(cachedGenres('a1')).toEqual(['rock']);
});

it('a deep run does not retry an artist MB already confirmed has no genres (durable none)', async () => {
  spotifyGenres(() => []);
  vi.mocked(mb.lookupGenresBulk).mockResolvedValue(new Map([['a1', []]])); // MB confirms nothing -> cached 'none'
  await resolveAllGenres([artist], () => {}, undefined, { deep: true });
  expect(mb.lookupGenresBulk).toHaveBeenCalledTimes(1);

  vi.mocked(mb.lookupGenresBulk).mockClear();
  await resolveAllGenres([artist], () => {}, undefined, { deep: true }); // second deep run
  expect(mb.lookupGenresBulk).not.toHaveBeenCalled(); // 'none' is durable — cache hit short-circuits
});

it('genreCoverage counts cache sources, treating an absent id as unresolved', async () => {
  spotifyGenres((id) => (id === 'a1' ? ['Trip Hop'] : []));
  await resolveAllGenres([artist], () => {}); // a1 -> spotify
  vi.mocked(mb.lookupGenresBulk).mockResolvedValue(new Map([['a2', []]]));
  await resolveAllGenres([{ id: 'a2', name: 'Two' }], () => {}, undefined, { deep: true }); // a2 -> none

  expect(genreCoverage(['a1', 'a2', 'missing']))
    .toEqual({ spotify: 1, musicbrainz: 0, wikipedia: 0, recordings: 0, neighbours: 0, lastfm: 0, none: 1, unresolved: 1, stale: 0 });
});

it('reaches (total, total) progress exactly for a mix of cached, Spotify, and MB artists', async () => {
  spotifyGenres(() => ['Trip Hop']);
  await resolveAllGenres([artist], () => {}); // a1 cached via spotify
  spotifyGenres((id) => (id === 'a2' ? ['Rock'] : []));
  vi.mocked(mb.lookupGenresBulk).mockImplementation(async (as, onProgress) => {
    onProgress?.(as.length, as.length);
    return new Map(as.map((a: { id: string }) => [a.id, []]));
  });

  const artists = [artist, { id: 'a2', name: 'Two' }, { id: 'a3', name: 'Three' }];
  const onProgress = vi.fn();
  await resolveAllGenres(artists, onProgress, undefined, { deep: true });

  expect(onProgress).toHaveBeenLastCalledWith(3, 3);
  // Progress must be monotonically non-decreasing.
  const calls = vi.mocked(onProgress).mock.calls.map(([r]) => r);
  for (let i = 1; i < calls.length; i++) expect(calls[i]).toBeGreaterThanOrEqual(calls[i - 1]);
});

// -- Wikidata join ----------------------------------------------------------

it('a deep run tries the Wikidata join, then falls through to MusicBrainz on a miss', async () => {
  spotifyGenres(() => []);
  vi.mocked(mb.lookupGenresBulk).mockResolvedValue(new Map([['a1', ['rock']]]));

  const result = await resolveAllGenres([artist], () => {}, undefined, { deep: true });

  expect(result.get('a1')).toEqual(['rock']);
  expect(vi.mocked(wikidata.joinWikidata).mock.calls[0][0]).toEqual(['a1']);
  expect(vi.mocked(mb.lookupGenresBulk).mock.calls[0][0]).toEqual([artist]);
  expect(cachedSource('a1')).toBe('musicbrainz');
});

it('a Wikidata join hit short-circuits MusicBrainz for that artist only', async () => {
  spotifyGenres(() => []);
  const artists = [artist, { id: 'a2', name: 'Massive Attack' }];
  vi.mocked(wikidata.joinWikidata).mockResolvedValue(new Map([['a1', ['trip hop']]]));
  vi.mocked(mb.lookupGenresBulk).mockResolvedValue(new Map([['a2', ['downtempo']]]));

  const result = await resolveAllGenres(artists, () => {}, undefined, { deep: true });

  expect(result.get('a1')).toEqual(['trip hop']);
  expect(cachedSource('a1')).toBe('wikipedia');
  expect(result.get('a2')).toEqual(['downtempo']);
  expect(cachedSource('a2')).toBe('musicbrainz');
  expect(vi.mocked(mb.lookupGenresBulk).mock.calls[0][0]).toEqual([{ id: 'a2', name: 'Massive Attack' }]);
});

it('the non-deep fast route never calls Wikidata, same as MusicBrainz', async () => {
  spotifyGenres(() => []);
  await resolveAllGenres([artist], () => {});
  expect(wikidata.joinWikidata).not.toHaveBeenCalled();
  expect(mb.lookupGenresBulk).not.toHaveBeenCalled();
  expect(cachedSource('a1')).toBe('unresolved');
});

// -- Last-chance enrichment and stale 'none' --------------------------------

it('a deep run hands MB misses to the enrichment pass and caches its hits by source', async () => {
  spotifyGenres(() => []);
  vi.mocked(mb.lookupGenresBulk).mockImplementation(async (_artists, _p, _r, opts) => {
    opts?.mbidsOut?.set('a1', 'mbid-1');
    return new Map([['a1', []], ['a2', []]]);
  });
  vi.mocked(enrich.enrichEmptyArtists).mockResolvedValue({
    found: new Map([['a1', { genres: ['soul'], source: 'neighbours' as const }]]),
    failed: new Set(),
  });
  const recordingsByArtist = new Map([['a2', [{ isrc: 'X', solo: true }]]]);
  const out = await resolveAllGenres(
    [artist, { id: 'a2', name: 'Two' }], () => {}, undefined, { deep: true, recordingsByArtist },
  );

  const [ids, recs, mbids] = vi.mocked(enrich.enrichEmptyArtists).mock.calls[0];
  expect(ids).toEqual(['a1', 'a2']);
  expect(recs).toBe(recordingsByArtist);
  expect(mbids.get('a1')).toBe('mbid-1');
  expect(out.get('a1')).toEqual(['soul']);
  expect(cachedSource('a1')).toBe('neighbours');
  expect(cachedSource('a2')).toBe('none');
  expect(isStaleNone({ genres: [], source: 'none', checked: NONE_SOURCES_VERSION, at: Date.now() })).toBe(false);
});

it('an enrichment request failure leaves a none that the next deep run re-checks', async () => {
  spotifyGenres(() => []);
  vi.mocked(mb.lookupGenresBulk).mockResolvedValue(new Map([['a1', []]]));
  vi.mocked(enrich.enrichEmptyArtists).mockResolvedValue({ found: new Map(), failed: new Set(['a1']) });
  await resolveAllGenres([artist], () => {}, undefined, { deep: true });
  expect(cachedSource('a1')).toBe('none');
  expect(genreCoverage(['a1']).stale).toBe(1);
});

it('re-checks a pre-version-2 none once, skipping its MB name search', async () => {
  localStorage.setItem('tracktackle:genres:v3', JSON.stringify({ a1: { genres: [], source: 'none' } }));
  spotifyGenres(() => []);
  vi.mocked(mb.lookupGenresBulk).mockResolvedValue(new Map([['a1', []]]));

  expect(genreCoverage(['a1']).stale).toBe(1);
  await resolveAllGenres([artist], () => {}, undefined, { deep: true });
  expect(vi.mocked(enrich.enrichEmptyArtists).mock.calls[0][4]?.noNameSearch?.has('a1')).toBe(true);
  expect(enrich.enrichEmptyArtists).toHaveBeenCalledTimes(1);
  expect(genreCoverage(['a1']).stale).toBe(0);

  vi.mocked(mb.lookupGenresBulk).mockClear();
  await resolveAllGenres([artist], () => {}, undefined, { deep: true }); // now current: durable again
  expect(mb.lookupGenresBulk).not.toHaveBeenCalled();
});

it('a non-deep run never re-checks a stale none', async () => {
  localStorage.setItem('tracktackle:genres:v3', JSON.stringify({ a1: { genres: [], source: 'none' } }));
  await resolveAllGenres([artist], () => {});
  expect(spotify.getArtistGenresBatch).not.toHaveBeenCalled();
  expect(mb.lookupGenresBulk).not.toHaveBeenCalled();
});

it('a none past its TTL is stale again', () => {
  const at = Date.now() - 91 * 24 * 60 * 60 * 1000;
  expect(isStaleNone({ genres: [], source: 'none', checked: NONE_SOURCES_VERSION, at })).toBe(true);
  expect(isStaleNone({ genres: ['rock'], source: 'musicbrainz' })).toBe(false);
});

it('a version-2 none is stale only when the build can actually run Last.fm', () => {
  const v2 = { genres: [], source: 'none' as const, checked: 2, at: Date.now() };
  expect(isStaleNone(v2)).toBe(false); // keyless: a re-check could do nothing new
  vi.stubEnv('VITE_LASTFM_API_KEY', 'k');
  try {
    expect(isStaleNone(v2)).toBe(true);
    expect(isStaleNone({ ...v2, checked: NONE_SOURCES_VERSION })).toBe(false);
  } finally {
    vi.unstubAllEnvs();
  }
});

it('stamps a none with the version this build delivers, and hands enrichment names + key', async () => {
  vi.stubEnv('VITE_LASTFM_API_KEY', 'k');
  try {
    spotifyGenres(() => []);
    vi.mocked(mb.lookupGenresBulk).mockResolvedValue(new Map([['a1', []]]));
    vi.mocked(enrich.enrichEmptyArtists).mockResolvedValue({ found: new Map(), failed: new Set() });
    await resolveAllGenres([artist], () => {}, undefined, { deep: true });
    const opts = vi.mocked(enrich.enrichEmptyArtists).mock.calls[0][4];
    expect(opts?.lastFmKey).toBe('k');
    expect(opts?.names?.get('a1')).toBe(artist.name);
    expect(genreCoverage(['a1']).stale).toBe(0);
  } finally {
    vi.unstubAllEnvs();
  }
});
