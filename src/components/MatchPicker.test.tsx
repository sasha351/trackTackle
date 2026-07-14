import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import MatchPicker from './MatchPicker';

const playlistNames = new Map([
  ['p1', 'Trip Hop'], ['p2', 'Chill'], ['p3', 'Rock'],
]);
const match = {
  best: { playlistId: 'p1', score: 0.8 },
  alternates: [
    { playlistId: 'p2', score: 0.5 },
    { playlistId: 'p3', score: 0.2 },
  ],
  belowThreshold: false,
};

it('adds the best match by default', async () => {
  const onAdd = vi.fn();
  render(<MatchPicker match={match} playlistNames={playlistNames} onAdd={onAdd} />);
  await userEvent.click(screen.getByRole('button', { name: /^add$/i }));
  expect(onAdd).toHaveBeenCalledWith(['p1']);
});

it('swaps the target via the dropdown', async () => {
  const onAdd = vi.fn();
  render(<MatchPicker match={match} playlistNames={playlistNames} onAdd={onAdd} />);
  await userEvent.selectOptions(screen.getByRole('combobox'), 'p2');
  await userEvent.click(screen.getByRole('button', { name: /^add$/i }));
  expect(onAdd).toHaveBeenCalledWith(['p2']);
});

it('supports adding to multiple playlists', async () => {
  const onAdd = vi.fn();
  render(<MatchPicker match={match} playlistNames={playlistNames} onAdd={onAdd} />);
  await userEvent.click(screen.getByText(/multiple/i));
  await userEvent.click(screen.getByRole('checkbox', { name: /chill/i }));
  await userEvent.click(screen.getByRole('button', { name: /^add$/i }));
  expect(onAdd).toHaveBeenCalledWith(['p1', 'p2']);
});

it('badges below-threshold matches but keeps them usable', () => {
  render(
    <MatchPicker
      match={{ ...match, belowThreshold: true }}
      playlistNames={playlistNames}
      onAdd={vi.fn()}
    />,
  );
  expect(screen.getByText(/no strong match/i)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^add$/i })).toBeEnabled();
});

it('renders a placeholder while match is undefined', () => {
  render(<MatchPicker match={undefined} playlistNames={playlistNames} onAdd={vi.fn()} />);
  expect(screen.getByText('…')).toBeInTheDocument();
});
