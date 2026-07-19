import { afterEach, expect, it, vi } from 'vitest';
import { resolveArtistGenres, resolveAllGenres, resetResolverForTests } from './resolver';
import * as spotify from '../api/spotify';
import * as mb from '../api/musicbrainz';
import { SpotifyApiError } from '../api/spotify';

vi.mock('../api/spotify', async () => {
  const actual = await vi.importActual<typeof import('../api/spotify')>('../api/spotify');
  return { getArtistGenres: vi.fn(), SpotifyApiError: actual.SpotifyApiError };
});
vi.mock('../api/musicbrainz', () => ({ lookupArtistGenres: vi.fn(), lookupGenresBulk: vi.fn() }));

const artist = { id: 'a1', name: 'Portishead' };

afterEach(() => {
  localStorage.clear();
  resetResolverForTests();
  vi.clearAllMocks();
});

it('uses Spotify genres when available and caches them', async () => {
  vi.mocked(spotify.getArtistGenres).mockResolvedValue(['Trip Hop']);
  expect(await resolveArtistGenres(artist)).toEqual({ genres: ['trip hop'], source: 'spotify' });
  // Second call is served from cache — no new API calls.
  expect(await resolveArtistGenres(artist)).toEqual({ genres: ['trip hop'], source: 'spotify' });
  expect(spotify.getArtistGenres).toHaveBeenCalledTimes(1);
  expect(mb.lookupArtistGenres).not.toHaveBeenCalled();
});

it('falls back to MusicBrainz when Spotify has no genres', async () => {
  vi.mocked(spotify.getArtistGenres).mockResolvedValue([]);
  vi.mocked(mb.lookupArtistGenres).mockResolvedValue(['trip hop']);
  expect(await resolveArtistGenres(artist)).toEqual({ genres: ['trip hop'], source: 'musicbrainz' });
});

it('disables Spotify for the session after a 403 (access revoked)', async () => {
  vi.mocked(spotify.getArtistGenres).mockRejectedValue(new SpotifyApiError('Spotify API 403', 403));
  vi.mocked(mb.lookupArtistGenres).mockResolvedValue([]);
  await resolveArtistGenres(artist);
  await resolveArtistGenres({ id: 'a2', name: 'Other' });
  expect(spotify.getArtistGenres).toHaveBeenCalledTimes(1); // sticky flag stopped call #2
});

it('does not disable Spotify on a per-artist 404 — falls back to MB for that artist only', async () => {
  vi.mocked(spotify.getArtistGenres).mockRejectedValue(new SpotifyApiError('Spotify API 404', 404));
  vi.mocked(mb.lookupArtistGenres).mockResolvedValue([]);
  await resolveArtistGenres(artist);
  await resolveArtistGenres({ id: 'a2', name: 'Other' });
  expect(spotify.getArtistGenres).toHaveBeenCalledTimes(2); // flag stayed on — call #2 still tried
});

it('does not disable Spotify on a transient error — falls back to MB for that artist only', async () => {
  vi.mocked(spotify.getArtistGenres).mockRejectedValue(new SpotifyApiError('Spotify API 502', 502));
  vi.mocked(mb.lookupArtistGenres).mockResolvedValue([]);
  await resolveArtistGenres(artist);
  await resolveArtistGenres({ id: 'a2', name: 'Other' });
  expect(spotify.getArtistGenres).toHaveBeenCalledTimes(2);
});

it('migrates v1 cache: spotify entries survive, name-search MB/none entries re-resolve', async () => {
  localStorage.setItem('kondo:genres:v1', JSON.stringify({
    a1: { genres: ['trip hop'], source: 'spotify' },
    a2: { genres: [], source: 'none' }, // poisoned by transliterated name search
  }));
  vi.mocked(spotify.getArtistGenres).mockResolvedValue([]);
  vi.mocked(mb.lookupArtistGenres).mockResolvedValue(['rock']);
  expect(await resolveArtistGenres(artist)).toEqual({ genres: ['trip hop'], source: 'spotify' });
  expect(mb.lookupArtistGenres).not.toHaveBeenCalled(); // served from migrated cache
  expect(await resolveArtistGenres({ id: 'a2', name: 'Bravo' })).toEqual({ genres: ['rock'], source: 'musicbrainz' });
  expect(localStorage.getItem('kondo:genres:v1')).toBeNull();
});

it('returns source none when nothing is found (and caches it)', async () => {
  vi.mocked(spotify.getArtistGenres).mockResolvedValue([]);
  vi.mocked(mb.lookupArtistGenres).mockResolvedValue([]);
  expect(await resolveArtistGenres(artist)).toEqual({ genres: [], source: 'none' });
  expect(await resolveArtistGenres(artist)).toEqual({ genres: [], source: 'none' });
  expect(mb.lookupArtistGenres).toHaveBeenCalledTimes(1);
});

// -- resolveAllGenres --------------------------------------------------------

it('resolves cached artists immediately, counting them up front, without any fetches', async () => {
  vi.mocked(spotify.getArtistGenres).mockResolvedValue(['Trip Hop']);
  await resolveArtistGenres(artist); // warms the cache
  vi.mocked(spotify.getArtistGenres).mockClear();

  const onProgress = vi.fn();
  const result = await resolveAllGenres([artist], onProgress);

  expect(result.get('a1')).toEqual(['trip hop']);
  expect(spotify.getArtistGenres).not.toHaveBeenCalled();
  expect(mb.lookupGenresBulk).not.toHaveBeenCalled();
  expect(onProgress).toHaveBeenCalledWith(1, 1); // cache hit counted up front
  expect(onProgress).toHaveBeenLastCalledWith(1, 1);
});

it('resolves uncached artists via the Spotify pool, skipping MB entirely on success', async () => {
  vi.mocked(spotify.getArtistGenres).mockImplementation(async (id) =>
    id === 'a1' ? ['Trip Hop'] : ['Rock'],
  );

  const artists = [artist, { id: 'a2', name: 'Other' }];
  const onProgress = vi.fn();
  const result = await resolveAllGenres(artists, onProgress);

  expect(result.get('a1')).toEqual(['trip hop']);
  expect(result.get('a2')).toEqual(['rock']);
  expect(spotify.getArtistGenres).toHaveBeenCalledTimes(2);
  expect(mb.lookupGenresBulk).not.toHaveBeenCalled();
  expect(onProgress).toHaveBeenLastCalledWith(2, 2);

  // Cached now — a second run touches neither API.
  vi.mocked(spotify.getArtistGenres).mockClear();
  await resolveAllGenres(artists, () => {});
  expect(spotify.getArtistGenres).not.toHaveBeenCalled();
});

it('sends artists with no Spotify genres to bulk MB, tagging results by source', async () => {
  vi.mocked(spotify.getArtistGenres).mockResolvedValue([]); // no genres on Spotify for anyone
  vi.mocked(mb.lookupGenresBulk).mockImplementation(async (as, onProgress) => {
    onProgress?.(as.length, as.length);
    return new Map(as.map((a: { id: string }) => [a.id, a.id === 'a1' ? ['trip hop'] : []]));
  });

  const artists = [artist, { id: 'a2', name: 'Other' }];
  const onProgress = vi.fn();
  const result = await resolveAllGenres(artists, onProgress);

  expect(result.get('a1')).toEqual(['trip hop']);
  expect(result.get('a2')).toEqual([]);
  expect(mb.lookupGenresBulk).toHaveBeenCalledTimes(1);
  const bulkArgs = vi.mocked(mb.lookupGenresBulk).mock.calls[0][0];
  expect(bulkArgs.map((a: { id: string }) => a.id).sort()).toEqual(['a1', 'a2']);
  expect(onProgress).toHaveBeenLastCalledWith(2, 2);

  // a1 cached as musicbrainz, a2 cached as none — re-run touches nothing.
  vi.mocked(spotify.getArtistGenres).mockClear();
  vi.mocked(mb.lookupGenresBulk).mockClear();
  await resolveAllGenres(artists, () => {});
  expect(spotify.getArtistGenres).not.toHaveBeenCalled();
  expect(mb.lookupGenresBulk).not.toHaveBeenCalled();
});

it('flips spotifyGenresAvailable on a 403 mid-run and routes the remainder to bulk MB', async () => {
  // 7 uncached artists: pool concurrency is 6, so the 7th sits in the queue
  // until a worker frees up — it must never attempt Spotify once the flag flips.
  const artists = Array.from({ length: 7 }, (_, i) => ({ id: `a${i}`, name: `Artist${i}` }));
  const resolvers: ((v: string[]) => void)[] = [];
  const rejecters: ((e: unknown) => void)[] = [];
  vi.mocked(spotify.getArtistGenres).mockImplementation(() => new Promise((resolve, reject) => {
    resolvers.push(resolve);
    rejecters.push(reject);
  }));
  vi.mocked(mb.lookupGenresBulk).mockResolvedValue(new Map());

  const onProgress = vi.fn();
  const resultPromise = resolveAllGenres(artists, onProgress);

  // Let the pool's first 6 workers dispatch their calls.
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(spotify.getArtistGenres).toHaveBeenCalledTimes(6); // 7th not yet attempted — pool is full

  // The first artist's Spotify call 403s -> flips the flag off for the session.
  rejecters[0](new SpotifyApiError('Spotify API 403', 403));
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

  // Resolve the other in-flight calls with genres so they succeed via Spotify.
  for (let i = 1; i < 6; i++) resolvers[i](['rock']);
  await resultPromise;

  // The 7th artist was freed up only after the flag flipped off — never attempted.
  expect(spotify.getArtistGenres).toHaveBeenCalledTimes(6);
  expect(mb.lookupGenresBulk).toHaveBeenCalledTimes(1);
  const bulkIds = vi.mocked(mb.lookupGenresBulk).mock.calls[0][0].map((a: { id: string }) => a.id).sort();
  expect(bulkIds).toEqual(['a0', 'a6']); // a0: 403'd itself; a6: skipped straight to MB
});

it('reaches (total, total) progress exactly for a mix of cached, Spotify, and MB artists', async () => {
  vi.mocked(spotify.getArtistGenres).mockResolvedValue(['Trip Hop']);
  await resolveArtistGenres(artist); // a1 cached via spotify
  vi.mocked(spotify.getArtistGenres).mockImplementation(async (id) =>
    id === 'a2' ? ['Rock'] : [],
  );
  vi.mocked(mb.lookupGenresBulk).mockImplementation(async (as, onProgress) => {
    onProgress?.(as.length, as.length);
    return new Map(as.map((a: { id: string }) => [a.id, []]));
  });

  const artists = [artist, { id: 'a2', name: 'Two' }, { id: 'a3', name: 'Three' }];
  const onProgress = vi.fn();
  await resolveAllGenres(artists, onProgress);

  expect(onProgress).toHaveBeenLastCalledWith(3, 3);
  // Progress must be monotonically non-decreasing.
  const calls = vi.mocked(onProgress).mock.calls.map(([r]) => r);
  for (let i = 1; i < calls.length; i++) expect(calls[i]).toBeGreaterThanOrEqual(calls[i - 1]);
});
