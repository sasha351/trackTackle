import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import Sorter from './Sorter';
import * as spotify from '../api/spotify';
import * as player from '../player/spotifyPlayer';
import type { LibraryState } from '../hooks/useLibrary';
import { getRemovalLog } from '../storage/removalLog';

vi.mock('../api/spotify', () => ({
  addTracksToPlaylist: vi.fn().mockResolvedValue(undefined),
  removeSavedTracks: vi.fn().mockResolvedValue(undefined),
  saveTracks: vi.fn().mockResolvedValue(undefined),
  removeTracksFromPlaylist: vi.fn().mockResolvedValue(undefined),
}));

const { mockPause } = vi.hoisted(() => ({ mockPause: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../player/spotifyPlayer', () => ({
  initPlayer: vi.fn().mockResolvedValue({ deviceId: 'd', pause: mockPause, disconnect: vi.fn() }),
  playUri: vi.fn().mockResolvedValue(undefined),
}));

const track = (id: string, addedAt: string) => ({
  id, uri: `spotify:track:${id}`, name: `Song ${id}`,
  artists: [{ id: 'a1', name: 'Artist' }],
  albumName: 'Album', releaseYear: 2000, isrc: null, addedAt,
});

const settings = { targetPlaylistIds: null, threshold: 0.3, sortOrder: 'oldest' as const };

function mockLibrary(tracks: ReturnType<typeof track>[]): LibraryState {
  return {
    status: 'ready', error: null,
    tracks,
    playlists: [{ id: 'p1', name: 'Trip Hop', trackCount: 5 }],
    allPlaylists: [{ id: 'p1', name: 'Trip Hop', trackCount: 5 }],
    genresByTrack: new Map(tracks.map((t) => [t.id, ['trip hop']])),
    fingerprints: new Map(),
    matches: new Map(tracks.map((t) => [t.id, {
      best: { playlistId: 'p1', score: 0.9 }, alternates: [], belowThreshold: false,
    }])),
    progress: { resolved: 1, total: 1 },
    removeTrackLocally: vi.fn(),
    restoreTrackLocally: vi.fn(),
  };
}

afterEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

it('shows the remaining count and sorts oldest-first by default', () => {
  const lib = mockLibrary([track('t1', '2024-06-01T00:00:00Z'), track('t2', '2023-01-01T00:00:00Z')]);
  render(<Sorter settings={settings} lib={lib} />);
  expect(screen.getByText(/2 liked songs/i)).toBeInTheDocument();
  const rows = screen.getAllByRole('listitem');
  expect(rows[0]).toHaveTextContent('Song t2'); // older first
});

it('flips the order with the toggle', async () => {
  const lib = mockLibrary([track('t1', '2024-06-01T00:00:00Z'), track('t2', '2023-01-01T00:00:00Z')]);
  render(<Sorter settings={settings} lib={lib} />);
  await userEvent.click(screen.getByRole('button', { name: 'old → new' }));
  expect(screen.getAllByRole('listitem')[0]).toHaveTextContent('Song t1');
});

it('add → adds to playlist, unlikes, logs, removes row, offers undo', async () => {
  const lib = mockLibrary([track('t1', '2024-06-01T00:00:00Z')]);
  render(<Sorter settings={settings} lib={lib} />);
  await userEvent.click(screen.getByRole('button', { name: /^add$/i }));
  await waitFor(() => {
    expect(spotify.addTracksToPlaylist).toHaveBeenCalledWith('p1', ['spotify:track:t1']);
    expect(spotify.removeSavedTracks).toHaveBeenCalledWith(['spotify:track:t1']);
  });
  expect(lib.removeTrackLocally).toHaveBeenCalledWith('t1');
  expect(getRemovalLog()).toHaveLength(1);
  expect(screen.getByRole('button', { name: /undo/i })).toBeInTheDocument();
});

it('undo re-likes and removes from the playlist again', async () => {
  const lib = mockLibrary([track('t1', '2024-06-01T00:00:00Z')]);
  render(<Sorter settings={settings} lib={lib} />);
  await userEvent.click(screen.getByRole('button', { name: /^add$/i }));
  await userEvent.click(await screen.findByRole('button', { name: /undo/i }));
  await waitFor(() => {
    expect(spotify.saveTracks).toHaveBeenCalledWith(['spotify:track:t1']);
    expect(spotify.removeTracksFromPlaylist).toHaveBeenCalledWith('p1', ['spotify:track:t1']);
  });
  expect(getRemovalLog()).toHaveLength(0);
});

it('surfaces an error and skips local updates when addTracksToPlaylist fails', async () => {
  vi.mocked(spotify.addTracksToPlaylist).mockRejectedValueOnce(new Error('network down'));
  const lib = mockLibrary([track('t1', '2024-06-01T00:00:00Z')]);
  render(<Sorter settings={settings} lib={lib} />);
  await userEvent.click(screen.getByRole('button', { name: /^add$/i }));
  expect(await screen.findByRole('alert')).toHaveTextContent('network down');
  expect(lib.removeTrackLocally).not.toHaveBeenCalled();
  expect(getRemovalLog()).toHaveLength(0);
  expect(screen.queryByRole('button', { name: /undo/i })).not.toBeInTheDocument();
});

it('surfaces an error and skips local updates when removeSavedTracks fails', async () => {
  vi.mocked(spotify.removeSavedTracks).mockRejectedValueOnce(new Error('unlike failed'));
  const lib = mockLibrary([track('t1', '2024-06-01T00:00:00Z')]);
  render(<Sorter settings={settings} lib={lib} />);
  await userEvent.click(screen.getByRole('button', { name: /^add$/i }));
  expect(await screen.findByRole('alert')).toHaveTextContent('unlike failed');
  expect(lib.removeTrackLocally).not.toHaveBeenCalled();
  expect(getRemovalLog()).toHaveLength(0);
  expect(screen.queryByRole('button', { name: /undo/i })).not.toBeInTheDocument();
});

it('surfaces an error and keeps the undo toast when saveTracks fails during undo', async () => {
  vi.mocked(spotify.saveTracks).mockRejectedValueOnce(new Error('relike failed'));
  const lib = mockLibrary([track('t1', '2024-06-01T00:00:00Z')]);
  render(<Sorter settings={settings} lib={lib} />);
  await userEvent.click(screen.getByRole('button', { name: /^add$/i }));
  await userEvent.click(await screen.findByRole('button', { name: /undo/i }));
  expect(await screen.findByRole('alert')).toHaveTextContent('relike failed');
  expect(lib.restoreTrackLocally).not.toHaveBeenCalled();
  expect(getRemovalLog()).toHaveLength(1);
  expect(screen.getByRole('button', { name: /undo/i })).toBeInTheDocument();
});

it('surfaces an error and keeps the undo toast when removeTracksFromPlaylist fails during undo', async () => {
  vi.mocked(spotify.removeTracksFromPlaylist).mockRejectedValueOnce(new Error('remove failed'));
  const lib = mockLibrary([track('t1', '2024-06-01T00:00:00Z')]);
  render(<Sorter settings={settings} lib={lib} />);
  await userEvent.click(screen.getByRole('button', { name: /^add$/i }));
  await userEvent.click(await screen.findByRole('button', { name: /undo/i }));
  expect(await screen.findByRole('alert')).toHaveTextContent('remove failed');
  expect(getRemovalLog()).toHaveLength(1);
  expect(screen.getByRole('button', { name: /undo/i })).toBeInTheDocument();
});

it('shows a match pill instead of a skeleton once a partial flush produces a match, even while still enriching', () => {
  const lib = { ...mockLibrary([track('t1', '2024-06-01T00:00:00Z')]), status: 'enriching' as const };
  render(<Sorter settings={settings} lib={lib} />);
  expect(screen.getByRole('button', { name: /^add$/i })).toBeInTheDocument();
  expect(document.querySelector('.match-skeleton')).not.toBeInTheDocument();
});

it('play button calls playUri, and clicking again pauses', async () => {
  const lib = mockLibrary([track('t1', '2024-06-01T00:00:00Z')]);
  render(<Sorter settings={settings} lib={lib} />);
  await userEvent.click(screen.getByRole('button', { name: 'play' }));
  await waitFor(() => {
    expect(player.playUri).toHaveBeenCalledWith(expect.any(Function), 'spotify:track:t1');
  });
  await userEvent.click(await screen.findByRole('button', { name: 'pause' }));
  await waitFor(() => {
    expect(mockPause).toHaveBeenCalled();
  });
});
