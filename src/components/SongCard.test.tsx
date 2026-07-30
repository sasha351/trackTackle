import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import SongCard from './SongCard';
import { freshnessScale } from '../freshness';

const track = {
  id: 't1', uri: 'spotify:track:t1', name: 'Glory Box',
  artists: [{ id: 'a1', name: 'Portishead' }],
  albumName: 'Dummy', releaseYear: 1994, isrc: null,
  addedAt: '2024-03-05T12:00:00Z', albumArt: 'https://i.scdn.co/album',
};

const match = { best: { playlistId: 'p1', score: 0.9 }, alternates: [], belowThreshold: false };
const playlistNames = new Map([['p1', 'Trip Hop']]);
const playlistImages = new Map([['p1', 'https://i.scdn.co/p1']]);
const membership = new Map<string, Set<string>>();
const scale = freshnessScale(['2024-01-01T00:00:00Z', '2024-06-01T00:00:00Z']);

const renderCard = (props: Partial<Parameters<typeof SongCard>[0]> = {}) =>
  render(
    <ul>
      <SongCard
        track={track}
        match={match}
        playlistNames={playlistNames}
        playlistImages={playlistImages}
        membership={membership}
        scale={scale}
        onAdd={() => {}}
        onPlay={() => {}}
        isPlaying={false}
        {...props}
      />
    </ul>,
  );

it('renders the song block, the date box and the match panel', () => {
  renderCard();
  expect(screen.getByRole('link', { name: 'Glory Box' }))
    .toHaveAttribute('href', 'https://open.spotify.com/track/t1');
  expect(screen.getByText('Portishead')).toBeInTheDocument();
  expect(screen.getByText('1994')).toBeInTheDocument();
  expect(screen.getByText('2024-03-05')).toBeInTheDocument();
  // Album cover plus the best-match playlist cover.
  const covers = screen.getAllByRole('presentation');
  expect(covers.map((c) => c.getAttribute('src')))
    .toEqual(['https://i.scdn.co/album', 'https://i.scdn.co/p1']);
  expect(screen.getByRole('button', { name: /^add$/i })).toBeInTheDocument();
});

it('labels the banana so the ranking is not colour-only', () => {
  renderCard();
  // 2024-03-05 sits in the middle third of a Jan 1 → Jun 1 span.
  expect(screen.getByRole('img', { name: 'Settled in' })).toBeInTheDocument();
});

it('plays and removes through the same callbacks as the table row', async () => {
  const onPlay = vi.fn();
  const onAdd = vi.fn();
  renderCard({ onPlay, onAdd });
  await userEvent.click(screen.getByRole('button', { name: 'play' }));
  expect(onPlay).toHaveBeenCalledWith('spotify:track:t1');
  await userEvent.click(screen.getByTitle(/remove from liked songs/i));
  expect(onAdd).toHaveBeenCalledWith(track, []);
});

it('falls back to a text tile when a song has no album art', () => {
  renderCard({ track: { ...track, albumArt: null } });
  expect(screen.getAllByRole('presentation')).toHaveLength(1); // only the playlist cover
  expect(screen.getByText('G')).toBeInTheDocument();
});

it('hides the match panel and disables play while pending', () => {
  renderCard({ pending: true });
  expect(screen.getByRole('button', { name: 'play' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: /^add$/i })).not.toBeInTheDocument();
});
