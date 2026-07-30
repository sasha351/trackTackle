import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  activatePlayerElement, initPlayer, isPlaybackSupported, playTrack, playUri, resetPlayerForTests,
} from './spotifyPlayer';
import { configureSpotify } from '../api/spotify';
import { saveTokens } from '../auth/token';

type Listener = (payload: { device_id: string }) => void;

class FakePlayer {
  listeners = new Map<string, Listener>();
  addListener(event: string, cb: Listener) { this.listeners.set(event, cb); }
  connect() { this.listeners.get('ready')?.({ device_id: 'dev42' }); return Promise.resolve(true); }
  pause() { return Promise.resolve(); }
  disconnect() { /* no-op */ }
}

beforeEach(() => {
  configureSpotify('cid');
  saveTokens({ accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 3600_000 });
});

afterEach(() => {
  localStorage.clear();
  resetPlayerForTests();
  document.querySelectorAll('script').forEach((s) => s.remove());
  delete (window as { Spotify?: unknown }).Spotify;
  vi.restoreAllMocks();
  Object.defineProperty(window.navigator, 'userAgent', {
    value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120',
    configurable: true,
  });
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

it('activatePlayerElement synchronously activates the live SDK player', async () => {
  const activateElement = vi.fn().mockResolvedValue(undefined);
  class ActivatablePlayer extends FakePlayer { activateElement = activateElement; }
  (window as unknown as { Spotify: unknown }).Spotify = { Player: ActivatablePlayer };
  await initPlayer(async () => 'tok');

  activatePlayerElement(); // no await — must fire inside the gesture
  expect(activateElement).toHaveBeenCalled();
});

it('activatePlayerElement is a no-op when no player exists yet', () => {
  expect(() => activatePlayerElement()).not.toThrow();
});

it('playTrack PUTs the uri to the device', async () => {
  const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
  await playTrack('dev42', 'spotify:track:t1');
  expect(spy.mock.calls[0][0]).toBe('https://api.spotify.com/v1/me/player/play?device_id=dev42');
  expect(spy.mock.calls[0][1]!.method).toBe('PUT');
  expect(JSON.parse(spy.mock.calls[0][1]!.body as string)).toEqual({ uris: ['spotify:track:t1'] });
});

it('playUri rebuilds the player and retries once when the device id is stale (404)', async () => {
  let deviceCounter = 0;
  const instances: RotatingPlayer[] = [];
  class RotatingPlayer {
    listeners = new Map<string, Listener>();
    disconnect = vi.fn();
    addListener(event: string, cb: Listener) { this.listeners.set(event, cb); }
    connect() {
      deviceCounter += 1;
      instances.push(this);
      this.listeners.get('ready')?.({ device_id: `dev${deviceCounter}` });
      return Promise.resolve(true);
    }
    pause() { return Promise.resolve(); }
  }
  (window as unknown as { Spotify: unknown }).Spotify = { Player: RotatingPlayer };
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response('{}', { status: 404 }))
    .mockResolvedValue(new Response(null, { status: 204 }));

  await playUri(async () => 'tok', 'spotify:track:t1');

  const urls = fetchSpy.mock.calls.map((c) => c[0]);
  expect(urls).toEqual([
    'https://api.spotify.com/v1/me/player/play?device_id=dev1',
    'https://api.spotify.com/v1/me/player/play?device_id=dev2', // fresh device after 404
  ]);
});

const withUserAgent = (ua: string) => {
  Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true });
};

it('reports playback unsupported on mobile browsers', () => {
  withUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15');
  expect(isPlaybackSupported()).toBe(false);
  withUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36');
  expect(isPlaybackSupported()).toBe(false);
  withUserAgent('Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15');
  expect(isPlaybackSupported()).toBe(false);
});

it('reports playback supported on desktop browsers', () => {
  withUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120');
  expect(isPlaybackSupported()).toBe(true);
});

it('a not_ready event on an abandoned (post-404) player does not null out the current handle', async () => {
  let deviceCounter = 0;
  const instances: RotatingPlayer[] = [];
  class RotatingPlayer {
    listeners = new Map<string, Listener>();
    disconnect = vi.fn();
    addListener(event: string, cb: Listener) { this.listeners.set(event, cb); }
    connect() {
      deviceCounter += 1;
      instances.push(this);
      this.listeners.get('ready')?.({ device_id: `dev${deviceCounter}` });
      return Promise.resolve(true);
    }
    pause() { return Promise.resolve(); }
  }
  (window as unknown as { Spotify: unknown }).Spotify = { Player: RotatingPlayer };
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response('{}', { status: 404 }))
    .mockResolvedValue(new Response(null, { status: 204 }));

  await playUri(async () => 'tok', 'spotify:track:t1');
  expect(instances).toHaveLength(2);
  const [oldPlayer] = instances;
  expect(oldPlayer.disconnect).toHaveBeenCalled(); // stale player was disconnected on rebuild

  // Simulate the abandoned (dev1) player firing not_ready after the rebuild —
  // it must not clear the handle now backed by the fresh (dev2) player.
  oldPlayer.listeners.get('not_ready')?.({ device_id: 'dev1' });

  const { deviceId } = await initPlayer(async () => 'tok');
  expect(deviceId).toBe('dev2'); // still the fresh device, no dev3 rebuilt
  expect(instances).toHaveLength(2);
});
