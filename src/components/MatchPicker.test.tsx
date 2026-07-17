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

it('adds the best match by default without opening the popover', async () => {
  const onAdd = vi.fn();
  render(<MatchPicker match={match} playlistNames={playlistNames} onAdd={onAdd} />);
  expect(screen.getByRole('button', { name: /trip hop.*80%/i })).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: /^add$/i }));
  expect(onAdd).toHaveBeenCalledWith(['p1']);
});

it('swaps the target via the popover', async () => {
  const onAdd = vi.fn();
  render(<MatchPicker match={match} playlistNames={playlistNames} onAdd={onAdd} />);
  await userEvent.click(screen.getByRole('button', { name: /trip hop/i }));
  await userEvent.click(screen.getByRole('checkbox', { name: /chill/i }));
  await userEvent.click(screen.getByRole('checkbox', { name: /trip hop/i }));
  await userEvent.click(screen.getByRole('button', { name: /^add$/i }));
  expect(onAdd).toHaveBeenCalledWith(['p2']);
});

it('supports adding to multiple playlists and labels the button with the count', async () => {
  const onAdd = vi.fn();
  render(<MatchPicker match={match} playlistNames={playlistNames} onAdd={onAdd} />);
  await userEvent.click(screen.getByRole('button', { name: /trip hop/i }));
  await userEvent.click(screen.getByRole('checkbox', { name: /chill/i }));
  expect(screen.getByRole('button', { name: /add to 2 playlists/i })).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: /add to 2 playlists/i }));
  expect(onAdd).toHaveBeenCalledWith(['p1', 'p2']);
});

it('will not let the last checked candidate be unchecked', async () => {
  const onAdd = vi.fn();
  render(<MatchPicker match={match} playlistNames={playlistNames} onAdd={onAdd} />);
  await userEvent.click(screen.getByRole('button', { name: /trip hop/i }));
  await userEvent.click(screen.getByRole('checkbox', { name: /trip hop/i }));
  expect(screen.getByRole('checkbox', { name: /trip hop/i })).toBeChecked();
  await userEvent.click(screen.getByRole('button', { name: /^add$/i }));
  expect(onAdd).toHaveBeenCalledWith(['p1']);
});

it('shows a dimmed "best guess" pill for below-threshold matches but keeps Add usable', () => {
  render(
    <MatchPicker
      match={{ ...match, belowThreshold: true }}
      playlistNames={playlistNames}
      onAdd={vi.fn()}
    />,
  );
  expect(screen.getByText(/best guess: trip hop/i)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^add$/i })).toBeEnabled();
});

it('renders a placeholder while match is undefined', () => {
  render(<MatchPicker match={undefined} playlistNames={playlistNames} onAdd={vi.fn()} />);
  expect(screen.getByText('…')).toBeInTheDocument();
});

it('renders a no-candidates message when there is no best match', () => {
  render(
    <MatchPicker
      match={{ best: null, alternates: [], belowThreshold: true }}
      playlistNames={playlistNames}
      onAdd={vi.fn()}
    />,
  );
  expect(screen.getByText(/no candidate playlists/i)).toBeInTheDocument();
});
