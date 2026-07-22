# Issues A–F Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Parts A–F from docs/superpowers/plans/issues.md: fix network retry/token labeling (A), auth-expiry UX and skeletons (B), investigate/fix playback leak (C), reduce play latency UX (D), move MusicBrainz work on-demand (E), and improve Settings layout (F).

**Architecture:** Incremental, one Part per PR. Each task: TDD cycle (failing test → implement → pass → commit). Keep changes small and reversible.

**Tech Stack:** TypeScript, React, Vitest, Vite, jsdom

## Global Constraints
- Run tests with: npx vitest run
- Build check: npx tsc -b
- Lint: npm run lint
- Follow existing test style using vi.spyOn(globalThis, 'fetch') and vi.useFakeTimers()

---

### Task 1: Part A — Network retry and labeled token errors

**Files:**
- Modify: `src/api/spotify.ts` (wrap fetch + token calls)
- Modify: `src/auth/token.ts` (label token fetch errors)
- Test: `src/api/spotify.test.ts`

**Interfaces:**
- Consumes: existing spotifyFetch(url, opts) internal retry loop
- Produces: SpotifyApiError class thrown on exhausted retries; better error messages that include URL and layer label.

- [ ] Step 1: Add SpotifyApiError type

Add at top of `src/api/spotify.ts`:

```ts
export class SpotifyApiError extends Error {
  url: string;
  attempts: number;
  constructor(message: string, url: string, attempts = 0) {
    super(message);
    this.name = 'SpotifyApiError';
    this.url = url;
    this.attempts = attempts;
  }
}
```

- [ ] Step 2: Wrap token fetch and api fetch in try/catch with retry

Replace the `await fetch(url, opts)` call inside the existing for-loop in `spotifyFetch` with this pattern (preserve existing backoff logic):

```ts
let res: Response | null = null;
try {
  res = await fetch(url, opts);
} catch (err) {
  // network-level rejection
  if (attempt < maxAttempts - 1) {
    await sleep(2 ** attempt * 1000);
    continue;
  }
  throw new SpotifyApiError(`Network failure fetching ${url}: ${String(err)}`, url, attempt + 1);
}
```

And for the `getValidAccessToken(clientId)` call used before fetch, wrap the call similarly where it may throw due to network error; on final attempt throw a SpotifyApiError with label `token refresh` in the message so UI can display layer.

- [ ] Step 3: Label token endpoint errors in `src/auth/token.ts`

In `tokenRequest` where `fetch(TOKEN_URL, ...)` is called, wrap and rethrow as an Error with message prefix `token endpoint unreachable: ` and include original message. Example:

```ts
export async function tokenRequest(body: BodyInit) {
  try {
    const res = await fetch(TOKEN_URL, { method: 'POST', body, headers });
    return res;
  } catch (err) {
    throw new Error(`token endpoint unreachable: ${String(err)}`);
  }
}
```

- [ ] Step 4: Tests

Create/modify `src/api/spotify.test.ts` with these tests (Vitest style):

```ts
import { vi, describe, it, expect } from 'vitest';
import { spotifyFetch, SpotifyApiError } from './spotify';

describe('spotifyFetch network retry', () => {
  it('retries on network rejection and succeeds', async () => {
    const realFetch = globalThis.fetch;
    let calls = 0;
    vi.stubGlobal('fetch', async (url: string) => {
      calls++;
      if (calls === 1) throw new TypeError('Network failure');
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const res = await spotifyFetch('/test', { method: 'GET' });
    expect(res.ok).toBe(true);
    vi.stubGlobal('fetch', realFetch as any);
  });

  it('throws SpotifyApiError after exhausted retries', async () => {
    vi.stubGlobal('fetch', async () => { throw new TypeError('down'); });
    await expect(spotifyFetch('/never', { method: 'GET' })).rejects.toThrow(SpotifyApiError);
  });
});
```

- [ ] Step 5: Run tests and commit

Run: `npx vitest run src/api/spotify.test.ts` Expect: tests pass

Commit:

```bash
git add src/api/spotify.ts src/auth/token.ts src/api/spotify.test.ts
git commit -m "fix(api): retry network-level fetch failures and label token errors

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: Part B — AuthError, authExpired flow, and skeleton rows

**Files:**
- Modify: `src/auth/token.ts` (add AuthError export)
- Modify: `src/hooks/useLibrary.ts` (add authExpired flag in state)
- Modify: `src/App.tsx` (Workspace onAuthExpired effect)
- Modify: `src/components/Login.tsx` (accept notice prop & render role=status)
- Modify: `src/components/Sorter.tsx` (render skeleton rows when status='loading')
- Tests: `src/App.test.tsx`, `src/components/Sorter.test.tsx`

**Interfaces:**
- Consumes: getValidAccessToken may throw AuthError
- Produces: lib.authExpired boolean; App responds by clearing tokens and showing Login notice

- [ ] Step 1: Define AuthError

In `src/auth/token.ts`, add:

```ts
export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}
```

Throw AuthError when token endpoint returns 400/401 or when no tokens exist:

```ts
if (res.status === 400 || res.status === 401) {
  throw new AuthError(`token request failed: ${res.status}`);
}
if (!storedTokens) throw new AuthError('not authenticated');
```

- [ ] Step 2: Propagate authExpired in useLibrary

In `src/hooks/useLibrary.ts`, in the top-level catch where errors set status 'error', detect AuthError and set `authExpired: true` on the returned `lib` state object:

```ts
catch (e) {
  if (e instanceof AuthError) {
    setLib(s => ({ ...s, status: 'error', authExpired: true }));
  } else {
    setLib(s => ({ ...s, status: 'error' }));
  }
}
```

- [ ] Step 3: App handles authExpired

In `src/App.tsx` where `Workspace` mounts, add `onAuthExpired` prop:

```tsx
useEffect(() => {
  if (lib.authExpired) {
    clearTokens();
    setAuthed(false);
    setNotice('Your Spotify session expired — log in again.');
  }
}, [lib.authExpired]);
```

- [ ] Step 4: Login notice

In `src/components/Login.tsx`, accept optional `notice?: string` prop and render above the explainer:

```tsx
{notice && <div role="status" className="login-notice">{notice}</div>}
```

- [ ] Step 5: Skeleton rows in Sorter

Replace the single loading text with 8 skeleton <li> elements matching song-row layout. Example snippet in `Sorter.tsx`:

```tsx
if (status === 'loading') {
  return (
    <ul className="song-list">
      {Array.from({length:8}).map((_,i) => (
        <li key={i} className="song-row skeleton">
          <div className="skeleton-line title" />
          <div className="skeleton-line artist" />
          <div className="skeleton-line date" />
        </li>
      ))}
    </ul>
  );
}
```

- [ ] Step 6: Tests

`src/App.test.tsx` - simulate AuthError during load and assert Login visible and localStorage cleared:

```ts
import { render, screen } from '@testing-library/react';
import App from '../App';
import { vi } from 'vitest';

it('returns to login on AuthError and clears tokens', async () => {
  // stub getValidAccessToken to throw AuthError
  vi.mock('../auth/token', () => ({ getValidAccessToken: () => { throw new (require('../auth/token').AuthError)('not authenticated'); } }));
  render(<App/>);
  expect(await screen.findByRole('status')).toBeInTheDocument();
  expect(localStorage.getItem('kondo:tokens')).toBeNull();
});
```

`src/components/Sorter.test.tsx` - assert skeleton rows render when status='loading'.

- [ ] Step 7: Run tests and commit

Run:

```bash
npx vitest run src/App.test.tsx src/components/Sorter.test.tsx
```

Commit:

```bash
git add src/auth/token.ts src/hooks/useLibrary.ts src/App.tsx src/components/Login.tsx src/components/Sorter.tsx src/App.test.tsx src/components/Sorter.test.tsx
git commit -m "feat(auth): add AuthError and auth-expired UX; add skeleton rows for loading

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: Part C — Playback investigation and leak fix (test-first)

**Files:**
- Modify: `src/player/spotifyPlayer.ts`
- Tests: create `src/player/spotifyPlayer.test.ts` (unit-level where possible)

**Interfaces:**
- Consumes: current boot/init flow for Spotify SDK
- Produces: player.disconnect called when nulling handle; metrics for instance counts

- [ ] Step 1: Add diagnostic counter

Temporarily add `console.count('spotifyPlayer.boot')` in `boot` to observe constructions. Add test harness to call boot twice and verify disconnect called once.

- [ ] Step 2: Implement disconnect-before-null

Edit `spotifyPlayer.ts` where the not_ready handler currently nulls handle. Replace with:

```ts
if (handle) {
  try { handle.player.disconnect(); } catch(e) { /* tolerate */ }
  handle = null;
}
```

- [ ] Step 3: Test

`src/player/spotifyPlayer.test.ts`:

```ts
import { boot, resetForTests } from './spotifyPlayer';
import { vi, it, expect } from 'vitest';

it('disconnects previous player before creating new one', () => {
  resetForTests();
  const mockDisconnect = vi.fn();
  // inject a fake handle with disconnect
  (globalThis as any).Spotify = { Player: function() { return { connect: () => {}, disconnect: mockDisconnect, addListener: () => {} }; } };
  boot();
  boot();
  expect(mockDisconnect).toHaveBeenCalled();
});
```

- [ ] Step 4: If disconnected players were the cause, submit small PR fixing this and run full tests.

Commit on success.

---

### Task 4: Part D — Pre-warm SDK and play latency UX

**Files:**
- Modify: `src/components/Sorter.tsx` (pre-warm initPlayer, pendingUri state)
- Modify: `src/components/SongRow.tsx` (render spinner when loading prop)
- Modify: `src/player/spotifyPlayer.ts` (expose onStateChange event)
- Modify: `src/index.css` (add spinner keyframes)
- Tests: `src/components/Sorter.test.tsx`, add timing instrumentation tests (console.time may be observed via spy)

**Interfaces:**
- Consumes: initPlayer(): Promise<PlayerHandle>
- Produces: pendingUri state and spinner; PlayerHandle.onStateChange(callback)

- [ ] Step 1: Pre-warm in Sorter

Add at top of `Sorter` component:

```tsx
useEffect(() => {
  let mounted = true;
  import('../player/spotifyPlayer').then(m => m.initPlayer()).catch(() => {}).finally(() => { mounted = false; });
  return () => { mounted = false; };
}, []);
```

- [ ] Step 2: pendingUri and spinner

Add state `const [pendingUri, setPendingUri] = useState<string | null>(null);`.
When play clicked, setPendingUri(track.uri); call playUri(...). In `SongRow` accept `loading` prop and render spinner instead of ▶ when true.

Add CSS in `src/index.css`:

```css
@keyframes spin { from { transform: rotate(0deg);} to { transform: rotate(360deg);} }
.play-btn.spin { animation: spin 1s linear infinite; }
```

- [ ] Step 3: player_state_changed handling

In `spotifyPlayer.ts` ensure the SDK 'player_state_changed' event calls any registered onStateChange callbacks. Surface `onStateChange` on PlayerHandle.

- [ ] Step 4: Instrumentation

Wrap `playUri` with `console.time('play:first-click')` / `console.timeEnd` and record metrics.

- [ ] Step 5: Tests & Commit

Write tests verifying that clicking play sets pendingUri and spinner appears. Use @testing-library/react to simulate and assert.

Commit.

---

### Task 5: Part E — On-demand MusicBrainz work

**Files:**
- Modify: `src/genre/resolver.ts` (skip lookupGenresBulk when !opts.deep; cache empty results)
- Modify: `src/api/musicbrainz.ts` (delete nameSearch option & tests)
- Modify: `src/hooks/useLibrary.ts` (add deepResolveTrack API)
- Modify: `src/components/MatchPicker.tsx` (add Deep-search genres button & spinner)
- Modify: `CLAUDE.md` (update genre resolution section)
- Tests: `src/genre/resolver.test.ts`, update musicbrainz tests

**Interfaces:**
- Consumes: resolver.lookupGenresBulk and existing caches
- Produces: deepResolveTrack( trackId ) promise that updates genresByTrack and triggers recompute of matches

- [ ] Step 1: Resolver change

In `src/genre/resolver.ts`, where startup currently calls `lookupGenresBulk`, gate it:

```ts
if (opts?.deep) {
  await lookupGenresBulk(artists);
} else {
  // mark unresolved artists as none so startup is fast
  for (const artist of artists) {
    if (!cache.has(artist.id)) cache.set(artist.id, { genres: [], source: 'none' });
  }
}
```

- [ ] Step 2: Add deepResolveTrack

In `useLibrary.ts` expose:

```ts
export async function deepResolveTrack(trackId: string) {
  const track = tracksById[trackId];
  await resolveArtistsDeep(track.artistIds);
  // rebuild genresByTrack for this track only and update state
}
```

- [ ] Step 3: UI: MatchPicker button

Add a button in `MatchPicker` that calls deepResolveTrack(track.id) and shows spinner while resolving. On completion, the candidate list should fade-in (use a resolve counter as key to remount rows).

- [ ] Step 4: Remove nameSearch and update tests

Delete dead `nameSearch` option in `src/api/musicbrainz.ts` and update/remove associated tests.

- [ ] Step 5: Update CLAUDE.md

Edit `CLAUDE.md` genre resolution section to describe the new on-demand flow.

- [ ] Step 6: Tests & Commit

Add tests asserting startup makes no MusicBrainz requests and deepResolveTrack triggers request. Run full test suite and commit.

---

### Task 6: Part F — Settings layout improvements

**Files:**
- Modify: `src/components/Settings.tsx` (reorder and convert destinations to bounded grid)
- Modify: `src/components/MatchPicker.tsx` (reuse match-search input)
- Modify: `src/index.css` (grid and bounded scroll styles)
- Tests: `src/components/Settings.test.tsx`

**Interfaces:**
- Consumes: existing settings state and playlist list
- Produces: reordered layout with sensitivity slider visible without page scroll

- [ ] Step 1: Reorder DOM in Settings

Move sensitivity slider markup above playlist list. Wrap destinations in a container with class `.dest-grid` and CSS `max-height: 40vh; overflow: auto; display: grid; grid-template-columns: repeat(auto-fit, minmax(200px,1fr)); gap: 8px;`.

- [ ] Step 2: Add search & select all/none

Re-use `.match-search` input from `MatchPicker` and add two buttons: Select all / Select none that toggle selected destinations.

- [ ] Step 3: Tests & Commit

Add Tests verifying layout ordering (slider present before scrollable list) and that Select all/none work.

---

## Self-review

- Spec coverage: Each part from the spec has a Task mapping above.
- Placeholder scan: No TODO/TBD placeholders used.
- Type consistency: Function/variable names used (initPlayer, deepResolveTrack, SpotifyApiError, AuthError) are defined in their tasks; ensure implementation uses these exact names.

Plan saved to: docs/superpowers/plans/2026-07-22-implement-issues-plan.md

Next: choose execution approach.

Two execution options:
1. Subagent-Driven (recommended): I will dispatch subagents per task using superpowers:subagent-driven-development.
2. Inline Execution: execute these tasks interactively in this session using superpowers:executing-plans.

Which approach? (Pick one)
- [ ] Subagent-Driven (Recommended)
- [ ] Inline Execution

