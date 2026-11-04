# Track Tackle

**Beta.** Your Liked Songs are a junk drawer. Track Tackle empties it into the
playlists you already have — one song at a time, with a genre-matched
suggestion for each.

It runs entirely in your browser. There is no server, no account, and no
analytics.

> Not affiliated with Spotify. Music data and playback are provided by Spotify.

## Getting in

Spotify caps apps like this one at **25 testers**, and each has to be added by
hand before they can log in. If you want a seat, send me the email address on
your Spotify account — it has to be that exact address, not your preferred
contact email. Anyone not on the list gets an error at login.

## What you need

|                | Requirement                                            |
|----------------|--------------------------------------------------------|
| **Sorting**    | Any Spotify account, any device.                        |
| **Previews**   | Spotify Premium, on a desktop browser. Mobile browsers can't play Spotify audio at all — that's a platform limit, not a missing feature. |

**The first load is slow.** Track Tackle looks up the genre of every artist in
your library, and the free music database it falls back on allows about one
lookup per second. A big library can take a few minutes the first time. After
that it's cached in your browser and loads fast.

## Using it

**Sorter** — your Liked Songs with a suggested playlist next to each. Accept
it, pick a different one, or skip. Songs it can't confidently place are left
alone rather than guessed at.

**Analyzer** — flags playlists that have drifted broad, where no single genre
covers even a third of the tracks.

**Settings** — choose which playlists are sort targets, set how confident a
match has to be, and switch between the dense table view and the cover-art
gallery.

## What it changes in your library

Only what you confirm. Nothing moves until you press the button.

One thing to know before you start: **Spotify permanently loses a song's
original "date added" when it leaves your Liked Songs.** No app can preserve
it. Every move therefore gets an 8-second undo, and Track Tackle keeps its own
log of what it removed so undo actually works.

## Privacy

Everything — your login, the genre cache, the removal log — lives in your own
browser's storage. Clearing your browser data deletes all of it.

Six services are ever contacted, and none of them is told who you are:

- **Spotify** — reads and modifies your library.
- **MusicBrainz** — genre lookups for artists Spotify has no genres for.
- **Wikidata** and **English Wikipedia** — the same job, as a last resort, and
  only during a "deep" genre run that you start yourself.
- **ListenBrainz** — also deep runs only: similar artists, for an artist no
  other source has genres for. MusicBrainz is also asked about your tracks'
  ISRCs then, to read album-level tags.
- **Last.fm** — deep runs only, and only if the build has a Last.fm API key:
  listener tags for artists every source above came up empty on.

Spotify's consent screen asks to share your email address and account details.
Both are demanded by Spotify's playback SDK, which is what plays the previews.
Track Tackle reads neither, and has nowhere to send them.

## How the matching works

Each playlist is profiled from the tracks already in it — mostly which genres,
plus which decades and which writing systems. Every Liked Song is scored
against every profile, and the best score above your threshold becomes the
suggestion.

Genre carries most of the weight. Era and language only break ties between
playlists that already look similar; neither can outvote genre on its own, and
a song whose genre is unknown is left unsuggested rather than filed by decade.
When nothing scores well anywhere, the Sorter can propose a **new** playlist
instead — but only for a genre your library doesn't already have a home for.

Genres come from Spotify where it has them. For the artists it doesn't, a
**deep run** in Settings goes out to MusicBrainz and Wikipedia and fills in the
gaps. That's the slow part, it's optional, and results are cached.

## Running it yourself

```
npm install
npm run dev      # http://127.0.0.1:5173 — must be the IP, not localhost
npx vitest run   # tests
npm run build    # static bundle in dist/
```

Needs an app registered at
[developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) with
redirect URI `http://127.0.0.1:5173/callback`, and a `.env.local` holding
`VITE_SPOTIFY_CLIENT_ID=<your client id>`. Optionally add
`VITE_LASTFM_API_KEY=<key>` (free at
[last.fm/api](https://www.last.fm/api/account/create)) to enable Last.fm genre
tags in deep runs — on a deployment, set it in the host's environment too.

Architecture, the genre-resolution waterfall and the scoring weights are
documented in [CLAUDE.md](CLAUDE.md).
