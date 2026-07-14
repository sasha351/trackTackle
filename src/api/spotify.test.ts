import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { configureSpotify, spotifyFetch, getAllPages } from './spotify';
import { saveTokens } from '../auth/token';

beforeEach(() => {
  configureSpotify('cid');
  saveTokens({ accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 3600_000 });
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

it('prefixes the base URL and sends the bearer token', async () => {
  const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
  );
  const json = await spotifyFetch<{ ok: boolean }>('/me');
  expect(json.ok).toBe(true);
  const [url, init] = spy.mock.calls[0];
  expect(url).toBe('https://api.spotify.com/v1/me');
  expect(new Headers(init!.headers).get('Authorization')).toBe('Bearer tok');
});

it('retries after 429 honoring Retry-After', async () => {
  vi.useFakeTimers();
  const spy = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '2' } }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  const promise = spotifyFetch<{ ok: boolean }>('/me');
  await vi.runAllTimersAsync();
  expect((await promise).ok).toBe(true);
  expect(spy).toHaveBeenCalledTimes(2);
  vi.useRealTimers();
});

it('forces a token refresh and retries once on 401', async () => {
  const spy = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response('', { status: 401 }))
    // refresh_token grant fired by getValidAccessToken:
    .mockResolvedValueOnce(new Response(
      JSON.stringify({ access_token: 'tok2', expires_in: 3600 }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  expect((await spotifyFetch<{ ok: boolean }>('/me')).ok).toBe(true);
  const lastInit = spy.mock.calls[2][1]!;
  expect(new Headers(lastInit.headers).get('Authorization')).toBe('Bearer tok2');
});

it('throws on non-retryable errors', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 403 }));
  await expect(spotifyFetch('/me')).rejects.toThrow('403');
});

it('getAllPages follows next links', async () => {
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response(JSON.stringify({
      items: [1, 2], next: 'https://api.spotify.com/v1/me/tracks?offset=2',
    }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({
      items: [3], next: null,
    }), { status: 200 }));
  expect(await getAllPages<number>('/me/tracks?limit=2')).toEqual([1, 2, 3]);
});
