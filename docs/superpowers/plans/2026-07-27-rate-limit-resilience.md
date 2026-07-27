# Rate-Limit Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the app tripping Spotify's rate limiter on every mount, and turn a 429 from a dead-end error into a self-healing countdown.

**Architecture:** Three layers. A token bucket in `spotifyFetch` bounds request *rate* (the existing pool bounds only concurrency), with priority so user actions never queue behind a bulk load. A compact `localStorage` snapshot serves the library on a TTL so reloads cost nothing. A persisted rate-limit gate drives a countdown banner, and the load effect re-runs itself when the gate clears.

**Tech Stack:** TypeScript, React 19, Vite, vitest + Testing Library (jsdom), oxlint. Browser-only — no backend.

**Spec:** `docs/superpowers/specs/2026-07-27-rate-limit-resilience-design.md`

## Global Constraints

- Test command is `npx vitest run` — there is **no** `test` script in `package.json`. One file: `npx vitest run src/api/spotify.test.ts`. One test: add `-t "substring"`.
- Lint is `npm run lint` (oxlint). Build is `npm run build` (`tsc -b && vite build`).
- Dev server is `npm run dev`, pinned to `127.0.0.1:5173`. `localhost` resolves to `::1` and breaks Spotify auth.
- Requires `.env.local` with `VITE_SPOTIFY_CLIENT_ID=<id>`. Git-ignored and **per-directory** — a fresh worktree has none and login fails with `client_id=undefined`.
- Tests are colocated `*.test.ts(x)`, jsdom, globals on.
- Modules with session-global state export `reset*ForTests()`. Existing tests call them in `beforeEach`/`afterEach` — every new global added here must be covered by the matching reset function.
- Mark deliberate simplifications with a `ponytail:` comment naming the ceiling.
- Non-obvious code carries a comment explaining the *why* (an API quirk, a race, a StrictMode interaction). This density is load-bearing in this repo; match it.
- The genre cache key is **`kondo:genres:v3`** (`resolver.ts:5`). CLAUDE.md still says v2 — it is out of date; do not follow it.
- New localStorage keys used by this plan: `kondo:ratelimit:v1`, `kondo:library:v1`.
- Feb 2026 API paths stay as they are: `/playlists/{id}/items`, `/me/library`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/api/spotify.ts` (modify) | Token bucket, priority slots, persisted gate, `RateLimitedError`, gate subscription |
| `src/api/spotify.test.ts` (modify) | Governor, priority, gate-persistence tests; two existing tests updated |
| `src/storage/librarySnapshot.ts` (create) | Snapshot read/write/compact/quota-degrade. Knows nothing about React or Spotify |
| `src/storage/librarySnapshot.test.ts` (create) | Round-trip, fingerprint invariance, quota, write-through |
| `src/hooks/useLibrary.ts` (modify) | Serve from snapshot on a TTL, write through on mutation, self-heal, `refresh()` |
| `src/hooks/useLibrary.test.ts` (modify) | Warm-mount-issues-no-requests, stale refetch, rate-limited refresh keeps data |
| `src/hooks/useRateLimit.ts` (create) | Subscribes to the gate; ticks 1s **only** while a penalty is live |
| `src/components/RateLimitBanner.tsx` (create) | Countdown UI |
| `src/components/RateLimitBanner.test.tsx` (create) | Renders countdown, clears at zero |
| `src/components/Sorter.tsx` (modify) | Add-path rollback fix, Refresh button, snapshot age |
| `src/components/Sorter.test.tsx` (modify) | Partial-failure copy, refresh wiring |
| `src/App.tsx` (modify) | Mount the banner; clear the snapshot on logout |
| `src/index.css` (modify) | Banner and snapshot-age styles |

Tasks 1-3 are self-contained inside `spotify.ts`. Task 4 is a standalone storage module. Tasks 5-9 wire them together.

---

## Task 1: Token bucket governor

`MAX_IN_FLIGHT = 6` bounds concurrency, not rate — at ~150ms latency six slots sustain ~40 req/s, which is what a rolling-window limiter punishes. Add a bucket.

**Files:**
- Modify: `src/api/spotify.ts:26-62` (globals + reset), `src/api/spotify.ts:92-94` (the `fetch` call site)
- Test: `src/api/spotify.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: module-private `takeToken(): Promise<void>`; `resetRateLimitForTests()` gains bucket reset. No public signature changes.

- [ ] **Step 1: Write the failing test**

Append to `src/api/spotify.test.ts`:

```ts
it('spaces requests once the burst allowance is spent', async () => {
  vi.useFakeTimers();
  // Reset *after* installing fake timers: the bucket's refill clock is
  // Date.now(), and it was last written under real time.
  resetRateLimitForTests();
  const spy = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

  const all = Promise.all(Array.from({ length: 28 }, () => spotifyFetch('/me')));

  // 1ms of refill is 0.008 tokens — not enough to release a 21st request,
  // but enough to fully drain the microtask queue.
  await vi.advanceTimersByTimeAsync(1);
  expect(spy).toHaveBeenCalledTimes(20); // BUCKET_CAPACITY, then the bucket bites

  await vi.advanceTimersByTimeAsync(1000); // one second at 8/sec
  expect(spy).toHaveBeenCalledTimes(28);

  await vi.runAllTimersAsync();
  await all;
  vi.useRealTimers();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/api/spotify.test.ts -t "spaces requests"`
Expected: FAIL — `expected "fetch" to be called 20 times, but got 28` (nothing throttles the rate today).

- [ ] **Step 3: Write minimal implementation**

In `src/api/spotify.ts`, insert after the `MAX_IN_FLIGHT` block (after line 39):

```ts
// The pool above bounds concurrency; this bounds *rate*. Six slots at ~150ms
// latency sustain ~40 req/s, and Spotify's limiter is a rolling window — the
// pool alone never stopped a full-library mount from tripping it. Capacity
// exceeds the refill rate so a handful of interactive requests after an idle
// stretch still go out instantly.
const REFILL_PER_SEC = 8;
const BUCKET_CAPACITY = 20;
let tokens = BUCKET_CAPACITY;
let lastRefill = Date.now();

function refill(): void {
  const now = Date.now();
  tokens = Math.min(BUCKET_CAPACITY, tokens + ((now - lastRefill) / 1000) * REFILL_PER_SEC);
  lastRefill = now;
}

async function takeToken(): Promise<void> {
  // Re-check after each sleep: several waiters wake together, and only the
  // one that gets to the synchronous decrement first actually spends it.
  for (;;) {
    refill();
    if (tokens >= 1) {
      tokens -= 1;
      return;
    }
    await sleep(Math.ceil(((1 - tokens) / REFILL_PER_SEC) * 1000));
  }
}
```

Extend `resetRateLimitForTests` (line 58-62) to:

```ts
export function resetRateLimitForTests(): void {
  rateLimitedUntil = 0;
  inFlight = 0;
  waiting.length = 0;
  tokens = BUCKET_CAPACITY;
  lastRefill = Date.now();
}
```

In `request()`, take a token immediately before the network call. Replace lines 92-94:

```ts
    let res: Response;
    // Inside the retry loop on purpose: a retry is a real request and must
    // cost a real token, or a 429 storm bypasses the governor entirely.
    await takeToken();
    try {
      res = await fetch(url, { ...init, headers });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/api/spotify.test.ts`
Expected: PASS, all tests in the file including the pre-existing concurrency and 429 tests.

- [ ] **Step 5: Commit**

```bash
git add src/api/spotify.ts src/api/spotify.test.ts
git commit -m "perf(spotify): bound request rate with a token bucket, not just concurrency"
```

---

## Task 2: Priority slots for user actions

FIFO starves the user: an add issued during a load queues behind ~100 background requests — a ~12s wait, which is the reported scenario.

**Files:**
- Modify: `src/api/spotify.ts:41-47` (`acquireSlot`), `:64-71` (`spotifyFetch`), `:252-278` (the four mutating wrappers)
- Test: `src/api/spotify.test.ts`

**Interfaces:**
- Consumes: Task 1's bucket (unchanged by this task).
- Produces: `spotifyFetch<T>(pathOrUrl: string, init?: RequestInit, opts?: { priority?: boolean }): Promise<T>`. The third parameter is optional — every existing call site keeps working untouched.

- [ ] **Step 1: Write the failing test**

Append to `src/api/spotify.test.ts`:

```ts
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

it('lets a user action jump the queue ahead of queued background reads', async () => {
  const started: string[] = [];
  const release: (() => void)[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
    started.push(String(url));
    return new Promise((resolve) => release.push(
      () => resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
    ));
  });

  // Ten background reads: six take slots, four queue. Well under the bucket's
  // 20-token capacity, so only the slot queue is in play here.
  const bg = Array.from({ length: 10 }, (_, i) => spotifyFetch(`/bg${i}`));
  await flush();
  expect(started).toHaveLength(6);

  const urgent = spotifyFetch('/urgent', {}, { priority: true });
  await flush();
  expect(started).toHaveLength(6); // still queued — no slot free yet

  release[0]();
  await flush();
  expect(started[6]).toBe('https://api.spotify.com/v1/urgent'); // ahead of /bg6

  while (release.length) release.pop()!();
  await flush();
  while (release.length) release.pop()!();
  await flush();
  await Promise.all([...bg, urgent]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/api/spotify.test.ts -t "jump the queue"`
Expected: FAIL — either a TypeScript error on the third argument, or `expected '…/bg6' to be '…/urgent'`.

- [ ] **Step 3: Write minimal implementation**

Replace `acquireSlot` (`src/api/spotify.ts:41-47`):

```ts
function acquireSlot(priority: boolean): Promise<void> | undefined {
  if (inFlight < MAX_IN_FLIGHT) {
    inFlight += 1;
    return;
  }
  return new Promise<void>((resolve) => {
    // Only ~6 requests hold slots at once, so a 100-deep background queue is
    // what makes an interactive add wait ten-plus seconds. The token bucket
    // needs no equivalent — it refills continuously, so the longest a
    // priority caller waits there is one token's worth (~125ms).
    if (priority) waiting.unshift(resolve);
    else waiting.push(resolve);
  });
}
```

Replace `spotifyFetch` (`:64-71`):

```ts
export async function spotifyFetch<T>(
  pathOrUrl: string,
  init: RequestInit = {},
  opts: { priority?: boolean } = {},
): Promise<T> {
  await acquireSlot(opts.priority === true);
  try {
    return await request<T>(pathOrUrl, init);
  } finally {
    releaseSlot();
  }
}
```

Mark the four mutating wrappers as priority. Replace `addTracksToPlaylist`, `removeTracksFromPlaylist`, `removeSavedTracks`, and `saveTracks` (`:252-278`) with:

```ts
// The four calls below are user actions, not background traffic — they jump
// the slot queue so a click never waits out a full-library load.
const USER_ACTION = { priority: true };

export async function addTracksToPlaylist(playlistId: string, uris: string[]): Promise<void> {
  await spotifyFetch(`/playlists/${playlistId}/items`, {
    method: 'POST',
    body: JSON.stringify({ uris }),
  }, USER_ACTION);
}

export async function removeTracksFromPlaylist(playlistId: string, uris: string[]): Promise<void> {
  await spotifyFetch(`/playlists/${playlistId}/items`, {
    method: 'DELETE',
    body: JSON.stringify({ items: uris.map((uri) => ({ uri })) }),
  }, USER_ACTION);
}

// Feb 2026 migration: PUT/DELETE /me/tracks became /me/library, addressed by
// URI via query param (max 40 per call — the app only ever sends one).
export async function removeSavedTracks(uris: string[]): Promise<void> {
  await spotifyFetch(`/me/library?uris=${encodeURIComponent(uris.join(','))}`, {
    method: 'DELETE',
  }, USER_ACTION);
}

export async function saveTracks(uris: string[]): Promise<void> {
  await spotifyFetch(`/me/library?uris=${encodeURIComponent(uris.join(','))}`, {
    method: 'PUT',
  }, USER_ACTION);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/api/spotify.test.ts && npm run build`
Expected: PASS, and `tsc -b` clean (proves no call site broke on the new parameter).

- [ ] **Step 5: Commit**

```bash
git add src/api/spotify.ts src/api/spotify.test.ts
git commit -m "perf(spotify): user actions jump the request queue"
```

---

## Task 3: Persisted gate, typed error, subscription

`rateLimitedUntil` is a module variable, so the current advice ("wait a few minutes and reload") wipes the gate and re-fires the whole burst.

**Files:**
- Modify: `src/api/spotify.ts:14-27` (errors + gate), `:58-62` (reset), `:73-145` (`request`)
- Test: `src/api/spotify.test.ts` — one new test, **two existing tests updated**

**Interfaces:**
- Consumes: Tasks 1-2.
- Produces:
  - `export class RateLimitedError extends SpotifyApiError { retryAt: number }`
  - `export function getRateLimitedUntil(): number` — epoch ms, or `0` when not limited
  - `export function subscribeRateLimit(cb: (until: number) => void): () => void` — returns an unsubscribe
  - `MAX_RETRY_AFTER_MS` is **removed**, replaced by `MAX_PARK_MS = 90_000`

- [ ] **Step 1: Write the failing test, and update the two tests this changes**

Append to `src/api/spotify.test.ts`:

```ts
it('remembers the penalty across a reload so a refresh cannot re-stampede', async () => {
  const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response('', { status: 429, headers: { 'Retry-After': '3600' } }),
  );
  await expect(spotifyFetch('/me')).rejects.toBeInstanceOf(RateLimitedError);
  expect(Number(localStorage.getItem('kondo:ratelimit:v1'))).toBeGreaterThan(Date.now());
  expect(spy).toHaveBeenCalledTimes(1);

  // Simulate a reload: module state is wiped, localStorage survives.
  resetRateLimitForTests();
  await expect(spotifyFetch('/me')).rejects.toBeInstanceOf(RateLimitedError);
  expect(spy).toHaveBeenCalledTimes(1); // the reload never reached the network
});

it('notifies subscribers when a penalty starts', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response('', { status: 429, headers: { 'Retry-After': '3600' } }),
  );
  const seen: number[] = [];
  const unsubscribe = subscribeRateLimit((until) => seen.push(until));
  await expect(spotifyFetch('/me')).rejects.toBeInstanceOf(RateLimitedError);
  expect(seen).toHaveLength(1);
  expect(seen[0]).toBeGreaterThan(Date.now());
  unsubscribe();
});
```

Add `RateLimitedError` and `subscribeRateLimit` to the import block at the top of the file (`src/api/spotify.test.ts:2-5`):

```ts
import {
  configureSpotify, spotifyFetch, getAllPages, resetRateLimitForTests,
  getArtistGenresBatch, ARTIST_BATCH, RateLimitedError, subscribeRateLimit,
} from './spotify';
```

Replace the existing test at `src/api/spotify.test.ts:64-69` — it asserted the fail-fast message that this task removes:

```ts
it('reports a long penalty as a typed error carrying the resume time', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response('', { status: 429, headers: { 'Retry-After': '3600' } }),
  );
  const err = await spotifyFetch('/me').catch((e: unknown) => e);
  expect(err).toBeInstanceOf(RateLimitedError);
  expect((err as RateLimitedError).retryAt).toBeGreaterThan(Date.now() + 3599_000);
});
```

The test at `:54-62` ("backs off exponentially…") still passes unchanged — the new message keeps the phrase "rate-limiting this app" and the call count stays 5. **Do not edit it**; if it fails, the message wording drifted and the implementation is wrong.

Finally, `afterEach` must clear the new key. `localStorage.clear()` at `:14` already does, but the ordering matters — confirm `resetRateLimitForTests()` runs *after* `localStorage.clear()` so the next test re-reads an empty gate. It already does at `:16`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/api/spotify.test.ts -t "across a reload"`
Expected: FAIL — `RateLimitedError` is not exported (TypeScript error).

- [ ] **Step 3: Write minimal implementation**

In `src/api/spotify.ts`, after the `SpotifyApiError` class (line 21), add:

```ts
// Distinguishable from a generic API failure so the UI can show the countdown
// banner instead of an error screen, and so useLibrary knows to keep the
// cached library on screen rather than blanking it.
export class RateLimitedError extends SpotifyApiError {
  retryAt: number;
  constructor(retryAt: number) {
    super(
      'Spotify is rate-limiting this app. It resumes on its own — nothing was lost.',
      429,
    );
    this.name = 'RateLimitedError';
    this.retryAt = retryAt;
  }
}
```

Replace the gate block (lines 23-27) with:

```ts
// Spotify rate-limits the whole app, not single requests — when one call gets
// a 429, every in-flight caller must back off too or they stampede and extend
// the penalty. One shared timestamp gates them all.
//
// It lives in localStorage because the penalty outlives the page: a reload
// used to wipe this and immediately re-fire the whole mount burst, which is
// exactly what turns a 30-second cooldown into an hour-long one.
const GATE_KEY = 'kondo:ratelimit:v1';
let rateLimitedUntil = 0;
let gateLoaded = false;
const gateSubscribers = new Set<(until: number) => void>();

// Past this, parking the request is worse than failing it: the caller would
// hang for an hour with no explanation. The UI watches the gate instead.
const MAX_PARK_MS = 90_000;

function loadGate(): number {
  if (!gateLoaded) {
    gateLoaded = true;
    rateLimitedUntil = Number(localStorage.getItem(GATE_KEY)) || 0;
  }
  return rateLimitedUntil;
}

/** Epoch ms the penalty ends, or 0 when there is no live penalty. */
export function getRateLimitedUntil(): number {
  const until = loadGate();
  return until > Date.now() ? until : 0;
}

export function subscribeRateLimit(cb: (until: number) => void): () => void {
  gateSubscribers.add(cb);
  return () => {
    gateSubscribers.delete(cb);
  };
}

function setGate(until: number): void {
  loadGate();
  // Only ever extends. A fresh 429 after the old deadline passed pushes the
  // countdown out rather than making it flap.
  if (until <= rateLimitedUntil) return;
  rateLimitedUntil = until;
  try {
    localStorage.setItem(GATE_KEY, String(until));
  } catch {
    // Storage full — the in-memory gate still holds for this session.
  }
  for (const cb of gateSubscribers) cb(until);
}
```

Delete the old `const MAX_RETRY_AFTER_MS = 60_000;` line.

Extend `resetRateLimitForTests`:

```ts
export function resetRateLimitForTests(): void {
  rateLimitedUntil = 0;
  gateLoaded = false; // forces a re-read of localStorage, i.e. simulates a reload
  gateSubscribers.clear();
  inFlight = 0;
  waiting.length = 0;
  tokens = BUCKET_CAPACITY;
  lastRefill = Date.now();
}
```

In `request()`, replace the gate wait (lines 77-78):

```ts
    const until = getRateLimitedUntil();
    const gateWait = until - Date.now();
    // Park on the gate rather than failing — but only so long. Past the bound
    // the UI's countdown is a better answer than a request that hangs.
    if (gateWait > MAX_PARK_MS) throw new RateLimitedError(until);
    if (gateWait > 0) await sleep(gateWait);
```

Replace the 429 block (lines 102-120):

```ts
    if (res.status === 429) {
      // Spotify omits Access-Control-Expose-Headers, so in a browser
      // Retry-After is unreadable (null) — back off exponentially instead:
      // 1s, 2s, 4s, 8s across the remaining attempts.
      const retryAfter = res.headers.get('Retry-After');
      const retryAfterMs = retryAfter != null
        ? (Number(retryAfter) + 0.5) * 1000
        : 2 ** attempt * 1000;
      setGate(Date.now() + retryAfterMs);
      continue;
    }
```

Replace the loop-exhaustion throw (lines 140-144):

```ts
  throw new RateLimitedError(Math.max(getRateLimitedUntil(), Date.now()));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/api/spotify.test.ts && npm run lint`
Expected: PASS on all tests in the file, lint clean.

- [ ] **Step 5: Commit**

```bash
git add src/api/spotify.ts src/api/spotify.test.ts
git commit -m "fix(spotify): persist the rate-limit gate so a reload cannot re-stampede"
```

---

## Task 4: Library snapshot storage module

**Files:**
- Create: `src/storage/librarySnapshot.ts`
- Test: `src/storage/librarySnapshot.test.ts`

**Deliberate deviation from the spec:** the spec's snapshot shape carries a `userId` to guard
against showing one account's library to the next. This plan drops that field and instead calls
`clearSnapshot()` on both auth exits (Task 6). Same guarantee, and it avoids a second `/me` call
on the cold path — `getMyPlaylists` already spends one internally, so storing `userId` would cost
an extra request on exactly the load this whole plan is trying to make cheaper.

**Interfaces:**
- Consumes: `langSignals` and `buildFingerprint` from `src/matching/engine.ts`; `Playlist`, `PlaylistTrack`, `Track` from `src/types.ts`.
- Produces:
  - `interface CompactItem { a: string[]; y: number | null; s: string | null; c: string | null }`
  - `interface LibrarySnapshot { savedAt: number; tracks: Track[]; playlists: Playlist[]; artistNames: Record<string, string>; items: Record<string, CompactItem[]> }`
  - `const SNAPSHOT_TTL_MS: number`
  - `compactPlaylists(byPlaylist: Map<string, PlaylistTrack[]>): { items: Record<string, CompactItem[]>; artistNames: Record<string, string> }`
  - `readSnapshot(): LibrarySnapshot | null`
  - `isFresh(s: LibrarySnapshot | null, now?: number): boolean`
  - `writeSnapshot(patch: Partial<LibrarySnapshot>): void`
  - `updateSnapshotTracks(fn: (tracks: Track[]) => Track[]): void`
  - `clearSnapshot(): void`
  - `resetSnapshotForTests(): void`

- [ ] **Step 1: Write the failing test**

Create `src/storage/librarySnapshot.test.ts`:

```ts
import { afterEach, expect, it, vi } from 'vitest';
import {
  clearSnapshot, compactPlaylists, isFresh, readSnapshot, resetSnapshotForTests,
  SNAPSHOT_TTL_MS, updateSnapshotTracks, writeSnapshot,
} from './librarySnapshot';
import { buildFingerprint, langSignals } from '../matching/engine';
import type { PlaylistTrack, Track } from '../types';

afterEach(() => {
  localStorage.clear();
  resetSnapshotForTests();
  vi.restoreAllMocks();
});

const track: Track = {
  id: 't1', uri: 'spotify:track:t1', name: 'Glory Box',
  artists: [{ id: 'a1', name: 'Portishead' }],
  albumName: 'Dummy', releaseYear: 1994, isrc: 'GBAAA9400001', addedAt: '2024-01-01T00:00:00Z',
};

const playlistTracks: PlaylistTrack[] = [
  { name: 'Angel', artists: [{ id: 'a2', name: 'Massive Attack' }], releaseYear: 1998, isrc: 'GBAAA9800001' },
  { name: 'Teardrop', artists: [{ id: 'a2', name: 'Massive Attack' }], releaseYear: 1998, isrc: null },
];

it('round-trips a snapshot through localStorage', () => {
  writeSnapshot({ tracks: [track], playlists: [{ id: 'p1', name: 'Trip', trackCount: 2 }] });
  const got = readSnapshot();
  expect(got?.tracks).toEqual([track]);
  expect(got?.playlists[0].name).toBe('Trip');
  expect(got?.items).toEqual({});
});

it('merges patches instead of replacing the whole snapshot', () => {
  writeSnapshot({ tracks: [track] });
  writeSnapshot({ playlists: [{ id: 'p1', name: 'Trip', trackCount: 2 }] });
  expect(readSnapshot()?.tracks).toEqual([track]); // survived the second write
});

// The whole point of CompactItem: it must carry exactly the signal
// buildFingerprint reads, so a cached rebuild is indistinguishable from a
// fetched one. If this drifts, matching silently degrades on warm loads.
it('rebuilds an identical fingerprint from compact items', () => {
  const { items } = compactPlaylists(new Map([['p1', playlistTracks]]));
  const genres = new Map([['a2', ['trip hop']]]);

  const fromRaw = buildFingerprint(playlistTracks.map((pt) => ({
    genres: genres.get(pt.artists[0].id) ?? [],
    releaseYear: pt.releaseYear,
    ...langSignals(pt.name, pt.artists, pt.isrc),
  })));
  const fromCache = buildFingerprint(items.p1.map((it) => ({
    genres: [...new Set(it.a.flatMap((id) => genres.get(id) ?? []))],
    releaseYear: it.y, script: it.s, country: it.c,
  })));

  expect(fromCache).toEqual(fromRaw);
});

it('collects deduped artist names so a deep MusicBrainz run still has them', () => {
  const { artistNames } = compactPlaylists(new Map([['p1', playlistTracks]]));
  expect(artistNames).toEqual({ a2: 'Massive Attack' });
});

it('treats a snapshot older than the TTL as stale', () => {
  writeSnapshot({ tracks: [track] });
  const snap = readSnapshot()!;
  expect(isFresh(snap)).toBe(true);
  expect(isFresh(snap, Date.now() + SNAPSHOT_TTL_MS + 1)).toBe(false);
  expect(isFresh(null)).toBe(false);
});

it('writes through a track removal without resetting the freshness clock', () => {
  writeSnapshot({ tracks: [track] });
  const savedAt = readSnapshot()!.savedAt;
  updateSnapshotTracks((ts) => ts.filter((t) => t.id !== 't1'));
  expect(readSnapshot()?.tracks).toEqual([]);
  // A mutation is not a refresh — bumping savedAt here would let steady
  // sorting postpone a real refetch forever.
  expect(readSnapshot()?.savedAt).toBe(savedAt);
});

it('drops the bulky items on a quota error rather than losing the whole snapshot', () => {
  const real = localStorage.setItem.bind(localStorage);
  let calls = 0;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation((k: string, v: string) => {
    calls += 1;
    if (calls === 1) throw new DOMException('full', 'QuotaExceededError');
    real(k, v);
  });

  const { items, artistNames } = compactPlaylists(new Map([['p1', playlistTracks]]));
  expect(() => writeSnapshot({ tracks: [track], items, artistNames })).not.toThrow();
  expect(readSnapshot()?.tracks).toEqual([track]); // the useful half survived
  expect(readSnapshot()?.items).toEqual({});
});

it('disables itself when even the trimmed snapshot will not fit', () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('full', 'QuotaExceededError');
  });
  expect(() => writeSnapshot({ tracks: [track] })).not.toThrow();
  expect(readSnapshot()).toBeNull();
});

it('clearSnapshot removes it', () => {
  writeSnapshot({ tracks: [track] });
  clearSnapshot();
  expect(readSnapshot()).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/storage/librarySnapshot.test.ts`
Expected: FAIL — `Failed to resolve import "./librarySnapshot"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/storage/librarySnapshot.ts`:

```ts
import { langSignals } from '../matching/engine';
import type { Playlist, PlaylistTrack, Track } from '../types';

const KEY = 'kondo:library:v1';

/** Serve the cached library for this long before refetching. Long enough that
 *  a session's worth of reloads costs nothing; short enough that edits made in
 *  the Spotify app show up the same day. */
export const SNAPSHOT_TTL_MS = 6 * 60 * 60 * 1000;

/** Exactly what buildFingerprint consumes, and nothing else. A playlist item's
 *  track name and ISRC exist only as langSignals input, so we store the derived
 *  script/country instead — lossless for the sole consumer, several times
 *  smaller. Genres come from artist ids via kondo:genres:v3. Saved tracks are
 *  NOT compacted: those get rendered, so they keep every field. */
export interface CompactItem {
  a: string[];      // artist ids
  y: number | null; // release year
  s: string | null; // dominant script
  c: string | null; // ISRC country
}

export interface LibrarySnapshot {
  savedAt: number;
  tracks: Track[];
  playlists: Playlist[];
  artistNames: Record<string, string>;
  items: Record<string, CompactItem[]>;
}

const EMPTY: LibrarySnapshot = {
  savedAt: 0, tracks: [], playlists: [], artistNames: {}, items: {},
};

// Set once localStorage proves it cannot hold even a trimmed snapshot. Trying
// again on every load would just burn a serialize-and-throw per phase.
let disabled = false;

export function resetSnapshotForTests(): void {
  disabled = false;
}

export function compactPlaylists(
  byPlaylist: Map<string, PlaylistTrack[]>,
): { items: Record<string, CompactItem[]>; artistNames: Record<string, string> } {
  const items: Record<string, CompactItem[]> = {};
  // Artists repeat heavily across playlists — deduping them here instead of
  // inlining names per item is most of this cache's size win.
  const artistNames: Record<string, string> = {};
  for (const [playlistId, pts] of byPlaylist) {
    items[playlistId] = pts.map((pt) => {
      for (const a of pt.artists) artistNames[a.id] = a.name;
      const { script, country } = langSignals(pt.name, pt.artists, pt.isrc);
      return { a: pt.artists.map((a) => a.id), y: pt.releaseYear, s: script, c: country };
    });
  }
  return { items, artistNames };
}

export function readSnapshot(): LibrarySnapshot | null {
  const raw = localStorage.getItem(KEY);
  if (!raw) return null;
  try {
    return { ...EMPTY, ...(JSON.parse(raw) as Partial<LibrarySnapshot>) };
  } catch {
    // Corrupt or half-written — a bad cache must never wedge the app.
    localStorage.removeItem(KEY);
    return null;
  }
}

export function isFresh(s: LibrarySnapshot | null, now = Date.now()): boolean {
  return s != null && now - s.savedAt < SNAPSHOT_TTL_MS;
}

function persist(s: LibrarySnapshot): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    try {
      // `items` and `artistNames` are the bulk. Dropping them still leaves the
      // song list loading for free; only fingerprints have to be refetched.
      localStorage.setItem(KEY, JSON.stringify({ ...s, items: {}, artistNames: {} }));
    } catch {
      disabled = true;
      localStorage.removeItem(KEY);
      console.warn('kondo: library snapshot disabled — localStorage is full');
    }
  }
}

/** Merge a patch into the stored snapshot and stamp it fresh. Called once per
 *  load phase, after that phase's fetch succeeded, so an interrupted load never
 *  persists a half-built snapshot. */
export function writeSnapshot(patch: Partial<LibrarySnapshot>): void {
  if (disabled) return;
  persist({ ...EMPTY, ...(readSnapshot() ?? {}), ...patch, savedAt: Date.now() });
}

/** Write-through for local mutations. Without this, a reload inside the TTL
 *  resurrects every song you just sorted — the one way this cache can be
 *  actively wrong rather than merely stale. */
export function updateSnapshotTracks(fn: (tracks: Track[]) => Track[]): void {
  if (disabled) return;
  const s = readSnapshot();
  if (!s) return;
  persist({ ...s, tracks: fn(s.tracks) }); // savedAt kept: a mutation is not a refresh
}

export function clearSnapshot(): void {
  localStorage.removeItem(KEY);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/storage/librarySnapshot.test.ts`
Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/storage/librarySnapshot.ts src/storage/librarySnapshot.test.ts
git commit -m "feat(storage): compact library snapshot with quota degradation"
```

---

## Task 5: Serve the library from the snapshot

**Files:**
- Modify: `src/hooks/useLibrary.ts:19-27` (`loadTracksAndPlaylists`), `:33-110` (`enrichLibrary`), `:217-224` (write-through)
- Test: `src/hooks/useLibrary.test.ts`

**Interfaces:**
- Consumes: Task 4's `readSnapshot`, `isFresh`, `writeSnapshot`, `compactPlaylists`, `updateSnapshotTracks`, `CompactItem`.
- Produces: `loadTracksAndPlaylists` and `enrichLibrary` keep their existing signatures and return types. `enrichLibrary`'s internals now key on `Record<string, CompactItem[]>` rather than `Map<string, PlaylistTrack[]>`.

- [ ] **Step 1: Write the failing test**

Append to `src/hooks/useLibrary.test.ts`:

```ts
import { writeSnapshot, readSnapshot, resetSnapshotForTests, compactPlaylists } from '../storage/librarySnapshot';

// Add to the existing top-of-file mock list — leave the current mocks intact.

it('serves a fresh snapshot without touching Spotify', async () => {
  const { items, artistNames } = compactPlaylists(new Map([['p1', [
    { name: 'Angel', artists: [{ id: 'a2', name: 'Massive Attack' }], releaseYear: 1998, isrc: null },
  ]]]));
  writeSnapshot({
    tracks: [likedTrack],
    playlists: [{ id: 'p1', name: 'Trip', trackCount: 1 }],
    items, artistNames,
  });
  vi.mocked(resolver.resolveAllGenres).mockResolvedValue(new Map([['a1', ['trip hop']], ['a2', ['trip hop']]]));

  const lib = await loadLibrary(
    { targetPlaylistIds: ['p1'], threshold: 0.3, sortOrder: 'oldest' },
    () => {},
  );

  expect(spotify.getSavedTracks).not.toHaveBeenCalled();
  expect(spotify.getMyPlaylists).not.toHaveBeenCalled();
  expect(spotify.getPlaylistTracks).not.toHaveBeenCalled();
  expect(lib.tracks).toEqual([likedTrack]);
  expect(lib.fingerprints.get('p1')?.size).toBe(1);
  // Artist names survive the round trip — a deep MusicBrainz run needs them.
  expect(vi.mocked(resolver.resolveAllGenres).mock.calls[0][0]
    .find((a) => a.id === 'a2')?.name).toBe('Massive Attack');
});

it('fetches only the playlists missing from the snapshot', async () => {
  const { items, artistNames } = compactPlaylists(new Map([['p1', [
    { name: 'Angel', artists: [{ id: 'a2', name: 'Massive Attack' }], releaseYear: 1998, isrc: null },
  ]]]));
  writeSnapshot({
    tracks: [likedTrack],
    playlists: [
      { id: 'p1', name: 'Trip', trackCount: 1 },
      { id: 'p2', name: 'New target', trackCount: 1 },
    ],
    items, artistNames,
  });
  vi.mocked(spotify.getPlaylistTracks).mockResolvedValue([
    { name: 'Protection', artists: [{ id: 'a3', name: 'Tracey Thorn' }], releaseYear: 1994, isrc: null },
  ]);
  vi.mocked(resolver.resolveAllGenres).mockImplementation(async (artists) =>
    new Map(artists.map((a) => [a.id, ['trip hop']])));

  await loadLibrary({ targetPlaylistIds: ['p1', 'p2'], threshold: 0.3, sortOrder: 'oldest' }, () => {});

  expect(spotify.getPlaylistTracks).toHaveBeenCalledTimes(1);
  expect(spotify.getPlaylistTracks).toHaveBeenCalledWith('p2');
  expect(Object.keys(readSnapshot()!.items).sort()).toEqual(['p1', 'p2']);
});

it('refetches when the snapshot has aged past the TTL', async () => {
  writeSnapshot({ tracks: [likedTrack], playlists: [{ id: 'p1', name: 'Trip', trackCount: 1 }] });
  // Age it out in place.
  const raw = JSON.parse(localStorage.getItem('kondo:library:v1')!);
  localStorage.setItem('kondo:library:v1', JSON.stringify({ ...raw, savedAt: 0 }));

  vi.mocked(spotify.getSavedTracks).mockResolvedValue([likedTrack]);
  vi.mocked(spotify.getMyPlaylists).mockResolvedValue([{ id: 'p1', name: 'Trip', trackCount: 1 }]);
  vi.mocked(spotify.getPlaylistTracks).mockResolvedValue([]);
  vi.mocked(resolver.resolveAllGenres).mockResolvedValue(new Map());

  await loadLibrary({ targetPlaylistIds: ['p1'], threshold: 0.3, sortOrder: 'oldest' }, () => {});

  expect(spotify.getSavedTracks).toHaveBeenCalledTimes(1);
});

it('write-through keeps a sorted song from coming back on reload', async () => {
  writeSnapshot({ tracks: [likedTrack], playlists: [] });
  vi.mocked(resolver.resolveAllGenres).mockResolvedValue(new Map());
  const { result } = renderHook(() =>
    useLibrary({ targetPlaylistIds: [], threshold: 0.3, sortOrder: 'oldest' }));
  await waitFor(() => expect(result.current.status).toBe('ready'));

  act(() => result.current.removeTrackLocally('t1'));

  expect(readSnapshot()?.tracks).toEqual([]);
});
```

Add `resetSnapshotForTests()` and `localStorage.clear()` to the file's cleanup. The file currently has no `afterEach` — add one near the top, after the `vi.mock` calls:

```ts
afterEach(() => {
  localStorage.clear();
  resetSnapshotForTests();
  vi.clearAllMocks();
});
```

Import `afterEach` from `vitest` in the first import line.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/hooks/useLibrary.test.ts -t "serves a fresh snapshot"`
Expected: FAIL — `expected "getSavedTracks" not to be called` (nothing reads the snapshot yet).

- [ ] **Step 3: Write minimal implementation**

In `src/hooks/useLibrary.ts`, extend the imports:

```ts
import {
  clearSnapshot, compactPlaylists, isFresh, readSnapshot, updateSnapshotTracks,
  writeSnapshot, type CompactItem,
} from '../storage/librarySnapshot';
```

Replace `loadTracksAndPlaylists` (lines 19-27):

```ts
/** Phase 1: everything needed to render the song list. Free from cache inside
 *  the TTL, seconds otherwise. */
export async function loadTracksAndPlaylists(
  settings: KondoSettings,
): Promise<Pick<LibraryData, 'tracks' | 'playlists' | 'allPlaylists'>> {
  const snap = readSnapshot();
  let tracks: Track[];
  let allPlaylists: Playlist[];
  if (isFresh(snap)) {
    ({ tracks, playlists: allPlaylists } = snap!);
  } else {
    [tracks, allPlaylists] = await Promise.all([getSavedTracks(), getMyPlaylists()]);
    // Written only after both succeeded — a load interrupted partway must not
    // persist a half-built snapshot.
    writeSnapshot({ tracks, playlists: allPlaylists });
  }
  const playlists = settings.targetPlaylistIds
    ? allPlaylists.filter((p) => settings.targetPlaylistIds!.includes(p.id))
    : allPlaylists;
  return { tracks, playlists, allPlaylists };
}
```

Replace the fetch block and artist collection in `enrichLibrary` (lines 39-62):

```ts
  const snap = readSnapshot();
  const cached = isFresh(snap) ? snap!.items : {};
  const cachedNames = isFresh(snap) ? snap!.artistNames : {};

  // ponytail: a playlist that 403s is not cached, so it is re-attempted every
  // mount — a handful of requests. Caching the failure would strand a playlist
  // whose permissions later change.
  const missing = playlists.filter((p) => cached[p.id] === undefined);
  const fetched = new Map<string, PlaylistTrack[]>(
    (await Promise.all(
      missing.map((p) =>
        getPlaylistTracks(p.id).then(
          (ts) => [p.id, ts] as const,
          (e) => {
            // Some playlists (Blends, algorithmic ones) 403 on their items
            // endpoint under dev-mode API restrictions — they can't be read or
            // sorted into, so drop them instead of failing the whole load.
            console.warn(`kondo: skipping unreadable playlist “${p.name}”`, e);
            return null;
          },
        ),
      ),
    )).filter((e) => e !== null),
  );
  const compacted = compactPlaylists(fetched);

  const items: Record<string, CompactItem[]> = {};
  for (const p of playlists) {
    const its = compacted.items[p.id] ?? cached[p.id];
    if (its) items[p.id] = its;
  }
  const artistNames = { ...cachedNames, ...compacted.artistNames };

  // Genre resolution is per unique artist — the cache and MB rate limit both
  // work in our favor this way.
  const artists = new Map<string, { id: string; name: string }>();
  for (const t of tracks) for (const a of t.artists) artists.set(a.id, a);
  for (const its of Object.values(items)) {
    for (const it of its) {
      for (const id of it.a) {
        // Names come from the snapshot's deduped directory — compact items
        // carry ids only, and MusicBrainz name search needs the name.
        if (!artists.has(id)) artists.set(id, { id, name: artistNames[id] ?? '' });
      }
    }
  }
```

Replace `buildFrom` (lines 66-88) so it reads compact items:

```ts
  // Shared by the partial and final builds — a rebuild is just "run this over
  // whatever's resolved so far"; missing artists contribute [] either way.
  const buildFrom = (
    genresByArtist: Map<string, string[]>,
  ): Pick<LibraryData, 'genresByTrack' | 'fingerprints'> => {
    const genresOf = (ids: string[]) =>
      [...new Set(ids.flatMap((id) => genresByArtist.get(id) ?? []))];

    const fingerprints = new Map<string, Fingerprint>(
      Object.entries(items).map(([id, its]) => [
        id,
        buildFingerprint(its.map((it) => ({
          genres: genresOf(it.a),
          releaseYear: it.y,
          script: it.s,
          country: it.c,
        }))),
      ]),
    );

    const genresByTrack = new Map(
      tracks.map((t) => [t.id, genresOf(t.artists.map((a) => a.id))]),
    );

    return { genresByTrack, fingerprints };
  };
```

`langSignals` is no longer called in this file for playlist items (`compactPlaylists` owns that now), but it is still used for saved tracks in the `matches` memo — keep the import.

Replace the return statement (line 109):

```ts
  const genresByArtist = await resolveAllGenres([...artists.values()], wrappedProgress, sink, opts);
  // Phase 2 succeeded — persist what it cost the most to get.
  writeSnapshot({ items, artistNames });
  return { ...buildFrom(genresByArtist), artists: [...artists.values()] };
```

Add write-through to the two local mutators (lines 217-224):

```ts
  const removeTrackLocally = useCallback((id: string) => {
    setData((d) => ({ ...d, tracks: d.tracks.filter((t) => t.id !== id) }));
    // Without this the next reload inside the TTL resurrects the song.
    updateSnapshotTracks((ts) => ts.filter((t) => t.id !== id));
  }, []);
  const restoreTrackLocally = useCallback((t: Track) => {
    setData((d) => ({ ...d, tracks: [...d.tracks, t] }));
    updateSnapshotTracks((ts) => [...ts.filter((x) => x.id !== t.id), t]);
  }, []);
```

No import changes are needed for the types: `src/hooks/useLibrary.ts:7` already imports
`Playlist, PlaylistTrack, SongMatch, Track`. Keep the `langSignals` import too — it is still used
by the `matches` memo at line 208 for saved tracks, even though playlist items now get their
script/country from `compactPlaylists`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/hooks/useLibrary.test.ts && npm run build`
Expected: PASS on all tests including the pre-existing ones, and `tsc -b` clean.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useLibrary.ts src/hooks/useLibrary.test.ts
git commit -m "perf(library): serve tracks, playlists and fingerprint input from a TTL snapshot"
```

---

## Task 6: Countdown hook and banner

**Files:**
- Create: `src/hooks/useRateLimit.ts`, `src/components/RateLimitBanner.tsx`, `src/components/RateLimitBanner.test.tsx`
- Modify: `src/App.tsx:80-97`, `src/index.css`

**Interfaces:**
- Consumes: Task 3's `getRateLimitedUntil`, `subscribeRateLimit`.
- Produces: `useRateLimit(): number` (epoch ms, `0` when clear); default-exported `RateLimitBanner` component taking no props.

- [ ] **Step 1: Write the failing test**

Create `src/components/RateLimitBanner.test.tsx`:

```tsx
import { afterEach, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import RateLimitBanner from './RateLimitBanner';
import { configureSpotify, resetRateLimitForTests, spotifyFetch } from '../api/spotify';
import { saveTokens } from '../auth/token';

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  resetRateLimitForTests();
});

it('renders nothing when there is no penalty', () => {
  const { container } = render(<RateLimitBanner />);
  expect(container).toBeEmptyDOMElement();
});

it('counts down while a penalty is live', async () => {
  configureSpotify('cid');
  saveTokens({ accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 3600_000 });
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response('', { status: 429, headers: { 'Retry-After': '120' } }),
  );

  render(<RateLimitBanner />);
  await spotifyFetch('/me').catch(() => {});

  await waitFor(() => expect(screen.getByRole('status')).toBeTruthy());
  expect(screen.getByRole('status').textContent).toMatch(/resuming in 2:0\d/);
  // The estimate is honest about being an estimate — Retry-After is usually
  // CORS-hidden in a browser.
  expect(screen.getByRole('status').textContent).toMatch(/estimate/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/RateLimitBanner.test.tsx`
Expected: FAIL — `Failed to resolve import "./RateLimitBanner"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/hooks/useRateLimit.ts`:

```ts
import { useEffect, useState } from 'react';
import { getRateLimitedUntil, subscribeRateLimit } from '../api/spotify';

/** Epoch ms the current penalty ends, or 0 when clear. Re-renders once a
 *  second **only** while a penalty is live — no permanent interval. */
export function useRateLimit(): number {
  const [until, setUntil] = useState(getRateLimitedUntil);
  const [, tick] = useState(0);

  useEffect(() => subscribeRateLimit(setUntil), []);

  useEffect(() => {
    if (until <= Date.now()) return;
    const id = setInterval(() => {
      // getRateLimitedUntil returns 0 once the deadline passes, which both
      // stops the timer (via the dep change) and clears the banner.
      if (getRateLimitedUntil() === 0) setUntil(0);
      else tick((n) => n + 1);
    }, 1000);
    return () => clearInterval(id);
  }, [until]);

  return until > Date.now() ? until : 0;
}
```

Create `src/components/RateLimitBanner.tsx`:

```tsx
import { useRateLimit } from '../hooks/useRateLimit';

export default function RateLimitBanner() {
  const until = useRateLimit();
  if (!until) return null;
  const secs = Math.max(0, Math.ceil((until - Date.now()) / 1000));
  const mmss = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  return (
    <p role="status" className="rate-limit-banner">
      Spotify is rate-limiting this app — resuming in {mmss}. Your library stays usable, and
      it picks back up on its own.{' '}
      <span className="rate-limit-note">
        Spotify hides the exact penalty from browsers, so this is an estimate and may extend.
      </span>
    </p>
  );
}
```

In `src/App.tsx`, import it after the other component imports (line 9):

```ts
import RateLimitBanner from './components/RateLimitBanner';
```

Render it next to the existing notice (replace line 94):

```tsx
      {notice && <p role="status">{notice}</p>}
      {authed && <RateLimitBanner />}
```

Also clear the snapshot on logout, so the next account never sees the previous one's library. Import at the top of `App.tsx`:

```ts
import { clearSnapshot } from './storage/librarySnapshot';
```

and add the call to both exit paths (lines 67-78):

```tsx
  const logout = () => {
    clearTokens();
    clearSnapshot(); // the cached library belongs to the account that just left
    setAuthed(false);
  };

  const handleAuthExpired = () => {
    clearTokens();
    clearSnapshot();
    setAuthed(false);
    setNotice('Your Spotify session expired — log in again.');
  };
```

Append to `src/index.css`:

```css
.rate-limit-banner {
  padding: 8px 16px;
  border-radius: 8px;
  background: rgba(255, 193, 7, 0.12);
  border: 1px solid rgba(255, 193, 7, 0.35);
  font-size: 0.9rem;
}

.rate-limit-note {
  opacity: 0.65;
  font-size: 0.85em;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/RateLimitBanner.test.tsx && npx vitest run src/components/`
Expected: PASS, including the existing component tests (the `App.tsx` edit must not break them).

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useRateLimit.ts src/components/RateLimitBanner.tsx \
        src/components/RateLimitBanner.test.tsx src/App.tsx src/index.css
git commit -m "feat(ui): rate-limit countdown banner, and clear the snapshot on logout"
```

---

## Task 7: Self-heal — keep cached data, resume at zero

**Files:**
- Modify: `src/hooks/useLibrary.ts:138-189` (the load effect and its catch), `:120-132` (`LibraryState`), `:263-275` (return)
- Test: `src/hooks/useLibrary.test.ts`

**Interfaces:**
- Consumes: Task 3's `RateLimitedError`, Task 6's `useRateLimit`, Task 4's `clearSnapshot`.
- Produces: `LibraryState` gains `refresh(): void` and `snapshotAge: number | null` (ms since the snapshot was written, `null` when there is none).

- [ ] **Step 1: Write the failing test**

Append to `src/hooks/useLibrary.test.ts`:

```ts
it('keeps the cached library on screen when a refresh is rate-limited', async () => {
  writeSnapshot({ tracks: [likedTrack], playlists: [{ id: 'p1', name: 'Trip', trackCount: 1 }] });
  const raw = JSON.parse(localStorage.getItem('kondo:library:v1')!);
  localStorage.setItem('kondo:library:v1', JSON.stringify({ ...raw, savedAt: 0 })); // stale

  vi.mocked(spotify.getSavedTracks).mockRejectedValue(new spotify.RateLimitedError(Date.now() + 60_000));
  vi.mocked(spotify.getMyPlaylists).mockRejectedValue(new spotify.RateLimitedError(Date.now() + 60_000));
  vi.mocked(resolver.resolveAllGenres).mockResolvedValue(new Map());

  const { result } = renderHook(() =>
    useLibrary({ targetPlaylistIds: ['p1'], threshold: 0.3, sortOrder: 'oldest' }));

  await waitFor(() => expect(result.current.status).not.toBe('loading'));
  // The banner explains the penalty; blanking the app would be strictly worse.
  expect(result.current.status).not.toBe('error');
  expect(result.current.tracks).toEqual([likedTrack]);
});

it('errors normally when rate-limited with nothing cached', async () => {
  vi.mocked(spotify.getSavedTracks).mockRejectedValue(new spotify.RateLimitedError(Date.now() + 60_000));
  vi.mocked(spotify.getMyPlaylists).mockRejectedValue(new spotify.RateLimitedError(Date.now() + 60_000));

  const { result } = renderHook(() =>
    useLibrary({ targetPlaylistIds: [], threshold: 0.3, sortOrder: 'oldest' }));

  await waitFor(() => expect(result.current.status).toBe('error'));
});

it('refresh() drops the snapshot and refetches', async () => {
  writeSnapshot({ tracks: [likedTrack], playlists: [] });
  vi.mocked(spotify.getSavedTracks).mockResolvedValue([likedTrack]);
  vi.mocked(spotify.getMyPlaylists).mockResolvedValue([]);
  vi.mocked(resolver.resolveAllGenres).mockResolvedValue(new Map());

  const { result } = renderHook(() =>
    useLibrary({ targetPlaylistIds: [], threshold: 0.3, sortOrder: 'oldest' }));
  await waitFor(() => expect(result.current.status).toBe('ready'));
  expect(spotify.getSavedTracks).not.toHaveBeenCalled(); // served from cache

  act(() => result.current.refresh());

  await waitFor(() => expect(spotify.getSavedTracks).toHaveBeenCalledTimes(1));
});
```

Add `RateLimitedError` to the `vi.mock('../api/spotify', …)` factory at the top of the file, since the mock replaces the whole module:

```ts
vi.mock('../api/spotify', async () => {
  const actual = await vi.importActual<typeof import('../api/spotify')>('../api/spotify');
  return {
    getSavedTracks: vi.fn(),
    getMyPlaylists: vi.fn(),
    getPlaylistTracks: vi.fn(),
    // Real class and real gate accessors — the hook's behavior depends on
    // `instanceof` matching, which a stub would silently break.
    RateLimitedError: actual.RateLimitedError,
    getRateLimitedUntil: actual.getRateLimitedUntil,
    subscribeRateLimit: actual.subscribeRateLimit,
  };
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/hooks/useLibrary.test.ts -t "rate-limited"`
Expected: FAIL — status is `'error'` and `tracks` is `[]`.

- [ ] **Step 3: Write minimal implementation**

In `src/hooks/useLibrary.ts`, add to the imports:

```ts
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getMyPlaylists, getPlaylistTracks, getSavedTracks, RateLimitedError } from '../api/spotify';
import { useRateLimit } from './useRateLimit';
```

Extend `LibraryState` (after line 131):

```ts
  /** Drop the cached snapshot and refetch from Spotify. */
  refresh(): void;
  /** Age of the served snapshot in ms, or null when the data came from the network. */
  snapshotAge: number | null;
```

Add state and the auto-resume effect inside `useLibrary`, after the existing `useState` block (after line 144):

```ts
  const [retryTick, setRetryTick] = useState(0);
  const [snapshotAge, setSnapshotAge] = useState<number | null>(null);
  // Set as soon as phase 1 produces rows — the catch below needs to know
  // whether there is anything on screen worth preserving.
  const hasDataRef = useRef(false);

  const rateLimitedUntil = useRateLimit();
  const wasLimitedRef = useRef(0);
  useEffect(() => {
    // The moment the penalty clears, re-run the load that it interrupted.
    // This is the "self-heal": no button, no reload.
    if (wasLimitedRef.current !== 0 && rateLimitedUntil === 0) setRetryTick((n) => n + 1);
    wasLimitedRef.current = rateLimitedUntil;
  }, [rateLimitedUntil]);

  const refresh = useCallback(() => {
    clearSnapshot();
    setRetryTick((n) => n + 1);
  }, []);
```

In the load effect, record the snapshot age and the data flag. Replace lines 151-156:

```ts
    (async () => {
      const before = readSnapshot();
      const base = await loadTracksAndPlaylists(settings);
      if (cancelled) return;
      setSnapshotAge(isFresh(before) ? Date.now() - before!.savedAt : null);
      hasDataRef.current = base.tracks.length > 0;
      setData({ ...EMPTY, ...base });
      setStatus('enriching');
```

Replace the catch (lines 173-184):

```ts
    })().catch((e) => {
      if (cancelled) return;
      // Distinguish an expired session (AuthError) from network-level failures
      if (e instanceof AuthError) {
        setError(String(e));
        setStatus('error');
        setAuthExpired(true);
      } else if (e instanceof RateLimitedError && hasDataRef.current) {
        // The banner already explains this, and the countdown re-runs this
        // effect at zero. Keep the snapshot's rows on screen instead of
        // replacing a working app with an error page.
        setError(null);
        setStatus('ready');
      } else {
        setError(String(e));
        setStatus('error');
      }
    });
```

Change the effect's dependency array (line 189):

```ts
  }, [settingsKey, retryTick]);
```

Add both to the returned object (after line 274):

```ts
    refresh,
    snapshotAge,
```

- [ ] **Step 4: Satisfy the widened LibraryState in the Sorter test double**

`src/components/Sorter.test.tsx:32-52` builds a full `LibraryState` via `mockLibrary`. Widening the
interface breaks its type-check, so add the two new fields to that object literal — put them next
to `deepState`:

```ts
    deepState: 'idle',
    refresh: vi.fn(),
    snapshotAge: null,
    coverage: { spotify: 0, musicbrainz: 0, none: 0, unresolved: 0 },
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/hooks/useLibrary.test.ts src/components/Sorter.test.tsx && npm run build`
Expected: PASS on both files, `tsc -b` clean. The build is the real gate here — it is what catches
any other construction of `LibraryState`.

- [ ] **Step 6: Commit**

```bash
git add src/hooks/useLibrary.ts src/hooks/useLibrary.test.ts src/components/Sorter.test.tsx
git commit -m "feat(library): keep cached data through a rate limit and resume automatically"
```

---

## Task 8: Fix the add-path rollback

If the unsave fails after the adds landed, the current catch restores the row while the song is already in the playlist — a retry then duplicates it.

**Files:**
- Modify: `src/components/Sorter.tsx:44-67`
- Test: `src/components/Sorter.test.tsx`

**Interfaces:**
- Consumes: Task 2 (these calls are now priority).
- Produces: no new exports. `handleAdd` behavior changes only in the partial-failure case.

- [ ] **Step 1: Write the failing test**

Append to `src/components/Sorter.test.tsx`, following the file's existing render/mock setup:

```tsx
it('keeps the row removed when the playlist add succeeded but the unsave failed', async () => {
  vi.mocked(spotify.removeSavedTracks).mockRejectedValueOnce(new Error('429'));
  const lib = mockLibrary([track('t1', '2024-06-01T00:00:00Z')]);
  render(<Sorter settings={settings} lib={lib} />);

  await userEvent.click(screen.getByRole('button', { name: /^add$/i }));

  await waitFor(() => expect(screen.getByRole('alert').textContent)
    .toMatch(/couldn't remove it from Liked/i));
  // Restoring the row would invite a retry that double-adds to the playlist.
  expect(lib.restoreTrackLocally).not.toHaveBeenCalled();
  // It is still in Liked Songs, so there is no removal to log.
  expect(getRemovalLog()).toHaveLength(0);
});

it('rolls the row back when the playlist add itself failed', async () => {
  vi.mocked(spotify.addTracksToPlaylist).mockRejectedValueOnce(new Error('429'));
  const lib = mockLibrary([track('t1', '2024-06-01T00:00:00Z')]);
  render(<Sorter settings={settings} lib={lib} />);

  await userEvent.click(screen.getByRole('button', { name: /^add$/i }));

  // Nothing landed, so the optimistic removal must be undone.
  await waitFor(() => expect(lib.restoreTrackLocally).toHaveBeenCalled());
  expect(spotify.removeSavedTracks).not.toHaveBeenCalled();
});
```

`mockLibrary`, `track`, `settings`, and `getRemovalLog` all already exist in that file
(`src/components/Sorter.test.tsx:10-56`) — use them as-is rather than adding helpers.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components/Sorter.test.tsx -t "unsave failed"`
Expected: FAIL — `restoreTrackLocally` was called, and the alert reads the raw error.

- [ ] **Step 3: Write minimal implementation**

Replace `handleAdd` in `src/components/Sorter.tsx` (lines 44-67):

```tsx
  const handleAdd = useCallback(async (track: Track, playlistIds: string[]) => {
    const removedAt = new Date().toISOString();
    // Optimistic: row vanishes and undo toast shows immediately.
    removeTrackLocally(track.id);
    setUndo({ track, playlistIds, removedAt });
    setActionError(null);

    // Adds first: unsaving first would risk losing the song entirely if the
    // add then failed.
    try {
      await Promise.all(playlistIds.map((pid) => addTracksToPlaylist(pid, [track.uri])));
    } catch (e) {
      // Nothing landed — safe to put the row back.
      restoreTrackLocally(track);
      setUndo(null);
      setActionError(String(e));
      return;
    }

    try {
      await removeSavedTracks([track.uri]);
    } catch (e) {
      // The adds already landed. Rolling back here would invite a retry that
      // duplicates the song in the playlist, so keep the row gone and lean on
      // the undo toast — it un-adds *and* re-saves.
      setActionError(
        `Added to your playlist, but couldn't remove it from Liked Songs — ${String(e)}. ` +
        'Undo to put everything back.',
      );
      return; // no removal log: it was never actually removed from Liked
    }

    logRemoval({
      trackId: track.id,
      name: track.name,
      artists: track.artists.map((a) => a.name).join(', '),
      addedAt: track.addedAt,
      removedAt,
      playlistIds,
    });
  }, [removeTrackLocally, restoreTrackLocally]);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/Sorter.test.tsx`
Expected: PASS, including the file's existing add/undo tests.

- [ ] **Step 5: Commit**

```bash
git add src/components/Sorter.tsx src/components/Sorter.test.tsx
git commit -m "fix(sorter): stop rolling back a row whose playlist add already succeeded"
```

---

## Task 9: Snapshot age and Refresh in the toolbar

**Files:**
- Modify: `src/components/Sorter.tsx:135-147` (toolbar), `src/index.css`
- Test: `src/components/Sorter.test.tsx`

**Interfaces:**
- Consumes: Task 7's `lib.refresh` and `lib.snapshotAge`.
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Append to `src/components/Sorter.test.tsx`:

```tsx
it('shows the snapshot age and refetches on Refresh', async () => {
  const lib = { ...mockLibrary([track('t1', '2024-06-01T00:00:00Z')]),
                snapshotAge: 2 * 60 * 60 * 1000 };
  render(<Sorter settings={settings} lib={lib} />);

  expect(screen.getByText(/2h ago/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: /refresh/i }));
  expect(lib.refresh).toHaveBeenCalled();
});

it('shows no cache age when the data came straight from Spotify', () => {
  // snapshotAge is null in mockLibrary's default, set in Task 7.
  const lib = mockLibrary([track('t1', '2024-06-01T00:00:00Z')]);
  render(<Sorter settings={settings} lib={lib} />);
  expect(screen.queryByRole('button', { name: /refresh/i })).toBeNull();
});
```

`refresh: vi.fn()` and `snapshotAge: null` were added to `mockLibrary` in Task 7 — this task needs
no further change to that helper.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components/Sorter.test.tsx -t "snapshot age"`
Expected: FAIL — `Unable to find an element with the text: /2h ago/`.

- [ ] **Step 3: Write minimal implementation**

Add the formatter above the `Sorter` component in `src/components/Sorter.tsx` (next to `mbEstimate`, after line 28):

```tsx
function formatAge(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}
```

Extend the toolbar (replace lines 137-147):

```tsx
      <div className="sorter-toolbar">
        {lib.status !== 'loading' && (
          <p className="song-count">
            <span className="heart" aria-hidden="true">♥</span>
            {lib.tracks.length} liked songs
          </p>
        )}
        {lib.snapshotAge != null && (
          <p className="snapshot-age">
            Cached {formatAge(lib.snapshotAge)}
            <button onClick={lib.refresh}>Refresh</button>
          </p>
        )}
        <button onClick={() => setOrder(order === 'oldest' ? 'newest' : 'oldest')}>
          {order === 'oldest' ? 'old → new' : 'new → old'}
        </button>
      </div>
```

Append to `src/index.css`:

```css
.snapshot-age {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.85rem;
  opacity: 0.7;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/Sorter.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/Sorter.tsx src/components/Sorter.test.tsx src/index.css
git commit -m "feat(sorter): show cache age with a manual Refresh"
```

---

## Final Verification

- [ ] **Full suite, lint, build**

```bash
npx vitest run
npm run lint
npm run build
```

Every file must report `1 passed`, not `2` — a `2` means a stale worktree copy is being scanned and the results are untrustworthy.

- [ ] **Manual, against a real library**

Needs `.env.local` with `VITE_SPOTIFY_CLIENT_ID`. Run `npm run dev` and open `http://127.0.0.1:5173` — **not** `localhost`, which resolves to `::1` and breaks Spotify auth.

1. Load the app cold with `kondo:library:v1` absent. Confirm in DevTools → Network that requests are *spaced* rather than fired in one wall, and that the load completes without a 429.
2. Reload twice. Both reloads show **zero** Spotify requests, and the toolbar reads "Cached … ago".
3. Sort a song into a playlist, then reload. It stays gone.
4. Press Refresh. Traffic resumes, still spaced, and the age indicator disappears.
5. Force a penalty: temporarily set `BUCKET_CAPACITY` and `REFILL_PER_SEC` very high in `spotify.ts`, load a cold library, and let Spotify 429 you. Confirm the banner counts down, the song list stays on screen and clickable, and the refresh resumes on its own at zero. **Revert the constants afterward.**
6. With the penalty still live, reload. The banner is still there with the countdown continuing — the gate survived.

## Out of Scope

- A durable retry queue for failed adds.
- IndexedDB. The compact item form fits localStorage at this library size; the quota fallback covers the case where it does not.
- Any change to genre resolution, scoring, or the analyzer.
