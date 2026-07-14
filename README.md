# spotifyKondo

Sort your Spotify Liked Songs (the *cache*) into your playlists (the *storage*),
one song at a time — genre-matched, privacy-first.

Everything runs in your browser: no backend, no analytics. The only services
contacted are Spotify and MusicBrainz (open genre data). Tokens and caches
live in your browser's localStorage.

## Setup

1. Create an app at https://developer.spotify.com/dashboard with redirect URI
   `http://127.0.0.1:5173/callback` (Web API + Web Playback SDK).
2. Create `.env.local` in the repo root:
   `VITE_SPOTIFY_CLIENT_ID=<your client id>`
3. `npm install && npm run dev`, then open **http://127.0.0.1:5173**
   (must be 127.0.0.1, not localhost — Spotify requires a loopback IP).

Playback requires Spotify Premium. The first library load is slow
(MusicBrainz allows 1 request/second); genre lookups are cached, so
later loads are fast.

## Notes

- Removing a song from Liked permanently loses its original added date on
  Spotify's side. The app keeps a local log (`kondo:removals:v1`) and offers
  an 8-second undo after every move.
- The Analyzer tab (too-broad playlist detection) is a planned follow-up.

## Development

- `npx vitest run` — tests
- `npm run build` — production build (static; deployable to any static host
  after registering an HTTPS redirect URI with Spotify)
