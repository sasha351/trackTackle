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
  },
});
