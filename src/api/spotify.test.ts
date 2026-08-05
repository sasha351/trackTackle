import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  configureSpotify, spotifyFetch, getAllPages, resetRateLimitForTests,
  getArtistGenresBatch, ARTIST_BATCH, RateLimitedError, subscribeRateLimit,
  pickCover, getSavedTracks,
} from './spotify';
import { saveTokens } from '../auth/token';

beforeEach(() => {
  configureSpotify('cid');
  saveTokens({ accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 3600_000 });
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  resetRateLimitForTests();
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

it('backs off exponentially when Retry-After is CORS-hidden, then reports the rate limit', async () => {
  vi.useFakeTimers();
  const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 429 }));
  const promise = spotifyFetch('/me').catch((e: Error) => e);
  await vi.runAllTimersAsync();
  expect(String(await promise)).toMatch(/rate-limiting/);
  expect(spy).toHaveBeenCalledTimes(5);
  vi.useRealTimers();
});

it('reports a long penalty as a typed error carrying the resume time', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response('', { status: 429, headers: { 'Retry-After': '3600' } }),
  );
  const err = await spotifyFetch('/me').catch((e: unknown) => e);
  expect(err).toBeInstanceOf(RateLimitedError);
  expect((err as RateLimitedError).retryAt).toBeGreaterThan(Date.now() + 3599_000);
});

it('retries transient 502s from a not-yet-ready playback device', async () => {
  vi.useFakeTimers();
  const spy = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response('', { status: 502 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  const promise = spotifyFetch<{ ok: boolean }>('/me');
  await vi.runAllTimersAsync();
  expect((await promise).ok).toBe(true);
  expect(spy).toHaveBeenCalledTimes(2);
  vi.useRealTimers();
});

it('retries transient 5xx with a short fixed backoff instead of exponential seconds', async () => {
  vi.useFakeTimers();
  const spy = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response('', { status: 502 }))
    .mockResolvedValueOnce(new Response('', { status: 503 }))
    .mockResolvedValueOnce(new Response('', { status: 504 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  const promise = spotifyFetch<{ ok: boolean }>('/me');
  // The short ramp (300+600+1200=2100ms) has already retried 3x by 2500ms;
  // the old exponential-seconds schedule (1000+2000+4000=7000ms) would not.
  await vi.advanceTimersByTimeAsync(2500);
  expect(spy).toHaveBeenCalledTimes(4);
  expect((await promise).ok).toBe(true);
  vi.useRealTimers();
});

it('throws on non-retryable errors', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 403 }));
  await expect(spotifyFetch('/me')).rejects.toThrow('403');
});

it('getArtistGenresBatch asks for all ids at once and drops ids Spotify does not know', async () => {
  const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
    // Spotify returns a null slot for an id it has no artist for.
    artists: [{ id: 'a1', genres: ['Trip Hop'] }, null, { id: 'a3' }],
  }), { status: 200 }));

  const got = await getArtistGenresBatch(['a1', 'nope', 'a3']);

  expect(String(spy.mock.calls[0][0])).toBe('https://api.spotify.com/v1/artists?ids=a1,nope,a3');
  expect(spy).toHaveBeenCalledTimes(1);
  // 'nope' is absent, not empty — callers must be able to tell the two apart.
  expect(got.has('nope')).toBe(false);
  expect(got.get('a1')).toEqual(['Trip Hop']); // lowercasing is the resolver's job, not ours
  expect(got.get('a3')).toEqual([]); // known artist, genuinely no genres
});

// Spotify 400s past 50 ids per request, so the constant callers chunk to must
// stay within that — a bump here silently breaks every batch call.
it('ARTIST_BATCH stays within the 50-id ceiling Spotify enforces', () => {
  expect(ARTIST_BATCH).toBeLessThanOrEqual(50);
});

it('caps concurrent requests so a wide Promise.all cannot stampede the rate limiter', async () => {
  let concurrent = 0;
  let peak = 0;
  const release: (() => void)[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
    concurrent += 1;
    peak = Math.max(peak, concurrent);
    return new Promise((resolve) => release.push(() => {
      concurrent -= 1;
      resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    }));
  });

  const all = Promise.all(Array.from({ length: 20 }, () => spotifyFetch('/me')));
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

  expect(peak).toBeLessThanOrEqual(6); // the other 14 are queued, not in flight
  // Drain: each release lets exactly one queued caller through.
  for (let i = 0; i < 20; i++) {
    release[i]();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  }
  await all;
  expect(peak).toBeLessThanOrEqual(6); // never exceeded the cap while draining either
});

it('spaces requests once the burst allowance is spent', async () => {
  vi.useFakeTimers();
  // Reset *after* installing fake timers: the bucket's refill clock is
  // Date.now(), and it was last written under real time.
  resetRateLimitForTests();
  // mockImplementation, not mockResolvedValue: 28 concurrent callers each
  // read the body via res.text() — sharing one Response object across them
  // throws "Body is unusable" on the second reader, unrelated to the rate
  // limiter this test exists to check.
  const spy = vi.spyOn(globalThis, 'fetch')
    .mockImplementation(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));

  const all = Promise.all(Array.from({ length: 28 }, () => spotifyFetch('/me')));

  // 1ms of refill is 0.008 tokens — not enough to release a 21st request,
  // but enough to fully drain the microtask queue.
  await vi.advanceTimersByTimeAsync(1);
  expect(spy).toHaveBeenCalledTimes(20); // BUCKET_CAPACITY, then the bucket bites

  await vi.advanceTimersByTimeAsync(1000); // one second at 8/sec
  expect(spy).toHaveBeenCalledTimes(28);

  await vi.runAllTimersAsync();
  await all;
  vi.useRealTimers();
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

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

it('lets a user action jump the queue ahead of queued background reads', async () => {
  const started: string[] = [];
  const release: (() => void)[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
    started.push(String(url));
    return new Promise((resolve) => release.push(
      () => resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
    ));
  });

  // Ten background reads: six take slots, four queue. Well under the bucket's
  // 20-token capacity, so only the slot queue is in play here.
  const bg = Array.from({ length: 10 }, (_, i) => spotifyFetch(`/bg${i}`));
  await flush();
  expect(started).toHaveLength(6);

  const urgent = spotifyFetch('/urgent', {}, { priority: true });
  await flush();
  expect(started).toHaveLength(6); // still queued — no slot free yet

  release[0]();
  await flush();
  expect(started[6]).toBe('https://api.spotify.com/v1/urgent'); // ahead of /bg6

  while (release.length) release.pop()!();
  await flush();
  while (release.length) release.pop()!();
  await flush();
  await Promise.all([...bg, urgent]);
});

it('remembers the penalty across a reload so a refresh cannot re-stampede', async () => {
  const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response('', { status: 429, headers: { 'Retry-After': '3600' } }),
  );
  await expect(spotifyFetch('/me')).rejects.toBeInstanceOf(RateLimitedError);
  expect(Number(localStorage.getItem('tracktackle:ratelimit:v1'))).toBeGreaterThan(Date.now());
  expect(spy).toHaveBeenCalledTimes(1);

  // Simulate a reload: module state is wiped, localStorage survives.
  resetRateLimitForTests();
  await expect(spotifyFetch('/me')).rejects.toBeInstanceOf(RateLimitedError);
  expect(spy).toHaveBeenCalledTimes(1); // the reload never reached the network
});

it('notifies subscribers when a penalty starts', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response('', { status: 429, headers: { 'Retry-After': '3600' } }),
  );
  const seen: number[] = [];
  const unsubscribe = subscribeRateLimit((until) => seen.push(until));
  await expect(spotifyFetch('/me')).rejects.toBeInstanceOf(RateLimitedError);
  expect(seen).toHaveLength(1);
  expect(seen[0]).toBeGreaterThan(Date.now());
  unsubscribe();
});

it('contains a throwing subscriber so the fetch still rejects with RateLimitedError and other subscribers still fire', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response('', { status: 429, headers: { 'Retry-After': '3600' } }),
  );
  const seen: number[] = [];
  const unsubscribeThrower = subscribeRateLimit(() => {
    throw new Error('boom');
  });
  const unsubscribe = subscribeRateLimit((until) => seen.push(until));
  await expect(spotifyFetch('/me')).rejects.toBeInstanceOf(RateLimitedError);
  expect(seen).toHaveLength(1);
  unsubscribeThrower();
  unsubscribe();
});

it('picks the largest cover available', () => {
  const images = [
    { url: 'big', width: 640, height: 640 },
    { url: 'mid', width: 300, height: 300 },
    { url: 'tiny', width: 64, height: 64 },
  ];
  // The gallery card draws these up to ~300px, so the 640px source is the
  // one that stays sharp on a retina display.
  expect(pickCover(images)).toBe('big');
});

it('falls back to the only entry when nothing reports a usable width', () => {
  // Playlist mosaics come back as a single image with width: null.
  expect(pickCover([{ url: 'mosaic', width: null, height: null }])).toBe('mosaic');
  expect(pickCover([])).toBeNull();
  expect(pickCover(undefined)).toBeNull();
});

it('carries album art through getSavedTracks', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
    total: 1,
    next: null,
    items: [{
      added_at: '2024-01-01T00:00:00Z',
      track: {
        id: 't1', uri: 'spotify:track:t1', name: 'Glory Box',
        artists: [{ id: 'a1', name: 'Portishead' }],
        album: {
          name: 'Dummy',
          release_date: '1994-08-22',
          images: [{ url: 'big', width: 640 }, { url: 'mid', width: 300 }],
        },
      },
    }],
  }), { status: 200 }));

  const tracks = await getSavedTracks();
  expect(tracks[0].albumArt).toBe('big');
});
