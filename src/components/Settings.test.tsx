import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import Settings from './Settings';
import { buildFingerprint, matchSong, DEFAULT_THRESHOLD } from '../matching/engine';
import { FRESHNESS_LABEL } from '../freshness';
import type { LibraryState } from '../hooks/useLibrary';

const settings = { targetPlaylistIds: null, threshold: 0.3, sortOrder: 'oldest' as const };
const playlists = [
  { id: 'p1', name: 'Trip Hop', trackCount: 10 },
  { id: 'p2', name: 'Road Trip', trackCount: 20 },
];

const baseLib: LibraryState = {
  status: 'ready',
  error: null,
  tracks: [],
  playlists: [],
  allPlaylists: playlists,
  genresByTrack: new Map(),
  fingerprints: new Map(),
  artists: [],
  membership: new Map(),
  progress: { resolved: 0, total: 0 },
  matches: new Map(),
  removeTrackLocally: () => {},
  restoreTrackLocally: () => {},
  deepResolveAll: async () => {},
  deepState: 'idle',  deepPhase: null,
  refresh: () => {},
  snapshotAge: null,
  coverage: { spotify: 0, musicbrainz: 0, wikipedia: 0, none: 0, unresolved: 0 },
};

it('lists owned playlists all-checked and materializes the list on uncheck', async () => {
  const onChange = vi.fn();
  render(<Settings settings={settings} onChange={onChange} playlists={playlists} error={null} lib={baseLib} />);
  const roadTrip = screen.getByRole('checkbox', { name: /road trip/i });
  expect(roadTrip).toBeChecked();
  await userEvent.click(roadTrip);
  expect(onChange).toHaveBeenCalledWith({ ...settings, targetPlaylistIds: ['p1'] });
});

it('changes the threshold via the slider', async () => {
  const onChange = vi.fn();
  render(<Settings settings={settings} onChange={onChange} playlists={[]} error={null} lib={baseLib} />);
  const slider = screen.getByRole('slider');
  // range inputs don't work with userEvent.type; fire a change directly:
  const { fireEvent } = await import('@testing-library/react');
  fireEvent.change(slider, { target: { value: '0.5' } });
  expect(onChange).toHaveBeenCalledWith({ ...settings, threshold: 0.5 });
});

it('shows loading and error states from the library', () => {
  const { rerender } = render(
    <Settings settings={settings} onChange={vi.fn()} playlists={null} error={null} lib={baseLib} />,
  );
  expect(screen.getByText(/loading playlists/i)).toBeInTheDocument();
  rerender(<Settings settings={settings} onChange={vi.fn()} playlists={null} error="boom" lib={baseLib} />);
  expect(screen.getByRole('alert')).toHaveTextContent('boom');
});

it('shows an animated spinner while playlists are loading', () => {
  render(<Settings settings={settings} onChange={vi.fn()} playlists={null} error={null} lib={baseLib} />);
  expect(document.querySelector('.spinner')).toBeInTheDocument();
});

it('runs the DEV-only score report against the library and shows the histogram', async () => {
  const fingerprints = new Map([
    ['p1', buildFingerprint([{ genres: ['trip hop'], releaseYear: 1994 }])],
  ]);
  const tracks = [
    { id: 't1', uri: 'spotify:track:t1', name: 'Song', artists: [], albumName: '', releaseYear: 1994, isrc: null, addedAt: '2024-01-01' },
  ];
  const matches = new Map([
    ['t1', matchSong({ genres: ['trip hop'], releaseYear: 1994 }, fingerprints, DEFAULT_THRESHOLD)],
  ]);
  const lib: LibraryState = {
    ...baseLib,
    tracks,
    fingerprints,
    matches,
    genresByTrack: new Map([['t1', ['trip hop']]]),
  };
  render(<Settings settings={settings} onChange={vi.fn()} playlists={playlists} error={null} lib={lib} />);
  await userEvent.click(screen.getByRole('button', { name: /score report/i }));
  expect(screen.getByText(/1 of 1 tracks have a best-match candidate/i)).toBeInTheDocument();
  expect(screen.getByText(/genre coverage: 1 of 1 tracks/i)).toBeInTheDocument();
});

it('explains the banana ripeness ranking', () => {
  render(<Settings settings={settings} onChange={vi.fn()} playlists={playlists} error={null} lib={baseLib} />);
  expect(screen.getByRole('heading', { name: /ripeness/i })).toBeInTheDocument();
  // Read from FRESHNESS_LABEL, not retyped: the point of the explainer is that
  // it says exactly what the cards say.
  for (const label of Object.values(FRESHNESS_LABEL)) {
    expect(screen.getByText(label)).toBeInTheDocument();
  }
});
