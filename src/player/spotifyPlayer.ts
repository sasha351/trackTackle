import { SpotifyApiError, spotifyFetch } from '../api/spotify';

interface SdkPlayer {
  addListener(event: string, cb: (payload: never) => void): void;
  connect(): Promise<boolean>;
  activateElement?: () => Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  seek(positionMs: number): Promise<void>;
  disconnect(): void;
}

declare global {
  interface Window {
    onSpotifyWebPlaybackSDKReady: () => void;
    Spotify?: {
      Player: new (opts: {
        name: string;
        getOAuthToken: (cb: (token: string) => void) => void;
        volume: number;
      }) => SdkPlayer;
    };
  }
}

export interface PlayerHandle {
  deviceId: string;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  seek: (positionMs: number) => Promise<void>;
  disconnect: () => void;
}

/** What the scrub bar needs from the SDK's `player_state_changed` payload.
 *  `at` is the `performance.now()` the position was sampled — the SDK only
 *  emits on changes (play, pause, seek, track end), not as the song advances,
 *  so the UI extrapolates from this anchor between events. */
export interface PlaybackState {
  uri: string;
  positionMs: number;
  durationMs: number;
  paused: boolean;
  at: number;
}

/** Where the song is *now*: the SDK only reports position on state changes,
 *  so between events we extrapolate from the last anchor. */
export function currentPosition(p: PlaybackState, now: number): number {
  if (p.paused) return p.positionMs;
  return Math.min(p.durationMs, p.positionMs + (now - p.at));
}

// Module-level, not per-handle: the handle is rebuilt whenever Spotify evicts
// an idle device, and a subscriber registered on the old SDK instance would
// silently stop hearing anything after that.
const subscribers = new Set<(s: PlaybackState | null) => void>();

/** Subscribe to playback state. `null` means our device is no longer the
 *  active one (playback was transferred away or the player was dropped). */
export function subscribePlayback(cb: (s: PlaybackState | null) => void): () => void {
  subscribers.add(cb);
  return () => { subscribers.delete(cb); };
}

interface SdkState {
  paused: boolean;
  position: number;
  duration: number;
  track_window?: { current_track?: { uri?: string } | null };
}

function emit(raw: SdkState | null): void {
  const uri = raw?.track_window?.current_track?.uri;
  const state: PlaybackState | null = raw && uri
    ? { uri, positionMs: raw.position, durationMs: raw.duration, paused: raw.paused, at: performance.now() }
    : null;
  subscribers.forEach((cb) => cb(state));
}

let handle: Promise<PlayerHandle> | null = null;
// The SDK player instance currently backing `handle`. Used so a `not_ready`
// event from an abandoned (already-replaced) player can't null out the
// handle of the player that actually replaced it.
let activePlayer: SdkPlayer | null = null;

/** Whether the Web Playback SDK can work in this browser at all.
 *
 *  A user-agent test, deliberately. The SDK's real blocker is EME/DRM, which
 *  no mobile browser exposes to a web page and which has no honest feature
 *  test — `navigator.requestMediaKeySystemAccess` exists on mobile Safari and
 *  resolves, it just never yields a Widevine/FairPlay key the SDK can use. A
 *  UA check is the lie we can actually detect.
 *
 *  Read per call rather than captured at module load, so it stays honest under
 *  a test that redefines the UA. */
export function isPlaybackSupported(): boolean {
  return !/Android|iPhone|iPad|iPod/.test(navigator.userAgent);
}

export function resetPlayerForTests(): void {
  handle = null;
  activePlayer = null;
  subscribers.clear();
}

export function initPlayer(getToken: () => Promise<string>): Promise<PlayerHandle> {
  if (handle) return handle;
  handle = new Promise<PlayerHandle>((resolve, reject) => {
    const boot = () => {
      // boot only runs when the SDK is present
      const player = new window.Spotify!.Player({
        name: 'Track Tackle',
        getOAuthToken: (cb) => void getToken().then(cb).catch(reject),
        volume: 0.8,
      });
      activePlayer = player;
      player.addListener('ready', ({ device_id }: { device_id: string }) =>
        resolve({
          deviceId: device_id,
          pause: () => player.pause(),
          resume: () => player.resume(),
          seek: (ms: number) => player.seek(ms),
          disconnect: () => player.disconnect(),
        }));
      // Registered once per SDK instance and fanned out to `subscribers`.
      // Gated on activePlayer for the same reason as `not_ready` below: a
      // replaced player must not overwrite the live one's state.
      player.addListener('player_state_changed', (s: SdkState | null) => {
        if (player === activePlayer) emit(s);
      });
      // Spotify drops idle web players — forget the handle so the next play
      // builds a fresh device instead of 404ing on the dead one. Guarded so
      // only the still-active player can clear the handle; a `not_ready`
      // firing on an already-replaced (disconnected) player must not null
      // out the handle of its replacement.
      player.addListener('not_ready', () => { if (player === activePlayer) { try { player.disconnect(); } catch { /* already gone; the point is only to null the handle */ } handle = null; emit(null); } });
      player.addListener('account_error', () =>
        reject(new Error('Playback needs Spotify Premium')));
      player.addListener('initialization_error', ({ message }: { message: string }) =>
        reject(new Error(message)));
      player.addListener('authentication_error', ({ message }: { message: string }) =>
        reject(new Error(message)));
      void player.connect();
    };
    if (window.Spotify) {
      boot(); // SDK already on the page (re-init after a stale device)
      return;
    }
    window.onSpotifyWebPlaybackSDKReady = boot;
    const script = document.createElement('script');
    script.src = 'https://sdk.scdn.co/spotify-player.js';
    script.onerror = () => reject(new Error('Failed to load the Spotify player SDK'));
    document.body.appendChild(script);
  });
  return handle;
}

// Safari/Chrome autoplay policy: the SDK's <audio> element only makes sound if
// it was unmuted inside a user gesture. We build the player in a mount effect
// (pre-warm), which is not a gesture — so without this the device connects,
// Spotify reports it as the active player, and nothing is audible.
//
// Must be called synchronously from the click handler: awaiting anything first
// spends the gesture. That's why it reads the module-global player instead of
// awaiting the initPlayer promise, and why it returns void rather than a promise.
export function activatePlayerElement(): void {
  // ponytail: fire-and-forget; a rejected activation just means the click was
  // already too late, and the next click re-tries.
  void activePlayer?.activateElement?.().catch(() => {});
}

export async function playTrack(deviceId: string, uri: string): Promise<void> {
  await spotifyFetch(`/me/player/play?device_id=${deviceId}`, {
    method: 'PUT',
    body: JSON.stringify({ uris: [uri] }),
  });
}

export async function playUri(getToken: () => Promise<string>, uri: string): Promise<void> {
  const stale = await initPlayer(getToken);
  try {
    await playTrack(stale.deviceId, uri);
  } catch (e) {
    // 404 = our memoized device id went stale (Spotify evicts idle web
    // players). Disconnect the dead player, rebuild once, and retry;
    // anything else rethrows.
    if (!(e instanceof SpotifyApiError) || e.status !== 404) throw e;
    stale.disconnect();
    handle = null;
    const fresh = await initPlayer(getToken);
    await playTrack(fresh.deviceId, uri);
  }
}
