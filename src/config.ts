export const CLIENT_ID = import.meta.env.VITE_SPOTIFY_CLIENT_ID as string;
export const REDIRECT_URI = `${window.location.origin}${import.meta.env.BASE_URL}callback`;
export const SCOPES = [
  'user-library-read', 'user-library-modify',
  'playlist-read-private', 'playlist-modify-public', 'playlist-modify-private',
  // streaming + user-read-email/private: Web Playback SDK. user-modify-playback-state:
  // required by PUT /me/player/play — without it the SDK device connects but the
  // play REST call 403s, so pressing play never starts the track.
  'streaming', 'user-read-email', 'user-read-private', 'user-modify-playback-state',
];
