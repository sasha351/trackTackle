# Open issues

**This is the only planning file.** Every completed plan under
`docs/superpowers/` was deleted on 2026-07-29 and whatever was still open in it
was folded in here — git history has the originals in full.

Ordered into batches. Batch 1 (sorter UX quick wins), batch 2 (recommendation
accuracy), and batch 3 (new-playlist creation) shipped on 2026-07-29 and have
been removed from this file — see git history for the raw notes. Batch 6's
README item shipped the same day (the sorting-logic walkthrough with the
mermaid waterfall diagram is now in `README.md`), leaving only verification.

Batch numbers are creation order, not priority. **Batch 5 is the next thing to
build.** Batch 8 (dense view corrections) shipped on 2026-07-29. Batch 5 is the
second half of that design pass — the gallery skin specified by
`design sketches/pretty view.jpeg`.

Retired plans and where their leftovers went:

| Plan | Outcome |
|---|---|
| `2026-07-27-rate-limit-resilience` (+ design, handoff, ledger) | 9/9 tasks merged. Live-traffic verification and three review leftovers → batch 6. |
| `2026-07-19-public-launch` | All 5 code tasks shipped; the ops runbook → batch 7. |
| `for-each-issue-in-deep-beaver` | Its deliverable was this file's batch structure. |
| `2026-07-22-issues-implementation-design` | Scoped to an issues.md the batch rewrite replaced. |

Batch 2 verdicts:
- 2.1 (title/description hints), 2.2 (era bleed), 2.3 (language penalty): shipped.
- 2.4 (mood/valence): closed, not built. Probed live —
  `GET /audio-features/{id}` and `GET /audio-features?ids=` both 403. The Nov
  2024 deprecation was not reversed by the Feb 2026 migration; no genre→mood
  table was invented in its place.

Decisions already taken, so they don't get re-litigated:

- **Mood/valence**: probe `/audio-features` first; if it's dead, close the item
  rather than inventing a genre→mood table.
- **Language rule**: heavy penalty (×0.25), not a hard veto — a mismatched
  playlist can still surface as a greyed-out best guess.
- **Second UI**: a real parallel skin with cover art, not a reskin of the table.
- **No new runtime dependencies.** The app has exactly two (`react`, `react-dom`).

---

## Batch 5 — The second UI skin

### Gallery skin
> i want to spec out another ui. the one thats there right now should stay but i want a toggle that will maybe let the user equip a prettier one. maybe with less details in view immediately. have it display the cover art of both the song and the playlist. have this be overall more minimal, more sleek, more artsy while still sticking with the ui theme of the app. it can be less space efficient but look better. the toggle for these two ui options should be in the upper right corner of the app and persist in its location with scroll.

The only item that needs new API data. Now specified by
`design sketches/pretty view.jpeg`.

**Shape (settled).** A vertical feed of wide, spacious cards, one per song — the
same data path and the same full list as the table, just a much taller row. Not
a one-song-at-a-time focus mode; the sketch's dashed right-hand panel is *one
card's expanded state*, not a second screen. (This supersedes the earlier "one
song in focus" line in this file.)

**Card anatomy**, left → right, per the sketch:

- **Song block** — name above a large album cover (`Track.albumArt`), artist and
  year beneath it. The name keeps today's `open.spotify.com` link.
- **Middle** — one small box holding `date added` + the banana glyph (that's the
  `(symbol)` in the sketch, and it settles where the bananas live), with a round
  ▶ under it. On phones the play button is hidden anyway — see `isPlaybackSupported()` in `src/player/spotifyPlayer.ts`.
- **Right** — the best-match playlist's **cover art**, clickable, next to an
  `add` pill and a `✕` circle. The cover *is* the match's identity here; the
  name/percent pill shrinks to a caption under it.
- **`show more` / `hide`** under the playlist cover, expanding an inline panel
  *inside the card*: the alternate playlists as cover-art tiles (the sketch draws
  4), then the search box, then the checkbox list of every remaining playlist.

**That panel is `MatchPicker`'s popover, inline instead of floating** — so the
old "reuses `MatchPicker` verbatim" line is wrong: same logic, different
container. Add `layout?: 'pill' | 'panel'`:

- `'pill'` (default) — today's trigger button + absolutely-positioned
  `.match-popover`. Untouched.
- `'panel'` — no trigger button; the scored candidates render as cover-art tiles
  (`.cand-tile`) instead of `.match-candidate` rows; the whole `browse-section`
  (search input + checkbox list) is reused as-is; open/closed is the card's
  `show more`, not MatchPicker's own `open` state.

Everything that carries an invariant stays put: `selected`/`chosen`, the
`alreadyIn` dupe guard, `effectiveChosen`, and the `canAdd` rule that Add can
never fire empty (`MatchPicker.tsx:64-70`). One component, one branch, and
`MatchPicker.test.tsx`'s 174 lines keep covering both skins.

**Data:**

- `spotify.ts` / `types.ts` — `album.images` in `getSavedTracks`, playlist
  `images` in `getMyPlaylists`; `Track.albumArt` and `Playlist.image`. Take the
  ~300px entry, **not `images[0]`** (that's 640px — a feed of those is megabytes
  of image traffic for thumbnails).
- The alternate tiles reuse the same `Playlist.image`, so expanding a card costs
  no extra request.
- Missing art is routine (playlists with no custom image, local files). Every
  cover needs a text-initial fallback tile, not a broken `<img>`.
- The snapshot grows ~60 chars/track; `persist()` already degrades on quota —
  but see batch 6: it currently treats *any* throw as a quota problem, so fix
  that first or a bad URL silently kills snapshotting.

**Wiring:**

- `storage/settings.ts` — `skin: 'table' | 'gallery'`, default `'table'`.
- `App.tsx` / `index.css` — the toggle is `position: fixed` top-right, above the
  sticky `.song-cols` header, so it persists across scroll and tabs. Batch 8
  moves sort-order + Refresh into that same top-right corner, so land batch 8
  first and slot the toggle into the cluster it creates rather than overlapping
  it.
- `Sorter.tsx` picks the row component by skin — one data path, two
  presentations. `renderRow` (`Sorter.tsx:250`) is already the single call site
  for both lists, so this is one conditional, not two.
- `components/SongCard.tsx` — new, with `SongCard.test.tsx` mirroring
  `SongRow.test.tsx`.
- Quick Add and Playlist Suggestions stay as batch 8 leaves them, unchanged and
  skin-independent — they're a decision strip above the list, not a row style.

### Banana freshness icons
> in addition to the dates added to liked i want little icons. three options: stale, stable, not ripe yet. use different colors of bananas for it. will be an indicator of how long the track has been in there. math should work like this. interval = newest - oldest / 3. depending on which date category a track falls into assign it that ranking (maybe a feature for the prettier ui version rather than the current one)

A pure function doing exactly that thirds math over `lib.tracks`' added dates.
Gallery skin only, per the note's own parenthetical, rendered in the card's date
box next to the date — which is exactly where the sketch's `(symbol)` sits.

Its one test covers the three buckets plus the degenerate case the formula hides:
a library where newest === oldest makes `interval` 0, and every boundary
comparison has to still land in one bucket instead of dividing by zero or
falling through. Colour alone can't carry the ranking (green/yellow/brown
bananas are a colour-only signal) — the glyph needs a `title`/label too.

*The light-animation pass from this batch shipped on 2026-07-29 as a stylesheet
tune-up: a `--t` transition token across every interactive surface, a shared
`rise` keyframe for the popover and toast, and a `scaleX` sweep on the score
bars. It landed as one reduced-motion damper rather than the
`prefers-reduced-motion: no-preference` wrapper this file originally proposed —
opting out once beats remembering to wrap each new rule.*

---

## Batch 6 — Verification

### Rate limiting — verify against real traffic
> after using the tool an adding a few songs i hit the SpotifyApiError: Spotify is rate-limiting this app (429). Wait a few minutes and reload — after heavy use the penalty can last an hour or more.

The machinery is built and 9/9 tasks of the rate-limit plan are merged:
`spotifyFetch` has a localStorage penalty gate, a 6-slot concurrency pool, an
8/sec token bucket, priority queue-jumping for user actions, and a 90s park
bound (`spotify.ts:38-186`), plus a TTL library snapshot and auto-resume.

**None of it has been exercised against real Spotify traffic yet** — this is the
only thing still owed from that plan. Needs `.env.local` and `npm run dev` on
`127.0.0.1:5173` (not `localhost` — it resolves to `::1` and breaks auth), then:
a cold load, two free reloads, a sorted song staying gone after reload, and a
forced-penalty countdown. If 429s still appear, tune `REFILL_PER_SEC` /
`BUCKET_CAPACITY` rather than adding machinery.

Three items survive that plan's review ledger, re-checked against the tree on
2026-07-29 (the rest were either fixed or went stale — see git history for the
full ledger):

- `persist()` (`librarySnapshot.ts:83`) treats **any** throw as "localStorage is
  full". A real bug in `JSON.stringify` or a serialization change would fall
  into the same branch, permanently disable snapshotting for the session, and
  report it as a quota problem. Narrow the catch to `QuotaExceededError` /
  `name === 'QuotaExceededError'` before trusting the warning.
- `writeSnapshot` replaces `items` wholesale, so narrowing the target playlist
  set evicts other playlists' cached items. Self-heals, costs refetches.
- The quota fallback stores `items: {}` *with* a fresh `savedAt`, so on a
  library big enough to blow the quota, `tracks` and `playlists` pin fresh until
  a manual Refresh.

---

## Batch 7 — Public launch

Carried out of `2026-07-19-public-launch.md` when that plan was retired. **Every
code task in it shipped** — `.env.local` untracked, global `ErrorBoundary`,
the non-Premium reassurance copy, `LegalPage`, and the login explainer +
Spotify attribution are all in the tree with tests. What is left is ops that
only Sasha can do, plus one optional test-coverage item.

### Domain decision (settled)
**Subdomain `kondo.shikhanovich.me`.** Vite `base` stays `/`, so the redirect
URI is a clean `https://kondo.shikhanovich.me/callback` and one standalone
Vercel project owns the subdomain. The subpath alternative
(`shikhanovich.me/kondo`) was rejected: it needs `base: '/kondo/'`, a *separate*
apex project, and a rewrite proxying `/kondo/*`, because one domain cannot
natively split across two Vercel projects by path.

### Deploy to Vercel (OPS — no code, blocks everything else)
1. vercel.com → Add New Project → import `spotifyKondo`. Preset **Vite**;
   build `npm run build`, output `dist` (both auto-detected).
2. Settings → Environment Variables → `VITE_SPOTIFY_CLIENT_ID =
   1aa1a441536d4ad8a7790b1cff55050d` for Production **and** Preview, then
   **redeploy**. Vite inlines `import.meta.env.*` at build time, so a var added
   after a build is not picked up by it.
3. Open the `*.vercel.app` URL and confirm the login screen renders. Don't test
   OAuth yet — the redirect URI isn't registered.
4. Settings → Domains → add `kondo.shikhanovich.me`, create the CNAME Vercel
   displays (`kondo` → `cname.vercel-dns.com`) at the registrar, wait for
   "Valid Configuration".
5. developer.spotify.com/dashboard → Settings → Redirect URIs → add **exactly**
   `https://kondo.shikhanovich.me/callback`. Keep `http://127.0.0.1:5173/callback`
   for local dev.
6. Confirm `dist/index.html` references `/assets/…` — a mismatched `base` is the
   most common cause of a blank deploy. No `vite.config.ts` change is needed for
   the subdomain.

The client ID is a **public PKCE identifier**, safe in the bundle and in
dashboards. It is not a secret.

### Live-domain smoke test (gates inviting anyone)
In a fresh/incognito profile signed into a Spotify account on the invite list:
login round-trip lands authenticated on the Sorter (an `INVALID_CLIENT` or
redirect-mismatch error means the registered URI ≠ the actual origin); library
loads; a song sorts into a playlist with the 8s undo and stays moved in Spotify;
a non-Premium tester sees the reassuring play message and can still sort; no
white-screen on any tab switch or transient API error.

### Invite the first 25 (OPS)
Spotify Dashboard → User Management → add each tester's **Spotify account
email**, max 25 including yourself. Send the link with a note: needs a Spotify
account, playback previews need Premium, sorting doesn't.

### Extended Quota Mode (OPS, unlimited public)
A Spotify **review**, not a toggle — submission needs the live URL, a
description ("sorts a user's Liked Songs into their existing playlists by
genre; browser-only; non-commercial"), screenshots or a <2-min recording, the
privacy-policy URL, commercial = No, and confirmed compliance with the
Developer Policy + Design Guidelines. Approval is not guaranteed and takes
weeks; Spotify has rejected hobby apps. Do the 25-user launch first so the app
is live regardless. Rejections usually name a specific fixable gap.

### Optional: fill the thinnest-tested paths
Not launch-blocking. The `?code` → `exchangeCode` → `setAuthed` callback effect
in `App.tsx` is only unit-tested at the token layer; `Sorter.tsx`'s play and
action error branches are uncovered.
