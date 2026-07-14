# spotifyKondo — planning session record (2026-07-14)

Brainstorming session over `idea.md`: a privacy-first web tool for sorting Spotify Liked Songs into playlists. This doc records the research and decisions from that session; `idea.md` is the living idea doc and the base for later implementation plans.

## Key research finding: the Spotify API has shrunk under this idea

- **Nov 2024**: Spotify cut new apps off from `audio_features`, `audio_analysis`, recommendations, genre seeds, and `preview_url`. This is the data organizeyourmusic.playlistmachinery.com is built on — it's grandfathered in; a new app can't take that route.
- **Feb 2026**: the [Web API changelog](https://developer.spotify.com/documentation/web-api/references/changes/february-2026) removed Get Artist / Get Several Artists — the traditional source of artist `genres` labels. Library and playlist endpoints (saved tracks, playlists, add/remove) remain, some in consolidated form (`PUT/DELETE /me/library`).
- **Consequence**: genre data can't be assumed from Spotify. Direction chosen: try Spotify first, fill gaps with MusicBrainz (open data, no API key, privacy-friendly). Verifying what a fresh Spotify app can actually access is the #1 open question and should happen first in implementation.

## Decisions

1. **Genre source** — Spotify where available, MusicBrainz fills the gaps.
2. **Architecture** — fully client-side static web app. OAuth PKCE, token lives only in browser storage. No backend anywhere; the only outside calls are Spotify and MusicBrainz. This is what "privacy first" means concretely: no server to trust.
3. **Match signals** — each candidate playlist gets a genre fingerprint from the songs already in it; liked songs are scored by genre similarity, with release era/decade as a secondary signal. Deliberately excluded: same-artist-in-playlist shortcuts and learning from accept/override decisions — matching stays deterministic and predictable.
4. **Below-threshold songs** — badge as "no strong match" but still show the top candidates greyed out (user can override). Additionally, cluster no-fit songs by shared genre and suggest new playlists ("you have 14 unsorted downtempo songs — maybe a new playlist?").
5. **Song age** — display date added plus an oldest↔newest sort toggle, nothing more. No ripeness markers or age filters; age stays a fact the user interprets (liked = cache, playlists = storage).
6. **Playback** — full in-app playback via the Spotify Web Playback SDK (the browser tab becomes a Spotify device). Assumes Premium.
7. **Analyzer tab** — read-only. Scores each playlist's genre spread, flags too-broad playlists, and suggests break-off groups with the actual songs listed. Acting on suggestions happens in Spotify; this tab never modifies anything. Kept fully separate from the sorter.
8. **Target playlists** — playlists the user owns, minus ones un-checked in a settings screen (road-trip mixes etc. aren't sorting destinations).

## Nuance worth remembering

Removing a song from Liked Songs permanently loses its original date-added if it's ever re-liked. Mitigation: an undo toast after each add+remove, and a local log of removals.

## Open questions

- What genre data does a fresh Spotify API app actually still get? (verify before building the matcher)
- What's the right match threshold, and should it be user-adjustable?
- How good is MusicBrainz genre coverage for this library?

## Next steps

- Rewrite `idea.md` to fold in the decisions above (keeping its casual tone and the cache/storage framing).
- Future sessions: design/spec pass, then an implementation plan. No code was written in this session — it was kept purely creative.
    