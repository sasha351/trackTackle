import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resolveAllGenres, resetResolverForTests, cachedGenres, cachedSource, genreCoverage } from './resolver';
import * as spotify from '../api/spotify';
import * as mb from '../api/musicbrainz';
import * as wikipedia from '../api/wikipedia';
import { SpotifyApiError } from '../api/spotify';

vi.mock('../api/spotify', async () => {
  const actual = await vi.importActual<typeof import('../api/spotify')>('../api/spotify');
  return { getArtistGenresBatch: vi.fn(), ARTIST_BATCH: 50, SpotifyApiError: actual.SpotifyApiError };
});
vi.mock('../api/musicbrainz', () => ({ lookupGenresBulk: vi.fn() }));
vi.mock('../api/wikipedia', () => ({ lookupGenresBulk: vi.fn() }));

// The resolver asks Spotify for up to 50 artists per call, but these tests
// reason per-artist — so express the mock as a per-id function and let this
// wrap it back into the batch shape.
const spotifyGenres = (fn: (id: string) => string[]) =>
  vi.mocked(spotify.getArtistGenresBatch).mockImplementation(
    async (ids) => new Map(ids.map((id) => [id, fn(id)])),
  );

const artist = { id: 'a1', name: 'Portishead' };

// A deep run now always runs a fast Wikidata join-only supplement ahead of
// MusicBrainz (see resolver.ts) — default every test to "no hits" so the
// existing MB-path tests don't have to know about it; the tests that care
// about the supplement itself override this explicitly.
beforeEach(() => {
  vi.mocked(wikipedia.lookupGenresBulk).mockResolvedValue(new Map());
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

it('passes nameSearch:true to bulk MB when deep', async () => {
  spotifyGenres(() => []);
  vi.mocked(mb.lookupGenresBulk).mockResolvedValue(new Map([['a1', ['rock']]]));
  await resolveAllGenres([artist], () => {}, undefined, { deep: true });
  expect(vi.mocked(mb.lookupGenresBulk).mock.calls[0][3]).toEqual({ nameSearch: true });
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
    .toEqual({ spotify: 1, musicbrainz: 0, wikipedia: 0, none: 1, unresolved: 1 });
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

// -- wikipedia fallback (challenger, opt-in) --------------------------------

it('deep run with no fallback opt tries the Wikidata join supplement, then falls through to MusicBrainz on a miss', async () => {
  spotifyGenres(() => []);
  vi.mocked(mb.lookupGenresBulk).mockResolvedValue(new Map([['a1', ['rock']]]));
  // beforeEach already defaults the join supplement to "no hits" — assert
  // MB still gets called with the full artist list, unaffected by an empty join.

  const result = await resolveAllGenres([artist], () => {}, undefined, { deep: true });

  expect(result.get('a1')).toEqual(['rock']);
  expect(wikipedia.lookupGenresBulk).toHaveBeenCalledTimes(1); // the join-only supplement
  expect(vi.mocked(wikipedia.lookupGenresBulk).mock.calls[0][3]).toMatchObject({ nameSearch: false, infobox: false });
  expect(mb.lookupGenresBulk).toHaveBeenCalledTimes(1);
  expect(vi.mocked(mb.lookupGenresBulk).mock.calls[0][0]).toEqual([artist]); // supplement miss -> full artist list still goes to MB
  expect(cachedSource('a1')).toBe('musicbrainz');
});

it('a Wikidata join-supplement hit short-circuits MusicBrainz for that artist only', async () => {
  spotifyGenres(() => []);
  const artists = [artist, { id: 'a2', name: 'Massive Attack' }];
  vi.mocked(wikipedia.lookupGenresBulk).mockResolvedValue(new Map([['a1', ['trip hop']]])); // a1 hits the join, a2 doesn't
  vi.mocked(mb.lookupGenresBulk).mockResolvedValue(new Map([['a2', ['downtempo']]]));

  const result = await resolveAllGenres(artists, () => {}, undefined, { deep: true });

  expect(result.get('a1')).toEqual(['trip hop']);
  expect(cachedSource('a1')).toBe('wikipedia');
  expect(result.get('a2')).toEqual(['downtempo']);
  expect(cachedSource('a2')).toBe('musicbrainz');
  // MB only sees the artist the join missed — never re-does a1's work.
  expect(vi.mocked(mb.lookupGenresBulk).mock.calls[0][0]).toEqual([{ id: 'a2', name: 'Massive Attack' }]);
});

it('the join supplement is skipped when fallback is already "wikipedia" (its own bulk call already joins)', async () => {
  spotifyGenres(() => []);
  vi.mocked(wikipedia.lookupGenresBulk).mockResolvedValue(new Map([['a1', ['dream pop']]]));

  await resolveAllGenres([artist], () => {}, undefined, { deep: true, fallback: 'wikipedia' });

  expect(wikipedia.lookupGenresBulk).toHaveBeenCalledTimes(1); // not twice
  expect(mb.lookupGenresBulk).not.toHaveBeenCalled();
});

it('deep run with fallback: "wikipedia" routes to wikipedia and never calls MusicBrainz', async () => {
  spotifyGenres(() => []);
  vi.mocked(wikipedia.lookupGenresBulk).mockResolvedValue(new Map([['a1', ['dream pop']]]));

  const result = await resolveAllGenres([artist], () => {}, undefined, { deep: true, fallback: 'wikipedia' });

  expect(result.get('a1')).toEqual(['dream pop']);
  expect(wikipedia.lookupGenresBulk).toHaveBeenCalledTimes(1);
  expect(mb.lookupGenresBulk).not.toHaveBeenCalled();
});

it('a non-empty wikipedia result caches source: "wikipedia", counted by genreCoverage', async () => {
  spotifyGenres(() => []);
  vi.mocked(wikipedia.lookupGenresBulk).mockResolvedValue(new Map([['a1', ['dream pop']]]));

  await resolveAllGenres([artist], () => {}, undefined, { deep: true, fallback: 'wikipedia' });

  expect(cachedSource('a1')).toBe('wikipedia');
  expect(cachedGenres('a1')).toEqual(['dream pop']);
  expect(genreCoverage(['a1']))
    .toEqual({ spotify: 0, musicbrainz: 0, wikipedia: 1, none: 0, unresolved: 0 });
});

it('a wikipedia [] result caches durable "none"; an id absent from the map stays uncached and is retried', async () => {
  spotifyGenres(() => []);
  // a1 answered with [] (durable "nothing there"); a2 is entirely absent (transient failure).
  vi.mocked(wikipedia.lookupGenresBulk).mockResolvedValueOnce(new Map([['a1', []]]));

  const artists = [artist, { id: 'a2', name: 'Two' }];
  const result = await resolveAllGenres(artists, () => {}, undefined, { deep: true, fallback: 'wikipedia' });

  expect(result.get('a1')).toEqual([]);
  expect(cachedSource('a1')).toBe('none');
  expect(cachedGenres('a2')).toBeUndefined(); // absent from the map — never cached

  // A second deep run trusts the durable 'none' for a1 but retries a2.
  vi.mocked(wikipedia.lookupGenresBulk).mockClear();
  vi.mocked(wikipedia.lookupGenresBulk).mockResolvedValueOnce(new Map([['a2', ['k-pop']]]));
  const result2 = await resolveAllGenres(artists, () => {}, undefined, { deep: true, fallback: 'wikipedia' });

  expect(wikipedia.lookupGenresBulk).toHaveBeenCalledTimes(1);
  const retriedIds = vi.mocked(wikipedia.lookupGenresBulk).mock.calls[0][0].map((a: { id: string }) => a.id);
  expect(retriedIds).toEqual(['a2']); // a1 was NOT retried — its 'none' is durable
  expect(result2.get('a2')).toEqual(['k-pop']);
});

it('a deep run passes { nameSearch: true, infobox: true } to wikipedia', async () => {
  spotifyGenres(() => []);
  vi.mocked(wikipedia.lookupGenresBulk).mockResolvedValue(new Map([['a1', ['rock']]]));

  await resolveAllGenres([artist], () => {}, undefined, { deep: true, fallback: 'wikipedia' });

  const opts = vi.mocked(wikipedia.lookupGenresBulk).mock.calls[0][3];
  expect(opts).toMatchObject({ nameSearch: true, infobox: true });
});

it('the non-deep fast route never calls wikipedia, same as MusicBrainz', async () => {
  spotifyGenres(() => []); // everyone falls to the bulk provider path
  await resolveAllGenres([artist], () => {}, undefined, { fallback: 'wikipedia' });

  expect(wikipedia.lookupGenresBulk).not.toHaveBeenCalled();
  expect(mb.lookupGenresBulk).not.toHaveBeenCalled();
  expect(cachedSource('a1')).toBe('unresolved');
});
