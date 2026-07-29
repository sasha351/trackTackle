# Open issues

**This is the only planning file.** Every completed plan under
`docs/superpowers/` was deleted on 2026-07-29 and whatever was still open in it
was folded in here — git history has the originals in full.

Ordered into batches. Batch 1 (sorter UX quick wins), batch 2 (recommendation
accuracy), and batch 3 (new-playlist creation) shipped on 2026-07-29 and have
been removed from this file — see git history for the raw notes. Batch 6's
README item shipped the same day (the sorting-logic walkthrough with the
mermaid waterfall diagram is now in `README.md`), leaving only verification.

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
dashboard change. An opt-in HTTPS dev mode remains open; the real deploy is
batch 7, and shipping that makes this item moot — a real HTTPS origin lets any
phone hit the app directly.

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
