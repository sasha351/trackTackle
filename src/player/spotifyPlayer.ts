import { spotifyFetch } from '../api/spotify';

interface SdkPlayer {
  addListener(event: string, cb: (payload: never) => void): void;
  connect(): Promise<boolean>;
  pause(): Promise<void>;
}

declare global {
  interface Window {
    onSpotifyWebPlaybackSDKReady: () => void;
    Spotify: {
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
}

let handle: Promise<PlayerHandle> | null = null;

export function resetPlayerForTests(): void {
  handle = null;
}

export function initPlayer(getToken: () => Promise<string>): Promise<PlayerHandle> {
  if (handle) return handle;
  handle = new Promise<PlayerHandle>((resolve, reject) => {
    window.onSpotifyWebPlaybackSDKReady = () => {
      const player = new window.Spotify.Player({
        name: 'spotifyKondo',
        getOAuthToken: (cb) => void getToken().then(cb),
        volume: 0.8,
      });
      player.addListener('ready', ({ device_id }: { device_id: string }) =>
        resolve({ deviceId: device_id, pause: () => player.pause() }));
      player.addListener('account_error', () =>
        reject(new Error('Playback needs Spotify Premium')));
      player.addListener('initialization_error', ({ message }: { message: string }) =>
        reject(new Error(message)));
      player.addListener('authentication_error', ({ message }: { message: string }) =>
        reject(new Error(message)));
      void player.connect();
    };
    const script = document.createElement('script');
    script.src = 'https://sdk.scdn.co/spotify-player.js';
    script.onerror = () => reject(new Error('Failed to load the Spotify player SDK'));
    document.body.appendChild(script);
  });
  return handle;
}

export async function playTrack(deviceId: string, uri: string): Promise<void> {
  await spotifyFetch(`/me/player/play?device_id=${deviceId}`, {
    method: 'PUT',
    body: JSON.stringify({ uris: [uri] }),
  });
}
