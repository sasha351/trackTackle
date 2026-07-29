import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import SongRow from './SongRow';
import { resetResolverForTests } from '../genre/resolver';

const track = {
  id: 't1', uri: 'spotify:track:t1', name: 'Glory Box',
  artists: [{ id: 'a1', name: 'Portishead' }],
  albumName: 'Dummy', releaseYear: 1994, isrc: null, addedAt: '2024-03-05T12:00:00Z',
};

const match = { best: { playlistId: 'p1', score: 0.9 }, alternates: [], belowThreshold: false };
const playlistNames = new Map([['p1', 'Trip Hop']]);

afterEach(() => {
  localStorage.clear();
  resetResolverForTests();
});

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

it('shows a MusicBrainz badge when an artist resolved via MusicBrainz', () => {
  localStorage.setItem('kondo:genres:v3', JSON.stringify({
    a1: { genres: ['trip hop'], source: 'musicbrainz' },
  }));
  resetResolverForTests();
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
  expect(screen.getByTitle('Resolved via MusicBrainz')).toBeInTheDocument();
});

it('omits the MusicBrainz badge when the artist resolved via Spotify', () => {
  localStorage.setItem('kondo:genres:v3', JSON.stringify({
    a1: { genres: ['trip hop'], source: 'spotify' },
  }));
  resetResolverForTests();
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
  expect(screen.queryByTitle('Resolved via MusicBrainz')).not.toBeInTheDocument();
});

it('links the track name to its Spotify page in a new tab', () => {
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
  const link = screen.getByRole('link', { name: 'Glory Box' });
  expect(link).toHaveAttribute('href', 'https://open.spotify.com/track/t1');
  expect(link).toHaveAttribute('target', '_blank');
  expect(link).toHaveAttribute('rel', 'noopener noreferrer');
});
