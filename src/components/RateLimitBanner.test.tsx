import { afterEach, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import RateLimitBanner from './RateLimitBanner';
import { configureSpotify, resetRateLimitForTests, spotifyFetch } from '../api/spotify';
import { saveTokens } from '../auth/token';

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  resetRateLimitForTests();
});

it('renders nothing when there is no penalty', () => {
  const { container } = render(<RateLimitBanner />);
  expect(container).toBeEmptyDOMElement();
});

it('counts down while a penalty is live', async () => {
  configureSpotify('cid');
  saveTokens({ accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 3600_000 });
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response('', { status: 429, headers: { 'Retry-After': '120' } }),
  );

  render(<RateLimitBanner />);
  await spotifyFetch('/me').catch(() => {});

  await waitFor(() => expect(screen.getByRole('status')).toBeTruthy());
  expect(screen.getByRole('status').textContent).toMatch(/resuming in 2:0\d/);
  // The estimate is honest about being an estimate — Retry-After is usually
  // CORS-hidden in a browser.
  expect(screen.getByRole('status').textContent).toMatch(/estimate/i);
});
