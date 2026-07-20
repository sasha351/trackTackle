import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import MatchPicker from './MatchPicker';

const playlistNames = new Map([
  ['p1', 'Trip Hop'], ['p2', 'Chill'], ['p3', 'Rock'], ['p4', 'Jazz'],
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

it('disables Add when no target is checked', async () => {
  const onAdd = vi.fn();
  render(<MatchPicker match={match} playlistNames={playlistNames} onAdd={onAdd} />);
  await userEvent.click(screen.getByRole('button', { name: /trip hop/i }));
  await userEvent.click(screen.getByRole('checkbox', { name: /trip hop/i }));
  expect(screen.getByRole('checkbox', { name: /trip hop/i })).not.toBeChecked();
  expect(screen.getByRole('button', { name: /^add$/i })).toBeDisabled();
});

it('adds to any library playlist via the search-all browse list', async () => {
  const onAdd = vi.fn();
  render(<MatchPicker match={match} playlistNames={playlistNames} onAdd={onAdd} />);
  await userEvent.click(screen.getByRole('button', { name: /trip hop/i }));
  // Jazz (p4) is not a scored candidate — it only lives in the browse list.
  await userEvent.type(screen.getByRole('searchbox', { name: /search all playlists/i }), 'jaz');
  await userEvent.click(screen.getByRole('checkbox', { name: /jazz/i }));
  await userEvent.click(screen.getByRole('button', { name: /add to 2 playlists/i }));
  expect(onAdd).toHaveBeenCalledWith(['p1', 'p4']);
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

it('offers a browse-all entry point when there is no best match', async () => {
  const onAdd = vi.fn();
  render(
    <MatchPicker
      match={{ best: null, alternates: [], belowThreshold: true }}
      playlistNames={playlistNames}
      onAdd={onAdd}
    />,
  );
  // Nothing to add yet, but the way in is featured, not a dead end.
  expect(screen.getByRole('button', { name: /^add$/i })).toBeDisabled();
  await userEvent.click(screen.getByRole('button', { name: /add to a playlist/i }));
  await userEvent.click(screen.getByRole('checkbox', { name: /rock/i }));
  await userEvent.click(screen.getByRole('button', { name: /^add$/i }));
  expect(onAdd).toHaveBeenCalledWith(['p3']);
});

it('drops a selection whose playlist no longer exists in the library', async () => {
  const onAdd = vi.fn();
  const { rerender } = render(<MatchPicker match={match} playlistNames={playlistNames} onAdd={onAdd} />);
  await userEvent.click(screen.getByRole('button', { name: /trip hop/i }));
  await userEvent.click(screen.getByRole('checkbox', { name: /chill/i })); // p2, survives
  await userEvent.click(screen.getByRole('checkbox', { name: /rock/i })); // p3, deleted below
  // Library reload: p3 (Rock) has been deleted from Spotify, so it drops out of playlistNames.
  const reloaded = new Map([['p1', 'Trip Hop'], ['p2', 'Chill'], ['p4', 'Jazz']]);
  rerender(<MatchPicker match={match} playlistNames={reloaded} onAdd={onAdd} />);
  await userEvent.click(screen.getByRole('button', { name: /add to 2 playlists/i }));
  expect(onAdd).toHaveBeenCalledWith(['p1', 'p2']);
});
