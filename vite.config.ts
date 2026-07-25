import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // ponytail: pin to IPv4 loopback — Spotify's redirect URI is 127.0.0.1, but
  // vite's default `host: 'localhost'` resolves to ::1-only on some systems
  server: { host: '127.0.0.1' },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.ts',
    // Vitest stubs .css imports to '' by default, which silently empties the
    // `?raw` import index.css.test.ts asserts against. Only main.tsx imports
    // the stylesheet, and no test mounts it, so turning processing on is inert
    // for every other suite.
    css: true,
  },
});
