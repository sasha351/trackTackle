# Matching Perf + Sorter UI Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the branch `fix/matching-perf-sorter-ui` — fix the enriching-phase "no candidate playlists" regression, then commit the already-implemented working-tree changes as reviewable slices.

**Architecture:** Almost all code for this branch already exists **uncommitted in the working tree** and passes all 72 tests. Task 1 is the only new code (a TDD bug fix in `useLibrary`). Tasks 2–6 verify and commit the existing work file-by-file in dependency order. Task 7 is final verification.

**Tech Stack:** React 19 + Vite, plain CSS, vitest + testing-library (jsdom, globals on). Tests run with `npx vitest run` (there is no `npm test` script).

## Global Constraints

- **Do not revert or "re-implement" working-tree changes.** The diff is the deliverable; tasks commit it in slices. If a file's content doesn't match what a task describes, stop and report — don't overwrite.
- No new dependencies.
- Test command: `npx vitest run` (focused: `npx vitest run <path>`).
- Commit only the files each task lists. Never `git add -A` / `git add .` — the repo has untracked files that must stay untracked: two `Screenshot *.jpg` files, `docs/bugList.md` (empty), `docs/superpowers/`. (`src/config.test.ts` is also untracked but gets committed in Task 6.)
- Commit messages end with the two footer lines already used on this repo's recent commits (Co-Authored-By + Claude-Session), if your harness provides them.

## Context (why this branch exists)

- July 16 screenshot: app healthy — match pills populated, genres under song names.
- July 17 screenshot: during the "enriching" phase every row shows **"no candidate playlists"** and genres show "…". Root cause: `useLibrary` now computes `matches` in a `useMemo` that runs even while `fingerprints` is still empty, so every track gets a defined match with `best: null`. `MatchPicker` renders "no candidate playlists" for `best: null`, but "…" only for `match === undefined`. Before this branch, `matches` stayed an empty Map until enrichment finished, so rows correctly showed "…".
- The rest of the working tree: cosine genre scoring (multi-tag artists no longer punished), 5 alternates instead of 2, typed `SpotifyApiError` + 403-only resolver disable (a single 404 used to kill Spotify genre lookups for the whole session), parallel saved-tracks paging, threshold slider recomputing matches locally instead of triggering a full reload, progress-tick throttling, memoized `SongRow` with a popover-style `MatchPicker`, wider layout CSS, playback scope fix.

---

### Task 1: Hide matches until enrichment lands (the regression fix — only new code in this plan)

**Files:**
- Modify: `src/hooks/useLibrary.ts:155-165` (the `matches` useMemo)
- Test: `src/hooks/useLibrary.test.ts`

**Interfaces:**
- Consumes: existing `useLibrary(settings)` hook; existing mocks in `useLibrary.test.ts` for `../api/spotify` and `../genre/resolver`.
- Produces: `matches` is an **empty Map** unless `status === 'ready'`. `MatchPicker` already renders "…" for `match === undefined` — no component changes.

- [ ] **Step 1: Write the failing test**

Append to `src/hooks/useLibrary.test.ts`. Add these two imports at the top of the file (the other imports already exist):

```ts
import { renderHook, waitFor } from '@testing-library/react';
import { useLibrary } from './useLibrary';
```

Then append the test:

```ts
it('reports no matches while enriching so rows render the placeholder', async () => {
  vi.mocked(spotify.getSavedTracks).mockResolvedValue([likedTrack]);
  vi.mocked(spotify.getMyPlaylists).mockResolvedValue([
    { id: 'p1', name: 'Trip', trackCount: 1 },
  ]);
  vi.mocked(spotify.getPlaylistTracks).mockResolvedValue([
    { artists: [{ id: 'a1', name: 'Portishead' }], releaseYear: 1994 },
  ]);
  // Hold genre resolution open so the hook sits in 'enriching' until we let go.
  let release!: (v: { genres: string[]; source: 'musicbrainz' }) => void;
  vi.mocked(resolver.resolveArtistGenres).mockReturnValue(
    new Promise((r) => { release = r; }),
  );

  const { result } = renderHook(() =>
    useLibrary({ targetPlaylistIds: ['p1'], threshold: 0.3, sortOrder: 'oldest' }),
  );

  await waitFor(() => expect(result.current.status).toBe('enriching'));
  // Regression guard: with empty fingerprints, a computed match would be
  // { best: null } and every row would say "no candidate playlists".
  // No entry at all → MatchPicker shows its "…" placeholder.
  expect(result.current.matches.get('t1')).toBeUndefined();

  release({ genres: ['trip hop'], source: 'musicbrainz' });
  await waitFor(() => expect(result.current.status).toBe('ready'));
  expect(result.current.matches.get('t1')?.best?.playlistId).toBe('p1');
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run src/hooks/useLibrary.test.ts`
Expected: the new test FAILS on `expect(result.current.matches.get('t1')).toBeUndefined()` — it currently gets `{ best: null, alternates: [], belowThreshold: true }`. The two existing tests still pass.

- [ ] **Step 3: Gate the memo on status**

In `src/hooks/useLibrary.ts`, replace the `matches` useMemo (currently lines 155–165) with:

```ts
  // Threshold-only changes recompute matches locally instead of refetching —
  // the sensitivity slider used to trigger a full reload via settingsKey.
  const matches = useMemo(() => {
    const m = new Map<string, SongMatch>();
    // Until enrichment lands, fingerprints are empty and every match would be
    // { best: null } — rows would say "no candidate playlists" while still
    // loading. No entry → MatchPicker renders its "…" placeholder instead.
    if (status !== 'ready') return m;
    for (const t of data.tracks) {
      m.set(t.id, matchSong(
        { genres: data.genresByTrack.get(t.id) ?? [], releaseYear: t.releaseYear },
        data.fingerprints,
        settings.threshold,
      ));
    }
    return m;
  }, [status, data.tracks, data.fingerprints, data.genresByTrack, settings.threshold]);
```

- [ ] **Step 4: Run the hook tests, then the full suite**

Run: `npx vitest run src/hooks/useLibrary.test.ts`
Expected: 3 tests PASS.

Run: `npx vitest run`
Expected: all tests PASS (74 total).

*(No commit yet — this fix ships inside Task 4's `useLibrary` slice so the file is committed once, whole.)*

---

### Task 2: Commit slice — matching engine (cosine scoring, 5 alternates)

**Files:**
- Commit as-is: `src/matching/engine.ts`, `src/matching/engine.test.ts`

**Interfaces:**
- Produces: `scoreSong` now uses cosine similarity (`dot / (sqrt(genreCount) * fingerprintMagnitude)`) instead of mean-of-weights; `matchSong` returns up to 5 alternates (`ranked.slice(1, 5)`). Later slices (useLibrary, MatchPicker popover) rely on both.

- [ ] **Step 1: Run the engine tests**

Run: `npx vitest run src/matching/engine.test.ts`
Expected: all PASS, including `'scores a song with many tags, only some relevant, above threshold (cosine vs. mean-of-weights)'`.

- [ ] **Step 2: Commit**

```bash
git add src/matching/engine.ts src/matching/engine.test.ts
git commit -m "fix: cosine genre scoring so multi-tag artists match; surface 5 alternates"
```

---

### Task 3: Commit slice — Spotify API errors + resolver + parallel paging

**Files:**
- Commit as-is: `src/api/spotify.ts`, `src/api/endpoints.test.ts`, `src/genre/resolver.ts`, `src/genre/resolver.test.ts`

**Interfaces:**
- Produces: `SpotifyApiError` (exported from `src/api/spotify.ts`, carries `status?: number`); `resolveArtistGenres` disables Spotify genre lookups for the session **only** on a 403 — 404s and 5xx fall back to MusicBrainz per-artist; `getSavedTracks` fetches remaining pages in parallel by offset after page 1.

- [ ] **Step 1: Run the affected tests**

Run: `npx vitest run src/api/endpoints.test.ts src/genre/resolver.test.ts`
Expected: all PASS, including the parallel-paging test and both "does not disable Spotify" tests.

- [ ] **Step 2: Commit**

```bash
git add src/api/spotify.ts src/api/endpoints.test.ts src/genre/resolver.ts src/genre/resolver.test.ts
git commit -m "fix: typed SpotifyApiError, 403-only genre disable, parallel saved-tracks paging"
```

---

### Task 4: Commit slice — useLibrary (threshold recompute, enriching fix, progress throttle)

**Files:**
- Commit as-is (includes Task 1's fix): `src/hooks/useLibrary.ts`, `src/hooks/useLibrary.test.ts`
- Commit as-is: `src/components/Sorter.test.tsx` (its `mockLibrary` gained `fingerprints: new Map()` to match the new `LibraryState`)

**Interfaces:**
- Consumes: `matchSong`/`buildFingerprint` from Task 2's engine.
- Produces: `LibraryData` carries `fingerprints: Map<string, Fingerprint>` instead of `matches`; `LibraryState.matches` is derived in the hook via useMemo (empty until `status === 'ready'`), so threshold changes no longer refetch; progress callbacks are throttled to ~4/sec.

- [ ] **Step 1: Run the affected tests**

Run: `npx vitest run src/hooks/useLibrary.test.ts src/components/Sorter.test.tsx`
Expected: all PASS (including Task 1's new test).

- [ ] **Step 2: Commit**

```bash
git add src/hooks/useLibrary.ts src/hooks/useLibrary.test.ts src/components/Sorter.test.tsx
git commit -m "fix: recompute matches locally on threshold change; no matches shown until enrichment lands"
```

---

### Task 5: Commit slice — Sorter UI (MatchPicker popover, memoized SongRow, layout)

**Files:**
- Commit as-is: `src/components/MatchPicker.tsx`, `src/components/MatchPicker.test.tsx`, `src/components/SongRow.tsx`, `src/components/SongRow.test.tsx`, `src/components/Sorter.tsx`, `src/components/Settings.tsx`, `src/index.css`

**Interfaces:**
- Consumes: `LibraryState.matches`/`fingerprints` shape from Task 4; 5 alternates from Task 2.
- Produces: `SongRow` props are now `{ track, genres, match, playlistNames, onAdd, onPlay, isPlaying }` (memoized; `matchSlot` ReactNode is gone); `MatchPicker` renders a pill button + checkbox popover with score bars ("best guess: …" when below threshold, "Add to N playlists" label); `Sorter` passes stable `useCallback` handlers so memoization holds.

- [ ] **Step 1: Run the component tests**

Run: `npx vitest run src/components/MatchPicker.test.tsx src/components/SongRow.test.tsx src/components/Sorter.test.tsx`
Expected: all PASS.

- [ ] **Step 2: Commit**

```bash
git add src/components/MatchPicker.tsx src/components/MatchPicker.test.tsx src/components/SongRow.tsx src/components/SongRow.test.tsx src/components/Sorter.tsx src/components/Settings.tsx src/index.css
git commit -m "feat: match popover with candidate score bars, memoized rows, wider layout"
```

---

### Task 6: Commit slice — playback scope fix

**Files:**
- Commit as-is: `src/config.ts` (adds `user-modify-playback-state` to `SCOPES` — without it the play REST call 403s even though the SDK device connects)
- Commit as-is: `src/config.test.ts` (currently **untracked** — a regression guard asserting the scope stays in `SCOPES`)

**Interfaces:**
- Produces: nothing other tasks depend on. Note for the user: existing sessions must re-login for the new scope to take effect.

- [ ] **Step 1: Run the scope test**

Run: `npx vitest run src/config.test.ts`
Expected: PASS — `'requests the scope needed to start playback'`.

- [ ] **Step 2: Commit**

```bash
git add src/config.ts src/config.test.ts
git commit -m "fix: request user-modify-playback-state so pressing play starts playback"
```

---

### Task 7: Final verification

**Files:** none modified.

- [ ] **Step 1: Working tree is clean of everything except intentionally-untracked files**

Run: `git status --porcelain`
Expected output — untracked (`??`) entries only: the two `Screenshot *.jpg` files, `docs/bugList.md`, `docs/superpowers/`. No `M` entries (`src/config.test.ts` was committed in Task 6).

- [ ] **Step 2: Full suite + typecheck/build**

Run: `npx vitest run`
Expected: all PASS (74 tests).

Run: `npm run build`
Expected: PASS (tsc + vite).

- [ ] **Step 3: Visual check against the screenshots**

Run: `npm run dev`, log in, and confirm:
- **During enrichment:** rows show "…" in the match column (NOT "no candidate playlists") — this is the Task 1 regression fix, compare the July 17 screenshot (broken state).
- **After enrichment:** match pills with playlist name + %, dashed dim "best guess" pills for below-threshold, popover with checkbox list and score bars — compare the July 16 screenshot (target state).
- Moving the Settings sensitivity slider re-badges rows instantly without a reload.
- Play button starts playback (requires a fresh login for the new scope).

---

## Skipped (deliberate, YAGNI)

- No outside-click/Escape close for the match popover — the toggle button closes it; add if it annoys in daily use.
- No test for the progress throttle timing — it's a render-frequency optimization; the existing progress-order test still pins correctness.
- `docs/bugList.md` is empty and stays untracked — delete it or fill it, its call is the user's.
