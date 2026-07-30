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
  createPlaylist: vi.fn().mockResolvedValue({ id: 'new-pl' }),
}));

const { mockPause } = vi.hoisted(() => ({ mockPause: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../player/spotifyPlayer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../player/spotifyPlayer')>();
  return {
    ...actual,
    initPlayer: vi.fn().mockResolvedValue({ deviceId: 'd', pause: mockPause, disconnect: vi.fn() }),
    playUri: vi.fn().mockResolvedValue(undefined),
    activatePlayerElement: vi.fn(),
  };
});

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
    membership: new Map(),
    matches: new Map(tracks.map((t) => [t.id, {
      best: { playlistId: 'p1', score: 0.9 }, alternates: [], belowThreshold: false,
    }])),
    progress: { resolved: 1, total: 1 },
    removeTrackLocally: vi.fn(),
    restoreTrackLocally: vi.fn(),
    deepResolveAll: vi.fn(),
    deepState: 'idle',    deepPhase: null,
    refresh: vi.fn(),
    snapshotAge: null,
    coverage: { spotify: 0, musicbrainz: 0, none: 0, unresolved: 0 },
  };
}

afterEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  Object.defineProperty(window.navigator, 'userAgent', {
    value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120',
    configurable: true,
  });
});

it('skips the SDK pre-warm and explains itself on a phone', () => {
  Object.defineProperty(window.navigator, 'userAgent', {
    value: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36',
    configurable: true,
  });
  render(<Sorter settings={settings} lib={mockLibrary([track('t1', '2024-06-01T00:00:00Z')])} />);
  expect(player.initPlayer).not.toHaveBeenCalled();
  expect(screen.getByText(/tap a song title to open it in spotify/i)).toBeInTheDocument();
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

it('names the artist being searched during the per-artist MusicBrainz phase', () => {
  const lib = mockLibrary([track('t1', '2024-06-01T00:00:00Z')]);
  lib.coverage = { spotify: 620, musicbrainz: 200, none: 0, unresolved: 180 };
  lib.deepState = 'running';
  lib.deepPhase = { phase: 'searching', artist: 'Portishead' };
  render(<Sorter settings={settings} lib={lib} />);
  expect(screen.getByText('Searching Portishead…')).toBeInTheDocument();
  expect(document.querySelector('.mb-searching-pulse')).toBeInTheDocument();
});

it('names the bulk mapping phase honestly instead of faking per-item progress', () => {
  const lib = mockLibrary([track('t1', '2024-06-01T00:00:00Z')]);
  lib.coverage = { spotify: 620, musicbrainz: 200, none: 0, unresolved: 180 };
  lib.deepState = 'running';
  lib.deepPhase = { phase: 'mapping' };
  render(<Sorter settings={settings} lib={lib} />);
  expect(screen.getByText(/looking up 180 artists on musicbrainz/i)).toBeInTheDocument();
});

it('names the bulk fetching phase', () => {
  const lib = mockLibrary([track('t1', '2024-06-01T00:00:00Z')]);
  lib.coverage = { spotify: 620, musicbrainz: 200, none: 0, unresolved: 180 };
  lib.deepState = 'running';
  lib.deepPhase = { phase: 'fetching' };
  render(<Sorter settings={settings} lib={lib} />);
  expect(screen.getByText(/fetching genres for batch/i)).toBeInTheDocument();
});

it('keeps the song list interactive (add still works) while a deep resolve runs', async () => {
  const lib = mockLibrary([track('t1', '2024-06-01T00:00:00Z')]);
  lib.coverage = { spotify: 620, musicbrainz: 200, none: 0, unresolved: 180 };
  lib.deepState = 'running';
  lib.deepPhase = { phase: 'searching', artist: 'Portishead' };
  render(<Sorter settings={settings} lib={lib} />);
  await userEvent.click(screen.getByRole('button', { name: /^add$/i }));
  expect(lib.removeTrackLocally).toHaveBeenCalledWith('t1');
});

it('shows the snapshot age and refetches on Refresh', async () => {
  const lib = { ...mockLibrary([track('t1', '2024-06-01T00:00:00Z')]),
                snapshotAge: 2 * 60 * 60 * 1000 };
  render(<Sorter settings={settings} lib={lib} />);

  expect(screen.getByText(/2h ago/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: /refresh/i }));
  expect(lib.refresh).toHaveBeenCalled();
});

it('shows no cache age when the data came straight from Spotify', () => {
  // snapshotAge is null in mockLibrary's default, set in Task 7.
  const lib = mockLibrary([track('t1', '2024-06-01T00:00:00Z')]);
  render(<Sorter settings={settings} lib={lib} />);
  expect(screen.queryByRole('button', { name: /refresh/i })).toBeNull();
});

// A rate-limited load lands on status 'ready' with no fingerprints, so every
// song scores { best: null, belowThreshold: true } — indistinguishable from a
// real "scored it, nothing fits". The cluster footer would then recommend new
// playlists off zero data.
it('does not claim songs are unsorted when a cached view was never scored', () => {
  const tracks = ['t1', 't2', 't3', 't4', 't5'].map((id) => track(id, '2024-06-01T00:00:00Z'));
  const lib = {
    ...mockLibrary(tracks),
    snapshotAge: 60 * 60 * 1000,
    fingerprints: new Map(),
    matches: new Map(tracks.map((t) => [t.id, {
      best: null, alternates: [], belowThreshold: true,
    }])),
  };
  render(<Sorter settings={settings} lib={lib} />);

  expect(screen.queryByText(/new playlist ideas/i)).toBeNull();
  expect(screen.getByText(/couldn't be scored/i)).toBeInTheDocument();
  // Manual sorting must still work — the picker keeps its full playlist browser.
  expect(screen.getAllByRole('button', { name: /add to a playlist/i }).length).toBeGreaterThan(0);
});

it('still suggests clusters when the songs were genuinely scored', () => {
  const tracks = ['t1', 't2', 't3', 't4', 't5'].map((id) => track(id, '2024-06-01T00:00:00Z'));
  const lib = {
    ...mockLibrary(tracks),
    fingerprints: new Map([['p1', {} as never]]),
    matches: new Map(tracks.map((t) => [t.id, {
      best: null, alternates: [], belowThreshold: true,
    }])),
  };
  render(<Sorter settings={settings} lib={lib} />);
  expect(screen.getByText(/playlist suggestions/i)).toBeInTheDocument();
});

// --- cluster playlist creation ---------------------------------------------

function clusteredLibrary() {
  const tracks = ['t1', 't2', 't3', 't4', 't5'].map((id) => track(id, '2024-06-01T00:00:00Z'));
  return {
    ...mockLibrary(tracks),
    fingerprints: new Map([['p1', {} as never]]),
    matches: new Map(tracks.map((t) => [t.id, {
      best: null, alternates: [], belowThreshold: true,
    }])),
  };
}

it('shows a name input prefilled with the genre and a create button sized to the cluster', () => {
  const lib = clusteredLibrary();
  render(<Sorter settings={settings} lib={lib} />);
  expect(screen.getByDisplayValue('trip hop')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /create with 5 songs/i })).toBeInTheDocument();
});

it('creates the playlist, adds the cluster tracks, and refreshes the library', async () => {
  const lib = clusteredLibrary();
  render(<Sorter settings={settings} lib={lib} />);
  await userEvent.click(screen.getByRole('button', { name: /create with 5 songs/i }));
  await waitFor(() => {
    expect(spotify.createPlaylist).toHaveBeenCalledWith('trip hop');
    expect(spotify.addTracksToPlaylist).toHaveBeenCalledWith(
      'new-pl',
      ['t1', 't2', 't3', 't4', 't5'].map((id) => `spotify:track:${id}`),
    );
    expect(lib.refresh).toHaveBeenCalled();
  });
});

it('uses an edited name instead of the genre default when creating the cluster playlist', async () => {
  const lib = clusteredLibrary();
  render(<Sorter settings={settings} lib={lib} />);
  const input = screen.getByDisplayValue('trip hop');
  await userEvent.clear(input);
  await userEvent.type(input, 'My Trip Hop Mix');
  await userEvent.click(screen.getByRole('button', { name: /create with 5 songs/i }));
  await waitFor(() => {
    expect(spotify.createPlaylist).toHaveBeenCalledWith('My Trip Hop Mix');
  });
});

it('surfaces an error and does not refresh when playlist creation fails', async () => {
  const lib = clusteredLibrary();
  vi.mocked(spotify.createPlaylist).mockRejectedValueOnce(new Error('creation failed'));
  render(<Sorter settings={settings} lib={lib} />);
  await userEvent.click(screen.getByRole('button', { name: /create with 5 songs/i }));
  expect(await screen.findByRole('alert')).toHaveTextContent('creation failed');
  expect(spotify.addTracksToPlaylist).not.toHaveBeenCalled();
  expect(lib.refresh).not.toHaveBeenCalled();
});

// --- quick matches ---------------------------------------------------------

it('lifts high-confidence songs into the quick-matches strip and out of the main list', () => {
  const tracks = [track('t1', '2024-06-01T00:00:00Z'), track('t2', '2023-01-01T00:00:00Z')];
  const lib = {
    ...mockLibrary(tracks),
    matches: new Map([
      ['t1', { best: { playlistId: 'p1', score: 0.92 }, alternates: [], belowThreshold: false }],
      ['t2', { best: { playlistId: 'p1', score: 0.5 }, alternates: [], belowThreshold: false }],
    ]),
  };
  render(<Sorter settings={settings} lib={lib} />);

  const strip = document.querySelector('.quick-matches')!;
  expect(strip).toHaveTextContent(/quick add/i);
  expect(strip.querySelectorAll('.song-row')).toHaveLength(1);
  expect(strip).toHaveTextContent('Song t1');
  // Moved, not copied — exactly one row per song across both lists.
  expect(screen.getAllByRole('listitem')).toHaveLength(2);
});

it('shows no quick-matches strip when nothing clears the bar', () => {
  const lib = {
    ...mockLibrary([track('t1', '2024-06-01T00:00:00Z')]),
    matches: new Map([
      ['t1', { best: { playlistId: 'p1', score: 0.5 }, alternates: [], belowThreshold: false }],
    ]),
  };
  render(<Sorter settings={settings} lib={lib} />);
  expect(document.querySelector('.quick-matches')).toBeNull();
});

// --- duplicate prevention --------------------------------------------------

it('refuses to add a song to a playlist it is already in', () => {
  const lib = {
    ...mockLibrary([track('t1', '2024-06-01T00:00:00Z')]),
    membership: new Map([['p1', new Set(['t1'])]]),
  };
  render(<Sorter settings={settings} lib={lib} />);
  // p1 is the only candidate and it's a duplicate, so nothing is selectable
  // and Add is disabled — the click never reaches the network at all.
  expect(screen.getByRole('button', { name: /^add$/i })).toBeDisabled();
  expect(spotify.addTracksToPlaylist).not.toHaveBeenCalled();
});

it('marks the already-in playlist in the picker instead of hiding it', async () => {
  const lib = {
    ...mockLibrary([track('t1', '2024-06-01T00:00:00Z')]),
    membership: new Map([['p1', new Set(['t1'])]]),
  };
  render(<Sorter settings={settings} lib={lib} />);
  await userEvent.click(screen.getByRole('button', { name: /trip hop/i }));

  const row = document.querySelector('.match-candidate.is-dupe')!;
  expect(row).toHaveTextContent('Trip Hop');
  expect(row.querySelector('input')).toBeDisabled();
});

it('still adds normally when the playlist does not have the song', async () => {
  const lib = {
    ...mockLibrary([track('t1', '2024-06-01T00:00:00Z')]),
    membership: new Map([['p1', new Set(['someone-else'])]]),
  };
  render(<Sorter settings={settings} lib={lib} />);
  await userEvent.click(screen.getByRole('button', { name: /^add$/i }));
  await waitFor(() => {
    expect(spotify.addTracksToPlaylist).toHaveBeenCalledWith('p1', ['spotify:track:t1']);
  });
});

it('groups the cache line and the sort toggle into one right-hand cluster', () => {
  const lib = mockLibrary([track('t1', '2024-06-01T00:00:00Z')]);
  lib.snapshotAge = 5 * 60_000;
  render(<Sorter settings={settings} lib={lib} />);

  const controls = document.querySelector('.toolbar-controls');
  expect(controls).not.toBeNull();
  // Both live in the same cluster, so `space-between` stops flinging them to
  // opposite ends of the toolbar — that is the whole visual delta of 8.1.
  expect(controls).toContainElement(screen.getByRole('button', { name: 'old → new' }));
  expect(controls!.textContent).toMatch(/Cached 5m ago/);
});

// --- quick-matches card cap + expand (batch 8, task 3) --------------------

// Six strong matches: enough to prove the cap and the expand button.
const sixQuick = () => {
  const tracks = ['t1', 't2', 't3', 't4', 't5', 't6'].map((id, i) =>
    track(id, `2024-0${i + 1}-01T00:00:00Z`));
  return mockLibrary(tracks);
};

it('caps the Quick Add strip at four cards', () => {
  render(<Sorter settings={settings} lib={sixQuick()} />);
  expect(document.querySelectorAll('.quick-matches .song-row')).toHaveLength(4);
  expect(screen.getByRole('button', { name: /show all 6/i })).toBeInTheDocument();
});

it('expands the strip to every strong match, so capped songs are still reachable', async () => {
  render(<Sorter settings={settings} lib={sixQuick()} />);
  await userEvent.click(screen.getByRole('button', { name: /show all 6/i }));
  expect(document.querySelectorAll('.quick-matches .song-row')).toHaveLength(6);
  expect(screen.getByRole('button', { name: /show fewer/i })).toBeInTheDocument();
});

it('labels the strip Quick Add with the count', () => {
  render(<Sorter settings={settings} lib={sixQuick()} />);
  expect(screen.getByText(/quick add/i)).toBeInTheDocument();
  expect(document.querySelector('.quick-matches')!.textContent).toMatch(/6/);
});

it('renders the strip rows compact and the main table rows full', () => {
  // Two songs match strongly, one does not — so one card and one full row.
  const lib = mockLibrary([track('t1', '2024-01-01T00:00:00Z'), track('t2', '2024-02-01T00:00:00Z')]);
  lib.matches.set('t2', { best: { playlistId: 'p1', score: 0.4 }, alternates: [], belowThreshold: false });
  render(<Sorter settings={settings} lib={lib} />);
  expect(document.querySelectorAll('.quick-matches .song-row.compact')).toHaveLength(1);
  expect(document.querySelectorAll('.song-list:not(.quick-list) > .song-row.compact')).toHaveLength(0);
});

// --- playlist suggestions card cap + expand (batch 8, task 4) ---------------

// Five clusters of five songs each: suggestClusters needs ≥5 songs per genre,
// and five clusters proves the four-cap plus the expand.
export function fiveClusters(): LibraryState {
  const genres = ['drill', 'jazz', 'metal', 'techno', 'folk'];
  const tracks = genres.flatMap((g, gi) =>
    [0, 1, 2, 3, 4].map((i) => track(`${g}${i}`, `202${gi}-01-0${i + 1}T00:00:00Z`)));
  const lib = mockLibrary(tracks);
  lib.genresByTrack = new Map(tracks.map((t) => [t.id, [t.id.replace(/\d+$/, '')]]));
  // Every song is below threshold, so all of them feed the cluster suggester.
  lib.matches = new Map(tracks.map((t) => [t.id, {
    best: { playlistId: 'p1', score: 0.1 }, alternates: [], belowThreshold: true,
  }]));
  return lib;
}

it('caps the playlist suggestions at four cards behind a disclosure', async () => {
  render(<Sorter settings={settings} lib={fiveClusters()} />);
  const strip = document.querySelector('.cluster-suggestions')!;
  expect(strip.tagName).toBe('DETAILS');
  expect(strip.querySelectorAll('li')).toHaveLength(4);
  await userEvent.click(screen.getByRole('button', { name: /show all 5/i }));
  expect(strip.querySelectorAll('li')).toHaveLength(5);
});

it('still creates a playlist from a suggestion card', async () => {
  const lib = fiveClusters();
  render(<Sorter settings={settings} lib={lib} />);
  await userEvent.click(screen.getAllByRole('button', { name: /create with 5 songs/i })[0]);
  await waitFor(() => expect(spotify.createPlaylist).toHaveBeenCalled());
});

it('labels the year column Yr', () => {
  render(<Sorter settings={settings} lib={mockLibrary([track('t1', '2024-06-01T00:00:00Z')])} />);
  expect(screen.getByText('Yr')).toBeInTheDocument();
  expect(screen.queryByText('Year')).not.toBeInTheDocument();
});

it('puts the resolve button on the coverage line it belongs to', () => {
  const lib = mockLibrary([track('t1', '2024-06-01T00:00:00Z')]);
  lib.coverage = { spotify: 3, musicbrainz: 1, none: 0, unresolved: 7 };
  render(<Sorter settings={settings} lib={lib} />);

  const line = document.querySelector('.status-line')!;
  expect(line.textContent).toMatch(/3 via Spotify/);
  // The button exists *because* unresolved > 0 — one thought, one line.
  expect(line).toContainElement(screen.getByRole('button', { name: /Resolve 7 via MusicBrainz/i }));
});

it('keeps the error rows as their own alerts', async () => {
  vi.mocked(spotify.addTracksToPlaylist).mockRejectedValueOnce(new Error('network down'));
  const lib = mockLibrary([track('t1', '2024-06-01T00:00:00Z')]);
  render(<Sorter settings={settings} lib={lib} />);
  await userEvent.click(screen.getByRole('button', { name: /^add$/i }));
  const alert = await screen.findByRole('alert');
  expect(alert).not.toHaveClass('status-line');
});
