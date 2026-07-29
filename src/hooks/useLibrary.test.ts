import { afterEach, expect, it, vi } from 'vitest';
import { enrichLibrary, loadLibrary, loadTracksAndPlaylists } from './useLibrary';
import * as spotify from '../api/spotify';
import * as resolver from '../genre/resolver';
import { matchSong } from '../matching/engine';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useLibrary } from './useLibrary';
import { writeSnapshot, readSnapshot, resetSnapshotForTests, compactPlaylists, clearSnapshot } from '../storage/librarySnapshot';

vi.mock('../api/spotify', async () => {
  const actual = await vi.importActual<typeof import('../api/spotify')>('../api/spotify');
  return {
    getSavedTracks: vi.fn(),
    getMyPlaylists: vi.fn(),
    getPlaylistTracks: vi.fn(),
    // Real class and real gate accessors — the hook's behavior depends on
    // `instanceof` matching, which a stub would silently break.
    RateLimitedError: actual.RateLimitedError,
    getRateLimitedUntil: actual.getRateLimitedUntil,
    subscribeRateLimit: actual.subscribeRateLimit,
    resetRateLimitForTests: actual.resetRateLimitForTests,
  };
});
vi.mock('../genre/resolver', () => ({
  resolveAllGenres: vi.fn(),
  genreCoverage: vi.fn(() => ({ spotify: 0, musicbrainz: 0, none: 0, unresolved: 0 })),
}));

afterEach(() => {
  localStorage.clear();
  resetSnapshotForTests();
  // The gate is module-global and memoises its localStorage read, so clearing
  // storage alone would leave a seeded penalty live for every later test.
  spotify.resetRateLimitForTests();
  vi.clearAllMocks();
  // clearAllMocks keeps implementations, so a vi.spyOn stub (e.g. the
  // console.warn silencer in the 403 test) would leak into every later test.
  vi.restoreAllMocks();
});

const likedTrack = {
  id: 't1', uri: 'spotify:track:t1', name: 'Glory Box',
  artists: [{ id: 'a1', name: 'Portishead' }],
  albumName: 'Dummy', releaseYear: 1994, isrc: null, addedAt: '2024-01-01T00:00:00Z',
};

/** Re-stamp the stored snapshot so it looks `ageMs` old. */
function ageSnapshot(ageMs: number): void {
  const raw = JSON.parse(localStorage.getItem('kondo:library:v1')!);
  localStorage.setItem('kondo:library:v1', JSON.stringify({ ...raw, savedAt: Date.now() - ageMs }));
}

/** Put a live penalty on the *real* rate-limit gate — the one useRateLimit
 *  polls. Constructing a RateLimitedError by hand does not touch it, so
 *  without this the countdown reads 0 and nothing ever auto-resumes. */
function seedRateLimit(ms: number): void {
  localStorage.setItem('kondo:ratelimit:v1', String(Date.now() + ms));
  spotify.resetRateLimitForTests(); // drops the memoised read so the seed is picked up
}

it('loads, resolves genres per unique artist, fingerprints, and matches', async () => {
  vi.mocked(spotify.getSavedTracks).mockResolvedValue([likedTrack]);
  vi.mocked(spotify.getMyPlaylists).mockResolvedValue([
    { id: 'p1', name: 'Trip', trackCount: 1 },
    { id: 'p2', name: 'Excluded', trackCount: 1 },
  ]);
  vi.mocked(spotify.getPlaylistTracks).mockResolvedValue([
    { name: 'Angel', artists: [{ id: 'a2', name: 'Massive Attack' }], releaseYear: 1998, isrc: null },
  ]);
  vi.mocked(resolver.resolveAllGenres).mockImplementation(async (artists, onProgress) => {
    onProgress(0, artists.length);
    onProgress(artists.length, artists.length);
    return new Map(artists.map((a) => [a.id, ['trip hop']]));
  });

  const progress: [number, number][] = [];
  const lib = await loadLibrary(
    { targetPlaylistIds: ['p1'], threshold: 0.3, sortOrder: 'oldest' },
    (r, t) => progress.push([r, t]),
  );

  expect(lib.playlists.map((p) => p.id)).toEqual(['p1']); // p2 filtered out
  expect(lib.allPlaylists.map((p) => p.id)).toEqual(['p1', 'p2']); // unfiltered, for Settings
  expect(spotify.getPlaylistTracks).toHaveBeenCalledTimes(1); // only target playlists fetched
  // 2 unique artists (a1 liked, a2 in playlist) → resolveAllGenres called once with both.
  expect(resolver.resolveAllGenres).toHaveBeenCalledTimes(1);
  expect(vi.mocked(resolver.resolveAllGenres).mock.calls[0][0].map((a) => a.id).sort()).toEqual(['a1', 'a2']);
  expect(progress[0]).toEqual([0, 2]); // total is visible before the slow work starts
  expect(progress.at(-1)).toEqual([2, 2]);
  expect(lib.genresByTrack.get('t1')).toEqual(['trip hop']);
  const match = matchSong(
    { genres: lib.genresByTrack.get('t1') ?? [], releaseYear: likedTrack.releaseYear },
    lib.fingerprints,
    0.3,
  );
  expect(match.best?.playlistId).toBe('p1');
  expect(match.belowThreshold).toBe(false);
});

it('skips playlists whose tracks are unreadable (403) instead of failing the load', async () => {
  vi.mocked(spotify.getSavedTracks).mockResolvedValue([likedTrack]);
  vi.mocked(spotify.getMyPlaylists).mockResolvedValue([
    { id: 'p1', name: 'Trip', trackCount: 1 },
    { id: 'blend', name: 'Blend', trackCount: 0 },
  ]);
  vi.mocked(spotify.getPlaylistTracks).mockImplementation(async (id) => {
    if (id === 'blend') throw new Error('Spotify API 403 for …/playlists/blend/tracks');
    return [{ name: 'Glory Box', artists: [{ id: 'a1', name: 'Portishead' }], releaseYear: 1994, isrc: null }];
  });
  vi.mocked(resolver.resolveAllGenres).mockImplementation(async (artists) =>
    new Map(artists.map((a) => [a.id, ['trip hop']])),
  );

  const lib = await loadLibrary(
    { targetPlaylistIds: null, threshold: 0.3, sortOrder: 'oldest' },
    () => {},
  );

  const match = matchSong(
    { genres: lib.genresByTrack.get('t1') ?? [], releaseYear: likedTrack.releaseYear },
    lib.fingerprints,
    0.3,
  );
  expect(match.best?.playlistId).toBe('p1');
  // The unreadable playlist must not appear as a candidate at all.
  expect([match.best, ...match.alternates].map((m) => m?.playlistId)).not.toContain('blend');
});

it('reports no matches while enriching so rows render the placeholder', async () => {
  vi.mocked(spotify.getSavedTracks).mockResolvedValue([likedTrack]);
  vi.mocked(spotify.getMyPlaylists).mockResolvedValue([
    { id: 'p1', name: 'Trip', trackCount: 1 },
  ]);
  vi.mocked(spotify.getPlaylistTracks).mockResolvedValue([
    { name: 'Glory Box', artists: [{ id: 'a1', name: 'Portishead' }], releaseYear: 1994, isrc: null },
  ]);
  // Hold genre resolution open so the hook sits in 'enriching' until we let go.
  let release!: (v: Map<string, string[]>) => void;
  vi.mocked(resolver.resolveAllGenres).mockReturnValue(
    new Promise((r) => { release = r; }),
  );

  const { result } = renderHook(() =>
    useLibrary({ targetPlaylistIds: ['p1'], threshold: 0.3, sortOrder: 'oldest' }),
  );

  await waitFor(() => expect(result.current.status).toBe('enriching'));
  // Regression guard: with empty fingerprints, a computed match would be
  // { best: null } and every row would say "no candidate playlists".
  // No entry at all → MatchPicker shows its "…" placeholder.
  expect(result.current.matches.get('t1')).toBeUndefined();

  release(new Map([['a1', ['trip hop']]]));
  await waitFor(() => expect(result.current.status).toBe('ready'));
  expect(result.current.matches.get('t1')?.best?.playlistId).toBe('p1');
});

it('produces matches (best: null) once ready even with zero target playlists — fingerprints never populate', async () => {
  vi.mocked(spotify.getSavedTracks).mockResolvedValue([likedTrack]);
  vi.mocked(spotify.getMyPlaylists).mockResolvedValue([{ id: 'p1', name: 'Trip', trackCount: 1 }]);
  vi.mocked(resolver.resolveAllGenres).mockResolvedValue(new Map([['a1', ['trip hop']]]));

  const { result } = renderHook(() =>
    useLibrary({ targetPlaylistIds: [], threshold: 0.3, sortOrder: 'oldest' }),
  );

  await waitFor(() => expect(result.current.status).toBe('ready'));
  expect(result.current.fingerprints.size).toBe(0); // zero target playlists — never populated
  expect(result.current.matches.get('t1')).toEqual(
    expect.objectContaining({ best: null, belowThreshold: true }),
  );
});

it('deepResolveAll re-enriches the whole library deep', async () => {
  vi.mocked(spotify.getSavedTracks).mockResolvedValue([]);
  vi.mocked(spotify.getMyPlaylists).mockResolvedValue([{ id: 'p1', name: 'Trip', trackCount: 1 }]);
  vi.mocked(spotify.getPlaylistTracks).mockResolvedValue([
    { name: 'Obscure', artists: [{ id: 'a2', name: 'Браво' }], releaseYear: 2000, isrc: null },
  ]);
  // Fast initial load: a2 got no genre and was left unresolved.
  vi.mocked(resolver.resolveAllGenres).mockResolvedValue(new Map([['a2', []]]));

  const { result } = renderHook(() =>
    useLibrary({ targetPlaylistIds: ['p1'], threshold: 0.3, sortOrder: 'oldest' }),
  );
  await waitFor(() => expect(result.current.status).toBe('ready'));
  expect(result.current.fingerprints.get('p1')?.genreWeights.size ?? 0).toBe(0);

  // Deep pass now finds a genre.
  vi.mocked(resolver.resolveAllGenres).mockResolvedValue(new Map([['a2', ['rock']]]));

  await act(async () => { await result.current.deepResolveAll(); });

  expect(result.current.fingerprints.get('p1')?.genreWeights.has('rock')).toBe(true);
  expect(result.current.deepState).toBe('done');
  // deep pass ran the full waterfall:
  expect(vi.mocked(resolver.resolveAllGenres).mock.calls.at(-1)?.[3]).toEqual({ deep: true });
});

it('deepResolveAll sets deepState to error when the deep pass rejects', async () => {
  vi.mocked(spotify.getSavedTracks).mockResolvedValue([likedTrack]);
  vi.mocked(spotify.getMyPlaylists).mockResolvedValue([{ id: 'p1', name: 'Trip', trackCount: 1 }]);
  vi.mocked(spotify.getPlaylistTracks).mockResolvedValue([
    { name: 'Angel', artists: [{ id: 'a2', name: 'Massive Attack' }], releaseYear: 1998, isrc: null },
  ]);
  vi.mocked(resolver.resolveAllGenres).mockResolvedValueOnce(new Map([['a1', []], ['a2', []]]));

  const { result } = renderHook(() =>
    useLibrary({ targetPlaylistIds: ['p1'], threshold: 0.3, sortOrder: 'oldest' }),
  );
  await waitFor(() => expect(result.current.status).toBe('ready'));

  vi.mocked(resolver.resolveAllGenres).mockRejectedValueOnce(new Error('MusicBrainz unreachable'));

  await act(async () => { await result.current.deepResolveAll(); });

  expect(result.current.deepState).toBe('error');
});

// -- incremental enrichment flush --------------------------------------------

it('flushes a partial rebuild once progress advances by >=100 artists, using only genres resolved so far', async () => {
  const total = 150;
  const artists = Array.from({ length: total }, (_, i) => ({ id: `a${i}`, name: `Artist${i}` }));
  const genreOf = (id: string) => (id === 'a149' ? ['punk'] : ['rock']);
  vi.mocked(spotify.getPlaylistTracks).mockResolvedValue(
    artists.map((a) => ({ name: `Song ${a.id}`, artists: [a], releaseYear: 2000, isrc: null })),
  );
  vi.mocked(resolver.resolveAllGenres).mockImplementation(async (as, onProgress, sink) => {
    for (let i = 0; i < 120; i++) sink?.(as[i].id, genreOf(as[i].id));
    onProgress(120, as.length); // one big jump — crosses the 100-artist threshold
    for (let i = 120; i < as.length; i++) sink?.(as[i].id, genreOf(as[i].id));
    onProgress(as.length, as.length);
    return new Map(as.map((a) => [a.id, genreOf(a.id)]));
  });

  const partials: { genresByTrack: Map<string, string[]>; fingerprints: Map<string, import('../matching/engine').Fingerprint> }[] = [];
  const final = await enrichLibrary(
    { tracks: [], playlists: [{ id: 'p1', name: 'Big', trackCount: total }] },
    () => {},
    (partial) => partials.push(partial),
  );

  expect(partials).toHaveLength(1); // exactly one flush — the single >=100 jump
  const partialFp = partials[0].fingerprints.get('p1')!;
  expect(partialFp.genreWeights.has('rock')).toBe(true); // a0..a119 resolved
  expect(partialFp.genreWeights.has('punk')).toBe(false); // a149 not resolved yet

  // Final data overwrites the partial — a149's genre now included.
  const finalFp = final.fingerprints.get('p1')!;
  expect(finalFp.genreWeights.has('punk')).toBe(true);
});

it('does not flush partial data for small libraries (<100 artists) until the run completes', async () => {
  const artists = Array.from({ length: 50 }, (_, i) => ({ id: `b${i}`, name: `Artist${i}` }));
  vi.mocked(spotify.getPlaylistTracks).mockResolvedValue(
    artists.map((a) => ({ name: `Song ${a.id}`, artists: [a], releaseYear: 2000, isrc: null })),
  );
  vi.mocked(resolver.resolveAllGenres).mockImplementation(async (as, onProgress, sink) => {
    for (const a of as) sink?.(a.id, ['rock']);
    onProgress(as.length, as.length); // single tick straight to completion, <100 total
    return new Map(as.map((a) => [a.id, ['rock']]));
  });

  const onPartial = vi.fn();
  await enrichLibrary(
    { tracks: [], playlists: [{ id: 'p1', name: 'Small', trackCount: 50 }] },
    () => {},
    onPartial,
  );

  expect(onPartial).not.toHaveBeenCalled();
});

it('surfaces interim matches from a partial flush while status is still enriching', async () => {
  const total = 150;
  const bigArtists = Array.from({ length: total }, (_, i) => ({ id: `c${i}`, name: `Artist${i}` }));
  vi.mocked(spotify.getSavedTracks).mockResolvedValue([
    { ...likedTrack, id: 'lt1', artists: [bigArtists[0]] }, // resolves in the first (partial) batch
  ]);
  vi.mocked(spotify.getMyPlaylists).mockResolvedValue([{ id: 'p1', name: 'Big', trackCount: total }]);
  vi.mocked(spotify.getPlaylistTracks).mockResolvedValue(
    bigArtists.map((a) => ({ name: `Song ${a.id}`, artists: [a], releaseYear: 1994, isrc: null })),
  );

  let releaseRest!: () => void;
  const restGate = new Promise<void>((r) => { releaseRest = r; });
  vi.mocked(resolver.resolveAllGenres).mockImplementation(async (as, onProgress, sink) => {
    for (let i = 0; i < 120; i++) sink?.(as[i].id, ['trip hop']);
    onProgress(120, as.length);
    await restGate; // hold here — hook must stay in 'enriching' with only the partial applied
    for (let i = 120; i < as.length; i++) sink?.(as[i].id, ['trip hop']);
    onProgress(as.length, as.length);
    return new Map(as.map((a) => [a.id, ['trip hop']]));
  });

  const { result } = renderHook(() =>
    useLibrary({ targetPlaylistIds: ['p1'], threshold: 0.3, sortOrder: 'oldest' }),
  );

  await waitFor(() => expect(result.current.status).toBe('enriching'));
  await waitFor(() => expect(result.current.matches.get('lt1')?.best?.playlistId).toBe('p1'));
  expect(result.current.status).toBe('enriching'); // still enriching — this is an interim match

  releaseRest();
  await waitFor(() => expect(result.current.status).toBe('ready'));
});

it('flushes mid-MB-phase end-to-end (real resolveAllGenres + real lookupGenresBulk, Spotify disabled)', async () => {
  // The other tests above mock resolver.resolveAllGenres wholesale, which
  // proves useLibrary's own throttle/rebuild logic but not the real wiring
  // from MB chunk landings all the way up to onPartial. On the cold-cache
  // path Spotify genre access is usually revoked (403), so nearly everything
  // resolves via lookupGenresBulk — this test unmocks resolver and exercises
  // the real resolver.ts + real musicbrainz.ts (fetch mocked) to confirm a
  // partial flush actually happens mid-MB-phase, not just once resolver
  // hands back its final Map.
  localStorage.clear();
  vi.doMock('../api/spotify', async () => {
    const actual = await vi.importActual<typeof import('../api/spotify')>('../api/spotify');
    return {
      getSavedTracks: vi.fn(), getMyPlaylists: vi.fn(), getPlaylistTracks: vi.fn(),
      getArtistGenresBatch: vi.fn(), ARTIST_BATCH: 50, SpotifyApiError: actual.SpotifyApiError,
    };
  });
  vi.doUnmock('../genre/resolver');
  vi.resetModules();

  const freshSpotify = await import('../api/spotify');
  const total = 150; // 3 arid-search chunks of 50 — the flush must land after chunk 2, before chunk 3
  const artists = Array.from({ length: total }, (_, i) => ({ id: `m${i}`, name: `Artist${i}` }));
  vi.mocked(freshSpotify.getPlaylistTracks).mockResolvedValue(
    artists.map((a) => ({ name: `Song ${a.id}`, artists: [a], releaseYear: 2000, isrc: null })),
  );
  // Every 50-artist batch 403s; the first flips spotifyGenresAvailable off and
  // all 150 fall through to the MB path this test actually exercises.
  vi.mocked(freshSpotify.getArtistGenresBatch).mockRejectedValue(
    new freshSpotify.SpotifyApiError('Spotify API 403', 403),
  );

  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    const json = (body: object) => new Response(JSON.stringify(body), { status: 200 });
    if (url.includes('/genre/all')) return new Response('rock', { status: 200 });
    if (url.includes('/url?')) {
      const resources = [...url.matchAll(/resource=([^&]+)/g)].map((m) => decodeURIComponent(m[1]));
      return json({
        urls: resources.map((r) => ({
          resource: r,
          relations: [{ artist: { id: `mbid-${r.split('/').pop()}` } }],
        })),
      });
    }
    const query = decodeURIComponent(url.match(/query=([^&]+)/)?.[1] ?? '');
    const aridMatch = query.match(/^arid:\((.+)\)$/);
    if (aridMatch) {
      const mbids = aridMatch[1].split(' OR ');
      return json({ artists: mbids.map((id) => ({ id, tags: [{ name: 'Rock', count: 5 }] })) });
    }
    return json({ artists: [] }); // name-search fallback — not expected to be hit here
  });

  const { enrichLibrary: realEnrichLibrary } = await import('./useLibrary');

  const partials: unknown[] = [];
  vi.useFakeTimers();
  const resultPromise = realEnrichLibrary(
    { tracks: [], playlists: [{ id: 'p1', name: 'Big', trackCount: total }] },
    () => {},
    (partial) => partials.push(partial),
    { deep: true }, // MB only runs in a deep pass now — this test exercises that path
  );
  await vi.runAllTimersAsync();
  await resultPromise;
  vi.useRealTimers();

  expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes('query=arid'))).toBe(true); // confirms MB path resolved these, not Spotify
  expect(partials.length).toBeGreaterThan(0); // the bug this fixes: zero flushes during a real MB-only run

  // Restore the module-level mock for any tests appended after this one.
  vi.doMock('../genre/resolver', () => ({
    resolveAllGenres: vi.fn(),
    genreCoverage: vi.fn(() => ({ spotify: 0, musicbrainz: 0, none: 0, unresolved: 0 })),
  }));
});

// -- snapshot wiring ----------------------------------------------------------

it('serves a fresh snapshot without touching Spotify', async () => {
  const { items, artistNames } = compactPlaylists(new Map([['p1', [
    { name: 'Angel', artists: [{ id: 'a2', name: 'Massive Attack' }], releaseYear: 1998, isrc: null },
  ]]]));
  writeSnapshot({
    tracks: [likedTrack],
    playlists: [{ id: 'p1', name: 'Trip', trackCount: 1 }],
    items, artistNames,
  });
  vi.mocked(resolver.resolveAllGenres).mockResolvedValue(new Map([['a1', ['trip hop']], ['a2', ['trip hop']]]));

  const lib = await loadLibrary(
    { targetPlaylistIds: ['p1'], threshold: 0.3, sortOrder: 'oldest' },
    () => {},
  );

  expect(spotify.getSavedTracks).not.toHaveBeenCalled();
  expect(spotify.getMyPlaylists).not.toHaveBeenCalled();
  expect(spotify.getPlaylistTracks).not.toHaveBeenCalled();
  expect(lib.tracks).toEqual([likedTrack]);
  expect(lib.fingerprints.get('p1')?.size).toBe(1);
  // Artist names survive the round trip — a deep MusicBrainz run needs them.
  expect(vi.mocked(resolver.resolveAllGenres).mock.calls[0][0]
    .find((a) => a.id === 'a2')?.name).toBe('Massive Attack');
});

it('fetches only the playlists missing from the snapshot', async () => {
  const { items, artistNames } = compactPlaylists(new Map([['p1', [
    { name: 'Angel', artists: [{ id: 'a2', name: 'Massive Attack' }], releaseYear: 1998, isrc: null },
  ]]]));
  writeSnapshot({
    tracks: [likedTrack],
    playlists: [
      { id: 'p1', name: 'Trip', trackCount: 1 },
      { id: 'p2', name: 'New target', trackCount: 1 },
    ],
    items, artistNames,
  });
  vi.mocked(spotify.getPlaylistTracks).mockResolvedValue([
    { name: 'Protection', artists: [{ id: 'a3', name: 'Tracey Thorn' }], releaseYear: 1994, isrc: null },
  ]);
  vi.mocked(resolver.resolveAllGenres).mockImplementation(async (artists) =>
    new Map(artists.map((a) => [a.id, ['trip hop']])));

  await loadLibrary({ targetPlaylistIds: ['p1', 'p2'], threshold: 0.3, sortOrder: 'oldest' }, () => {});

  expect(spotify.getPlaylistTracks).toHaveBeenCalledTimes(1);
  expect(spotify.getPlaylistTracks).toHaveBeenCalledWith('p2');
  expect(Object.keys(readSnapshot()!.items).sort()).toEqual(['p1', 'p2']);
});

it('refetches when the snapshot has aged past the TTL', async () => {
  writeSnapshot({ tracks: [likedTrack], playlists: [{ id: 'p1', name: 'Trip', trackCount: 1 }] });
  // Age it out in place.
  const raw = JSON.parse(localStorage.getItem('kondo:library:v1')!);
  localStorage.setItem('kondo:library:v1', JSON.stringify({ ...raw, savedAt: 0 }));

  vi.mocked(spotify.getSavedTracks).mockResolvedValue([likedTrack]);
  vi.mocked(spotify.getMyPlaylists).mockResolvedValue([{ id: 'p1', name: 'Trip', trackCount: 1 }]);
  vi.mocked(spotify.getPlaylistTracks).mockResolvedValue([]);
  vi.mocked(resolver.resolveAllGenres).mockResolvedValue(new Map());

  await loadLibrary({ targetPlaylistIds: ['p1'], threshold: 0.3, sortOrder: 'oldest' }, () => {});

  expect(spotify.getSavedTracks).toHaveBeenCalledTimes(1);
});

it('refetches playlist items when the snapshot has aged past the TTL, not just tracks/playlists', async () => {
  const { items, artistNames } = compactPlaylists(new Map([['p1', [
    { name: 'Angel', artists: [{ id: 'a2', name: 'Massive Attack' }], releaseYear: 1998, isrc: null },
  ]]]));
  writeSnapshot({
    tracks: [likedTrack],
    playlists: [{ id: 'p1', name: 'Trip', trackCount: 1 }],
    items, artistNames,
  });
  // Age it out in place — the stale items must not survive the refetch.
  const raw = JSON.parse(localStorage.getItem('kondo:library:v1')!);
  localStorage.setItem('kondo:library:v1', JSON.stringify({ ...raw, savedAt: 0 }));

  vi.mocked(spotify.getSavedTracks).mockResolvedValue([likedTrack]);
  vi.mocked(spotify.getMyPlaylists).mockResolvedValue([{ id: 'p1', name: 'Trip', trackCount: 1 }]);
  vi.mocked(spotify.getPlaylistTracks).mockResolvedValue([
    { name: 'Angel', artists: [{ id: 'a2', name: 'Massive Attack' }], releaseYear: 1998, isrc: null },
  ]);
  vi.mocked(resolver.resolveAllGenres).mockResolvedValue(new Map([['a1', ['trip hop']], ['a2', ['trip hop']]]));

  await loadLibrary({ targetPlaylistIds: ['p1'], threshold: 0.3, sortOrder: 'oldest' }, () => {});

  expect(spotify.getPlaylistTracks).toHaveBeenCalledTimes(1);
});

it('a load that fetches nothing does not extend the snapshot TTL', async () => {
  const { items, artistNames } = compactPlaylists(new Map([['p1', [
    { name: 'Angel', artists: [{ id: 'a2', name: 'Massive Attack' }], releaseYear: 1998, isrc: null },
  ]]]));
  writeSnapshot({
    tracks: [likedTrack],
    playlists: [{ id: 'p1', name: 'Trip', trackCount: 1 }],
    items, artistNames,
  });
  const savedAt = readSnapshot()!.savedAt;
  vi.mocked(resolver.resolveAllGenres).mockResolvedValue(new Map([['a1', ['trip hop']], ['a2', ['trip hop']]]));

  vi.useFakeTimers();
  vi.setSystemTime(savedAt + 1000); // time has moved on since the snapshot was written
  await loadLibrary({ targetPlaylistIds: ['p1'], threshold: 0.3, sortOrder: 'oldest' }, () => {});
  vi.useRealTimers();

  expect(readSnapshot()!.savedAt).toBe(savedAt);
});

it('a load whose only target playlist 403s does not extend the snapshot TTL', async () => {
  // p1 has no cached items — same state a 403'ing playlist is stuck in
  // forever (see the ponytail on `missing` in enrichLibrary), so it's
  // "missing" on this load too.
  writeSnapshot({
    tracks: [likedTrack],
    playlists: [{ id: 'p1', name: 'Trip', trackCount: 1 }],
  });
  const savedAt = readSnapshot()!.savedAt;
  vi.mocked(spotify.getPlaylistTracks).mockRejectedValue(new Error('403'));
  vi.mocked(resolver.resolveAllGenres).mockResolvedValue(new Map());
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  vi.useFakeTimers();
  vi.setSystemTime(savedAt + 1000); // time has moved on since the snapshot was written
  await loadLibrary({ targetPlaylistIds: ['p1'], threshold: 0.3, sortOrder: 'oldest' }, () => {});
  vi.useRealTimers();

  expect(readSnapshot()!.savedAt).toBe(savedAt);
});

// -- self-heal: keep cached data through a rate limit, resume automatically --

it('keeps the cached library on screen when a refresh is rate-limited', async () => {
  writeSnapshot({ tracks: [likedTrack], playlists: [{ id: 'p1', name: 'Trip', trackCount: 1 }] });
  const raw = JSON.parse(localStorage.getItem('kondo:library:v1')!);
  localStorage.setItem('kondo:library:v1', JSON.stringify({ ...raw, savedAt: 0 })); // stale

  vi.mocked(spotify.getSavedTracks).mockRejectedValue(new spotify.RateLimitedError(Date.now() + 60_000));
  vi.mocked(spotify.getMyPlaylists).mockRejectedValue(new spotify.RateLimitedError(Date.now() + 60_000));
  vi.mocked(resolver.resolveAllGenres).mockResolvedValue(new Map());

  const { result } = renderHook(() =>
    useLibrary({ targetPlaylistIds: ['p1'], threshold: 0.3, sortOrder: 'oldest' }));

  await waitFor(() => expect(result.current.status).not.toBe('loading'));
  // The banner explains the penalty; blanking the app would be strictly worse.
  expect(result.current.status).not.toBe('error');
  expect(result.current.tracks).toEqual([likedTrack]);
});

it('errors normally when rate-limited with nothing cached', async () => {
  vi.mocked(spotify.getSavedTracks).mockRejectedValue(new spotify.RateLimitedError(Date.now() + 60_000));
  vi.mocked(spotify.getMyPlaylists).mockRejectedValue(new spotify.RateLimitedError(Date.now() + 60_000));

  const { result } = renderHook(() =>
    useLibrary({ targetPlaylistIds: [], threshold: 0.3, sortOrder: 'oldest' }));

  await waitFor(() => expect(result.current.status).toBe('error'));
});

it('auto-resumes the load once a real rate-limit penalty clears', async () => {
  writeSnapshot({ tracks: [likedTrack], playlists: [] });
  ageSnapshot(9 * 60 * 60 * 1000); // stale, so phase 1 actually fetches
  seedRateLimit(200);

  vi.mocked(spotify.getMyPlaylists).mockResolvedValue([]);
  vi.mocked(spotify.getSavedTracks)
    .mockRejectedValueOnce(new spotify.RateLimitedError(Date.now() + 200))
    .mockResolvedValue([{ ...likedTrack, id: 'fresh' }]);
  vi.mocked(resolver.resolveAllGenres).mockResolvedValue(new Map());

  const { result } = renderHook(() =>
    useLibrary({ targetPlaylistIds: [], threshold: 0.3, sortOrder: 'oldest' }));

  // Rate-limited: the stale rows stand in rather than an error page.
  await waitFor(() => expect(result.current.tracks).toEqual([likedTrack]));
  // …and when the penalty lapses the load resumes on its own, no button.
  await waitFor(
    () => expect(result.current.tracks.map((t) => t.id)).toEqual(['fresh']),
    { timeout: 4000 },
  );
});

// Refresh's whole point is bypassing the TTL. If the auto-resume drops `force`
// while re-running it, the resumed pass finds the snapshot still fresh and
// serves it without fetching — the user pressed Refresh and silently got the
// cache back.
it('keeps a rate-limited Refresh forced when it auto-resumes inside the TTL', async () => {
  writeSnapshot({ tracks: [likedTrack], playlists: [] }); // fresh, so only `force` can drive a fetch
  // Seeded before mount: seedRateLimit resets the module gate, which drops
  // useRateLimit's subscription, so a penalty seeded afterwards is never seen.
  seedRateLimit(1500);
  vi.mocked(spotify.getMyPlaylists).mockResolvedValue([]);
  vi.mocked(spotify.getSavedTracks)
    .mockRejectedValueOnce(new spotify.RateLimitedError(Date.now() + 1500))
    .mockResolvedValue([{ ...likedTrack, id: 'fresh' }]);
  vi.mocked(resolver.resolveAllGenres).mockResolvedValue(new Map());

  const { result } = renderHook(() =>
    useLibrary({ targetPlaylistIds: [], threshold: 0.3, sortOrder: 'oldest' }));
  await waitFor(() => expect(result.current.status).toBe('ready'));
  expect(spotify.getSavedTracks).not.toHaveBeenCalled(); // served from cache

  act(() => { result.current.refresh(); });
  // The forced refetch is the call that gets rate-limited.
  await waitFor(() => expect(spotify.getSavedTracks).toHaveBeenCalledTimes(1));

  await waitFor(
    () => expect(result.current.tracks.map((t) => t.id)).toEqual(['fresh']),
    { timeout: 4000 },
  );
});

it('does not restart a load that succeeded while a penalty came and went', async () => {
  // spotifyFetch parks on short penalties instead of throwing, so this is the
  // common shape: the gate goes up and comes back down under a load that was
  // never interrupted. Restarting it would cancel healthy work and put two
  // full library loads on the wire exactly as the limiter lets go.
  seedRateLimit(200);
  vi.mocked(spotify.getSavedTracks).mockResolvedValue([likedTrack]);
  vi.mocked(spotify.getMyPlaylists).mockResolvedValue([]);
  vi.mocked(resolver.resolveAllGenres).mockResolvedValue(new Map());

  const { result } = renderHook(() =>
    useLibrary({ targetPlaylistIds: [], threshold: 0.3, sortOrder: 'oldest' }));
  await waitFor(() => expect(result.current.status).toBe('ready'));
  expect(spotify.getSavedTracks).toHaveBeenCalledTimes(1);
  expect(resolver.resolveAllGenres).toHaveBeenCalledTimes(1);

  // useRateLimit polls once a second; give it room to see the penalty lapse.
  await act(async () => { await new Promise((r) => setTimeout(r, 1500)); });

  expect(spotify.getSavedTracks).toHaveBeenCalledTimes(1);
  // Phase 2 re-runs on every pass of the load effect even when phase 1 is
  // served from the snapshot phase 1 just wrote — so this, not the fetch
  // count, is what shows whether the effect restarted.
  expect(resolver.resolveAllGenres).toHaveBeenCalledTimes(1);
  expect(result.current.status).toBe('ready');
});

// -- snapshotAge --------------------------------------------------------------

it('reports the snapshot age when served from cache and null when fetched', async () => {
  const ONE_HOUR = 60 * 60 * 1000;
  writeSnapshot({ tracks: [likedTrack], playlists: [] });
  ageSnapshot(ONE_HOUR); // still inside the TTL — served without fetching
  vi.mocked(spotify.getSavedTracks).mockResolvedValue([likedTrack]);
  vi.mocked(spotify.getMyPlaylists).mockResolvedValue([]);
  vi.mocked(resolver.resolveAllGenres).mockResolvedValue(new Map());

  const { result } = renderHook(() =>
    useLibrary({ targetPlaylistIds: [], threshold: 0.3, sortOrder: 'oldest' }));
  await waitFor(() => expect(result.current.status).toBe('ready'));

  expect(result.current.snapshotAge).toBeGreaterThanOrEqual(ONE_HOUR);
  expect(result.current.snapshotAge).toBeLessThan(ONE_HOUR + 60_000);

  act(() => result.current.refresh());
  await waitFor(() => expect(spotify.getSavedTracks).toHaveBeenCalledTimes(1));

  // These rows came off the network — reporting an age would be a lie.
  await waitFor(() => expect(result.current.snapshotAge).toBeNull());
});

it('reports the stale snapshot age when the rate-limited fallback serves it', async () => {
  const NINE_HOURS = 9 * 60 * 60 * 1000;
  writeSnapshot({ tracks: [likedTrack], playlists: [] });
  ageSnapshot(NINE_HOURS);

  vi.mocked(spotify.getSavedTracks).mockRejectedValue(new spotify.RateLimitedError(Date.now() + 60_000));
  vi.mocked(spotify.getMyPlaylists).mockRejectedValue(new spotify.RateLimitedError(Date.now() + 60_000));
  vi.mocked(resolver.resolveAllGenres).mockResolvedValue(new Map());

  const { result } = renderHook(() =>
    useLibrary({ targetPlaylistIds: [], threshold: 0.3, sortOrder: 'oldest' }));
  await waitFor(() => expect(result.current.tracks).toEqual([likedTrack]));

  // The fallback serves the snapshot by construction — a fresh one would have
  // been served without fetching at all. null here would claim "from network".
  expect(result.current.snapshotAge).toBeGreaterThanOrEqual(NINE_HOURS);
  expect(result.current.snapshotAge).toBeLessThan(NINE_HOURS + 60_000);
});

it('refresh() while rate-limited keeps the cached rows and the snapshot', async () => {
  writeSnapshot({ tracks: [likedTrack], playlists: [] });
  vi.mocked(resolver.resolveAllGenres).mockResolvedValue(new Map());

  const { result } = renderHook(() =>
    useLibrary({ targetPlaylistIds: [], threshold: 0.3, sortOrder: 'oldest' }));
  await waitFor(() => expect(result.current.status).toBe('ready'));
  expect(spotify.getSavedTracks).not.toHaveBeenCalled(); // served from cache

  vi.mocked(spotify.getSavedTracks).mockRejectedValue(new spotify.RateLimitedError(Date.now() + 60_000));
  vi.mocked(spotify.getMyPlaylists).mockRejectedValue(new spotify.RateLimitedError(Date.now() + 60_000));

  act(() => result.current.refresh());
  await waitFor(() => expect(spotify.getSavedTracks).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(result.current.status).toBe('ready'));

  // Refresh must not be able to reach the state Task 7 exists to prevent.
  expect(result.current.error).toBeNull();
  expect(result.current.tracks).toEqual([likedTrack]);
  expect(readSnapshot()?.tracks).toEqual([likedTrack]);
});

it('refresh() refetches even while the snapshot is still fresh', async () => {
  writeSnapshot({ tracks: [likedTrack], playlists: [] });
  vi.mocked(spotify.getSavedTracks).mockResolvedValue([likedTrack]);
  vi.mocked(spotify.getMyPlaylists).mockResolvedValue([]);
  vi.mocked(resolver.resolveAllGenres).mockResolvedValue(new Map());

  const { result } = renderHook(() =>
    useLibrary({ targetPlaylistIds: [], threshold: 0.3, sortOrder: 'oldest' }));
  await waitFor(() => expect(result.current.status).toBe('ready'));
  expect(spotify.getSavedTracks).not.toHaveBeenCalled(); // served from cache

  act(() => result.current.refresh());

  await waitFor(() => expect(spotify.getSavedTracks).toHaveBeenCalledTimes(1));
});

// -- cross-account race: a cancelled load must not clobber a newer snapshot --

it('a load cancelled mid-fetch does not overwrite a newer snapshot written after it', async () => {
  // Simulates: user A's load is in flight, user A logs out (Workspace unmounts,
  // cancelled flips true), user B logs in and writes their own snapshot, and
  // only THEN does A's stale fetch resolve. Without gating writeSnapshot on
  // isCancelled, A's stale data would land last and overwrite B's snapshot,
  // re-stamping it fresh for a full TTL window.
  let resolveSavedTracks!: (v: (typeof likedTrack)[]) => void;
  vi.mocked(spotify.getSavedTracks).mockReturnValue(new Promise((r) => { resolveSavedTracks = r; }));
  vi.mocked(spotify.getMyPlaylists).mockResolvedValue([]);

  let cancelled = false;
  const promise = loadTracksAndPlaylists(
    { targetPlaylistIds: null, threshold: 0.3, sortOrder: 'oldest' },
    () => cancelled,
  );

  cancelled = true; // user A logs out mid-fetch

  const bTrack = { ...likedTrack, id: 'b1' };
  writeSnapshot({ tracks: [bTrack], playlists: [] }); // user B logs in, writes their own snapshot

  resolveSavedTracks([likedTrack]); // A's stale fetch finally resolves
  await promise;

  expect(readSnapshot()!.tracks).toEqual([bTrack]); // B's snapshot survived untouched
});

it('a deep pass that lands after logout does not re-create the cleared snapshot', async () => {
  // A deep run takes minutes and nothing aborts it on unmount, so it is the
  // writer most likely to still be in flight when the account changes:
  // A starts a deep run → A logs out and the snapshot is cleared → the run
  // finishes and re-creates a snapshot holding A's playlist items with no
  // tracks, which B is then served for a full TTL window.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  writeSnapshot({ tracks: [likedTrack], playlists: [{ id: 'p1', name: 'Trip', trackCount: 1 }] });
  // p1 is unreadable on the first pass, so nothing about it gets cached and
  // the deep pass below has a real fetch to do — and therefore a real write.
  vi.mocked(spotify.getPlaylistTracks).mockRejectedValue(new Error('403'));
  vi.mocked(resolver.resolveAllGenres).mockResolvedValue(new Map());

  const { result, unmount } = renderHook(() =>
    useLibrary({ targetPlaylistIds: ['p1'], threshold: 0.3, sortOrder: 'oldest' }));
  await waitFor(() => expect(result.current.status).toBe('ready'));

  vi.mocked(spotify.getPlaylistTracks).mockResolvedValue([
    { name: 'Angel', artists: [{ id: 'a2', name: 'Massive Attack' }], releaseYear: 1998, isrc: null },
  ]);
  let releaseDeep!: (v: Map<string, string[]>) => void;
  vi.mocked(resolver.resolveAllGenres).mockReturnValue(new Promise((r) => { releaseDeep = r; }));

  let deep!: Promise<void>;
  act(() => { deep = result.current.deepResolveAll(); });
  await waitFor(() => expect(spotify.getPlaylistTracks).toHaveBeenCalledTimes(2));

  unmount();       // account A logs out — Workspace unmounts
  clearSnapshot(); // …and App.tsx drops the cache that belonged to A

  releaseDeep(new Map());
  await act(async () => { await deep; });

  expect(readSnapshot()).toBeNull();
});

it('write-through keeps a sorted song from coming back on reload', async () => {
  writeSnapshot({ tracks: [likedTrack], playlists: [] });
  vi.mocked(resolver.resolveAllGenres).mockResolvedValue(new Map());
  const { result } = renderHook(() =>
    useLibrary({ targetPlaylistIds: [], threshold: 0.3, sortOrder: 'oldest' }));
  await waitFor(() => expect(result.current.status).toBe('ready'));

  act(() => result.current.removeTrackLocally('t1'));

  expect(readSnapshot()?.tracks).toEqual([]);
});
