import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import Sorter from './Sorter';
import * as spotify from '../api/spotify';
import * as lib from '../hooks/useLibrary';
import { getRemovalLog } from '../storage/removalLog';

vi.mock('../api/spotify', () => ({
  addTracksToPlaylist: vi.fn().mockResolvedValue(undefined),
  removeSavedTracks: vi.fn().mockResolvedValue(undefined),
  saveTracks: vi.fn().mockResolvedValue(undefined),
  removeTracksFromPlaylist: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../hooks/useLibrary');
vi.mock('../player/spotifyPlayer', () => ({
  initPlayer: vi.fn().mockRejectedValue(new Error('Playback needs Spotify Premium')),
  playTrack: vi.fn(),
}));

const track = (id: string, addedAt: string) => ({
  id, uri: `spotify:track:${id}`, name: `Song ${id}`,
  artists: [{ id: 'a1', name: 'Artist' }],
  albumName: 'Album', releaseYear: 2000, isrc: null, addedAt,
});

const settings = { targetPlaylistIds: null, threshold: 0.3, sortOrder: 'oldest' as const };

function mockLibrary(tracks: ReturnType<typeof track>[]) {
  const removeTrackLocally = vi.fn();
  const restoreTrackLocally = vi.fn();
  vi.mocked(lib.useLibrary).mockReturnValue({
    status: 'ready', error: null,
    tracks,
    playlists: [{ id: 'p1', name: 'Trip Hop', trackCount: 5 }],
    genresByTrack: new Map(tracks.map((t) => [t.id, ['trip hop']])),
    matches: new Map(tracks.map((t) => [t.id, {
      best: { playlistId: 'p1', score: 0.9 }, alternates: [], belowThreshold: false,
    }])),
    progress: { resolved: 1, total: 1 },
    removeTrackLocally,
    restoreTrackLocally,
  });
  return { removeTrackLocally, restoreTrackLocally };
}

afterEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

it('shows the remaining count and sorts oldest-first by default', () => {
  mockLibrary([track('t1', '2024-06-01T00:00:00Z'), track('t2', '2023-01-01T00:00:00Z')]);
  render(<Sorter settings={settings} />);
  expect(screen.getByText(/2 liked songs/i)).toBeInTheDocument();
  const rows = screen.getAllByRole('listitem');
  expect(rows[0]).toHaveTextContent('Song t2'); // older first
});

it('flips the order with the toggle', async () => {
  mockLibrary([track('t1', '2024-06-01T00:00:00Z'), track('t2', '2023-01-01T00:00:00Z')]);
  render(<Sorter settings={settings} />);
  await userEvent.click(screen.getByRole('button', { name: 'old → new' }));
  expect(screen.getAllByRole('listitem')[0]).toHaveTextContent('Song t1');
});

it('add → adds to playlist, unlikes, logs, removes row, offers undo', async () => {
  const { removeTrackLocally } = mockLibrary([track('t1', '2024-06-01T00:00:00Z')]);
  render(<Sorter settings={settings} />);
  await userEvent.click(screen.getByRole('button', { name: /^add$/i }));
  await waitFor(() => {
    expect(spotify.addTracksToPlaylist).toHaveBeenCalledWith('p1', ['spotify:track:t1']);
    expect(spotify.removeSavedTracks).toHaveBeenCalledWith(['t1']);
  });
  expect(removeTrackLocally).toHaveBeenCalledWith('t1');
  expect(getRemovalLog()).toHaveLength(1);
  expect(screen.getByRole('button', { name: /undo/i })).toBeInTheDocument();
});

it('undo re-likes and removes from the playlist again', async () => {
  mockLibrary([track('t1', '2024-06-01T00:00:00Z')]);
  render(<Sorter settings={settings} />);
  await userEvent.click(screen.getByRole('button', { name: /^add$/i }));
  await userEvent.click(await screen.findByRole('button', { name: /undo/i }));
  await waitFor(() => {
    expect(spotify.saveTracks).toHaveBeenCalledWith(['t1']);
    expect(spotify.removeTracksFromPlaylist).toHaveBeenCalledWith('p1', ['spotify:track:t1']);
  });
  expect(getRemovalLog()).toHaveLength(0);
});

it('surfaces an error and skips local updates when addTracksToPlaylist fails', async () => {
  vi.mocked(spotify.addTracksToPlaylist).mockRejectedValueOnce(new Error('network down'));
  const { removeTrackLocally } = mockLibrary([track('t1', '2024-06-01T00:00:00Z')]);
  render(<Sorter settings={settings} />);
  await userEvent.click(screen.getByRole('button', { name: /^add$/i }));
  expect(await screen.findByRole('alert')).toHaveTextContent('network down');
  expect(removeTrackLocally).not.toHaveBeenCalled();
  expect(getRemovalLog()).toHaveLength(0);
  expect(screen.queryByRole('button', { name: /undo/i })).not.toBeInTheDocument();
});

it('surfaces an error and skips local updates when removeSavedTracks fails', async () => {
  vi.mocked(spotify.removeSavedTracks).mockRejectedValueOnce(new Error('unlike failed'));
  const { removeTrackLocally } = mockLibrary([track('t1', '2024-06-01T00:00:00Z')]);
  render(<Sorter settings={settings} />);
  await userEvent.click(screen.getByRole('button', { name: /^add$/i }));
  expect(await screen.findByRole('alert')).toHaveTextContent('unlike failed');
  expect(removeTrackLocally).not.toHaveBeenCalled();
  expect(getRemovalLog()).toHaveLength(0);
  expect(screen.queryByRole('button', { name: /undo/i })).not.toBeInTheDocument();
});

it('surfaces an error and keeps the undo toast when saveTracks fails during undo', async () => {
  vi.mocked(spotify.saveTracks).mockRejectedValueOnce(new Error('relike failed'));
  const { restoreTrackLocally } = mockLibrary([track('t1', '2024-06-01T00:00:00Z')]);
  render(<Sorter settings={settings} />);
  await userEvent.click(screen.getByRole('button', { name: /^add$/i }));
  await userEvent.click(await screen.findByRole('button', { name: /undo/i }));
  expect(await screen.findByRole('alert')).toHaveTextContent('relike failed');
  expect(restoreTrackLocally).not.toHaveBeenCalled();
  expect(getRemovalLog()).toHaveLength(1);
  expect(screen.getByRole('button', { name: /undo/i })).toBeInTheDocument();
});

it('tells non-Premium users playback is optional and sorting still works', async () => {
  mockLibrary([track('t1', '2024-06-01T00:00:00Z')]);
  render(<Sorter settings={settings} />);
  await userEvent.click(screen.getByRole('button', { name: 'play' }));
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent(/premium/i);
  expect(alert).toHaveTextContent(/sorting still works|no premium needed/i);
});

it('surfaces an error and keeps the undo toast when removeTracksFromPlaylist fails during undo', async () => {
  vi.mocked(spotify.removeTracksFromPlaylist).mockRejectedValueOnce(new Error('remove failed'));
  mockLibrary([track('t1', '2024-06-01T00:00:00Z')]);
  render(<Sorter settings={settings} />);
  await userEvent.click(screen.getByRole('button', { name: /^add$/i }));
  await userEvent.click(await screen.findByRole('button', { name: /undo/i }));
  expect(await screen.findByRole('alert')).toHaveTextContent('remove failed');
  expect(getRemovalLog()).toHaveLength(1);
  expect(screen.getByRole('button', { name: /undo/i })).toBeInTheDocument();
});
