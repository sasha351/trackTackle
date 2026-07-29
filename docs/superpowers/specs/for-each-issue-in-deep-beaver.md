# Roadmap for every issue in docs/superpowers/plans/issues.md

## Context

`docs/superpowers/plans/issues.md` is an unordered inbox: 18 raw feature notes
written while using the app, followed by 5 scoped follow-ups left over from the
responsive-layout work. Nothing in it is sequenced, sized, or checked against
what the code can actually do — two items depend on Spotify endpoints that may
not exist any more, and several are already half-built.

**Deliverable:** rewrite `docs/superpowers/plans/issues.md` in place as the
ordered plan below — six batches, every item with an approach, the files it
touches, and a checkbox. Original wording is preserved as a quoted line under
each item so nothing is lost. The raw version stays in git history.

**Batch order** (user-chosen): Sorter UX → Recommendation accuracy → Playlist
creation → Mobile/delivery → Second UI skin → Docs.

---

## Batch 1 — Sorter UX quick wins — SHIPPED 2026-07-29

Bigger playlist dropdown, open-row highlight with every other row locked,
now-playing highlight, back-to-top anchor, quick-matches strip, duplicate
prevention, and analyzer refresh + verdict grouping. See git history for the
design detail this section carried.

---

## Batch 2 — Recommendation accuracy

The app's core purpose; everything else displays its output.

### 2.1 Playlist name and description as genre hints
> *"look into if its possible to read playlist name / description to get a better idea of its ideal tag and genre"*

Yes — `/me/playlists` returns `description`, it's just not mapped. And MusicBrainz's
canonical genre vocabulary is already cached in `kondo:mb-genres:v1`, so matching
a playlist title against real genre names costs nothing extra.

- `src/api/spotify.ts:324` — map `description`; `Playlist` in `types.ts` gains it.
- `src/api/musicbrainz.ts:68` — export a synchronous `cachedGenreVocabulary(): Set<string>`
  reading the already-cached whitelist (currently module-private).
- `src/hooks/useLibrary.ts` — derive hint genres by scanning
  `` `${name} ${description}`.toLowerCase() `` for vocabulary terms, longest match first.
- `src/matching/engine.ts` — `buildFingerprint(songs, hints?: string[])` seeds
  `genreCounts` for each hint at a fixed weight (~25% of the playlist's songs), so
  a "Lo-fi Study" playlist with no resolved genres still ranks. Carries a
  `ponytail:` comment naming the ceiling: a title is weaker evidence than a
  resolved artist genre, and the weight is a guess until tuned.

Test: `engine.test.ts` (hints seed the fingerprint), plus a term-extraction test.

### 2.2 Era as a real factor
> *"recs need to add year as a factor. if all the songs in a playlist are batched around a certain year or era"*

Already partly there — `ERA_WEIGHT = 0.15` over decade buckets — but the buckets
have a hard cliff (a 1979 song gets nothing from a playlist full of 1980s) and
the weight is low. Two small changes in `engine.ts`:

```ts
// bleed into neighbouring decades so a boundary year isn't punished
const eraScore = Math.min(1, w(d) + 0.5 * (w(d - 10) + w(d + 10)));
// GENRE_WEIGHT 0.7 → 0.65, ERA_WEIGHT 0.15 → 0.2
```

Files: `src/matching/engine.ts`.
Test: update `engine.test.ts:76` ("era is a secondary signal only") and add a
decade-boundary case. Several existing assertions bake in the current weights —
expect to touch ~4 of the 14 tests.

### 2.3 Language: heavy penalty on mismatch
> *"if all songs in a playlist are in one / two foreign languages that playlist should only be recommended when songs are also in that foreign language"*

Today language is additive-only (max +0.15), so a Russian playlist still ranks
for an English song on genre alone. Add a suppression step in `explainScore`:
when a playlist is ≥70% one script (or ISRC country) **and** the song carries a
different script signal, multiply the total by **0.25**.

Chosen over a hard veto so a genuinely bilingual or mis-transliterated track can
still surface as a greyed-out best guess rather than vanishing. Stays
script-bucket based — no language list — so it behaves identically whatever the
user's library is mostly in.

Files: `src/matching/engine.ts` (add the penalty to `ScoreBreakdown` so
MatchPicker's DEV explain line shows it).
Test: `engine.test.ts` — mismatch penalised, match untouched, and the symmetric
flip (mostly-Russian library) behaves the same.

### 2.4 Mood / valence — probe, then almost certainly drop
> *"Valence and energy metrics from spotifys web api are not considered heavily enough"*

`/audio-features` was deprecated for new apps in Nov 2024 and the Feb 2026
migration is unlikely to have brought it back. Add two probe lines to
`src/dev/probe.ts` (`/audio-features/{id}` and `/audio-features?ids=`), run it,
and record the verdict in `issues.md`. If it 403s, the item is closed with the
probe output as evidence — no invented genre→mood table, which would be ~100
lines of unvalidatable numbers.

Files: `src/dev/probe.ts`.

---

## Batch 3 — New-playlist creation

### 3.1 Cluster suggestions, made actionable
> *"the new playlist ideas at the bottom of the sorter is weak, doesnt let you make the playlist from there and is hidden all the way at the bottom"*

`suggestClusters` (`src/matching/clusters.ts`) already produces the groups; only
the presentation and the write path are missing.

- **Probe first**: playlist creation was `POST /users/{id}/playlists` pre-2026.
  Add a probe line before writing `createPlaylist` — the Feb 2026 migration
  renamed several routes and this one is unverified.
- `src/api/spotify.ts` — `createPlaylist(name)`, with `USER_ACTION` priority like
  the other four write calls.
- `src/components/Sorter.tsx` — move the ideas block out of the footer into a
  `<details>` beside the quick-matches strip; each cluster gets a name input
  prefilled with the genre and a "Create with N songs" button. On success: add
  the tracks, then `lib.refresh()` so the new playlist becomes a match target.

**Creation does not unsave.** Everywhere else in the app "move" means add +
unsave + removal log; doing that here would silently destroy `added_at` for a
whole cluster behind one button. The songs stay in Liked and now match the new
playlist, so the normal per-song flow handles them.

Test: `Sorter.test.tsx` with a mocked `createPlaylist`.

---

## Batch 4 — Mobile and delivery (the five follow-ups)

These carry my recommended defaults rather than settled decisions — revisit when
the batch comes up.

### 4.1 Playback gate on phones
`isPlaybackSupported()` in `src/player/spotifyPlayer.ts` — a UA check
(`/Android|iPhone|iPad|iPod/`). The SDK's real blocker is EME/DRM, which no
mobile browser exposes and which has no honest feature test. Gate the pre-warm
(`Sorter.tsx:130`), hide `.play-btn`, show one explanatory line. The title already
links to `open.spotify.com` (`SongRow.tsx:25-31`), which hands off to the app.

### 4.2 Phone can't reach the dev server
Document the SSH local-forward in the README. Loopback *on the phone* is the only
thing that satisfies both Spotify's http-redirect rule and `crypto.subtle`'s
secure-context rule — zero code, zero deps, no dashboard change. HTTPS dev mode
and the real deploy (`2026-07-19-public-launch.md`) both remain open.

### 4.3 PWA metadata
Full install: `theme-color`, `apple-touch-icon` (180px), and
`manifest.webmanifest` with 192/512 PNGs rendered once from `public/favicon.svg`
via `rsvg-convert` (already installed) and committed to `public/`.

### 4.4 Viewport regression coverage
**Skip Playwright.** A ~150MB browser download and a second test runner, in a
two-runtime-dependency app, to guard one assertion. `index.css.test.ts` already
fails on the regressions that actually happen. Document the manual devtools
check (390×844, `scrollWidth <= clientWidth`) in CLAUDE.md instead.

### 4.5 Phone column labels
Use CSS `::before` labels on `.song-year` / `.song-added` inside the existing
720px breakpoint rather than editing `SongRow.tsx` — no JSX change, no test churn,
and it keeps the phone-only concern in the phone-only block.

---

## Batch 5 — The second UI skin

### 5.1 Gallery skin
> *"a toggle that will maybe let the user equip a prettier one… display the cover art of both the song and the playlist… more minimal, more sleek, more artsy"*

The only item that needs new API data:

- `src/api/spotify.ts` — `album.images` in `getSavedTracks`, playlist `images` in
  `getMyPlaylists`; `Track.albumArt` and `Playlist.image` (`string | null`) in `types.ts`.
  Snapshot grows ~60 chars/track — `persist()` already degrades gracefully on quota.
- `src/storage/settings.ts` — `skin: 'table' | 'gallery'`.
- `src/App.tsx` + `src/index.css` — the toggle is `position: fixed` top-right,
  `z-index` above the sticky `.song-cols` header, so it persists across scroll and tabs.
- `src/components/SongCard.tsx` — new; one song in focus, both covers, minimal
  chrome. Reuses `MatchPicker` verbatim, so both skins share one interaction model.
- `Sorter.tsx` picks the row component by skin — one data path, two presentations.

### 5.2 Banana freshness icons
> *"stale, stable, not ripe yet… interval = newest - oldest / 3"*

Small pure function (`freshnessOf(addedAt, oldest, newest)`) doing exactly the
thirds math from the note. Gallery skin only, per the item's own parenthetical.

### 5.3 Light animation pass
> *"need to incorporate some light animation to give the app a more premium feel"*

Row hover lift, popover scale-in, toast slide-in — all inside
`@media (prefers-reduced-motion: no-preference)`, matching the reduced-motion
blocks the stylesheet already has at lines 310 and 364.

---

## Batch 6 — Docs and verification

### 6.1 README: how sorting actually works
> *"update the readme with the logic used to sort songs, include a mermaid diagram"*

Document the genre waterfall (cache → Spotify → MusicBrainz bulk) and the scoring
formula with a mermaid flowchart. GitHub renders mermaid natively. Write it
**after** batch 2, so it documents the new weights rather than the old ones.

### 6.2 Rate limiting — verify, don't rebuild
> *"after using the tool an adding a few songs i hit the SpotifyApiError… (429)"*

Largely fixed after this note was written: `spotifyFetch` now has a localStorage
penalty gate, a 6-slot concurrency pool, an 8/sec token bucket, priority
queue-jumping for user actions, and a 90s park bound
(`src/api/spotify.ts:38-186`). Re-verify with a heavy sorting session. If 429s
still appear, tune `REFILL_PER_SEC` / `BUCKET_CAPACITY` — do not add machinery.

---

## Verification

Per batch:
- `npx vitest run` — full suite. `npm run lint` (oxlint). `npm run build` (tsc + vite).
- `npm run dev` at `http://127.0.0.1:5173` and exercise the batch by hand:
  - **B1**: open a dropdown → other rows dim and are unclickable; clicking one
    closes the popover. Play a song → row highlights. Add a song to a playlist it's
    already in → blocked with a warning, song stays in Liked.
  - **B2**: DEV builds show the per-candidate `g/e/l` breakdown in MatchPicker
    (`MatchPicker.tsx:97-102`) — read it to confirm the era and language changes
    move the numbers the intended direction.
  - **B3**: create a playlist from a cluster, confirm it appears in Spotify and
    the songs are still in Liked.
  - **B4**: DevTools at 390×844, `document.documentElement.scrollWidth <= clientWidth`.
- Commit per batch, not per item.

## Out of scope

No new runtime dependencies — the app has exactly two (`react`, `react-dom`).
No backend, no router. Batch 4's HTTPS dev mode and the Vercel deploy stay in
`2026-07-19-public-launch.md`.
