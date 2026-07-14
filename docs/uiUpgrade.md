# UI Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the app to match the hand-drawn sketch (`IMG_2074.jpeg`) and Spotify's design guidelines: dark theme, "Kondo" branding, a proper track table (Song | Artist | Date added | Match), and pill-shaped controls.

**Architecture:** Pure restyle + small copy/markup changes. One rewritten `src/index.css` holds the whole theme (no CSS modules, no styling libs). Components keep their current structure and tests except where the sketch dictates markup/copy changes (Sorter header, SongRow column layout).

**Tech Stack:** React 19 + Vite, plain CSS, vitest + testing-library. Tests run with `npx vitest run` (there is no `npm test` script).

## Global Constraints

- Spotify design guidelines (https://developer.spotify.com/documentation/design):
  - App display name must NOT contain "Spotify" → the visible brand becomes **"Kondo"** (matches the sketch). Repo name is untouched.
  - Font stack: `'Helvetica Neue', Helvetica, Arial, sans-serif`.
  - Do not use Spotify green as the app's brand color for the logo/wordmark. Green is fine for action buttons.
- Color tokens (Spotify-style dark theme, define once in `:root`):
  - `--bg: #121212`, `--surface: #181818`, `--surface-hover: #282828`, `--border: #2a2a2a`
  - `--text: #b3b3b3`, `--text-h: #ffffff`, `--green: #1db954`, `--green-hover: #1ed760`
- No new dependencies. No dark/light toggle — the app is dark-only (`color-scheme: dark`).
- Existing behavior tests must keep passing; only assertions on changed copy get updated.
- Keep `ul`/`li` for the track list (Sorter tests use `getAllByRole('listitem')`).

## Sketch interpretation (locked)

Rotated, the sketch shows:
1. Title **"Kondo"** with a row of small hearts (decorative — skipped, one ♥ glyph next to the count instead).
2. **"400 liked songs"** count and **"old → new"** sort direction.
3. A track table with column headers: **Song | Artist | date added | rec** — "rec" is the recommended-playlist picker drawn as a pill with a dropdown chevron ("rap ∨").
4. The current genres column disappears as a column; genres become small subtext under the song name.

---

### Task 1: Theme foundation

**Files:**
- Modify: `src/index.css` (full rewrite)
- Delete: `src/App.css` (unused Vite template leftovers — nothing imports it)
- Modify: `index.html:7` (page title)

**Interfaces:**
- Produces: CSS custom properties (`--bg`, `--surface`, `--surface-hover`, `--border`, `--text`, `--text-h`, `--green`, `--green-hover`) and utility classes `.pill` and `.pill-green` used by every later task.

- [ ] **Step 1: Verify App.css is unused, then delete it**

Run: `grep -rn "App.css" src index.html || echo "unused"`
Expected: `unused`

```bash
rm src/App.css
```

- [ ] **Step 2: Rewrite `src/index.css`**

Replace the entire file with:

```css
:root {
  --bg: #121212;
  --surface: #181818;
  --surface-hover: #282828;
  --border: #2a2a2a;
  --text: #b3b3b3;
  --text-h: #ffffff;
  --green: #1db954;
  --green-hover: #1ed760;

  --sans: 'Helvetica Neue', Helvetica, Arial, sans-serif;

  font: 15px/1.5 var(--sans);
  color-scheme: dark;
  color: var(--text);
  background: var(--bg);
  -webkit-font-smoothing: antialiased;
}

body {
  margin: 0;
}

#root {
  max-width: 960px;
  margin: 0 auto;
  padding: 0 24px 96px; /* bottom space so the toast never covers the last row */
  text-align: left;
}

h1,
h2 {
  color: var(--text-h);
  font-weight: 700;
  letter-spacing: -0.5px;
}

h1 {
  font-size: 40px;
  margin: 28px 0 8px;
}

h2 {
  font-size: 20px;
  margin: 24px 0 8px;
}

p {
  margin: 0;
}

a {
  color: var(--text-h);
}

/* --- pills: the one button/control shape in the app --- */
.pill,
button {
  font: 700 13px/1 var(--sans);
  color: var(--text-h);
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 8px 14px;
  cursor: pointer;
}

button:hover {
  border-color: var(--text);
  background: var(--surface-hover);
}

button:focus-visible {
  outline: 2px solid var(--text-h);
  outline-offset: 2px;
}

.pill-green,
.pill-green:hover {
  background: var(--green);
  border-color: transparent;
  color: #000;
}

.pill-green:hover {
  background: var(--green-hover);
}

button[aria-pressed='true'] {
  background: var(--text-h);
  border-color: transparent;
  color: #000;
}

select {
  font: 13px/1 var(--sans);
  color: var(--text-h);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 7px 12px;
  max-width: 220px;
}

[role='alert'] {
  color: #f15e6c;
}

/* --- app header --- */
.app-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
}

.app-header nav {
  display: flex;
  gap: 8px;
}

/* --- sorter toolbar: "N liked songs" + sort chip --- */
.sorter-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 16px 0 12px;
}

.song-count {
  color: var(--text-h);
  font-size: 17px;
  font-weight: 700;
}

.song-count .heart {
  color: var(--green);
  margin-right: 6px;
}

/* --- track table (header row + song rows share one grid) --- */
.song-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.song-cols,
.song-row {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(0, 1.2fr) 110px minmax(0, 2fr);
  gap: 16px;
  align-items: center;
  padding: 8px 16px;
}

.song-cols {
  color: var(--text);
  font-size: 12px;
  font-weight: 400;
  text-transform: uppercase;
  letter-spacing: 1px;
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 0;
  background: var(--bg);
}

.song-row {
  border-radius: 6px;
}

.song-row:hover {
  background: var(--surface-hover);
}

.song-title {
  min-width: 0;
}

.song-name {
  display: block;
  color: var(--text-h);
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.song-genres {
  display: block;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.song-artists {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.song-added {
  font-variant-numeric: tabular-nums;
  font-size: 13px;
}

.song-match {
  display: flex;
  align-items: center;
  gap: 8px;
  justify-content: flex-end;
}

.play-btn {
  padding: 6px 10px;
  flex-shrink: 0;
}

/* --- match picker --- */
.match-picker {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.match-picker .badge {
  font-size: 11px;
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 3px 8px;
  white-space: nowrap;
}

.match-picker details {
  position: relative;
}

.match-picker details > div {
  position: absolute;
  right: 0;
  z-index: 1;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  white-space: nowrap;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
}

.match-picker summary {
  cursor: pointer;
  font-size: 12px;
  list-style: none;
}

.match-picker summary::after {
  content: ' ∨';
}

/* --- undo toast --- */
.undo-toast {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 16px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 16px;
  color: var(--text-h);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
  max-width: min(90vw, 640px);
}

/* --- settings --- */
.settings ul {
  list-style: none;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.settings label {
  display: flex;
  align-items: center;
  gap: 8px;
}

input[type='checkbox'],
input[type='range'] {
  accent-color: var(--green);
}
```

- [ ] **Step 3: Update the page title in `index.html`**

```html
<title>Kondo</title>
```

- [ ] **Step 4: Run the whole test suite**

Run: `npx vitest run`
Expected: all tests PASS (this task changes no markup or copy).

- [ ] **Step 5: Visual check**

Run: `npm run dev`, open the app. Expected: dark background, left-aligned layout, pill buttons. (Login screen is enough — no need to auth.)

- [ ] **Step 6: Commit**

```bash
git add -A src/index.css src/App.css index.html
git commit -m "feat: spotify-style dark theme foundation"
```

---

### Task 2: App header, tabs, and login button

**Files:**
- Modify: `src/App.tsx:44-55` (header markup, brand copy)
- Modify: `src/components/Login.tsx:20` (green login button)
- Test: `src/App.test.tsx`

**Interfaces:**
- Consumes: `.app-header`, `.pill-green`, `button[aria-pressed]` styles from Task 1.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the failing test**

Add to `src/App.test.tsx` (the file already imports `render`, `screen`, `expect`, `it` and needs no mocks — `App` renders the Login screen when unauthenticated):

```tsx
it('brands the app as Kondo', () => {
  render(<App />);
  expect(screen.getByRole('heading', { name: 'Kondo' })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run src/App.test.tsx`
Expected: FAIL — heading is "spotifyKondo".

- [ ] **Step 3: Update the header in `src/App.tsx`**

Replace the `<header>` block:

```tsx
<header className="app-header">
  <h1>Kondo</h1>
  {authed && (
    <nav>
      <button aria-pressed={tab === 'sorter'} onClick={() => setTab('sorter')}>Sorter</button>
      <button aria-pressed={tab === 'analyzer'} onClick={() => setTab('analyzer')}>Analyzer</button>
      <button aria-pressed={tab === 'settings'} onClick={() => setTab('settings')}>Settings</button>
      <button onClick={logout}>Log out</button>
    </nav>
  )}
</header>
```

- [ ] **Step 4: Make the login button a green pill in `src/components/Login.tsx`**

```tsx
<button className="pill-green" onClick={login}>Log in with Spotify</button>
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/App.tsx src/App.test.tsx src/components/Login.tsx
git commit -m "feat: Kondo header with tab pills and green login button"
```

---

### Task 3: Sorter toolbar — liked-songs count and sort chip

**Files:**
- Modify: `src/components/Sorter.tsx:97-111`
- Test: `src/components/Sorter.test.tsx:48-56`

**Interfaces:**
- Consumes: `.sorter-toolbar`, `.song-count`, `.heart` styles from Task 1.
- Produces: copy `"{n} liked songs"` — Task 3's test assertion is the contract.

- [ ] **Step 1: Update the copy assertion in `src/components/Sorter.test.tsx`**

In the test `'shows the remaining count and sorts oldest-first by default'`, change:

```tsx
expect(screen.getByText(/2 liked songs/i)).toBeInTheDocument();
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run src/components/Sorter.test.tsx`
Expected: FAIL — copy still says "2 songs remaining in Liked".

- [ ] **Step 3: Restructure the Sorter header into a toolbar**

In `src/components/Sorter.tsx`, replace lines 99-111 (the count `<p>` through the sort `<button>`) with:

```tsx
<div className="sorter-toolbar">
  {lib.status !== 'loading' && (
    <p className="song-count">
      <span className="heart" aria-hidden="true">♥</span>
      {lib.tracks.length} liked songs
    </p>
  )}
  <button onClick={() => setOrder(order === 'oldest' ? 'newest' : 'oldest')}>
    {order === 'oldest' ? 'old → new' : 'new → old'}
  </button>
</div>
{playerError && <p role="alert">{playerError}</p>}
{actionError && <p role="alert">{actionError}</p>}
{lib.status === 'loading' && <p>Loading your liked songs…</p>}
{lib.status === 'enriching' && (
  <p>
    Matching playlists… resolving genres {lib.progress.resolved}/{lib.progress.total}
    {lib.progress.total > 0 && ' (first run is slow; results are cached)'}
  </p>
)}
```

Note: the sort-toggle test queries `/newest/i`, which still matches "new → old"? No — it must match the button *before* clicking, whose label is now `old → new`. The test clicks `getByRole('button', { name: /newest/i })`. Update that query in `src/components/Sorter.test.tsx` (test `'flips the order with the toggle'`) to:

```tsx
await userEvent.click(screen.getByRole('button', { name: 'old → new' }));
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/components/Sorter.test.tsx`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/Sorter.tsx src/components/Sorter.test.tsx
git commit -m "feat: sorter toolbar with liked-songs count and sort chip"
```

---

### Task 4: Track table — column headers and row layout

**Files:**
- Modify: `src/components/SongRow.tsx`
- Modify: `src/components/Sorter.tsx:112-135` (column header row, play-button class)
- Test: `src/components/SongRow.test.tsx` (existing assertions already cover the new markup — verify, don't rewrite)

**Interfaces:**
- Consumes: `.song-cols`, `.song-row`, `.song-title`, `.song-match`, `.play-btn` styles from Task 1.
- Produces: `SongRow` props unchanged (`{ track, genres, matchSlot }`).

- [ ] **Step 1: Restructure `src/components/SongRow.tsx`**

Genres move under the song name (per sketch: columns are Song | Artist | date added | rec):

```tsx
import type { ReactNode } from 'react';
import type { Track } from '../types';

interface Props {
  track: Track;
  genres: string[] | undefined;
  matchSlot: ReactNode;
}

export default function SongRow({ track, genres, matchSlot }: Props) {
  return (
    <li className="song-row">
      <span className="song-title">
        <span className="song-name">{track.name}</span>
        <span className="song-genres">{genres ? genres.join(', ') || '—' : '…'}</span>
      </span>
      <span className="song-artists">{track.artists.map((a) => a.name).join(', ')}</span>
      <span className="song-added">{track.addedAt.slice(0, 10)}</span>
      <span className="song-match">{matchSlot}</span>
    </li>
  );
}
```

- [ ] **Step 2: Add the column header row in `src/components/Sorter.tsx`**

Immediately before `<ul className="song-list">`:

```tsx
<div className="song-cols" aria-hidden="true">
  <span>Song</span>
  <span>Artist</span>
  <span>Date added</span>
  <span>Match</span>
</div>
```

And give the play button its class (line ~121):

```tsx
<button
  className="play-btn"
  aria-label={playingUri === t.uri ? 'pause' : 'play'}
  onClick={() => void handlePlay(t.uri)}
>
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run`
Expected: all PASS — `SongRow.test.tsx` asserts by text content, `Sorter.test.tsx` by `listitem` role; both survive the markup change.

- [ ] **Step 4: Visual check**

Run: `npm run dev`, log in, confirm: 4-column grid aligns header and rows, rows highlight on hover, long names truncate with ellipsis instead of breaking the grid.

- [ ] **Step 5: Commit**

```bash
git add src/components/SongRow.tsx src/components/Sorter.tsx
git commit -m "feat: track table with column headers, genres as subtext"
```

---

### Task 5: MatchPicker pill styling

**Files:**
- Modify: `src/components/MatchPicker.tsx:24-49`
- Test: `src/components/MatchPicker.test.tsx` (behavior unchanged — must still pass untouched)

**Interfaces:**
- Consumes: `.match-picker`, `.badge`, `.pill-green`, select and `details > div` styles from Task 1.
- Produces: nothing new.

- [ ] **Step 1: Apply classes and wrap the checkbox list**

The `details` dropdown needs a positioned wrapper `div` so the checkbox list floats instead of expanding the row:

```tsx
return (
  <span className={match.belowThreshold ? 'match-picker no-match' : 'match-picker'}>
    {match.belowThreshold && <span className="badge">no strong match</span>}
    <select value={current} onChange={(e) => setSelected(e.target.value)}>
      {options.map((o) => (
        <option key={o.playlistId} value={o.playlistId}>
          {nameOf(o.playlistId)} ({Math.round(o.score * 100)}%)
        </option>
      ))}
    </select>
    <button className="pill-green" onClick={() => onAdd([...new Set([current, ...extra])])}>
      Add
    </button>
    <details>
      <summary>multiple</summary>
      <div>
        {options.map((o) => (
          <label key={o.playlistId}>
            <input
              type="checkbox"
              checked={o.playlistId === current || extra.includes(o.playlistId)}
              disabled={o.playlistId === current}
              onChange={() => toggleExtra(o.playlistId)}
            />
            {nameOf(o.playlistId)}
          </label>
        ))}
      </div>
    </details>
  </span>
);
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run src/components/MatchPicker.test.tsx`
Expected: all PASS with no test edits (only classes and a wrapper div changed).

- [ ] **Step 3: Commit**

```bash
git add src/components/MatchPicker.tsx
git commit -m "feat: pill-styled match picker with floating multi-select"
```

---

### Task 6: Settings polish

**Files:**
- Modify: `src/components/Settings.tsx:32`
- Test: `src/components/Settings.test.tsx` (behavior unchanged — must still pass untouched)

**Interfaces:**
- Consumes: `.settings` styles from Task 1.

- [ ] **Step 1: Add the class**

```tsx
<section className="settings">
```

- [ ] **Step 2: Run the full suite**

Run: `npx vitest run`
Expected: all PASS.

- [ ] **Step 3: Final visual pass**

Run: `npm run dev`. Check every screen: Login, Sorter (loading + ready states, undo toast by adding a song, "multiple" dropdown), Settings, tab switching. Confirm against `IMG_2074.jpeg`: title "Kondo", "N liked songs", "old → new" chip, Song/Artist/date-added/match columns, pill dropdown in the match column.

- [ ] **Step 4: Build check and commit**

Run: `npm run build`
Expected: PASS (tsc + vite).

```bash
git add src/components/Settings.tsx
git commit -m "feat: settings styling"
```

---

## Skipped (deliberate, per sketch/YAGNI)

- Decorative hearts row under the title → one ♥ glyph next to the count.
- Album artwork thumbnails: `Track` has no image URL; fetching art means API changes + Spotify artwork rules (rounded corners, attribution). Add later if wanted — it's the biggest visual gap vs. real Spotify.
- Custom dropdown to replace the native `<select>`: native is styled as a pill and keeps keyboard/a11y for free.
- Light theme: dark-only, matching Spotify.
- Spotify logo attribution next to metadata (guidelines ask for it): personal local-only tool, and adding the logo brings the full logo-usage ruleset with it. Add alongside album artwork if this ever becomes public.
