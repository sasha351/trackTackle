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
const membership = new Map<string, Set<string>>();

afterEach(() => {
  localStorage.clear();
  resetResolverForTests();
  Object.defineProperty(window.navigator, 'userAgent', {
    value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120',
    configurable: true,
  });
});

it('renders name, artists, genres, date added, and the match picker', () => {
  render(
    <ul>
      <SongRow
        track={track}
        genres={['trip hop']}
        match={match}
        playlistNames={playlistNames}
        membership={membership}
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
        membership={membership}
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
        membership={membership}
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
        membership={membership}
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
        membership={membership}
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
        membership={membership}
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

it('drops the artist, year and date columns in compact mode', () => {
  render(
    <ul>
      <SongRow
        track={track}
        genres={['trip hop']}
        match={match}
        playlistNames={playlistNames}
        membership={membership}
        onAdd={() => {}}
        onPlay={() => {}}
        isPlaying={false}
        compact
      />
    </ul>,
  );
  // Omitted from the DOM, not hidden: a screen reader must not read a column
  // the card does not draw.
  expect(screen.queryByText('Portishead')).not.toBeInTheDocument();
  expect(screen.queryByText('1994')).not.toBeInTheDocument();
  expect(screen.queryByText('2024-03-05')).not.toBeInTheDocument();
  // Everything the card still has to do survives.
  expect(screen.getByText('Glory Box')).toBeInTheDocument();
  expect(screen.getByText('trip hop')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'play' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^add$/i })).toBeInTheDocument();
  expect(document.querySelector('.song-row')).toHaveClass('compact');
});

it('orders the controls as pill → play → remove', () => {
  render(
    <ul>
      <SongRow
        track={track}
        genres={['trip hop']}
        match={match}
        playlistNames={playlistNames}
        membership={membership}
        onAdd={() => {}}
        onPlay={() => {}}
        isPlaying={false}
      />
    </ul>,
  );
  const controls = document.querySelector('.song-match')!;
  const order = [...controls.querySelectorAll('button')].map((b) =>
    b.className.split(' ')[0]);
  // The MatchPicker unit (its trigger pill + Add) comes first, then the round
  // play button, then remove — matching `design sketches/dense view.jpeg`.
  expect(order).toEqual(['match-pill', 'pill-green', 'play-btn', 'remove-btn']);
});

it('hides the play button where the Web Playback SDK cannot run', () => {
  Object.defineProperty(window.navigator, 'userAgent', {
    value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15',
    configurable: true,
  });
  render(
    <ul>
      <SongRow
        track={track}
        genres={['trip hop']}
        match={match}
        playlistNames={playlistNames}
        membership={membership}
        onAdd={() => {}}
        onPlay={() => {}}
        isPlaying={false}
      />
    </ul>,
  );
  // A button that provably cannot work is worse than no button.
  expect(screen.queryByRole('button', { name: 'play' })).not.toBeInTheDocument();
  // The Spotify link is the mobile substitute, and it stays.
  expect(screen.getByRole('link', { name: 'Glory Box' })).toBeInTheDocument();
});

it('marks the row as playing so it stands out in a long list', () => {
  const { rerender } = render(
    <ul>
      <SongRow
        track={track}
        genres={['trip hop']}
        match={match}
        playlistNames={playlistNames}
        membership={membership}
        onAdd={() => {}}
        onPlay={() => {}}
        isPlaying={false}
      />
    </ul>,
  );
  expect(document.querySelector('.song-row')).not.toHaveClass('playing');

  rerender(
    <ul>
      <SongRow
        track={track}
        genres={['trip hop']}
        match={match}
        playlistNames={playlistNames}
        membership={membership}
        onAdd={() => {}}
        onPlay={() => {}}
        isPlaying
      />
    </ul>,
  );
  expect(document.querySelector('.song-row')).toHaveClass('playing');
});
