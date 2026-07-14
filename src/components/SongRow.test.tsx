import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import SongRow from './SongRow';

const track = {
  id: 't1', uri: 'spotify:track:t1', name: 'Glory Box',
  artists: [{ id: 'a1', name: 'Portishead' }],
  albumName: 'Dummy', releaseYear: 1994, isrc: null, addedAt: '2024-03-05T12:00:00Z',
};

it('renders name, artists, genres, and date added', () => {
  render(
    <ul>
      <SongRow track={track} genres={['trip hop']} matchSlot={<span>MATCH</span>} />
    </ul>,
  );
  expect(screen.getByText('Glory Box')).toBeInTheDocument();
  expect(screen.getByText('Portishead')).toBeInTheDocument();
  expect(screen.getByText('trip hop')).toBeInTheDocument();
  expect(screen.getByText('2024-03-05')).toBeInTheDocument();
  expect(screen.getByText('MATCH')).toBeInTheDocument();
});
