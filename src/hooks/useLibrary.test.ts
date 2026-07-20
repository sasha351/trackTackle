import { expect, it, vi } from 'vitest';
import { enrichLibrary, loadLibrary } from './useLibrary';
import * as spotify from '../api/spotify';
import * as resolver from '../genre/resolver';
import { matchSong } from '../matching/engine';
import { renderHook, waitFor } from '@testing-library/react';
import { useLibrary } from './useLibrary';

vi.mock('../api/spotify', () => ({
  getSavedTracks: vi.fn(),
  getMyPlaylists: vi.fn(),
  getPlaylistTracks: vi.fn(),
}));
vi.mock('../genre/resolver', () => ({ resolveAllGenres: vi.fn() }));

const likedTrack = {
  id: 't1', uri: 'spotify:track:t1', name: 'Glory Box',
  artists: [{ id: 'a1', name: 'Portishead' }],
  albumName: 'Dummy', releaseYear: 1994, isrc: null, addedAt: '2024-01-01T00:00:00Z',
};

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
      getArtistGenres: vi.fn(), SpotifyApiError: actual.SpotifyApiError,
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
  vi.mocked(freshSpotify.getArtistGenres).mockRejectedValue(
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
  );
  await vi.runAllTimersAsync();
  await resultPromise;
  vi.useRealTimers();

  expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes('query=arid'))).toBe(true); // confirms MB path resolved these, not Spotify
  expect(partials.length).toBeGreaterThan(0); // the bug this fixes: zero flushes during a real MB-only run

  // Restore the module-level mock for any tests appended after this one.
  vi.doMock('../genre/resolver', () => ({ resolveAllGenres: vi.fn() }));
});
