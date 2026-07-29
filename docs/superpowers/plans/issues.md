# Open issues

Ordered into batches. Batch 1 (sorter UX quick wins) shipped on 2026-07-29 and
has been removed from this file — see git history for the raw notes.

Decisions already taken, so they don't get re-litigated:

- **Mood/valence**: probe `/audio-features` first; if it's dead, close the item
  rather than inventing a genre→mood table.
- **Language rule**: heavy penalty (×0.25), not a hard veto — a mismatched
  playlist can still surface as a greyed-out best guess.
- **Second UI**: a real parallel skin with cover art, not a reskin of the table.
- **No new runtime dependencies.** The app has exactly two (`react`, `react-dom`).

---

## Batch 2 — Recommendation accuracy (next)

### Playlist name and description as genre hints
> look into if its possible to read playlist name / description to get a better idea of its ideal tag and genre. could help increase recommendation accuracy

Possible, and cheap. `/me/playlists` returns `description`, it's just not mapped
(`spotify.ts:324`), and MusicBrainz's canonical genre vocabulary is already
cached in `kondo:mb-genres:v1`, so matching a playlist title against real genre
names costs no extra requests.

- `spotify.ts` / `types.ts` — map and type `description`.
- `musicbrainz.ts:68` — export a synchronous `cachedGenreVocabulary(): Set<string>`;
  the whitelist is currently module-private.
- `useLibrary.ts` — scan `` `${name} ${description}` `` for vocabulary terms, longest match first.
- `engine.ts` — `buildFingerprint(songs, hints?)` seeds `genreCounts` per hint at
  ~25% of the playlist's song count, so a "Lo-fi Study" playlist with no resolved
  genres still ranks. Needs a `ponytail:` comment: a title is weaker evidence
  than a resolved artist genre, and that weight is a guess until tuned.

### Era as a real factor
> recs need to add year as a factor. if all the songs in a playlist are batched around a certain year or era that needs to be accounted for in the recommendations

Half-built already: `ERA_WEIGHT = 0.15` over decade buckets. Two problems — the
buckets have a hard cliff (a 1979 song gets nothing from a playlist full of
1980s) and the weight is low.

```ts
// engine.ts
const eraScore = Math.min(1, w(d) + 0.5 * (w(d - 10) + w(d + 10)));
// GENRE_WEIGHT 0.7 → 0.65, ERA_WEIGHT 0.15 → 0.2
```

Roughly 4 of the 14 tests in `engine.test.ts` bake in the current weights.

### Language: heavy penalty on mismatch
> language matching feature is still weak. if all songs in a playlist are in one / two foreign languages that playlist should only be recommended when songs are also in that foreign language

Today language is additive-only (max +0.15), so a Russian playlist still ranks
for an English song on genre alone. Add a suppression step to `explainScore`:
when a playlist is ≥70% one script (or ISRC country) **and** the song carries a
different script signal, multiply the total by 0.25.

Stays script-bucket based — no language list — so it behaves identically
whatever the user's library is mostly in. Surface the penalty in
`ScoreBreakdown` so MatchPicker's DEV explain line shows it.

### Mood / valence — probe, then almost certainly close
> Valence and energy metrics from spotifys web api are not considered heavily enough, the current sorting has no feel for the mood of a track, it should. factor this into recs and the analyzer. underlying tweak to the whole app

`/audio-features` was deprecated for new apps in Nov 2024 and the Feb 2026
migration is unlikely to have restored it. Add `/audio-features/{id}` and
`/audio-features?ids=` to `src/dev/probe.ts`, run it, record the verdict here.

---

## Batch 3 — New-playlist creation

### Make cluster suggestions actionable
> the new playlist ideas at the bottom of the sorter is weak, doesnt let you make the playlist from there and is hidden all the way at the bottom. redo its UI and look into a way to get a quick create ui / option on the table

`suggestClusters` already produces the groups; the presentation and the write
path are what's missing.

- **Probe first** — creation was `POST /users/{id}/playlists` pre-2026 and that
  route is unverified against the Feb 2026 migration.
- `spotify.ts` — `createPlaylist(name)` with `USER_ACTION` priority, like the
  other four write calls.
- `Sorter.tsx` — move the ideas block out of the footer to sit beside the
  quick-matches strip; each cluster gets a name input prefilled with the genre
  and a "Create with N songs" button. On success: add the tracks, then
  `lib.refresh()` so the new playlist becomes a match target.

**Creation must not unsave.** Everywhere else "move" means add + unsave +
removal log; doing that here would destroy `added_at` for a whole cluster behind
one button. The songs stay in Liked and now match the new playlist, so the
normal per-song flow handles them.

---

## Batch 4 — Mobile and delivery

The five follow-ups from the responsive-layout work. Recommended defaults below,
not settled decisions.

### Playback silently fails on phones
`src/player/spotifyPlayer.ts:80` loads the Web Playback SDK from `sdk.scdn.co`,
which does not run in any mobile browser. `Sorter.tsx` pre-warms it on mount and
`SongRow.tsx` renders a play button per row, so on a phone the buttons are
visible and do nothing.

Add `isPlaybackSupported()` — a UA check (`/Android|iPhone|iPad|iPod/`). The
SDK's real blocker is EME/DRM, which no mobile browser exposes and which has no
honest feature test. Gate the pre-warm, hide `.play-btn`, show one line of
explanation. The track title already links to `open.spotify.com`, which hands
off to the installed app — the natural mobile substitute.

### The dev server can't be reached from a phone
`vite.config.ts:4` pins `host: '127.0.0.1'`. Binding `0.0.0.0` is necessary but
not sufficient — `http://<lan-ip>:5173` fails twice over:

- Spotify permits plain `http` redirect URIs **only** for loopback literals
  (`http://127.0.0.1:PORT`, `http://[::1]:PORT`). A private network address
  requires HTTPS, so the redirect URI can't even be registered.
- `src/auth/pkce.ts` uses `crypto.subtle` for the S256 challenge, and
  `crypto.subtle` is undefined outside a secure context.

**Recommended:** document an SSH local forward
(`ssh -L 5173:127.0.0.1:5173 <mac>`, then open `http://127.0.0.1:5173` on the
phone). Loopback *on the phone* satisfies both rules — no code, no deps, no
dashboard change. An opt-in HTTPS dev mode and the real deploy
(`2026-07-19-public-launch.md`) both remain open.

### No PWA metadata
`index.html` has the viewport meta but no `manifest`, `apple-touch-icon`, or
`theme-color`; `public/` holds only `favicon.svg` and `icons.svg`.
Add-to-home-screen currently produces a generic icon and a browser chrome frame.

Full install: `theme-color`, a 180px `apple-touch-icon`, and
`manifest.webmanifest` with 192/512 PNGs rendered once from `public/favicon.svg`
via `rsvg-convert` (already installed) and committed to `public/`.

### No viewport regression coverage
`src/index.css.test.ts` asserts the responsive *contract* — the breakpoints exist
and override the rules that overflow. It cannot catch actual overflow, because
jsdom does no layout and does not evaluate width media queries.

**Recommended: skip Playwright.** A ~150MB browser download and a second test
runner, in a two-dependency app, to guard one assertion. Document the manual
devtools check (390×844, `scrollWidth <= clientWidth`) in CLAUDE.md instead.

### Column labels are gone on phones
The phone breakpoint hides `.song-cols` because the headings no longer align with
anything once a row stacks. Year and date-added are now two bare numbers on a
shared line. If that reads as ambiguous in use, add `::before` labels on
`.song-year` / `.song-added` inside the existing 720px block — no JSX change, no
test churn, and it keeps a phone-only concern in the phone-only block.

---

## Batch 5 — The second UI skin

### Gallery skin
> i want to spec out another ui. the one thats there right now should stay but i want a toggle that will maybe let the user equip a prettier one. maybe with less details in view immediately. have it display the cover art of both the song and the playlist. have this be overall more minimal, more sleek, more artsy while still sticking with the ui theme of the app. it can be less space efficient but look better. the toggle for these two ui options should be in the upper right corner of the app and persist in its location with scroll.

The only item that needs new API data.

- `spotify.ts` / `types.ts` — `album.images` in `getSavedTracks`, playlist
  `images` in `getMyPlaylists`; `Track.albumArt` and `Playlist.image`. The
  snapshot grows ~60 chars/track; `persist()` already degrades on quota.
- `storage/settings.ts` — `skin: 'table' | 'gallery'`.
- `App.tsx` / `index.css` — the toggle is `position: fixed` top-right, above the
  sticky `.song-cols` header, so it persists across scroll and tabs.
- `components/SongCard.tsx` — new; one song in focus, both covers, minimal
  chrome. Reuses `MatchPicker` verbatim so both skins share one interaction model.
- `Sorter.tsx` picks the row component by skin — one data path, two presentations.

### Banana freshness icons
> in addition to the dates added to liked i want little icons. three options: stale, stable, not ripe yet. use different colors of bananas for it. will be an indicator of how long the track has been in there. math should work like this. interval = newest - oldest / 3. depending on which date category a track falls into assign it that ranking (maybe a feature for the prettier ui version rather than the current one)

A pure function doing exactly that thirds math. Gallery skin only, per the note's
own parenthetical.

### Light animation pass
> need to incorporate some light animation to give the app a more premium feel. little ones but have them all around so it feels sleek

Row hover lift, popover scale-in, toast slide-in — all inside
`@media (prefers-reduced-motion: no-preference)`, matching the reduced-motion
blocks the stylesheet already has.

---

## Batch 6 — Docs and verification

### README: how sorting actually works
> update the readme with the logic used to sort songs, include a mermaid diagram, i want to see the logic behind whats happening so i can comment and tweak it later.

Document the genre waterfall (cache → Spotify → MusicBrainz bulk) and the
scoring formula with a mermaid flowchart; GitHub renders it natively. Write it
**after** batch 2, so it documents the new weights rather than the old ones.

### Rate limiting — verify, don't rebuild
> after using the tool an adding a few songs i hit the SpotifyApiError: Spotify is rate-limiting this app (429). Wait a few minutes and reload — after heavy use the penalty can last an hour or more.

Largely fixed after this note was written. `spotifyFetch` now has a localStorage
penalty gate, a 6-slot concurrency pool, an 8/sec token bucket, priority
queue-jumping for user actions, and a 90s park bound (`spotify.ts:38-186`).
Re-verify with a heavy sorting session; if 429s still appear, tune
`REFILL_PER_SEC` / `BUCKET_CAPACITY` rather than adding machinery.
