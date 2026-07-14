import { afterEach, expect, it, vi } from 'vitest';
import {
  saveTokens, loadTokens, clearTokens, exchangeCode, getValidAccessToken, expireAccessToken,
} from './token';

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

function mockTokenResponse(body: object) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(body), { status: 200 }),
  );
}

it('round-trips tokens through localStorage', () => {
  const t = { accessToken: 'a', refreshToken: 'r', expiresAt: 123 };
  saveTokens(t);
  expect(loadTokens()).toEqual(t);
  clearTokens();
  expect(loadTokens()).toBeNull();
});

it('exchangeCode POSTs the authorization_code grant and saves the result', async () => {
  const spy = mockTokenResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 });
  const t = await exchangeCode('thecode', 'theverifier', 'cid', 'http://127.0.0.1:5173/callback');
  expect(t.accessToken).toBe('at');
  expect(loadTokens()?.refreshToken).toBe('rt');
  const [url, init] = spy.mock.calls[0];
  expect(url).toBe('https://accounts.spotify.com/api/token');
  const body = new URLSearchParams(init!.body as string);
  expect(body.get('grant_type')).toBe('authorization_code');
  expect(body.get('code')).toBe('thecode');
  expect(body.get('code_verifier')).toBe('theverifier');
});

it('getValidAccessToken returns the token untouched when fresh', async () => {
  saveTokens({ accessToken: 'fresh', refreshToken: 'r', expiresAt: Date.now() + 3600_000 });
  expect(await getValidAccessToken('cid')).toBe('fresh');
});

it('getValidAccessToken refreshes when expired (and after expireAccessToken)', async () => {
  saveTokens({ accessToken: 'old', refreshToken: 'r1', expiresAt: Date.now() + 3600_000 });
  expireAccessToken();
  const spy = mockTokenResponse({ access_token: 'new', refresh_token: 'r2', expires_in: 3600 });
  expect(await getValidAccessToken('cid')).toBe('new');
  const body = new URLSearchParams(spy.mock.calls[0][1]!.body as string);
  expect(body.get('grant_type')).toBe('refresh_token');
  expect(body.get('refresh_token')).toBe('r1');
  expect(loadTokens()?.refreshToken).toBe('r2');
});

it('getValidAccessToken throws when not authenticated', async () => {
  await expect(getValidAccessToken('cid')).rejects.toThrow('not authenticated');
});

it('getValidAccessToken dedupes concurrent refreshes into a single request', async () => {
  saveTokens({ accessToken: 'old', refreshToken: 'r1', expiresAt: Date.now() + 3600_000 });
  expireAccessToken();
  const spy = mockTokenResponse({ access_token: 'new', refresh_token: 'r2', expires_in: 3600 });
  const [a, b] = await Promise.all([getValidAccessToken('cid'), getValidAccessToken('cid')]);
  expect(a).toBe('new');
  expect(b).toBe('new');
  expect(spy).toHaveBeenCalledTimes(1);
});
