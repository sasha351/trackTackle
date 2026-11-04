import { readFileSync } from 'node:fs';
import { defineConfig, configDefaults } from 'vitest/config';
import react from '@vitejs/plugin-react';

/** The production security headers, read out of vercel.json rather than
 *  restated here — a CSP that drifts from the one Vercel serves is worse than
 *  no local CSP at all, because it tests the wrong thing.
 *
 *  Applied to `preview` only, never `dev`: React Refresh injects an inline
 *  module preamble that `script-src 'self'` would block, so a dev server under
 *  this policy simply does not boot. `vite preview` serves the real build, so
 *  it is the faithful rehearsal anyway. That matters most for the Web Playback
 *  SDK, whose needs
 *  are not obvious from reading the app: it loads a script from sdk.scdn.co,
 *  injects an *iframe* from the same host for EME/DRM, streams audio through
 *  MSE `blob:` URLs and spawns a worker — hence `frame-src`, `media-src blob:`
 *  and `worker-src blob:`, none of which you would guess from grepping for
 *  fetch calls. `img-src` covers *.spotifycdn.com as well as *.scdn.co because
 *  playlist and Blend covers come from the former. */
const prodHeaders: Record<string, string> = Object.fromEntries(
  (JSON.parse(readFileSync(new URL('./vercel.json', import.meta.url), 'utf8')) as {
    headers: { headers: { key: string; value: string }[] }[];
  }).headers[0].headers.map((h) => [h.key, h.value]),
);

export default defineConfig({
  plugins: [react()],
  // ponytail: pin to IPv4 loopback — Spotify's redirect URI is 127.0.0.1, but
  // vite's default `host: 'localhost'` resolves to ::1-only on some systems
  server: { host: '127.0.0.1' },
  preview: { host: '127.0.0.1', headers: prodHeaders },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.ts',
    // Vitest stubs .css imports to '' by default, which silently empties the
    // `?raw` import index.css.test.ts asserts against. Only main.tsx imports
    // the stylesheet, and no test mounts it, so turning processing on is inert
    // for every other suite.
    css: true,
    // A stray worktree under .claude/worktrees/ has its own node_modules and
    // full source tree; without this it doubles every test file Vitest finds.
    exclude: [...configDefaults.exclude, '.claude/**'],
    // .env.local is git-ignored and per-directory, so CI and fresh clones
    // have no VITE_SPOTIFY_CLIENT_ID and config.ts's CLIENT_ID is undefined.
    // Pin a fake one so the suite is hermetic and can assert the exact value
    // App passes to the token exchange.
    // VITE_LASTFM_API_KEY pinned empty for the same reason in reverse: a
    // developer's .env.local key would otherwise send deep-run tests to Last.fm.
    env: { VITE_SPOTIFY_CLIENT_ID: 'test-client-id', VITE_LASTFM_API_KEY: '' },
  },
});
