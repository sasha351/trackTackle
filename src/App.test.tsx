import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import App from './App';
import { exchangeCode, saveTokens } from './auth/token';
import { useLibrary } from './hooks/useLibrary';
import type { LibraryState } from './hooks/useLibrary';

// Workspace isn't exported, so drive it through App with the settings tab —
// mock the hook rather than the network calls it makes.
vi.mock('./hooks/useLibrary', () => ({ useLibrary: vi.fn() }));

// Only exchangeCode is faked; saveTokens/loadTokens stay real so the authed
// tests below still work off localStorage.
vi.mock('./auth/token', async (orig) => ({
  ...(await orig<typeof import('./auth/token')>()),
  exchangeCode: vi.fn(async () => {}),
}));

const baseLib: LibraryState = {
  status: 'ready',
  error: null,
  tracks: [],
  playlists: [],
  allPlaylists: [],
  genresByTrack: new Map(),
  fingerprints: new Map(),
  artists: [],
  membership: new Map(),
  progress: { resolved: 0, total: 0 },
  matches: new Map(),
  removeTrackLocally: () => {},
  restoreTrackLocally: () => {},
  deepResolveAll: async () => {},
  deepState: 'idle',  deepPhase: null,
  refresh: () => {},
  snapshotAge: null,
  coverage: { spotify: 0, musicbrainz: 0, wikipedia: 0, none: 0, unresolved: 0 },
};

vi.mocked(useLibrary).mockReturnValue(baseLib);

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState(null, '', '/');
  vi.mocked(exchangeCode).mockClear();
  vi.mocked(useLibrary).mockReturnValue(baseLib);
});

it('shows the login button when unauthenticated', () => {
  render(<App />);
  expect(screen.getByRole('button', { name: /continue with spotify/i })).toBeInTheDocument();
});

it('shows the tab nav when authenticated', () => {
  saveTokens({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 });
  render(<App />);
  expect(screen.getByRole('button', { name: /sorter/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /analyzer/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /settings/i })).toBeInTheDocument();
});

it('hides the tab nav while the legal page is shown', async () => {
  saveTokens({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 });
  render(<App />);
  await userEvent.click(screen.getByRole('button', { name: /privacy & terms/i }));
  expect(screen.queryByRole('button', { name: /^sorter$/i })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^analyzer$/i })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^settings$/i })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^log out$/i })).not.toBeInTheDocument();
});

it('explains a cancelled consent screen instead of silently showing the login page', () => {
  window.history.replaceState(null, '', '/?error=access_denied');
  render(<App />);
  expect(screen.getByRole('status')).toHaveTextContent(/cancelled the spotify login/i);
  expect(exchangeCode).not.toHaveBeenCalled();
  expect(window.location.search).toBe(''); // the error param is scrubbed
});

it('reports a non-cancel authorize error rather than swallowing it', () => {
  window.history.replaceState(null, '', '/?error=invalid_scope');
  render(<App />);
  expect(screen.getByRole('status')).toHaveTextContent(/invalid_scope/);
});

it('refuses to exchange a code whose state does not match the one it stored', () => {
  sessionStorage.setItem('tracktackle:verifier', 'v');
  sessionStorage.setItem('tracktackle:state', 'ours');
  window.history.replaceState(null, '', '/?code=abc&state=theirs');
  render(<App />);
  expect(exchangeCode).not.toHaveBeenCalled();
  expect(screen.getByRole('alert')).toHaveTextContent(/state mismatch/i);
  // Both must be spent even on the failure path, or a later attempt could
  // replay them against an attacker-supplied code.
  expect(sessionStorage.getItem('tracktackle:verifier')).toBeNull();
  expect(sessionStorage.getItem('tracktackle:state')).toBeNull();
});

it('exchanges the code when the state matches', () => {
  sessionStorage.setItem('tracktackle:verifier', 'v');
  sessionStorage.setItem('tracktackle:state', 'ours');
  window.history.replaceState(null, '', '/?code=abc&state=ours');
  render(<App />);
  expect(exchangeCode).toHaveBeenCalledWith('abc', 'v', expect.anything(), expect.anything());
});

it('brands the app as Track Tackle', () => {
  render(<App />);
  expect(screen.getByRole('heading', { name: 'Track Tackle' })).toBeInTheDocument();
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

it('attributes music data and playback to Spotify in the footer', () => {
  render(<App />);
  expect(screen.getByText(/music data and playback provided by spotify/i)).toBeInTheDocument();
  expect(screen.getByText(/not affiliated with spotify ab/i)).toBeInTheDocument();
});

it('toggles the skin and persists it', async () => {
  saveTokens({ accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 3600_000 });
  render(<App />);
  const toggle = screen.getByRole('button', { name: /gallery view/i });
  expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await userEvent.click(toggle);
  expect(screen.getByRole('button', { name: /table view/i })).toHaveAttribute('aria-pressed', 'true');
  expect(JSON.parse(localStorage.getItem('tracktackle:settings:v1')!).skin).toBe('gallery');
});
