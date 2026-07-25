# Open follow-ups

Small, unresolved things found while making the layout responsive. None of them
block that work; each is scoped and independent.

## Playback silently fails on phones

`src/player/spotifyPlayer.ts:80` loads the Spotify Web Playback SDK from
`sdk.scdn.co`. That SDK does not run in any mobile browser. `Sorter.tsx:78-80`
pre-warms it on mount and `SongRow.tsx:35-42` renders a play button per row, so
on a phone the buttons are visible and do nothing.

Wants an `isPlaybackSupported()` gate in `spotifyPlayer.ts` that skips the
pre-warm, hides `.play-btn`, and shows one line of explanation. The track title
in `SongRow.tsx:21-28` already links to `open.spotify.com`, which hands off to
the installed Spotify app — that's the natural mobile substitute.

## The dev server can't be reached from a phone

`vite.config.ts:4` pins `host: '127.0.0.1'`. Binding `0.0.0.0` is necessary but
not sufficient — `http://<lan-ip>:5173` fails twice over:

- Spotify permits plain `http` redirect URIs **only** for loopback literals
  (`http://127.0.0.1:PORT`, `http://[::1]:PORT`). A private network address
  requires HTTPS, so the redirect URI can't even be registered.
- `src/auth/pkce.ts` uses `crypto.subtle` for the S256 challenge, and
  `crypto.subtle` is undefined outside a secure context. A private IP over http
  is not one, so login breaks before Spotify is ever contacted.

Three ways out: an SSH local forward (`ssh -L 5173:127.0.0.1:5173 <server>`,
then open `http://127.0.0.1:5173` on the phone — loopback on the phone satisfies
both rules and needs no code or dashboard change); an opt-in HTTPS dev mode; or
a real deploy. `docs/superpowers/plans/2026-07-19-public-launch.md` covers the
deploy path.

## No PWA metadata

`index.html` has the viewport meta but no `manifest`, `apple-touch-icon`, or
`theme-color`. `public/` holds only `favicon.svg` and `icons.svg`. Add-to-home-
screen currently produces a generic icon and a browser chrome frame.

## No viewport regression coverage

`src/index.css.test.ts` asserts the responsive *contract* — the breakpoints
exist and override the rules that overflow. It cannot catch actual overflow,
because jsdom does no layout and does not evaluate width media queries. A
Playwright check that loads the app at 390×844 and asserts
`document.documentElement.scrollWidth <= clientWidth` would close that gap.

## Column labels are gone on phones

The phone breakpoint hides `.song-cols` because the headings no longer align
with anything once a row stacks. Year and date-added are now two bare numbers on
a shared line. If that reads as ambiguous in use, add inline per-field labels in
`SongRow.tsx` rather than bringing the header row back.
