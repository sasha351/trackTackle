# Misc notes — design

The `# misc notes` list at the end of `docs/superpowers/plans/issues.md`, minus
the one note that already has a spec. Six items, all UI. No new dependencies —
the app still has exactly two (`react`, `react-dom`).

Note 4 ("playlist suggestions recommend genres the library already has") is
**out of scope**: it is already specified in full as Batch 9 of `issues.md` and
stays queued for its own branch. Mood/decade clustering stays closed —
`/audio-features` is 403 and Batch 9 rejected era/language clustering.

## Decisions taken (do not re-litigate)

- The two gallery covers are **fluid and equal**, sized by equal grid tracks —
  not by a shared pixel value. Fixed sizes are what drifted apart in the first
  place.
- The middle cluster is a **single stacked column**: date/banana, play, Add, ✕.
- The header nav **drops to its own row, flush right**. The skin toggle stays
  viewport-fixed; that was an explicit earlier request.

---

## 1. Gallery card layout (notes 1, 2, 3)

Notes 1–3 are one layout, not three:

> - size of playlist cover art still is not same size as song cover art in the gallery view
> - each rectangle containing song match reccomendations is not centered on the page in gallery view
> - add, x, play, and the song age need to be in the middle of the two cover arts

Today `.card-song .cover-lg` is `width: 100%` of a 260px track (≈260px) while
`.panel-head .cover-md` is a hard 160px, Add and ✕ sit at the card's right edge
via `space-between`, and `.song-card` has `max-width: 880px` with no auto
margin, so every card hugs the left gutter.

### Target

```
        ┌────────────────────────────────────────────────────────┐
        │ song name                                              │
        │ ┌────────────┐      🍌       ┌────────────┐            │
        │ │            │    2024-03    │            │            │
        │ │ song cover │     ( ▶ )     │  playlist  │            │
        │ │            │    [ Add ]    │   cover    │            │
        │ └────────────┘     ( ✕ )     └────────────┘            │
        │ artist                       playlist · 82%            │
        │ year                         show more                 │
        └────────────────────────────────────────────────────────┘
         ^ centered on the page, capped at 880px
```

### Grid

One grid owns the three zones:

```css
.song-card {
  grid-template-columns: minmax(0, 1fr) var(--gallery-mid) minmax(0, 1fr);
  margin-inline: auto;     /* note 2 */
  align-items: center;
}
```

`--gallery-mid` is a new token (`160px` — wide enough for "Add to 3 playlists"
at 13px/700 plus its padding).

`.match-panel` spans columns 2–4 and **restates the same two tracks with the
same gap**:

```css
.match-panel {
  grid-column: 2 / 4;
  display: grid;
  grid-template-columns: var(--gallery-mid) minmax(0, 1fr);
  gap: var(--sp-6);
}
```

The arithmetic that makes the covers equal: with card width `W`, gap `G` and
outer tracks `X, M, X` we have `2X + M + 2G = W`. The panel occupies
`M + G + X`; its own tracks are `M` and `1fr`, so the `1fr` resolves to exactly
`X`. Both covers are `width: 100%; aspect-ratio: 1` inside an `X`-wide track —
equal by construction, at every viewport width, with no shared pixel constant to
keep in sync. **This is why the gap must be `var(--sp-6)` in both places; a
different inner gap silently breaks the equality.**

`align-items: center` on the card is what keeps the two covers roughly level
despite the song name sitting above one of them and nothing above the other. It
is deliberately approximate — the exact fix would be a magic offset that breaks
the moment a title wraps to two lines. `ponytail:` comment says so.

### The middle cluster

Add lives inside `MatchPicker` (it is the only thing that knows `effectiveChosen`
— selection minus stale ids minus playlists the song is already in). Moving Add
into the middle column therefore means either lifting that state into `SongCard`
or passing the middle column *down*. We pass it down:

- `MatchPicker` gains one optional prop, `midSlot?: ReactNode`, honoured by the
  `panel` layout only.
- `SongCard` renders `<div className="card-mid">` — banana/date, play button, ✕
  — and hands it to `MatchPicker` as `midSlot`. The `.card-match` wrapper and
  its `.remove-btn` child go away; ✕ moves into `.card-mid`.
- `MatchPicker`'s panel renders `<div className="panel-mid">{midSlot}{addButton}</div>`
  in the panel grid's first track, and the cover / caption / toggle in the
  second.

No state moves. The `pill` layout is untouched — it ignores `midSlot`.

`.panel-head` is deleted. Its children become direct children of `.match-panel`
with explicit placement:

| element | column | row |
|---|---|---|
| `.panel-mid` | 1 | 1 / 4 |
| cover link | 2 | 1 |
| `.panel-caption` | 2 | 2 |
| `.panel-toggle` | 2 | 3 |
| `.panel-body` | 1 / -1 | 4 |

`.panel-body` (candidate tiles + search) spans both tracks, so "show more"
still opens across the full width it has today. `.cand-tiles` keeps
`repeat(auto-fill, …)`.

### Phone (≤720px)

The existing one-column collapse stays, with two additions: `.match-panel`
reverts to `display: flex; flex-direction: column` (its explicit row/column
placements must not survive into the stacked layout), and `.panel-mid` becomes a
row so the date, play, ✕ and Add sit on one line across the phone's single
column — `.card-mid`'s existing `flex-direction: row; justify-content:
space-between` at this breakpoint already does half of that.

### Tests

`SongCard.test.tsx`:
- Add and ✕ are both inside the element that also contains the play button
  (assert via `.card-mid`'s parent containing all three) — the containment *is*
  note 3.
- ✕ still calls `onAdd(track, [])`.

`index.css.test.ts`:
- `.song-card` has `margin-inline: auto` and two `minmax(0, 1fr)` flanking
  tracks around `var(--gallery-mid)`.
- `.match-panel` restates `var(--gallery-mid)` and uses `gap: var(--sp-6)` —
  this is the assertion that protects the equal-cover arithmetic above.
- **Replaces** the existing `stretches the panel head across the match column`
  test, which asserts a `.panel-head` that no longer exists.
- The phone block reverts `.match-panel` to `flex`.

---

## 2. Now-playing indicator (note 5)

> need some sort of hovering now playing indicator that when you click it auto
> scrolls you to the songs location on page, something small but like usable

A plain anchor, not a scroll handler — the browser already does this and
`scroll-behavior: smooth` is set globally (`index.css:60`). Same rung as the
existing `.to-top` anchor in `App.tsx`.

- `SongCard` and `SongRow` put `id={`track-${track.id}`}` on their `<li>`. Both
  skins, so the indicator works in either. `quick` and `rest` are disjoint by
  construction (`Sorter.tsx:274-283`), so the id is unique on the page.
- `Sorter` renders, only while `playingUri` is non-null:

  ```tsx
  <a className="now-playing" href={`#track-${playingTrack.id}`}>
    <span aria-hidden="true">▶</span> {playingTrack.name}
  </a>
  ```

  with `aria-label="Scroll to the song now playing"`. `playingTrack` is found in
  `lib.tracks` by uri; if it is gone (sorted away mid-play), render nothing.
- Fixed to the viewport bottom-left, mirroring `.to-top`'s bottom-right: same
  `z-index: 2`, same `env(safe-area-inset-bottom)` treatment, truncated to a
  `max-width` with `text-overflow: ellipsis` so a long title cannot span the
  screen. On phones it clears the undo toast the same way `.to-top` does.

Nothing scroll-listens, and there is no state beyond the `playingUri` that
already exists.

### Tests

`Sorter.test.tsx`: playing a song renders a link whose `href` is
`#track-<id>`; the element with that id exists in the list; no link before any
song is played.

---

## 3. Header nav flush right (note 6)

> pill shaped buttons for sorter analyzer settings log out are not right
> justified and have weird spacing between them

The nav cannot reach the right edge today because `.app-header` reserves
`padding-right: 140px` to clear the viewport-fixed `.skin-toggle`. The phone
breakpoint already solves this by forcing the title full-width so the nav wraps
to its own row; that solution is promoted to the base stylesheet:

```css
.app-header { /* padding-right: 140px deleted */ }
.app-header h1 { flex: 1 0 100%; }
.app-header nav { margin-left: auto; gap: var(--sp-2); }
```

`h1` is 40px with `--sp-8` above it, so row 2 begins ≈90px down — well clear of
the fixed toggle at `top: var(--sp-3)` (≈46px tall). The nav's own gap stays
`--sp-2`; the "weird spacing" was the 140px void to the right of the group, not
the gaps within it.

The phone block's `.app-header { padding-right: 0 }` and
`.app-header h1 { flex: 1 0 100% }` become redundant and are deleted;
`.app-header nav { flex-wrap: wrap }` stays (it is what wraps by whole pills at
390px).

### Tests

`index.css.test.ts`: the base sheet has no `padding-right: 140px` on
`.app-header` and does set `h1 { flex: 1 0 100% }`. The existing phone-block
test `drops the header reservation once the nav has its own row` is rewritten
against the base sheet, keeping its comment about *why* the reservation existed.

---

## 4. Banana explainer in Settings (note 7)

> settings page needs an explainer for the banana emoji ranking system

The three-stage `BANANA` src map currently lives in `SongCard.tsx`. It moves to
`src/freshness.ts` beside `FRESHNESS_LABEL` — that module already owns the
ranking's meaning, and Vite resolves the `.png` imports there identically.
`SongCard` imports it instead of declaring it.

`Settings` gains a section under the existing headings:

```
Ripeness
Each song carries a banana for how long it has been sitting in Liked. The
three stages are thirds of your own library's span, oldest to newest — so
they mean the same thing whatever your library looks like.

  🍌(green)  Recently liked
  🍌(yellow) Settled in
  🍌(brown)  Been in Liked the longest
```

Labels come from `FRESHNESS_LABEL`, not retyped, so the explainer cannot drift
from the cards. Images carry the same `alt` as on a card. One sentence about
the relative scale, because "stale" meaning different dates in different
libraries is the non-obvious part.

### Tests

`Settings.test.tsx`: all three `FRESHNESS_LABEL` values render on the settings
page.

---

## Verification

`npx vitest run` green, `npm run build` clean, `npm run lint` clean, and the
manual viewport check from `CLAUDE.md` at 390×844:

```js
document.documentElement.scrollWidth <= document.documentElement.clientWidth
```

must be `true` — jsdom does no layout, so the CSS contract tests above cannot
catch real overflow from the new grid.
