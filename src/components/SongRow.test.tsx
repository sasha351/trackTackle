import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import SongRow from './SongRow';

const track = {
  id: 't1', uri: 'spotify:track:t1', name: 'Glory Box',
  artists: [{ id: 'a1', name: 'Portishead' }],
  albumName: 'Dummy', releaseYear: 1994, isrc: null, addedAt: '2024-03-05T12:00:00Z',
};

const match = { best: { playlistId: 'p1', score: 0.9 }, alternates: [], belowThreshold: false };
const playlistNames = new Map([['p1', 'Trip Hop']]);

it('renders name, artists, genres, date added, and the match picker', () => {
  render(
    <ul>
      <SongRow
        track={track}
        genres={['trip hop']}
        match={match}
        playlistNames={playlistNames}
        onAdd={() => {}}
        onPlay={() => {}}
        isPlaying={false}
      />
    </ul>,
  );
  expect(screen.getByText('Glory Box')).toBeInTheDocument();
  expect(screen.getByText('Portishead')).toBeInTheDocument();
  expect(screen.getByText('trip hop')).toBeInTheDocument();
  expect(screen.getByText('2024-03-05')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'play' })).toBeInTheDocument();
});

it('shows a pause button and calls onPlay with the track uri', async () => {
  const onPlay = vi.fn();
  render(
    <ul>
      <SongRow
        track={track}
        genres={['trip hop']}
        match={match}
        playlistNames={playlistNames}
        onAdd={() => {}}
        onPlay={onPlay}
        isPlaying
      />
    </ul>,
  );
  const button = screen.getByRole('button', { name: 'pause' });
  await userEvent.click(button);
  expect(onPlay).toHaveBeenCalledWith(track.uri);
});

it('hides the match picker and disables play while pending', () => {
  render(
    <ul>
      <SongRow
        track={track}
        genres={['trip hop']}
        match={match}
        playlistNames={playlistNames}
        onAdd={() => {}}
        onPlay={() => {}}
        isPlaying={false}
        pending
      />
    </ul>,
  );
  expect(screen.getByRole('button', { name: 'play' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: /add/i })).not.toBeInTheDocument();
});
