import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initPlayer, playTrack, resetPlayerForTests } from './spotifyPlayer';
import { configureSpotify } from '../api/spotify';
import { saveTokens } from '../auth/token';

type Listener = (payload: { device_id: string }) => void;

class FakePlayer {
  listeners = new Map<string, Listener>();
  addListener(event: string, cb: Listener) { this.listeners.set(event, cb); }
  connect() { this.listeners.get('ready')?.({ device_id: 'dev42' }); return Promise.resolve(true); }
  pause() { return Promise.resolve(); }
}

beforeEach(() => {
  configureSpotify('cid');
  saveTokens({ accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 3600_000 });
});

afterEach(() => {
  localStorage.clear();
  resetPlayerForTests();
  document.querySelectorAll('script').forEach((s) => s.remove());
  vi.restoreAllMocks();
});

it('loads the SDK script and resolves with the device id on ready', async () => {
  const promise = initPlayer(async () => 'tok');
  const script = document.querySelector('script[src="https://sdk.scdn.co/spotify-player.js"]');
  expect(script).not.toBeNull();
  // Simulate the SDK arriving:
  (window as unknown as { Spotify: unknown }).Spotify = { Player: FakePlayer };
  window.onSpotifyWebPlaybackSDKReady();
  const { deviceId } = await promise;
  expect(deviceId).toBe('dev42');
  // Idempotent — second call returns the same promise, no second script.
  await initPlayer(async () => 'tok');
  expect(document.querySelectorAll('script').length).toBe(1);
});

it('playTrack PUTs the uri to the device', async () => {
  const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
  await playTrack('dev42', 'spotify:track:t1');
  expect(spy.mock.calls[0][0]).toBe('https://api.spotify.com/v1/me/player/play?device_id=dev42');
  expect(spy.mock.calls[0][1]!.method).toBe('PUT');
  expect(JSON.parse(spy.mock.calls[0][1]!.body as string)).toEqual({ uris: ['spotify:track:t1'] });
});
