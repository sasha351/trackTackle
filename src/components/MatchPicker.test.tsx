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

it('collapses the popover on Escape', async () => {
  render(<MatchPicker match={match} playlistNames={playlistNames} onAdd={vi.fn()} />);
  await userEvent.click(screen.getByRole('button', { name: /trip hop/i }));
  expect(screen.getByRole('searchbox', { name: /search all playlists/i })).toBeInTheDocument();
  await userEvent.keyboard('{Escape}');
  expect(screen.queryByRole('searchbox', { name: /search all playlists/i })).not.toBeInTheDocument();
});

it('keeps only one picker open — opening one collapses an adjacent one', async () => {
  const other = { best: { playlistId: 'p3', score: 0.2 }, alternates: [], belowThreshold: false };
  render(
    <>
      <MatchPicker match={match} playlistNames={playlistNames} onAdd={vi.fn()} />
      <MatchPicker match={other} playlistNames={playlistNames} onAdd={vi.fn()} />
    </>,
  );
  await userEvent.click(screen.getByRole('button', { name: /trip hop/i }));
  expect(screen.getAllByRole('searchbox', { name: /search all playlists/i })).toHaveLength(1);
  await userEvent.click(screen.getByRole('button', { name: /rock.*20%/i }));
  // First popover collapsed as the second opened — still exactly one on screen, no overlap.
  expect(screen.getAllByRole('searchbox', { name: /search all playlists/i })).toHaveLength(1);
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

it('shows a DEV-only score breakdown per candidate when one is attached', async () => {
  const withBreakdown = {
    best: {
      playlistId: 'p1', score: 0.61,
      breakdown: {
        total: 0.61, genre: 0.42, era: 0.05, lang: 0.14, langPenalty: 1,
        overlap: ['drill', 'uk drill'], songGenres: 2, fpGenres: 5,
      },
    },
    alternates: [],
    belowThreshold: false,
  };
  render(<MatchPicker match={withBreakdown} playlistNames={playlistNames} onAdd={vi.fn()} />);
  await userEvent.click(screen.getByRole('button', { name: /trip hop/i }));
  expect(screen.getByText('0.42g · 0.05e · 0.14l — shared: drill, uk drill')).toBeInTheDocument();
});

it('flags a language-mismatch penalty in the DEV score breakdown', async () => {
  const penalized = {
    best: {
      playlistId: 'p1', score: 0.2125,
      breakdown: {
        total: 0.2125, genre: 0.1625, era: 0.05, lang: 0, langPenalty: 0.25,
        overlap: ['rap'], songGenres: 1, fpGenres: 1,
      },
    },
    alternates: [],
    belowThreshold: false,
  };
  render(<MatchPicker match={penalized} playlistNames={playlistNames} onAdd={vi.fn()} />);
  await userEvent.click(screen.getByRole('button', { name: /trip hop/i }));
  expect(screen.getByText('0.16g · 0.05e · 0.00l · ×0.25 lang — shared: rap')).toBeInTheDocument();
});

it('omits the breakdown line when a candidate has none attached', async () => {
  render(<MatchPicker match={match} playlistNames={playlistNames} onAdd={vi.fn()} />);
  await userEvent.click(screen.getByRole('button', { name: /trip hop/i }));
  expect(screen.queryByText(/shared:/)).not.toBeInTheDocument();
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

const images = new Map([['p1', 'https://i.scdn.co/p1'], ['p2', null]]);

it('panel layout shows the best match as a cover with the caption under it', () => {
  render(
    <MatchPicker
      match={match}
      playlistNames={playlistNames}
      playlistImages={images}
      onAdd={vi.fn()}
      layout="panel"
    />,
  );
  // No trigger pill in this layout — the cover *is* the match's identity.
  expect(screen.queryByRole('button', { name: /trip hop · 80%/i })).not.toBeInTheDocument();
  expect(screen.getByRole('presentation')).toHaveAttribute('src', 'https://i.scdn.co/p1');
  expect(screen.getByRole('link', { name: /trip hop/i }))
    .toHaveAttribute('href', 'https://open.spotify.com/playlist/p1');
  expect(screen.getByText(/trip hop · 80%/i)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^add$/i })).toBeEnabled();
});

it('panel layout hides the candidates until show more, then reuses the browse section', async () => {
  render(
    <MatchPicker
      match={match}
      playlistNames={playlistNames}
      playlistImages={images}
      onAdd={vi.fn()}
      layout="panel"
    />,
  );
  expect(screen.queryByRole('searchbox', { name: /search all playlists/i })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: /show more/i }));
  // Scored candidates as tiles, plus the untouched browse section.
  expect(screen.getByRole('checkbox', { name: /chill/i })).toBeInTheDocument();
  expect(screen.getByRole('searchbox', { name: /search all playlists/i })).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: /hide/i }));
  expect(screen.queryByRole('searchbox', { name: /search all playlists/i })).not.toBeInTheDocument();
});

it('panel layout renders the candidate/search body as a sibling of match-panel, not nested inside it', async () => {
  // The sketch runs the tile row and search under the *album* cover too — a
  // third grid track .match-panel's own X | X grid doesn't have. Nesting
  // .panel-body inside .match-panel confines it to match-panel's own two
  // tracks, leaving the album-cover column blank above it.
  const { container } = render(
    <MatchPicker
      match={match}
      playlistNames={playlistNames}
      playlistImages={images}
      onAdd={vi.fn()}
      layout="panel"
    />,
  );
  await userEvent.click(screen.getByRole('button', { name: /show more/i }));
  const panel = container.querySelector('.match-panel');
  const body = container.querySelector('.panel-body');
  expect(body).not.toBeNull();
  expect(panel).not.toContainElement(body);
});

it('panel layout keeps the selection invariants — Add never fires empty', async () => {
  const onAdd = vi.fn();
  render(
    <MatchPicker
      match={match}
      playlistNames={playlistNames}
      playlistImages={images}
      onAdd={onAdd}
      layout="panel"
    />,
  );
  await userEvent.click(screen.getByRole('button', { name: /show more/i }));
  await userEvent.click(screen.getByRole('checkbox', { name: /trip hop/i })); // deselect the default
  expect(screen.getByRole('button', { name: /^add$/i })).toBeDisabled();
  await userEvent.click(screen.getByRole('checkbox', { name: /chill/i }));
  await userEvent.click(screen.getByRole('button', { name: /^add$/i }));
  expect(onAdd).toHaveBeenCalledWith(['p2']);
});

it('panel layout does not collapse on an outside click — it is inline, not floating', async () => {
  render(
    <div>
      <button>elsewhere</button>
      <MatchPicker
        match={match}
        playlistNames={playlistNames}
        playlistImages={images}
        onAdd={vi.fn()}
        layout="panel"
      />
    </div>,
  );
  await userEvent.click(screen.getByRole('button', { name: /show more/i }));
  await userEvent.click(screen.getByRole('button', { name: 'elsewhere' }));
  expect(screen.getByRole('searchbox', { name: /search all playlists/i })).toBeInTheDocument();
});

it('panel layout offers a way in when there is no best match', async () => {
  const onAdd = vi.fn();
  render(
    <MatchPicker
      match={{ best: null, alternates: [], belowThreshold: true }}
      playlistNames={playlistNames}
      playlistImages={images}
      onAdd={onAdd}
      layout="panel"
    />,
  );
  expect(screen.getByRole('button', { name: /^add$/i })).toBeDisabled();
  expect(screen.getByText(/add to a playlist/i)).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: /show more/i }));
  await userEvent.click(screen.getByRole('checkbox', { name: /rock/i }));
  await userEvent.click(screen.getByRole('button', { name: /^add$/i }));
  expect(onAdd).toHaveBeenCalledWith(['p3']);
});
