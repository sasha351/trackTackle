import { SpotifyApiError, spotifyFetch } from '../api/spotify';

interface SdkPlayer {
  addListener(event: string, cb: (payload: never) => void): void;
  connect(): Promise<boolean>;
  activateElement?: () => Promise<void>;
  pause(): Promise<void>;
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
  disconnect: () => void;
  onStateChange?: (cb: (state: any) => void) => void;
}

let handle: Promise<PlayerHandle> | null = null;
// The SDK player instance currently backing `handle`. Used so a `not_ready`
// event from an abandoned (already-replaced) player can't null out the
// handle of the player that actually replaced it.
let activePlayer: SdkPlayer | null = null;

export function resetPlayerForTests(): void {
  handle = null;
  activePlayer = null;
}

export function initPlayer(getToken: () => Promise<string>): Promise<PlayerHandle> {
  if (handle) return handle;
  handle = new Promise<PlayerHandle>((resolve, reject) => {
    const boot = () => {
      // boot only runs when the SDK is present
      const player = new window.Spotify!.Player({
        name: 'spotifyKondo',
        getOAuthToken: (cb) => void getToken().then(cb).catch(reject),
        volume: 0.8,
      });
      activePlayer = player;
      player.addListener('ready', ({ device_id }: { device_id: string }) =>
        resolve({
          deviceId: device_id,
          pause: () => player.pause(),
          disconnect: () => player.disconnect(),
          onStateChange: (cb: (s: any) => void) => player.addListener('player_state_changed', cb),
        }));
      // Spotify drops idle web players — forget the handle so the next play
      // builds a fresh device instead of 404ing on the dead one. Guarded so
      // only the still-active player can clear the handle; a `not_ready`
      // firing on an already-replaced (disconnected) player must not null
      // out the handle of its replacement.
      player.addListener('not_ready', () => { if (player === activePlayer) { try { player.disconnect(); } catch (e) {} handle = null; } });
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
