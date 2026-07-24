import { afterEach, expect, it, vi } from 'vitest';
import { resolveAllGenres, resetResolverForTests, cachedGenres, genreCoverage } from './resolver';
import * as spotify from '../api/spotify';
import * as mb from '../api/musicbrainz';
import { SpotifyApiError } from '../api/spotify';

vi.mock('../api/spotify', async () => {
  const actual = await vi.importActual<typeof import('../api/spotify')>('../api/spotify');
  return { getArtistGenresBatch: vi.fn(), ARTIST_BATCH: 50, SpotifyApiError: actual.SpotifyApiError };
});
vi.mock('../api/musicbrainz', () => ({ lookupGenresBulk: vi.fn() }));

// The resolver asks Spotify for up to 50 artists per call, but these tests
// reason per-artist — so express the mock as a per-id function and let this
// wrap it back into the batch shape.
const spotifyGenres = (fn: (id: string) => string[]) =>
  vi.mocked(spotify.getArtistGenresBatch).mockImplementation(
    async (ids) => new Map(ids.map((id) => [id, fn(id)])),
  );

const artist = { id: 'a1', name: 'Portishead' };

afterEach(() => {
  localStorage.clear();
  resetResolverForTests();
  vi.clearAllMocks();
});

it('migrates v1 cache: spotify entries survive, other entries re-resolve via bulk MB', async () => {
  localStorage.setItem('kondo:genres:v1', JSON.stringify({
    a1: { genres: ['trip hop'], source: 'spotify' },
    a2: { genres: [], source: 'none' }, // poisoned by transliterated name search
  }));
  spotifyGenres(() => []);
  vi.mocked(mb.lookupGenresBulk).mockResolvedValue(new Map([['a2', ['rock']]]));

  const result = await resolveAllGenres([artist, { id: 'a2', name: 'Bravo' }], () => {}, undefined, { deep: true });

  expect(result.get('a1')).toEqual(['trip hop']); // served from migrated cache
  expect(result.get('a2')).toEqual(['rock']);
  const bulkIds = vi.mocked(mb.lookupGenresBulk).mock.calls[0][0].map((a: { id: string }) => a.id);
  expect(bulkIds).toEqual(['a2']); // a1 was cached — never sent to MB
  expect(localStorage.getItem('kondo:genres:v1')).toBeNull();
});

it('cachedGenres reads resolved genres back out of the cache', async () => {
  spotifyGenres(() => ['Trip Hop']);
  await resolveAllGenres([artist], () => {});
  expect(cachedGenres('a1')).toEqual(['trip hop']);
  expect(cachedGenres('missing')).toBeUndefined();
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

it('migrates v2 cache: none becomes unresolved (retryable), other sources unchanged', () => {
  localStorage.setItem('kondo:genres:v2', JSON.stringify({
    a1: { genres: [], source: 'none' },
    a2: { genres: ['rock'], source: 'spotify' },
  }));

  cachedGenres('a1'); // any cache read triggers the migration, synchronously

  const v3 = JSON.parse(localStorage.getItem('kondo:genres:v3')!);
  expect(v3.a1).toEqual({ genres: [], source: 'unresolved' });
  expect(v3.a2).toEqual({ genres: ['rock'], source: 'spotify' });
  expect(localStorage.getItem('kondo:genres:v2')).toBeNull();
});

it('genreCoverage counts cache sources, treating an absent id as unresolved', async () => {
  spotifyGenres((id) => (id === 'a1' ? ['Trip Hop'] : []));
  await resolveAllGenres([artist], () => {}); // a1 -> spotify
  vi.mocked(mb.lookupGenresBulk).mockResolvedValue(new Map([['a2', []]]));
  await resolveAllGenres([{ id: 'a2', name: 'Two' }], () => {}, undefined, { deep: true }); // a2 -> none

  expect(genreCoverage(['a1', 'a2', 'missing'])).toEqual({ spotify: 1, musicbrainz: 0, none: 1, unresolved: 1 });
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
