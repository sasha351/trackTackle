# Misc Notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the six open items under `# misc notes` in `docs/superpowers/plans/issues.md` — the gallery card layout (three of them), a now-playing indicator, the header nav, and a banana explainer in Settings.

**Architecture:** All four tasks are UI. The gallery card becomes one CSS grid whose two flanking tracks size both cover arts identically, with `MatchPicker` restating the same tracks over the two columns it owns; the middle control cluster is passed *down* into `MatchPicker` as a `midSlot` prop so no selection state has to move. The now-playing indicator is a plain `<a href="#track-id">` — the browser scrolls, `scroll-behavior: smooth` is already global. No new dependencies, no new state.

**Tech Stack:** React 19 + TypeScript, Vite, vitest + Testing Library (jsdom, globals on), plain CSS in one tokens-first stylesheet.

**Spec:** `docs/superpowers/specs/2026-08-02-misc-notes-design.md`

## Global Constraints

- **No new runtime dependencies.** The app has exactly two: `react`, `react-dom`.
- Full test suite: `npx vitest run`. One file: `npx vitest run src/path/file.test.ts`. There is no `test` script in `package.json`.
- `src/index.css` is tokens-first: every gap/margin/padding uses the `--sp-*` scale (`--sp-1:4px --sp-2:8px --sp-3:12px --sp-4:16px --sp-6:24px --sp-8:32px --sp-12:48px`), every hover/focus transition uses `--t`, font sizes are px (no rem/em).
- Do **not** add per-rule `animation: none` — the `prefers-reduced-motion` damper at the end of `index.css` covers every animation automatically.
- `src/index.css.test.ts` asserts the stylesheet's *contract* as extracted text. `desktopCss` is everything before `@media (max-width: 1024px)`; `mediaBlock('(max-width: 720px)')` is the phone block. jsdom does no layout, so these regexes are the only guard — when a rule they name is deleted, the test must be rewritten, never deleted silently.
- Non-obvious code carries a comment explaining the *why*. `ponytail:` comments mark deliberate simplifications and name their ceiling.
- Commit after each task. Never use `git add -A`; stage the exact files listed.
- Out of scope: the fifth misc note (playlist suggestions recommending genres the library already has). It is specced separately as Batch 9 in `issues.md`. Do not touch `src/matching/clusters.ts`.

---

## Task 1: Now-playing indicator

Misc note: *"need some sort of hovering now playing indicator that when you click it auto scrolls you to the songs location on page, something small but like usable"*.

**Files:**
- Modify: `src/components/SongRow.tsx:32`
- Modify: `src/components/SongCard.tsx:46`
- Modify: `src/components/Sorter.tsx` (add a derived const near `sorted`, render an anchor near `<UndoToast>`)
- Modify: `src/index.css` (new `.now-playing` block after `.to-top:hover`, ~line 1128; one addition inside the `@media (max-width: 720px)` block near the existing `.to-top` override, ~line 1586)
- Test: `src/components/Sorter.test.tsx` (append)
- Test: `src/index.css.test.ts:127` (update the `env(safe-area-inset-bottom)` count)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: the DOM id format `track-${track.id}` on every `<li>` in both skins. Task 4 must keep it on `SongCard`'s `<li>`.

- [ ] **Step 1: Write the failing test**

Append to `src/components/Sorter.test.tsx`:

```tsx
it('links the now-playing song to its row so the list can scroll to it', async () => {
  const lib = mockLibrary([track('t1', '2024-01-01'), track('t2', '2024-02-01')]);
  // 0.9 (mockLibrary's default) clears QUICK_MATCH_MIN, which lifts both songs
  // into the Quick Add strip and out of the main list. The anchor points at the
  // row in the list, so score them below that bar.
  lib.matches = new Map(lib.tracks.map((t) => [t.id, {
    best: { playlistId: 'p1', score: 0.5 }, alternates: [], belowThreshold: false,
  }]));
  render(<Sorter settings={settings} lib={lib} />);
  expect(screen.queryByRole('link', { name: /now playing/i })).not.toBeInTheDocument();

  await userEvent.click(screen.getAllByRole('button', { name: 'play' })[0]);

  const link = await screen.findByRole('link', { name: /now playing/i });
  expect(link).toHaveAttribute('href', '#track-t1');
  // The anchor is only usable if the target actually exists in the list.
  expect(document.getElementById('track-t1')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/Sorter.test.tsx -t "now-playing"`
Expected: FAIL — `Unable to find an accessible element with the role "link" and name /now playing/i`.

- [ ] **Step 3: Give both row components a stable DOM id**

In `src/components/SongRow.tsx`, line 32, add the `id`:

```tsx
    <li id={`track-${track.id}`} className={`song-row${compact ? ' compact' : ''}${isPlaying ? ' playing' : ''}`}>
```

In `src/components/SongCard.tsx`, line 46:

```tsx
    <li id={`track-${track.id}`} className={isPlaying ? 'song-card playing' : 'song-card'}>
```

- [ ] **Step 4: Render the indicator in Sorter**

In `src/components/Sorter.tsx`, directly after the `sorted` const (currently line 225-229), add:

```tsx
  // Looked up rather than stored: `playingUri` is the only state playback has,
  // and a song sorted away mid-play is simply not found — the indicator
  // disappears instead of pointing at an id that has left the DOM.
  const playingTrack = playingUri ? lib.tracks.find((t) => t.uri === playingUri) : undefined;
```

Then, inside the returned JSX, immediately before the `{undo && (` block near the end:

```tsx
      {/* A plain anchor, like .to-top in App.tsx: the browser already scrolls to
          a fragment, and `scroll-behavior: smooth` makes it glide. A scroll
          handler here would buy nothing and cost a listener. */}
      {playingTrack && (
        <a
          className="now-playing"
          href={`#track-${playingTrack.id}`}
          aria-label={`Now playing ${playingTrack.name} — scroll to it`}
        >
          <span className="now-playing-icon" aria-hidden="true">▶</span>
          <span className="now-playing-name">{playingTrack.name}</span>
        </a>
      )}
```

- [ ] **Step 5: Style it**

In `src/index.css`, immediately after the `.to-top:hover` rule (currently ends line 1128), add:

```css
/* The now-playing jump link. Mirrors .to-top on the opposite corner and for the
   same reason: it is an <a href="#id">, so the browser owns the scrolling. */
.now-playing {
  position: fixed;
  left: var(--sp-6);
  bottom: calc(var(--sp-6) + env(safe-area-inset-bottom));
  z-index: 2;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  max-width: 240px;
  padding: var(--sp-2) var(--sp-4);
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
  color: var(--text);
  font: 700 13px/1 var(--sans);
  text-decoration: none;
  opacity: 0.85;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
  transition: opacity var(--t), color var(--t), border-color var(--t);
}

.now-playing:hover {
  opacity: 1;
  color: var(--text-h);
  border-color: var(--green);
}

.now-playing-icon { color: var(--green); }

/* A long title must not span the viewport — the pill is a jump link, not a
   now-playing bar. */
.now-playing-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

Inside the `@media (max-width: 720px)` block, immediately after the existing `.to-top { … }` override (currently ends line 1591), add:

```css
  /* Lifted a toast's height clear, exactly like .to-top above: .undo-toast goes
     full-bleed at this width. */
  .now-playing {
    left: var(--sp-3);
    bottom: calc(var(--sp-3) + 56px + env(safe-area-inset-bottom));
    max-width: 55vw;
  }
```

- [ ] **Step 6: Update the safe-area contract test**

`src/index.css.test.ts`, the test at line 127 now counts four fixed elements. Replace it with:

```js
    it('clears the iOS bottom bar for every fixed-position element', () => {
      // the match sheet, the undo toast, the back-to-top button and the
      // now-playing jump link
      expect(block.match(/env\(safe-area-inset-bottom\)/g)).toHaveLength(4);
    });
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run src/components/Sorter.test.tsx src/index.css.test.ts src/components/SongCard.test.tsx src/components/SongRow.test.tsx`
Expected: PASS, all four files.

- [ ] **Step 8: Commit**

```bash
git add src/components/SongRow.tsx src/components/SongCard.tsx src/components/Sorter.tsx src/index.css src/components/Sorter.test.tsx src/index.css.test.ts
git commit -m "feat(sorter): jump link to the song that is playing"
```

---

## Task 2: Header nav flush right

Misc note: *"pill shaped buttons for sorter analyzer settings log out are not right justified and have weird spacing between them"*.

The nav cannot reach the right edge because `.app-header` reserves `padding-right: 140px` to clear the viewport-fixed `.skin-toggle`. The phone breakpoint already solves this by forcing the title full-width so the nav wraps to its own row. Promote that to the base stylesheet and delete the reservation. `h1` is 40px with `--sp-8` above it, so the second row starts ≈90px down — clear of the toggle at `top: var(--sp-3)` (≈32px tall).

**Files:**
- Modify: `src/index.css:216-219` (add `h1` and `nav` rules), `src/index.css:1181-1184` (delete the reservation), `src/index.css:1655-1672` (phone block cleanup)
- Test: `src/index.css.test.ts:102-110` (rewrite against the base sheet)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Write the failing test**

In `src/index.css.test.ts`, replace the whole `it('drops the header reservation once the nav has its own row', …)` test (lines 102-110, inside `describe('phone breakpoint')`) with this pair. The first moves **out** of the phone describe — put it directly above `describe('phone breakpoint', …)`; the second stays inside it:

```js
  it('gives the nav its own row, flush right, instead of reserving space for the fixed toggle', () => {
    // The nav used to share the title's line, so it had to keep 140px clear of
    // the viewport-fixed .skin-toggle — which is exactly what stopped it
    // reaching the right edge. A full-width title drops it to a row of its own,
    // below the toggle, where margin-left:auto can push it flush.
    expect(desktopCss).toMatch(/\.app-header h1\s*\{[^}]*flex:\s*1 0 100%/);
    expect(desktopCss).toMatch(/\.app-header nav\s*\{[^}]*margin-left:\s*auto/);
    expect(desktopCss).not.toMatch(/\.app-header\s*\{[^}]*padding-right:\s*140px/);
  });
```

```js
    it('wraps the nav by whole pills', () => {
      // Without this the nav is a single non-wrapping flex line whose buttons
      // shrink instead, which is what breaks their labels at 390px.
      expect(block).toMatch(/\.app-header nav\s*\{[^}]*flex-wrap:\s*wrap/);
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/index.css.test.ts -t "flush right"`
Expected: FAIL — the `.app-header h1` rule is not in the desktop sheet.

- [ ] **Step 3: Move the rules into the base sheet**

In `src/index.css`, replace the `.app-header nav` rule at lines 216-219 with:

```css
/* The title takes the whole first row, which drops the nav to a row of its own
   below the viewport-fixed .skin-toggle. That is what lets the pills sit flush
   right: sharing the title's line meant reserving 140px of clearance for the
   toggle, and the nav then stopped 140px short of the edge. */
.app-header h1 {
  flex: 1 0 100%;
}

.app-header nav {
  display: flex;
  margin-left: auto;
  gap: var(--sp-2);
}
```

- [ ] **Step 4: Delete the reservation and the now-redundant phone overrides**

Delete lines 1181-1184 of `src/index.css` entirely — comment and rule:

```css
/* Keeps the nav out from under the fixed toggle at every width. */
.app-header {
  padding-right: 140px;
}
```

In the `@media (max-width: 720px)` block, delete the `.app-header { padding-right: 0; }` rule together with its four-line comment, and delete the `.app-header h1 { flex: 1 0 100%; }` rule (currently lines 1655-1666). **Keep** the `.app-header nav { flex-wrap: wrap; }` rule and its comment.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/index.css.test.ts`
Expected: PASS, including `wraps the nav by whole pills` and the untouched `caps the album cover on phones`.

- [ ] **Step 6: Commit**

```bash
git add src/index.css src/index.css.test.ts
git commit -m "fix(header): nav gets its own row, flush right"
```

---

## Task 3: Banana explainer in Settings

Misc note: *"settings page needs an explainer for the banana emoji ranking system"*.

The three-image map currently lives in `SongCard.tsx`. It moves to `src/freshness.ts`, beside `FRESHNESS_LABEL`, so the card and the explainer read the same source and the labels cannot drift.

**Files:**
- Modify: `src/freshness.ts` (add three asset imports and `BANANA_SRC`)
- Modify: `src/components/SongCard.tsx:1-17` (drop the local map, import it)
- Modify: `src/components/Settings.tsx` (new section)
- Modify: `src/index.css` (append a `.ripeness-key` block at the end of the settings section — search for `.dest-grid` and add after that rule group)
- Test: `src/components/Settings.test.tsx` (append)

**Interfaces:**
- Consumes: nothing.
- Produces: `BANANA_SRC: Record<Freshness, string>` exported from `src/freshness.ts`. Task 4 keeps `SongCard` importing it.

- [ ] **Step 1: Write the failing test**

Append to `src/components/Settings.test.tsx`, and add `import { FRESHNESS_LABEL } from '../freshness';` to the imports at the top:

```tsx
it('explains the banana ripeness ranking', () => {
  render(<Settings settings={settings} onChange={vi.fn()} playlists={playlists} error={null} lib={baseLib} />);
  expect(screen.getByRole('heading', { name: /ripeness/i })).toBeInTheDocument();
  // Read from FRESHNESS_LABEL, not retyped: the point of the explainer is that
  // it says exactly what the cards say.
  for (const label of Object.values(FRESHNESS_LABEL)) {
    expect(screen.getByText(label)).toBeInTheDocument();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/Settings.test.tsx -t "ripeness"`
Expected: FAIL — no heading matching `/ripeness/i`.

- [ ] **Step 3: Move the banana map into `freshness.ts`**

At the top of `src/freshness.ts`, above the existing doc comment, add:

```ts
import bananaUnripe from './assets/banana-unripe.png';
import bananaStable from './assets/banana-stable.png';
import bananaStale from './assets/banana-stale.png';
```

Then, directly after the `FRESHNESS_LABEL` const (currently ends line 18), add:

```ts
/** Three drawn bananas rather than one emoji re-tinted by CSS filters: the
 *  ripeness stages differ by their brown spotting, which no hue-rotate on a
 *  clean yellow emoji can fake. Imported (not /public) so Vite hashes them.
 *  Lives here, not in SongCard, so the Settings explainer and the cards cannot
 *  drift apart. */
export const BANANA_SRC: Record<Freshness, string> = {
  unripe: bananaUnripe,
  stable: bananaStable,
  stale: bananaStale,
};
```

- [ ] **Step 4: Point SongCard at it**

In `src/components/SongCard.tsx`, delete lines 6-17 (the three `banana*` imports, the comment, and the local `BANANA` const), and change the `freshness` import on line 3 to:

```tsx
import { BANANA_SRC, FRESHNESS_LABEL, freshnessOf, type Freshness, type FreshnessScale } from '../freshness';
```

Then, in the JSX, change `src={BANANA[fresh]}` to `src={BANANA_SRC[fresh]}`.

If TypeScript then reports `Freshness` as unused in this file, drop it from that import list — nothing else in `SongCard.tsx` references the type once the local map is gone.

- [ ] **Step 5: Add the Settings section**

In `src/components/Settings.tsx`, add to the imports at the top:

```tsx
import { BANANA_SRC, FRESHNESS_LABEL, type Freshness } from '../freshness';
```

And insert this block in the returned JSX, immediately after the closing `</div>` of `.dest-grid` and before the `{import.meta.env.DEV && (` block:

```tsx
      <h2>Ripeness</h2>
      <p>
        Every song carries a banana for how long it has been sitting in Liked. The three stages
        are thirds of your own library’s span, oldest to newest — so they mean the same thing
        whatever your library looks like.
      </p>
      <ul className="ripeness-key">
        {(['unripe', 'stable', 'stale'] as Freshness[]).map((f) => (
          <li key={f}>
            {/* alt="" on purpose: the label beside it is the same words, and a
                screen reader reading them twice is worse than not at all. */}
            <img className="banana" src={BANANA_SRC[f]} alt="" />
            <span>{FRESHNESS_LABEL[f]}</span>
          </li>
        ))}
      </ul>
```

- [ ] **Step 6: Style the key**

In `src/index.css`, after the `.dest-grid` rule group, add:

```css
/* The ripeness key: one row per stage, the picture beside the label that
   actually carries the meaning. list-style is reset here because the global
   reset is scoped to .song-list. */
.ripeness-key {
  list-style: none;
  margin: var(--sp-3) 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.ripeness-key li {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  font-size: 13px;
  color: var(--text-dim);
}
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run src/components/Settings.test.tsx src/components/SongCard.test.tsx src/freshness.test.ts`
Expected: PASS, all three. `SongCard.test.tsx`'s `labels the banana so the ranking is not colour-only` proves the card still renders the right image.

- [ ] **Step 8: Commit**

```bash
git add src/freshness.ts src/components/SongCard.tsx src/components/Settings.tsx src/index.css src/components/Settings.test.tsx
git commit -m "feat(settings): explain the banana ripeness ranking"
```

---

## Task 4: Gallery card — equal covers, centred card, middle control cluster

Three misc notes, one layout:

> - size of playlist cover art still is not same size as song cover art in the gallery view
> - each rectangle containing song match reccomendations is not centered on the page in gallery view
> - add, x, play, and the song age need to be in the middle of the two cover arts

Target shape:

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
         ^ centred on the page, capped at 880px
```

**Why the covers end up equal:** the card's tracks are `X | MID | X`. `.match-panel`
spans the last two (`MID + gap + X`) and restates `grid-template-columns:
var(--gallery-mid) minmax(0, 1fr)` with the **same gap**, so its `1fr` resolves to
exactly `X`. Both covers are `width: 100%; aspect-ratio: 1` inside an `X`-wide
track. A different gap inside the panel silently breaks the equality — that is
what the new contract test guards.

**Why `midSlot` instead of lifting state:** the Add button is the only thing that
knows `effectiveChosen` (selection, minus ids that no longer exist, minus
playlists the song is already in). Moving Add out of `MatchPicker` would mean
lifting that logic into `SongCard`; passing the card's middle cluster *down*
costs one optional prop and moves no state.

**Files:**
- Modify: `src/components/MatchPicker.tsx` (new `midSlot` prop; restructure the `panel` branch, lines 163-228)
- Modify: `src/components/SongCard.tsx` (build `midSlot`, drop the `.card-match` wrapper)
- Modify: `src/index.css:1230-1400` (the gallery block) and the `@media (max-width: 720px)` gallery overrides (~lines 1640-1653)
- Modify: `src/index.css` `:root` token block (~line 23) — add `--gallery-mid`
- Test: `src/components/SongCard.test.tsx` (append one test)
- Test: `src/index.css.test.ts:187-211` (`describe('gallery skin')`) and one addition to the phone describe

**Interfaces:**
- Consumes: `id={`track-${track.id}`}` on `SongCard`'s `<li>` (Task 1) and `BANANA_SRC` from `src/freshness.ts` (Task 3). Keep both.
- Produces: `MatchPicker` prop `midSlot?: ReactNode` — rendered by the `panel` layout only, wrapped in `<div className="panel-mid">` together with the Add button. The `pill` layout ignores it.

- [ ] **Step 1: Write the failing test**

Append to `src/components/SongCard.test.tsx`:

```tsx
it('puts the date, play, add and remove in one cluster between the two covers', () => {
  const { container } = renderCard();
  // The containment *is* the requirement: these four controls live between the
  // album cover and the playlist cover, not at the card's right edge.
  const mid = container.querySelector('.panel-mid');
  expect(mid).not.toBeNull();
  expect(mid).toContainElement(screen.getByRole('img', { name: 'Settled in' }));
  expect(mid).toContainElement(screen.getByRole('button', { name: 'play' }));
  expect(mid).toContainElement(screen.getByRole('button', { name: /^add$/i }));
  expect(mid).toContainElement(screen.getByTitle(/remove from liked songs/i));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/SongCard.test.tsx -t "one cluster"`
Expected: FAIL — `expect(received).not.toBeNull()`, there is no `.panel-mid`.

- [ ] **Step 3: Add the `midSlot` prop to MatchPicker**

In `src/components/MatchPicker.tsx`, add `ReactNode` to the react import on line 1:

```tsx
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
```

Add to the `Props` interface, after `playlistImages`:

```tsx
  /** Panel layout only: the card's middle cluster (date, play, ✕). Rendered
   *  above this component's own Add button, in the track between the two cover
   *  arts. Passed down rather than lifted out, because Add is the only control
   *  that knows which of the selected playlists are actually addable. */
  midSlot?: ReactNode;
```

And to the destructured parameter list on line 22:

```tsx
  { match, playlistNames, onAdd, alreadyIn, layout = 'pill', playlistImages, midSlot }: Props,
```

- [ ] **Step 4: Restructure the panel branch**

Replace the whole `if (layout === 'panel') { … }` block (lines 163-228) with:

```tsx
  if (layout === 'panel') {
    return (
      // Two of the card's three grid tracks, restated — see .match-panel in
      // index.css for why that is what makes the two covers the same size.
      <div className="match-panel">
        <div className="panel-mid">
          {midSlot}
          {addButton}
        </div>
        <div className="panel-cover">
          {best ? (
            // The cover *is* the match's identity in this skin, so it is the
            // clickable thing — the name/percent shrinks to a caption below.
            <a
              className="cover-link"
              href={`https://open.spotify.com/playlist/${best.playlistId}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <CoverArt
                src={playlistImages?.get(best.playlistId) ?? null}
                name={nameOf(best.playlistId)}
                className="cover-md"
              />
              <span className="sr-only">{nameOf(best.playlistId)}</span>
            </a>
          ) : (
            <CoverArt src={null} name="" className="cover-md" />
          )}
        </div>
        <p className={match.belowThreshold ? 'panel-caption panel-caption-dim' : 'panel-caption'}>
          {pillLabel}
        </p>
        {/* Same `open` state the popover uses — this is the card's "show more",
            just owned by the component that already tracks it. */}
        <button className="panel-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? 'hide' : 'show more'}
        </button>
        {open && (
          <div className="panel-body">
            <div className="cand-tiles">
              {candidates.map((c) => (
                <label
                  key={c.playlistId}
                  className={isDupe(c.playlistId) ? 'cand-tile is-dupe' : 'cand-tile'}
                  title={isDupe(c.playlistId) ? 'Already in this playlist' : undefined}
                >
                  <input
                    type="checkbox"
                    checked={chosen.has(c.playlistId) && !isDupe(c.playlistId)}
                    disabled={isDupe(c.playlistId)}
                    onChange={() => toggle(c.playlistId)}
                  />
                  <CoverArt
                    src={playlistImages?.get(c.playlistId) ?? null}
                    name={nameOf(c.playlistId)}
                    className="cover-sm"
                  />
                  <span className="cand-name">{nameOf(c.playlistId)}</span>
                  <span className="cand-pct">
                    {isDupe(c.playlistId) ? 'in ✓' : `${pct(c.score)}%`}
                  </span>
                </label>
              ))}
            </div>
            {browseSection}
          </div>
        )}
      </div>
    );
  }
```

The only changes from the previous version: `.panel-head` is gone, `.panel-mid`
is new and holds `midSlot` + Add, and the cover is wrapped in `.panel-cover` so
one selector can place it whether or not there is a best match.

- [ ] **Step 5: Restructure SongCard**

In `src/components/SongCard.tsx`, replace everything from `const fresh =` through the end of the returned JSX with:

```tsx
  const fresh = freshnessOf(track.addedAt, scale);
  const freshLabel = FRESHNESS_LABEL[fresh];

  // Handed to MatchPicker rather than rendered here. The request is that the
  // date, play, Add and ✕ all sit between the two cover arts; Add belongs to
  // the picker (only it knows which selections are addable), so the cluster
  // goes down to the picker instead of the picker's button coming up here.
  const midSlot = (
    <>
      {/* The banana IS the date control: it carries the ranking at a glance
          and the exact date rides underneath it, revealed on hover/focus.
          tabIndex so that reveal is reachable without a pointer; the text
          stays in the DOM at opacity 0, so screen readers always get it. */}
      <span className="card-date" tabIndex={0}>
        {/* alt/title, not just a picture: green, yellow and brown bananas
            are a colour-only signal on their own. */}
        <img
          className="banana"
          src={BANANA_SRC[fresh]}
          alt={freshLabel}
          title={`${freshLabel} · added ${track.addedAt.slice(0, 10)}`}
        />
        <span className="date-text">{track.addedAt.slice(0, 10)}</span>
      </span>
      <button
        className={'play-btn round' + (loading ? ' spin' : '')}
        aria-label={isPlaying ? 'pause' : 'play'}
        onClick={() => onPlay(track.uri)}
        disabled={pending}
      >
        {loading ? '' : (isPlaying ? '⏸' : '▶')}
      </button>
      <button className="remove-btn" title="Remove from Liked Songs" onClick={() => onAdd(track, [])}>
        ✕
      </button>
    </>
  );

  return (
    <li id={`track-${track.id}`} className={isPlaying ? 'song-card playing' : 'song-card'}>
      <div className="card-song">
        <a
          className="song-name"
          href={`https://open.spotify.com/track/${track.id}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          {track.name}
        </a>
        <CoverArt src={track.albumArt} name={track.name} className="cover-lg" />
        <span className="card-artists">{track.artists.map((a) => a.name).join(', ')}</span>
        <span className="card-year">{track.releaseYear ?? '—'}</span>
      </div>

      {/* While pending there is no picker to host the cluster, but the play
          button and ✕ must not vanish — so the card puts up the same two grid
          tracks itself, with a skeleton where the match will land. */}
      {pending ? (
        <div className="match-panel">
          <div className="panel-mid">{midSlot}</div>
          <span className="match-skeleton" aria-hidden="true" />
        </div>
      ) : (
        <MatchPicker
          layout="panel"
          match={match}
          playlistNames={playlistNames}
          playlistImages={playlistImages}
          onAdd={(ids) => onAdd(track, ids)}
          alreadyIn={(pid) => membership.get(pid)?.has(track.id) ?? false}
          midSlot={midSlot}
        />
      )}
    </li>
  );
```

- [ ] **Step 6: Rewrite the gallery CSS**

In `src/index.css`, add the new token to the `:root` block, after `--sp-12: 48px;`:

```css
  /* The gallery card's middle track: wide enough for "Add to 3 playlists" at
     13px/700 plus its pill padding. Restated by .match-panel — see there. */
  --gallery-mid: 160px;
```

Replace the `.song-card` rule (lines 1230-1251) with:

```css
.song-card {
  display: grid;
  /* Capped and centred. The two flanking tracks are what make the album cover
     and the playlist cover the same size at every width — see .match-panel. */
  max-width: 880px;
  margin-inline: auto;
  box-sizing: border-box; /* or the 48px of padding lands outside the cap */
  grid-template-columns: minmax(0, 1fr) var(--gallery-mid) minmax(0, 1fr);
  gap: var(--sp-6);
  /* ponytail: centred, not baseline-matched. The song name sits above one cover
     and nothing above the other, so the two are level only to within half that
     line. The exact fix is a magic offset that breaks the moment a title wraps
     to two lines — take the approximation. */
  align-items: center;
  padding: var(--sp-6);
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface);
  transition: background-color var(--t), box-shadow var(--t);
}
```

Replace the `.card-mid` rule (lines 1294-1299) with nothing — it is superseded by `.panel-mid` below. Keep `.card-date`, `.date-text`, the `:hover/:focus-within` pair, `.play-btn.round` and `.banana` exactly as they are.

Replace the whole block from `/* --- inline match panel (gallery) --- */` through the `.panel-head .cover-md.cover-empty` rule (lines 1338-1377) with:

```css
/* --- inline match panel (gallery) ---
   The card is one grid of X | MID | X. This panel spans the last two tracks and
   restates them, so its own `1fr` resolves to exactly X — which is what makes
   the playlist cover the same size as the album cover, at every width, with no
   shared pixel constant to keep in sync. The gap MUST match .song-card's: a
   different one here shifts the inner track and the covers drift apart again. */
.match-panel {
  grid-column: 2 / 4;
  display: grid;
  grid-template-columns: var(--gallery-mid) minmax(0, 1fr);
  gap: var(--sp-6);
  align-items: start;
  min-width: 0;
}

/* Everything the user acts on, stacked between the two covers: the date, play,
   Add and ✕. Spans the cover/caption/toggle rows so it centres against the
   cover rather than against the cover alone. */
.panel-mid {
  grid-column: 1;
  grid-row: 1 / 4;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--sp-3);
}

.panel-cover {
  grid-column: 2;
  grid-row: 1;
  min-width: 0;
}

/* Fills its track, like .card-song .cover-lg does on the other side. This is
   the pair that used to be 260px against a hard 160px. */
.panel-cover .cover-link,
.panel-cover .cover-md {
  width: 100%;
  height: auto;
  aspect-ratio: 1;
}

.panel-cover .cover-md.cover-empty { font-size: 48px; }

/* The pending skeleton stands in for the cover, so it takes the cover's cell. */
.match-panel > .match-skeleton { grid-column: 2; }

.panel-caption {
  grid-column: 2;
  grid-row: 2;
  margin: 0;
  font-size: 13px;
  color: var(--text);
}
```

Then, in the existing `.panel-toggle` rule (line 1394), add the placement at the top of the declaration list:

```css
.panel-toggle {
  grid-column: 2;
  grid-row: 3;
  justify-self: start;
  font-size: 12px;
  border-color: transparent;
  color: var(--text-dim);
  margin-left: calc(var(--sp-4) * -1);
}
```

And in the existing `.panel-body` rule (line 1401), add the placement at the top of the declaration list, keeping every declaration it already has:

```css
.panel-body {
  grid-column: 1 / -1;
  grid-row: 4;
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  width: 100%;
  padding-top: var(--sp-2);
  border-top: 1px solid var(--border);
  animation: rise 120ms ease-out;
}
```

- [ ] **Step 7: Update the phone overrides**

In the `@media (max-width: 720px)` block, replace the `.card-mid` rule (lines 1646-1649) with:

```css
  /* The card is one column here, so the panel's two-track grid and its explicit
     row/column placements must not survive — they would stack the cover beside
     the caption. Flex column, and the control cluster lies down into a row. */
  .match-panel {
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
  }

  .panel-mid {
    flex-direction: row;
    justify-content: space-between;
    width: 100%;
  }

  /* Same cap and the same reason as .cover-lg below: a 100%-wide square is
     340px at 390px wide, and two of them make the card a screen and a half. */
  .panel-cover .cover-md {
    max-width: 200px;
  }
```

Leave the `.song-card` and `.cover-lg` phone rules exactly as they are.

- [ ] **Step 8: Rewrite the gallery contract tests**

In `src/index.css.test.ts`, inside `describe('gallery skin')`, replace the `it('stretches the panel head across the match column', …)` test (lines 196-204) with:

```js
    it('sizes both gallery covers from equal flanking tracks', () => {
      // The playlist cover was a hard 160px beside a fluid album cover, so they
      // drifted apart at every width. The card's tracks are X | MID | X and the
      // panel spans MID+X restating the same MID and the same gap, so its 1fr
      // resolves to exactly X. A different gap in the panel breaks that
      // silently — hence both gap assertions.
      expect(desktopCss).toMatch(
        /\.song-card\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) var\(--gallery-mid\) minmax\(0, 1fr\)/,
      );
      expect(desktopCss).toMatch(/\.song-card\s*\{[^}]*gap:\s*var\(--sp-6\)/);
      expect(desktopCss).toMatch(
        /\.match-panel\s*\{[^}]*grid-template-columns:\s*var\(--gallery-mid\) minmax\(0, 1fr\)/,
      );
      expect(desktopCss).toMatch(/\.match-panel\s*\{[^}]*gap:\s*var\(--sp-6\)/);
    });

    it('centres the gallery card on the page', () => {
      expect(desktopCss).toMatch(/\.song-card\s*\{[^}]*margin-inline:\s*auto/);
    });
```

And inside `describe('phone breakpoint')`, append:

```js
    it('undoes the two-track match panel', () => {
      // The explicit grid-row/grid-column placements would stack the cover
      // beside the caption once the card is a single column.
      expect(block).toMatch(/\.match-panel\s*\{[^}]*flex-direction:\s*column/);
    });
```

- [ ] **Step 9: Run the full suite**

Run: `npx vitest run`
Expected: PASS, every file. In particular `SongCard.test.tsx`'s `hides the match panel and disables play while pending` must still pass — the pending branch keeps the play button — and `renders the song block, the date box and the match panel` must still see the two covers in album-then-playlist order.

- [ ] **Step 10: Build and lint**

Run: `npm run build && npm run lint`
Expected: `tsc -b` clean, vite build succeeds, oxlint reports no errors.

- [ ] **Step 11: Commit**

```bash
git add src/components/MatchPicker.tsx src/components/SongCard.tsx src/index.css src/components/SongCard.test.tsx src/index.css.test.ts
git commit -m "fix(gallery): equal covers, centred card, controls between them"
```

---

## Final verification (after all four tasks)

- [ ] `npx vitest run` — whole suite green.
- [ ] `npm run build` — clean.
- [ ] `npm run lint` — clean.
- [ ] Manual viewport check, per `CLAUDE.md`. `npm run dev`, open `http://127.0.0.1:5173` (not `localhost` — it resolves to `::1` and breaks auth), devtools at 390×844, and confirm:

  ```js
  document.documentElement.scrollWidth <= document.documentElement.clientWidth
  ```

  is `true`. jsdom does no layout, so nothing above can catch real overflow from the new grid.
- [ ] At ~1440px in the gallery skin, confirm by eye: the card is centred, the two covers are the same size, and the date/play/Add/✕ cluster sits between them.
- [ ] Delete the six closed items from the `# misc notes` list in `docs/superpowers/plans/issues.md`, leaving the playlist-suggestions note (Batch 9) and the closed-folders paragraph. Commit that edit.
