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
  activatePlayerElement: vi.fn(),
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
    artists: [{ id: 'a1', name: 'Artist' }],
    matches: new Map(tracks.map((t) => [t.id, {
      best: { playlistId: 'p1', score: 0.9 }, alternates: [], belowThreshold: false,
    }])),
    progress: { resolved: 1, total: 1 },
    removeTrackLocally: vi.fn(),
    restoreTrackLocally: vi.fn(),
    deepResolveAll: vi.fn(),
    deepState: 'idle',
    refresh: vi.fn(),
    snapshotAge: null,
    coverage: { spotify: 0, musicbrainz: 0, none: 0, unresolved: 0 },
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

it('removes the row and shows undo optimistically, before the network resolves', async () => {
  let resolveAdd!: () => void;
  vi.mocked(spotify.addTracksToPlaylist).mockReturnValueOnce(new Promise((r) => { resolveAdd = r; }));
  const lib = mockLibrary([track('t1', '2024-06-01T00:00:00Z')]);
  render(<Sorter settings={settings} lib={lib} />);
  await userEvent.click(screen.getByRole('button', { name: /^add$/i }));

  // Optimistic: fires before the add/remove network chain has resolved.
  expect(lib.removeTrackLocally).toHaveBeenCalledWith('t1');
  expect(screen.getByRole('button', { name: /undo/i })).toBeInTheDocument();
  expect(getRemovalLog()).toHaveLength(0); // logRemoval waits for the network to succeed

  resolveAdd();
  await waitFor(() => {
    expect(spotify.removeSavedTracks).toHaveBeenCalledWith(['spotify:track:t1']);
    expect(getRemovalLog()).toHaveLength(1);
  });
});

it('fires playlist POSTs in parallel, not one at a time', async () => {
  let resolveP1!: () => void;
  vi.mocked(spotify.addTracksToPlaylist)
    .mockImplementationOnce(() => new Promise((r) => { resolveP1 = r; }))
    .mockImplementationOnce(() => Promise.resolve(undefined));
  const lib = mockLibrary([track('t1', '2024-06-01T00:00:00Z')]);
  lib.playlists.push({ id: 'p2', name: 'Chill', trackCount: 3 });
  lib.matches.set('t1', {
    best: { playlistId: 'p1', score: 0.9 },
    alternates: [{ playlistId: 'p2', score: 0.5 }],
    belowThreshold: false,
  });
  render(<Sorter settings={settings} lib={lib} />);
  await userEvent.click(screen.getByRole('button', { name: /trip hop/i }));
  await userEvent.click(screen.getByRole('checkbox', { name: /chill/i }));
  await userEvent.click(screen.getByRole('button', { name: /add to 2 playlists/i }));

  // p2's POST fires even though p1's promise is still pending — proves
  // Promise.all dispatch, not a serial for-await loop.
  await waitFor(() => {
    expect(spotify.addTracksToPlaylist).toHaveBeenCalledWith('p2', ['spotify:track:t1']);
  });
  resolveP1();
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

it('rolls back the optimistic removal and surfaces an error when addTracksToPlaylist fails', async () => {
  vi.mocked(spotify.addTracksToPlaylist).mockRejectedValueOnce(new Error('network down'));
  const lib = mockLibrary([track('t1', '2024-06-01T00:00:00Z')]);
  render(<Sorter settings={settings} lib={lib} />);
  await userEvent.click(screen.getByRole('button', { name: /^add$/i }));
  expect(await screen.findByRole('alert')).toHaveTextContent('network down');
  expect(lib.removeTrackLocally).toHaveBeenCalledWith('t1'); // optimistic removal happened
  expect(lib.restoreTrackLocally).toHaveBeenCalledWith(lib.tracks[0]); // then rolled back
  expect(getRemovalLog()).toHaveLength(0);
  expect(screen.queryByRole('button', { name: /undo/i })).not.toBeInTheDocument();
  // Nothing landed, so we must not have gone on to unsave it either.
  expect(spotify.removeSavedTracks).not.toHaveBeenCalled();
});

it('keeps the row removed when the playlist add succeeded but the unsave failed', async () => {
  vi.mocked(spotify.removeSavedTracks).mockRejectedValueOnce(new Error('429'));
  const lib = mockLibrary([track('t1', '2024-06-01T00:00:00Z')]);
  render(<Sorter settings={settings} lib={lib} />);

  await userEvent.click(screen.getByRole('button', { name: /^add$/i }));

  await waitFor(() => expect(screen.getByRole('alert').textContent)
    .toMatch(/couldn't remove it from Liked/i));
  expect(lib.removeTrackLocally).toHaveBeenCalledWith('t1');
  // Restoring the row would invite a retry that double-adds to the playlist.
  expect(lib.restoreTrackLocally).not.toHaveBeenCalled();
  // It is still in Liked Songs, so there is no removal to log.
  expect(getRemovalLog()).toHaveLength(0);
  // The toast is the only way back out of the half-applied state.
  expect(screen.getByRole('button', { name: /undo/i })).toBeInTheDocument();
});

// The ✕ button sorts nothing — it calls onAdd(track, []) to unheart in place.
// With no adds to duplicate, a failed unsave means nothing happened at all, so
// this path keeps the plain rollback.
it('rolls the row back when a remove-only unsave fails', async () => {
  vi.mocked(spotify.removeSavedTracks).mockRejectedValueOnce(new Error('unlike failed'));
  const lib = mockLibrary([track('t1', '2024-06-01T00:00:00Z')]);
  render(<Sorter settings={settings} lib={lib} />);

  // Queried by title: the button's ✕ text content wins the accessible name.
  await userEvent.click(screen.getByTitle(/remove from liked songs/i));

  expect(await screen.findByRole('alert')).toHaveTextContent('unlike failed');
  expect(screen.getByRole('alert').textContent).not.toMatch(/added to your playlist/i);
  expect(lib.restoreTrackLocally).toHaveBeenCalledWith(lib.tracks[0]);
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

it('tells non-Premium users playback is optional and sorting still works', async () => {
  vi.mocked(player.playUri).mockRejectedValueOnce(new Error('Playback needs Spotify Premium'));
  const lib = mockLibrary([track('t1', '2024-06-01T00:00:00Z')]);
  render(<Sorter settings={settings} lib={lib} />);
  await userEvent.click(screen.getByRole('button', { name: 'play' }));
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent(/premium/i);
  expect(alert).toHaveTextContent(/sorting still works|no premium needed/i);
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

// Safari (and Chrome's autoplay policy) only lets the SDK's audio element make
// sound if it was activated inside a real user gesture. The click handler awaits
// before it plays, so activation must happen synchronously — before any await —
// or the gesture is spent and playback is silent while Spotify still reports the
// device as active.
it('activates the player audio element synchronously on the play click', async () => {
  const lib = mockLibrary([track('t1', '2024-06-01T00:00:00Z')]);
  render(<Sorter settings={settings} lib={lib} />);
  await userEvent.click(screen.getByRole('button', { name: 'play' }));
  expect(player.activatePlayerElement).toHaveBeenCalled();
  expect(vi.mocked(player.activatePlayerElement).mock.invocationCallOrder[0])
    .toBeLessThan(vi.mocked(player.playUri).mock.invocationCallOrder[0]);
});

it('shows genre coverage split and the unresolved count', () => {
  const lib = mockLibrary([track('t1', '2024-06-01T00:00:00Z')]);
  lib.coverage = { spotify: 620, musicbrainz: 200, none: 0, unresolved: 180 };
  render(<Sorter settings={settings} lib={lib} />);
  expect(screen.getByText(/620 via Spotify/)).toBeInTheDocument();
  expect(screen.getByText(/180 unresolved/)).toBeInTheDocument();
  expect(screen.queryByText(/none found/)).not.toBeInTheDocument();
});

it('clicking the MusicBrainz resolve button calls deepResolveAll', async () => {
  const lib = mockLibrary([track('t1', '2024-06-01T00:00:00Z')]);
  lib.coverage = { spotify: 620, musicbrainz: 200, none: 0, unresolved: 180 };
  render(<Sorter settings={settings} lib={lib} />);
  await userEvent.click(screen.getByRole('button', { name: /resolve 180 via musicbrainz/i }));
  expect(lib.deepResolveAll).toHaveBeenCalled();
});

it('shows no resolve button once nothing is unresolved', () => {
  const lib = mockLibrary([track('t1', '2024-06-01T00:00:00Z')]);
  lib.coverage = { spotify: 620, musicbrainz: 200, none: 0, unresolved: 0 };
  render(<Sorter settings={settings} lib={lib} />);
  expect(screen.queryByRole('button', { name: /resolve .* via musicbrainz/i })).not.toBeInTheDocument();
});

it('shows an animated spinner in the resolve button while a deep resolve is running', () => {
  const lib = mockLibrary([track('t1', '2024-06-01T00:00:00Z')]);
  lib.coverage = { spotify: 620, musicbrainz: 200, none: 0, unresolved: 180 };
  lib.deepState = 'running';
  render(<Sorter settings={settings} lib={lib} />);
  expect(document.querySelector('.spinner')).toBeInTheDocument();
});
