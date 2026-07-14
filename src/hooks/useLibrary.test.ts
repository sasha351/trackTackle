import { expect, it, vi } from 'vitest';
import { loadLibrary } from './useLibrary';
import * as spotify from '../api/spotify';
import * as resolver from '../genre/resolver';

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
  expect(progress.at(-1)).toEqual([2, 2]);
  expect(lib.genresByTrack.get('t1')).toEqual(['trip hop']);
  const match = lib.matches.get('t1')!;
  expect(match.best?.playlistId).toBe('p1');
  expect(match.belowThreshold).toBe(false);
});
