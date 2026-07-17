import { expect, it, vi } from 'vitest';
import { loadLibrary } from './useLibrary';
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
vi.mock('../genre/resolver', () => ({ resolveArtistGenres: vi.fn() }));

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
    { artists: [{ id: 'a2', name: 'Massive Attack' }], releaseYear: 1998 },
  ]);
  vi.mocked(resolver.resolveArtistGenres).mockResolvedValue({
    genres: ['trip hop'], source: 'musicbrainz',
  });

  const progress: [number, number][] = [];
  const lib = await loadLibrary(
    { targetPlaylistIds: ['p1'], threshold: 0.3, sortOrder: 'oldest' },
    (r, t) => progress.push([r, t]),
  );

  expect(lib.playlists.map((p) => p.id)).toEqual(['p1']); // p2 filtered out
  expect(spotify.getPlaylistTracks).toHaveBeenCalledTimes(1); // only target playlists fetched
  // 2 unique artists (a1 liked, a2 in playlist) → resolver called once each.
  expect(resolver.resolveArtistGenres).toHaveBeenCalledTimes(2);
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
    return [{ artists: [{ id: 'a1', name: 'Portishead' }], releaseYear: 1994 }];
  });
  vi.mocked(resolver.resolveArtistGenres).mockResolvedValue({
    genres: ['trip hop'], source: 'musicbrainz',
  });

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
    { artists: [{ id: 'a1', name: 'Portishead' }], releaseYear: 1994 },
  ]);
  // Hold genre resolution open so the hook sits in 'enriching' until we let go.
  let release!: (v: { genres: string[]; source: 'musicbrainz' }) => void;
  vi.mocked(resolver.resolveArtistGenres).mockReturnValue(
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

  release({ genres: ['trip hop'], source: 'musicbrainz' });
  await waitFor(() => expect(result.current.status).toBe('ready'));
  expect(result.current.matches.get('t1')?.best?.playlistId).toBe('p1');
});
