import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import App from './App';
import { saveTokens } from './auth/token';
import { useLibrary } from './hooks/useLibrary';
import type { LibraryState } from './hooks/useLibrary';

// Workspace isn't exported, so drive it through App with the settings tab —
// mock the hook rather than the network calls it makes.
vi.mock('./hooks/useLibrary', () => ({ useLibrary: vi.fn() }));

const baseLib: LibraryState = {
  status: 'ready',
  error: null,
  tracks: [],
  playlists: [],
  allPlaylists: [],
  genresByTrack: new Map(),
  fingerprints: new Map(),
  progress: { resolved: 0, total: 0 },
  matches: new Map(),
  removeTrackLocally: () => {},
  restoreTrackLocally: () => {},
};

vi.mocked(useLibrary).mockReturnValue(baseLib);

afterEach(() => {
  localStorage.clear();
  vi.mocked(useLibrary).mockReturnValue(baseLib);
});

it('shows the login button when unauthenticated', () => {
  render(<App />);
  expect(screen.getByRole('button', { name: /log in with spotify/i })).toBeInTheDocument();
});

it('shows the tab nav when authenticated', () => {
  saveTokens({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 });
  render(<App />);
  expect(screen.getByRole('button', { name: /sorter/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /analyzer/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /settings/i })).toBeInTheDocument();
});

it('brands the app as Kondo', () => {
  render(<App />);
  expect(screen.getByRole('heading', { name: 'Kondo' })).toBeInTheDocument();
});

it('shows the library error in Settings when there are no playlists to fall back on', async () => {
  vi.mocked(useLibrary).mockReturnValue({ ...baseLib, status: 'error', error: 'boom', allPlaylists: [] });
  saveTokens({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 });
  render(<App />);
  await userEvent.click(screen.getByRole('button', { name: /settings/i }));
  expect(screen.getByRole('alert')).toHaveTextContent('boom');
});

it('shows Settings playlists instead of the error when the library already loaded them', async () => {
  vi.mocked(useLibrary).mockReturnValue({
    ...baseLib,
    status: 'error',
    error: 'boom',
    allPlaylists: [{ id: 'p1', name: 'Trip Hop', trackCount: 10 }],
  });
  saveTokens({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 });
  render(<App />);
  await userEvent.click(screen.getByRole('button', { name: /settings/i }));
  expect(screen.getByRole('checkbox', { name: /trip hop/i })).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
