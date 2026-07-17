import { afterEach, expect, it, vi } from 'vitest';
import { resolveArtistGenres, resetResolverForTests } from './resolver';
import * as spotify from '../api/spotify';
import * as mb from '../api/musicbrainz';
import { SpotifyApiError } from '../api/spotify';

vi.mock('../api/spotify', async () => {
  const actual = await vi.importActual<typeof import('../api/spotify')>('../api/spotify');
  return { getArtistGenres: vi.fn(), SpotifyApiError: actual.SpotifyApiError };
});
vi.mock('../api/musicbrainz', () => ({ lookupArtistGenres: vi.fn() }));

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

it('returns source none when nothing is found (and caches it)', async () => {
  vi.mocked(spotify.getArtistGenres).mockResolvedValue([]);
  vi.mocked(mb.lookupArtistGenres).mockResolvedValue([]);
  expect(await resolveArtistGenres(artist)).toEqual({ genres: [], source: 'none' });
  expect(await resolveArtistGenres(artist)).toEqual({ genres: [], source: 'none' });
  expect(mb.lookupArtistGenres).toHaveBeenCalledTimes(1);
});
