# Genre resolution redesign — deployment plan (written for takeover by a less capable executor)

## Context

Genre resolution today is inconsistent and biases recommendations:

- The default sweep auto-routes to MusicBrainz when Spotify 403s mid-run (`src/genre/resolver.ts:167`), so startup behavior is unpredictable.
- The cache value `source:'none'` conflates "MusicBrainz confirmed nothing" with "we never asked MusicBrainz".
- Deep resolution exists at three different granularities (per-track in MatchPicker, per-playlist in Analyzer, loop-all-playlists in Sorter). Partially deep-resolved playlists have richer fingerprints and get recommended disproportionately (the user's core complaint in `docs/superpowers/plans/issues.md`).
- No UI shows source or coverage — a tester cannot tell how much of the library the Spotify sweep covered.
- The DEV capability probe appears dead (it paginates the whole liked library twice, no busy indicator), and `Settings.tsx` has a Rules-of-Hooks violation.

**User decisions (FIXED — do not deviate, do not re-ask):**
1. Default sweep = **Spotify only**. MusicBrainz NEVER runs automatically, even when Spotify 403s.
2. **One global deep action** (`deepResolveAll`) covering the whole library uniformly. Per-playlist and per-track deep buttons are removed.
3. Coverage UI: Sorter status line + resolve button with time estimate; Analyzer per-playlist "% have genres". No per-song source hints.
4. Fix the probe and the Settings hooks bug.

## Ground rules for the executor

- Work through tasks **in order** (1→8). Each task ends with a test run and a commit. Do not batch commits.
- Test command: `npx vitest run <files>` per task, full `npx vitest run` + `npm run build` + `npm run lint` at the end. There is NO `npm test` script.
- Do NOT touch: `MIN_SPACING_MS` in musicbrainz.ts, the serial MB queue, `spotifyFetch` internals, the matching weights in engine.ts.
- Do NOT refactor beyond what a task specifies. Keep existing comment density; update comments the edits make stale.
- The user (Sasha) sometimes edits files while agents run. **Before every commit, re-run `git diff` on the files you're committing and make sure only your intended changes are present.** If you see unrelated hunks, stop and ask.
- If a test fails and the Failure Playbook (bottom) doesn't cover it, STOP and report rather than improvising a fix.
- Line numbers below are from the plan-time working tree; verify with a quick read before each edit, they may drift a few lines per prior task.

---

## Task 1 — Cache schema v3 + Spotify-only default (resolver)

Files: `src/types.ts`, `src/genre/resolver.ts`, `src/genre/resolver.test.ts`

### 1a. `src/types.ts` line 14 — add the fourth source value

```ts
export interface GenreInfo { genres: string[]; source: 'spotify' | 'musicbrainz' | 'none' | 'unresolved' }
```

Meaning from now on: `'none'` = MB was asked and confirmed nothing (durable). `'unresolved'` = nobody asked MB yet (retryable by a deep run).

### 1b. `src/genre/resolver.ts` — cache keys + migration

Replace lines 5-6:

```ts
const CACHE_KEY = 'kondo:genres:v3';
const V2_KEY = 'kondo:genres:v2';
const V1_KEY = 'kondo:genres:v1';
```

Replace the body of `getCache()` (lines 13-32) with:

```ts
function getCache(): GenreCache {
  if (!cache) {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) {
      cache = JSON.parse(raw) as GenreCache;
    } else {
      const v2 = localStorage.getItem(V2_KEY);
      if (v2) {
        // v2 'none' conflated "MB confirmed nothing" with "never asked MB" —
        // the old fast path wrote 'none' without calling MB at all. Migrate
        // them all to retryable 'unresolved'; a deep run re-confirms real ones.
        cache = Object.fromEntries(
          Object.entries(JSON.parse(v2) as GenreCache).map(([id, i]) => [
            id,
            i.source === 'none' ? ({ genres: [], source: 'unresolved' } as GenreInfo) : i,
          ]),
        );
        // Persist NOW — writeCache's debounced timer only starts on the next
        // resolution; closing the tab before that would lose the migration.
        localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
        localStorage.removeItem(V2_KEY);
      } else {
        // v1 MB entries were resolved by name search, which misses transliterated
        // artists — keep only Spotify-sourced entries, re-resolve the rest via
        // the Spotify-URL lookup.
        const v1 = localStorage.getItem(V1_KEY);
        cache = v1
          ? Object.fromEntries(
              Object.entries(JSON.parse(v1) as GenreCache).filter(([, i]) => i.source === 'spotify'),
            )
          : {};
        localStorage.removeItem(V1_KEY);
      }
    }
  }
  return cache;
}
```

### 1c. `src/genre/resolver.ts` — coverage accessor

Add directly below `cachedGenres` (line 36):

```ts
export interface GenreCoverage { spotify: number; musicbrainz: number; none: number; unresolved: number }

/** Cache-source counts for a set of artist ids. A missing cache entry counts
 *  as 'unresolved' — same retry semantics either way. */
export function genreCoverage(ids: string[]): GenreCoverage {
  const c = getCache();
  const out: GenreCoverage = { spotify: 0, musicbrainz: 0, none: 0, unresolved: 0 };
  for (const id of ids) out[c[id]?.source ?? 'unresolved'] += 1;
  return out;
}
```

### 1d. `src/genre/resolver.ts` — delete the dead single-artist path

Delete `resolveArtistGenres` entirely (lines 61-88). It has zero production callers (verified by grep) and always falls through to MB, violating the new "MB never automatic" invariant. Change line 2's import to:

```ts
import { lookupGenresBulk } from '../api/musicbrainz';
```

Also update the comment above `resolveAllGenres` (lines 92-96) which references `resolveArtistGenres` — reword to "Orchestrates the cache -> Spotify -> (optional deep) MusicBrainz waterfall for a whole library at once: …".

### 1e. `src/genre/resolver.ts` — deep retry condition (Phase A)

Line 110-112, replace:

```ts
    // A deep run re-tries anything the fast pass gave up on (cached as []) —
    // that's the whole point of "deeper search".
    if (cached && !(opts.deep && cached.genres.length === 0)) {
```

with:

```ts
    // A deep run re-tries only 'unresolved' (never asked MB). A durable 'none'
    // (MB confirmed nothing) is NOT retried — that's the distinction the two
    // source values exist for.
    if (cached && !(opts.deep && cached.source === 'unresolved')) {
```

### 1f. `src/genre/resolver.ts` — Phase C: MB only when deep

Replace the whole `if (forBulk.length > 0)` block's decision logic (lines 159-194) with:

```ts
  if (forBulk.length > 0) {
    // Default (non-deep) runs NEVER call MusicBrainz — not even when Spotify
    // genre access is revoked (403). Misses are cached as retryable
    // 'unresolved'; the user triggers the MB pass explicitly (deepResolveAll),
    // which is the only place nameSearch runs.
    if (opts.deep) {
      // onResult forwards straight to sink — chunk results land (and get
      // reported) well before the whole bulk call returns, which is what makes
      // a mid-run partial flush possible during the (usually long) MB phase.
      const mbResults = await lookupGenresBulk(forBulk, (done) => {
        onProgress(resolved + done, total);
      }, sink, { nameSearch: true });
      for (const a of forBulk) {
        const genres = mbResults.get(a.id);
        result.set(a.id, genres ?? []);
        // Absent from the map = a transient chunk/search failure, not a real
        // "MB has nothing" — leave it uncached so the next run retries it.
        if (genres === undefined) continue;
        const info: GenreInfo = genres.length > 0
          ? { genres, source: 'musicbrainz' }
          : { genres: [], source: 'none' };
        writeCache(a.id, info);
      }
    } else {
      for (const a of forBulk) {
        result.set(a.id, []);
        writeCache(a.id, { genres: [], source: 'unresolved' });
        resolved += 1;
        onProgress(resolved, total);
        sink?.(a.id, []);
      }
    }
  }
```

(The only semantic changes vs today: condition drops `|| !spotifyGenresAvailable`, `nameSearch` becomes literally `true` since we're inside `opts.deep`, and the else-branch writes `'unresolved'` instead of `'none'`. `spotifyGenresAvailable` keeps gating Phase B untouched.)

### 1g. `src/genre/resolver.test.ts` — test updates

Read the file first. Then:

1. **Delete** the `resolveArtistGenres` describe/tests (approx. lines 21-79) and its import. Any later test that used `resolveArtistGenres` to pre-warm the cache must warm it via `resolveAllGenres([artist], () => {})` with the same mocks instead.
2. **Flip the mid-run-403 test** (approx. line 153): previously it asserted the remainder of the run routed to `lookupGenresBulk`. New expectations: `lookupGenresBulk` is **not** called; every artist Spotify didn't resolve ends with cache `source:'unresolved'` (assert via `genreCoverage`), and the run still completes with `result` entries `[]` for them.
3. **Fast-route tests** (approx. lines 226-253): misses are cached `'unresolved'` not `'none'`; deep runs retry them (existing assertion, condition changed underneath — should still pass).
4. **New test — deep does not retry 'none':** seed the cache by running a deep run where the `lookupGenresBulk` mock returns `new Map([['a1', []]])` (→ cached `'none'`), then run deep again with a fresh spy; assert `lookupGenresBulk` was not called the second time (cache hit short-circuits).
5. **New test — v2→v3 migration:** in the test body (after `resetResolverForTests()`), `localStorage.setItem('kondo:genres:v2', JSON.stringify({ a1: { genres: [], source: 'none' }, a2: { genres: ['rock'], source: 'spotify' } }))`; trigger any cache read (e.g. `cachedGenres('a1')`); assert `localStorage.getItem('kondo:genres:v3')` parses with `a1.source === 'unresolved'`, `a2` unchanged, and `localStorage.getItem('kondo:genres:v2') === null`. **Immediately**, without waiting on timers.
6. **New test — genreCoverage:** seed via runs or direct localStorage v3, assert counts, and that an id absent from the cache counts as `unresolved`.

> Vitest/jsdom note: localStorage persists between tests in a file. The existing `beforeEach` should already call `resetResolverForTests()` and clear storage — if the migration test flakes on ordering, add `localStorage.clear()` to `beforeEach`.

### 1h. Verify + commit

```
npx vitest run src/genre/resolver.test.ts
git add src/types.ts src/genre/resolver.ts src/genre/resolver.test.ts
git commit -m "feat(genre): v3 cache with 'unresolved' source; MB never runs in default sweep"
```

---

## Task 2 — MusicBrainz dead-code removal

Files: `src/api/musicbrainz.ts`, `src/api/musicbrainz.test.ts`

1. Delete `lookupArtistGenres` (lines 76-87). Its only caller was `resolveArtistGenres`, deleted in Task 1. Keep `mbidFromSpotify` and `mbidFromSearch` — `lookupGenresBulk` uses them.
2. Line ~137 has a comment "search (existing, serial — `lookupArtistGenres` above is unchanged)." — delete or reword that clause.
3. In `src/api/musicbrainz.test.ts`, delete tests that call `lookupArtistGenres` (approx. lines 56-93) and its import if named.
4. If deleting it orphans a helper that is now unused, `npm run lint` will flag it — remove only what lint flags.

```
npx vitest run src/api/musicbrainz.test.ts && npm run lint
git add src/api/musicbrainz.ts src/api/musicbrainz.test.ts
git commit -m "chore(mb): remove dead lookupArtistGenres"
```

---

## Task 3 — Fingerprint `genred` counter (for Analyzer coverage)

Files: `src/matching/engine.ts`, `src/analyzer/broadPlaylists.ts`, their tests

### 3a. `engine.ts`

Add to the `Fingerprint` interface (after `countried`, line 10):

```ts
  genred: number;     // songs that carried ≥1 genre
```

In `buildFingerprint`, add `let genred = 0;` next to `scripted`/`countried` (line 72-73), and change the genre loop (lines 74-77) from:

```ts
    for (const g of new Set(s.genres.map((x) => x.toLowerCase()))) {
      genreCounts.set(g, (genreCounts.get(g) ?? 0) + 1);
    }
```

to:

```ts
    const gset = new Set(s.genres.map((x) => x.toLowerCase()));
    if (gset.size > 0) genred += 1;
    for (const g of gset) {
      genreCounts.set(g, (genreCounts.get(g) ?? 0) + 1);
    }
```

Add `genred` to the return object (line 105-108).

### 3b. `broadPlaylists.ts`

Add to `PlaylistProfile` (line 11-17): `genreCoverage: number; // fraction of tracks with ≥1 genre`.

In `buildPlaylistProfiles`: the insufficient-data early return (line 41) gains `genreCoverage: 0`; the normal return (line 49) gains `genreCoverage: fp.genred / fp.size`.

### 3c. Tests

- `src/matching/engine.test.ts`: any test asserting the full fingerprint shape needs `genred` added; add one assertion that a 3-song build where 2 songs have genres yields `genred === 2`.
- `src/analyzer/broadPlaylists.test.ts`: assert `genreCoverage` on one profile (e.g. 2-of-3 genred → `2/3`) and `0` for insufficient-data.

```
npx vitest run src/matching/engine.test.ts src/analyzer/broadPlaylists.test.ts
git add -A src/matching src/analyzer
git commit -m "feat(matching): count genred tracks per fingerprint; expose per-playlist genre coverage"
```

---

## Task 4 — Hook rework (`useLibrary`)

Files: `src/hooks/useLibrary.ts`, `src/hooks/useLibrary.test.ts`

### 4a. Data plumbing

- `LibraryData` (line 9-15) gains `artists: { id: string; name: string }[];` — the unique artist set enrichment ran over; the coverage line reads it.
- `EMPTY` (line 132-134) gains `artists: [],`.
- `enrichLibrary` (line 32-36): signature becomes

```ts
export async function enrichLibrary(
  { tracks, playlists }: Pick<LibraryData, 'tracks' | 'playlists'>,
  onProgress: (resolved: number, total: number) => void,
  onPartial?: (partial: Pick<LibraryData, 'genresByTrack' | 'fingerprints'>) => void,
  opts: { deep?: boolean } = {},
): Promise<Pick<LibraryData, 'genresByTrack' | 'fingerprints' | 'artists'>> {
```

- Line 105 becomes: `const genresByArtist = await resolveAllGenres([...artists.values()], wrappedProgress, sink, opts);`
- Final return (line 107) becomes: `return { ...buildFrom(genresByArtist), artists: [...artists.values()] };`
- `loadLibrary` (line 110-116) needs no change — the spread already carries `artists` through.

### 4b. Imports (line 4-5)

After deleting the deep functions (4c), `cachedGenres` has no remaining users in this file — drop it. **Keep `buildFingerprint`** (still used by `buildFrom` at line 73) and everything else. New imports:

```ts
import { genreCoverage, resolveAllGenres } from '../genre/resolver';
import { buildFingerprint, langSignals, matchSong, type Fingerprint } from '../matching/engine';
```

(Executor: grep each symbol before removing any import; lint also catches unused ones.)

### 4c. Replace the deep API

Delete `deepResolvePlaylist` (lines 224-252), `deepResolveTrack` (lines 254-271), the `deepStatus` state (line 141), and their entries in `LibraryState` (lines 127-129) and the return object (lines 282-284).

Add state next to `progress` (line 140):

```ts
  const [deepState, setDeepState] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
```

Add callbacks/memo after `restoreTrackLocally` (line 222):

```ts
  // One global deep pass so every fingerprint is built from the same data
  // depth — partial (per-playlist) deep resolution skewed recommendations
  // toward whichever playlists happened to be deep-resolved.
  // ponytail: re-runs enrichLibrary, which re-fetches playlist tracks (seconds)
  // — negligible next to the minutes-long MB phase, and it guarantees the
  // artist set matches startup by construction.
  const deepResolveAll = useCallback(async () => {
    if (deepState === 'running') return;
    setDeepState('running');
    try {
      let lastProgressAt = 0;
      const rest = await enrichLibrary(
        { tracks: data.tracks, playlists: data.playlists },
        (resolved, total) => {
          const now = Date.now();
          if (now - lastProgressAt < 250 && resolved < total) return; // same 4/sec throttle as the load effect
          lastProgressAt = now;
          setProgress({ resolved, total });
        },
        (partial) => setData((d) => ({ ...d, ...partial })),
        { deep: true },
      );
      setData((d) => ({ ...d, ...rest }));
      setDeepState('done');
    } catch {
      setDeepState('error');
    }
  }, [data.tracks, data.playlists, deepState]);

  // Reads the resolver cache, which is updated synchronously before every
  // partial flush replaces genresByTrack — so keying on genresByTrack keeps
  // the counts live during a deep run.
  const coverage = useMemo(
    () => genreCoverage(data.artists.map((a) => a.id)),
    [data.artists, data.genresByTrack],
  );
```

`LibraryState` gains:

```ts
  deepResolveAll(): Promise<void>;
  deepState: 'idle' | 'running' | 'done' | 'error';
  coverage: { spotify: number; musicbrainz: number; none: number; unresolved: number };
```

Return object gains `deepResolveAll, deepState, coverage,`.

### 4d. `src/hooks/useLibrary.test.ts`

- Extend the resolver mock to include the new export: `vi.mock('../genre/resolver', () => ({ resolveAllGenres: vi.fn(), genreCoverage: vi.fn(() => ({ spotify: 0, musicbrainz: 0, none: 0, unresolved: 0 })) }))` — keep `cachedGenres` in the mock only if anything still imports it (it shouldn't).
- Delete the `deepResolvePlaylist` test (approx. lines 135-161, the one titled "deep-resolves a playlist…").
- New test `deepResolveAll re-enriches the whole library deep`: render the hook to `ready`, then change the `resolveAllGenres` mock to return richer genres, `await act(() => result.current.deepResolveAll())`, assert: last `resolveAllGenres` call's 4th arg is `{ deep: true }`; `deepState === 'done'`; fingerprints rebuilt from the new mock data.
- New test error path: make `resolveAllGenres` reject **on the deep call only** (e.g. `mockRejectedValueOnce` queued after ready) → `deepState === 'error'`. Do NOT drive the error via `getPlaylistTracks` — `enrichLibrary` deliberately swallows per-playlist fetch failures.

```
npx vitest run src/hooks/useLibrary.test.ts
git add src/hooks/useLibrary.ts src/hooks/useLibrary.test.ts
git commit -m "feat(library): replace per-playlist/track deep resolve with global deepResolveAll + coverage"
```

> tsc will now fail on components/tests still using `deepStatus` etc. — that's expected until Tasks 5-6. Don't run `npm run build` until after Task 6.

---

## Task 5 — Sorter: status line + single resolve action

Files: `src/components/Sorter.tsx`, `src/components/SongRow.tsx`, `src/components/MatchPicker.tsx`, `src/components/Sorter.test.tsx`, plus `SongRow`/`MatchPicker` tests if they exist, and `src/App.test.tsx`

### 5a. `Sorter.tsx`

- Delete lines 100-101 (`deepRunning`, `deepDone`).
- Add above the component (near `UndoState`):

```ts
// ponytail: worst case — every artist needs the 1.1s serial name search plus
// its share of the 50-per-request bulk phases. Real runs finish sooner.
function mbEstimate(n: number): string {
  const secs = n * 1.1 + Math.ceil(n / 50) * 2 * 1.1;
  return secs < 90 ? '~1 min' : `~${Math.round(secs / 60)} min`;
}
```

- Replace the toolbar deep button block (lines 142-153, including the ponytail comment) with:

```tsx
        {lib.status === 'ready' && (
          <p className="song-count">
            Genres: {lib.coverage.spotify} via Spotify · {lib.coverage.musicbrainz} via MusicBrainz
            {lib.coverage.none > 0 && <> · {lib.coverage.none} none found</>}
            {' · '}
            {lib.coverage.unresolved} unresolved
          </p>
        )}
        {lib.status === 'ready' && lib.coverage.unresolved > 0 && (
          <button
            disabled={lib.deepState === 'running'}
            onClick={() => void lib.deepResolveAll()}
          >
            {lib.deepState === 'running'
              ? `Resolving via MusicBrainz ${lib.progress.resolved}/${lib.progress.total}…`
              : `Resolve ${lib.coverage.unresolved} via MusicBrainz (${mbEstimate(lib.coverage.unresolved)})`}
          </button>
        )}
```

- Below the toolbar, next to the existing `{actionError && …}` line (line 161), add:

```tsx
      {lib.deepState === 'error' && (
        <p role="alert">
          MusicBrainz resolution stopped part-way — everything already resolved is kept.
          Use the resolve button to retry the rest.
        </p>
      )}
```

- In the `SongRow` render (lines 193-210), delete the two lines `deepResolve={…}` and `deepResolving={…}` (204-205).

### 5b. `SongRow.tsx`

Remove `deepResolve` and `deepResolving` from `Props` (lines 15-16), the destructuring (line 19), and the two pass-through props to `MatchPicker` (lines 52-53).

### 5c. `MatchPicker.tsx`

Remove `deepResolve`/`deepResolving` from `Props` (lines 8-9) and destructuring (line 12), and delete the popover button block (lines 102-108, the `{deepResolve && (…)}` div).

### 5d. Tests

- `Sorter.test.tsx`: its mock `LibraryState` object(s) must drop `deepResolvePlaylist`/`deepResolveTrack`/`deepStatus` and gain `artists: []`, `coverage: { spotify: 0, musicbrainz: 0, none: 0, unresolved: 0 }`, `deepState: 'idle' as const`, `deepResolveAll: vi.fn()`. Replace any old deep-button test with three new ones:
  1. status `ready` + coverage `{spotify: 620, musicbrainz: 200, none: 0, unresolved: 180}` → text matching `/620 via Spotify/` and `/180 unresolved/` renders; `/none found/` absent.
  2. click the button whose name matches `/resolve 180 via musicbrainz/i` → `deepResolveAll` called.
  3. coverage with `unresolved: 0` → no button matching `/resolve .* via musicbrainz/i`.
- `App.test.tsx` (approx. lines 25-26) mocks `deepResolvePlaylist`/`deepStatus` — swap for the new fields exactly as in the Sorter fixture.
- `MatchPicker.test.tsx` / `SongRow.test.tsx` / `Sorter.test.tsx` may pass the removed props in fixtures — delete those props. No behavioral assertions exist for them (verified by grep).

```
npx vitest run src/components src/App.test.tsx
git add -A src/components src/App.test.tsx
git commit -m "feat(sorter): genre coverage status line + single global MB resolve action"
```

---

## Task 6 — Analyzer: coverage % instead of buttons

Files: `src/components/Analyzer.tsx`, `src/components/Analyzer.test.tsx`

- `PlaylistCard` (line 24): props become `{ profile }: { profile: PlaylistProfile }`. Delete the deep button (lines 40-47).
- Replace the track-count line (line 39) with:

```tsx
      <p className="playlist-card-count">
        {profile.trackCount} tracks
        {profile.status !== 'insufficient-data' && <> · {pct(profile.genreCoverage)}% have genres</>}
      </p>
```

- Delete the hint `<p className="analyzer-hint">…` (line 80).
- Call site (lines 82-89): `<PlaylistCard key={p.playlistId} profile={p} />`.
- `Analyzer.test.tsx`: delete the deep-click test ("runs a deep resolve for a playlist when its button is clicked"); fix `baseLib` fixture fields exactly as in Task 5d; add an assertion that a card renders text matching `/% have genres/` when its fingerprint has genres.

```
npx vitest run src/components/Analyzer.test.tsx
npm run build   # first full tsc since Task 4 — must be clean now
git add src/components/Analyzer.tsx src/components/Analyzer.test.tsx
git commit -m "feat(analyzer): show per-playlist genre coverage; drop per-playlist deep buttons"
```

If `npm run build` fails here, the error list is your remaining-fixtures todo list — every failure will be a test fixture or component still referencing a removed field. Fix them; do not change the hook API to satisfy old call sites.

---

## Task 7 — DEV probe + Settings hooks fix

Files: `src/dev/probe.ts`, `src/components/Settings.tsx`, `src/components/Login.tsx`

### 7a. `probe.ts`

Replace lines 19-30 (the `getSavedTracks` probe AND the second `getSavedTracks` call) with a single one-page fetch. The Feb-2026 API sometimes nests the track under `item` instead of `track`, so read both:

```ts
  type SavedPage = {
    items?: { track?: SavedTrackLike | null; item?: SavedTrackLike | null }[];
    total?: number;
  };
  type SavedTrackLike = {
    name?: string;
    artists?: { id: string; name: string }[];
    external_ids?: { isrc?: string };
  };
  let firstTrack: SavedTrackLike | null = null;
  await probe('GET /me/tracks?limit=1', async () => {
    const page = await spotifyFetch<SavedPage>('/me/tracks?limit=1');
    firstTrack = page.items?.[0]?.item ?? page.items?.[0]?.track ?? null;
    return { total: page.total, first: firstTrack?.name, isrc: firstTrack?.external_ids?.isrc };
  });

  const artistId = firstTrack?.artists?.[0]?.id;
```

Keep the two `/artists` probes and everything below unchanged. Remove `getSavedTracks` from the import (keep `getArtistGenres`, `spotifyFetch`).

> Note: `firstTrack` is assigned inside the closure — TypeScript may narrow it to `null` at the `artistId` read. If tsc complains, declare it as `let firstTrack = null as SavedTrackLike | null;` — do not restructure further.

### 7b. `Settings.tsx`

1. **Hooks fix:** move line 30 (`const [query, setQuery] = useState('');`) up to line 15, directly under the `probeLines` useState — it currently sits below the early returns at lines 16-17, which is a Rules-of-Hooks violation that crashes when `playlists` flips from null to loaded.
2. **Busy state:** add `const [probing, setProbing] = useState(false);` next to `probeLines`. Replace the button (lines 80-82) with:

```tsx
          <button
            disabled={probing}
            onClick={() => {
              setProbing(true);
              runCapabilityProbe().then(setProbeLines).finally(() => setProbing(false));
            }}
          >
            {probing ? 'Probing…' : 'Run API capability probe'}
          </button>
```

### 7c. `Login.tsx`

Same busy-state treatment for its probe button (lines 33-35), with label `Run API capability probe (needs prior login)`.

```
npx vitest run src/components && npm run lint
git add src/dev/probe.ts src/components/Settings.tsx src/components/Login.tsx
git commit -m "fix(dev): probe fetches one page not the whole library; busy state; Settings hooks-order fix"
```

---

## Task 8 — Full verification

1. `npx vitest run` → all green. `npm run build` → clean. `npm run lint` → clean.
2. `npm run dev` (it pins to `127.0.0.1:5173`; `.env.local` with `VITE_SPOTIFY_CLIENT_ID` must exist — it is per-directory and git-ignored, a fresh worktree won't have it).
3. In the browser, DevTools → Application → Local Storage: delete `kondo:genres:v3` and `kondo:genres:v2` if present. Reload.
4. **Assert zero requests to `musicbrainz.org` in the Network tab during the initial load.** This is the core acceptance criterion.
5. Wait for `ready`: Sorter shows `Genres: X via Spotify · 0 via MusicBrainz · Z unresolved` and the `Resolve Z via MusicBrainz (~N min)` button. Analyzer cards show `% have genres`.
6. Settings → run the probe → it returns within seconds and prints lines. **Record the `GET /artists/{id} genres` line — report it to the user verbatim** (it answers whether Spotify genre access is 403'd).
7. Click the resolve button: MB traffic starts, the count ticks down live, match pills re-rank mid-run, button label shows progress, state ends `done`. If some artists remain unresolved (transient MB failures), the button remains with the smaller count — that is correct behavior, click again to retry.
8. Reload → warm start, no MB traffic, counts stable.
9. Migration check: paste an old-style v2 blob into localStorage (`{"aX":{"genres":[],"source":"none"}}` under `kondo:genres:v2`, after deleting v3), reload, confirm v3 exists with `source:"unresolved"` and v2 is gone.

---

## Foreseen failures & debugging playbook

| Symptom | Likely cause | Fix |
|---|---|---|
| Task 1 tests: migration test passes alone, fails in suite | localStorage leaking between tests | add `localStorage.clear()` to the file's `beforeEach`, keep `resetResolverForTests()` |
| Task 1 tests: 403 test still sees `lookupGenresBulk` called | you edited the else-branch but left `\|\| !spotifyGenresAvailable` in the condition | re-check 1f |
| Task 4/5 tsc: "property 'deepStatus' does not exist" | a component/test fixture not yet updated | the error location IS the todo; update fixture, never re-add the field |
| `deepResolveAll` test hangs | `act()` missing around the await, or the mock never resolves | wrap in `await act(async () => …)`; make sure the deep-call mock resolves |
| Coverage line shows all `unresolved` in the UI while status is `enriching` | expected — `data.artists` only lands at enrich completion; the line is gated on `status === 'ready'` for exactly this reason | not a bug; if the gate was dropped, restore it |
| Coverage counts don't tick during deep run | memo not re-running: `genresByTrack` identity unchanged | ensure partial flushes go through `setData((d) => ({ ...d, ...partial }))` — `buildFrom` always creates a new Map |
| Probe still slow / empty lines | user not logged in (probe needs a token), or `/me/tracks?limit=1` shape differs | log the raw `page` JSON in the probe line; the tolerant `item ?? track` read covers both known shapes |
| StrictMode double-run in dev doubles the enrich | pre-existing behavior, unrelated to this change | leave it alone; the cache makes the second pass cheap |
| MB requests 503 during the deep run | normal — anonymous MB rate-limit pool; client already retries with Retry-After | do nothing; only investigate if the run *stops* (deepState 'error') |
| `deepState` ends `'error'` in manual testing | a thrown non-MB error (auth expiry mid-run is the usual suspect) | check console; if AuthError, that's session expiry — re-login and retry; consider surfacing it in the alert copy but ask the user first |
| Estimate looks absurd (e.g. `~37 min` for a huge unresolved count) | it's honest worst-case | do not "fix" the formula; flag to the user (follow-up question 3) |

## Edge cases (handle exactly as stated)

- **Empty library / zero artists:** coverage is all zeros, `unresolved === 0`, no button renders. No special casing needed — verify it falls out naturally.
- **Zero target playlists selected:** enrich produces no fingerprints; matches populate as `{ best: null }` at ready (existing behavior, see comment at useLibrary.ts:191-200). Coverage line still renders (saved-track artists only). Fine.
- **Spotify 403 at startup:** every artist becomes `'unresolved'`; status line reads `0 via Spotify … N unresolved` — this is the designed behavior, NOT a failure. The resolve button is then the only path to genres.
- **User changes target playlists (Settings) while a deep run is in flight:** the settingsKey effect reloads and both writers race on `setData`. Accept it: the genre cache is global and consistent, so the reload picks up everything the deep run cached; worst case the deep run's final `setData` briefly reflects the old playlist set until reload completes. Do not build cancellation for this — note it as a known limit in the commit message for Task 4 if you like.
- **Deep run leaves `unresolved > 0`:** transient MB chunk failures stay uncached by design. The button re-appearing with a smaller count IS the retry mechanism.
- **`'none'` artists forever excluded:** deep runs never re-ask MB about `'none'`. If MB later adds tags for such an artist, the app won't see it. Accepted ceiling — do not add a force-refresh unless the user asks (follow-up question 2).
- **v1 cache still present (very old install):** unchanged path — Spotify entries kept, rest re-resolved. The latent v1 bug (migration lost if tab closes before first debounced write) is NOT fixed for v1 — only v2→v3 persists immediately. Leave v1 as-is; it's near-extinct.

## Follow-up questions for the user (ask AFTER Task 8, with probe results in hand)

1. **Probe verdict:** "The probe says `GET /artists/{id} genres` → &lt;OK/FAIL&gt;. If it's FAIL (403), every fresh load will show ~everything unresolved and MB is your only genre source — do you want a Settings option to auto-run the MB pass on load for this case, or keep it strictly manual?"
2. **'none' artists:** "Artists MB confirmed as having no tags are never re-checked. Want a rare 'force re-check' escape hatch (e.g. clearing them to unresolved from Settings), or leave it?"
3. **Estimate honesty:** "The button shows worst-case time (every artist name-searched at 1.1s). Real runs are often much faster. Keep worst-case, or switch to a live-updated ETA once the run starts?"
4. **Coverage during enriching:** "The status line only appears at `ready` (artist set isn't final earlier). Want an interim version during enriching too, or is the existing `resolving genres X/Y` progress line enough?"
5. **`the-genre-resoltion-still-linked-hellman.md` and `docs/superpowers/plans/issues.md`:** "Both are addressed by this change (uniform deep resolution removes the over-recommending bias). OK to delete the scratch note and mark the issue done?"
6. **Old plan file:** "`docs/superpowers/plans/2026-07-19-public-launch.md` and the deleted `2026-07-22-implement-issues-plan.md` are in uncommitted state — want those committed/cleaned as part of this branch or left alone?"
