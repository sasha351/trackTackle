# spotifyKondo — Sorter Implementation Plan

> **On approval:** save this entire document verbatim as `implementation.md` in the repo root (`/Users/sasha/Documents/spotifyKondo/implementation.md`) — the user asked for the full plan to live there — then execute it task by task.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A privacy-first, fully client-side web app that sorts Spotify Liked Songs into the user's playlists by deep-genre matching, with in-app playback, add-to-playlist + unlike flow, and undo.

**Architecture:** Static Vite + React + TypeScript SPA. No backend — OAuth happens via Authorization Code + PKCE entirely in the browser, tokens live in `localStorage`, and the only network calls are to Spotify (`accounts.spotify.com`, `api.spotify.com`, `sdk.scdn.co`) and MusicBrainz (`musicbrainz.org`). Genre data comes from Spotify where still available (verified by a capability probe early on) and MusicBrainz fills the gaps, cached locally per artist. Each target playlist gets a genre/decade fingerprint built from its existing songs; liked songs are scored against fingerprints deterministically.

**Tech Stack:** Vite 5+, React 18, TypeScript (strict), Vitest + @testing-library/react + jsdom, Spotify Web API, Spotify Web Playback SDK, MusicBrainz WS/2 API.

## Context

From `docs/idea.md` and the brainstorm record `docs/plan.md` (2026-07-14): the user manually sorts Liked Songs (treated as a *cache*) into genre/mood playlists (*storage*) using organizeyourmusic.playlistmachinery.com for genre labels. That site relies on Spotify endpoints (`audio_features`, artist genres via Get Artist) that Spotify has removed for new apps (Nov 2024 cut, Feb 2026 removed Get Artist / Get Several Artists). So this tool cannot assume Spotify genre data exists — the **first real task after auth is a capability probe**, and the genre pipeline is built as a chain: Spotify if available → MusicBrainz fallback → "none".

Decisions locked in during brainstorming and Q&A:
- Fully client-side static app; privacy-first means *no server to trust*.
- Sorter only in this plan. The playlist-breadth **Analyzer tab ships as a stub** ("coming soon") and gets its own follow-up plan.
- Match threshold: sensible default, user-adjustable via a settings slider.
- Runs on localhost now; keep everything migration-ready for static hosting (redirect URI derived from `location.origin`, no hardcoded hosts).
- Deterministic matching only: genre similarity primary, release-era secondary. No learning, no same-artist shortcuts.
- Below-threshold songs are badged "no strong match" but still show greyed top candidates; no-fit songs are clustered by shared genre into new-playlist suggestions.
- Removing from Liked loses the original added-date forever if re-liked → undo toast after every add+remove, plus a local removal log.
- Playback via Web Playback SDK (assumes Spotify Premium).

## Global Constraints

- **No backend, no third-party scripts, no analytics.** Only allowed hosts: `accounts.spotify.com`, `api.spotify.com`, `sdk.scdn.co` (playback SDK), `musicbrainz.org`.
- Tokens and caches live only in browser `localStorage`/`sessionStorage`, keys prefixed `kondo:`.
- TypeScript `strict: true` (Vite template default — do not weaken).
- All Spotify Web API endpoint paths live in `src/api/spotify.ts` only, so the Feb 2026 endpoint consolidation (e.g. possible `/me/library` forms) can be fixed in one file if the probe (Task 4) shows a path is gone.
- MusicBrainz: max 1 request/second, sequential queue (their rate-limit policy). Never parallelize MB calls.
- Redirect URI is always derived: `` `${window.location.origin}${import.meta.env.BASE_URL}callback` `` — never hardcoded, so static hosting later just means registering a second redirect URI.
- Dev server must be accessed at `http://127.0.0.1:5173` (Spotify requires loopback IP, not `localhost`, for HTTP redirect URIs).
- Spotify client ID comes from `.env.local` as `VITE_SPOTIFY_CLIENT_ID` (git-ignored via the template's `*.local` rule).
- Node 20+. Run tests with `npx vitest run`, dev server with `npm run dev`.
- Commit after every task (steps say when). Conventional-commit style messages (`feat:`, `test:`, `chore:`).

## One-time Manual Setup (user, before Task 2 can be verified live)

1. Go to https://developer.spotify.com/dashboard → Create app.
2. App name: `spotifyKondo`. Redirect URI: `http://127.0.0.1:5173/callback`. API/SDKs: Web API + Web Playback SDK.
3. Copy the Client ID into `.env.local` (created in Task 1).

## File Structure

```
implementation.md            ← this plan
.env.local                   ← VITE_SPOTIFY_CLIENT_ID (git-ignored)
src/
  main.tsx                   ← entry (Vite template)
  App.tsx                    ← auth gate + tab shell
  config.ts                  ← CLIENT_ID, REDIRECT_URI, SCOPES (browser-only; never import in pure modules)
  types.ts                   ← Track, Playlist, GenreInfo, MatchResult, SongMatch
  auth/pkce.ts               ← verifier/challenge/auth-URL (pure)
  auth/token.ts              ← exchange/refresh/localStorage token store
  api/spotify.ts             ← fetch wrapper (401/429 handling), pagination, ALL endpoints
  api/musicbrainz.ts         ← 1 req/s queue + artist genre lookup
  genre/resolver.ts          ← Spotify→MusicBrainz chain + localStorage cache
  matching/engine.ts         ← buildFingerprint, scoreSong, matchSong
  matching/clusters.ts       ← suggestClusters for no-fit songs
  player/spotifyPlayer.ts    ← Web Playback SDK wrapper
  storage/settings.ts        ← target playlists, threshold, sort order
  storage/removalLog.ts      ← permanent local log of unliked songs
  hooks/useLibrary.ts        ← data orchestration (load, resolve, match)
  components/Login.tsx
  components/Sorter.tsx      ← list + sort toggle + remaining count
  components/SongRow.tsx
  components/MatchPicker.tsx
  components/UndoToast.tsx
  components/Settings.tsx
  dev/probe.ts               ← DEV-only Spotify capability probe
  test/setup.ts
```

Tests live next to sources as `*.test.ts(x)` (e.g. `src/auth/pkce.test.ts`).

---

### Task 1: Scaffold — Vite + React + TS + Vitest

**Files:**
- Create: entire Vite template (via scaffold), `vite.config.ts` (modify), `src/test/setup.ts`, `src/App.test.tsx`, `.env.local`
- Delete: template cruft (`src/App.css` contents trimmed later as needed — leave as-is for now)

**Interfaces:**
- Consumes: nothing (greenfield; repo currently contains only `docs/`).
- Produces: working `npm run dev`, `npx vitest run`; `App` component other tasks extend.

- [ ] **Step 1: Scaffold into the existing repo**

The repo root is non-empty (`docs/`), so scaffold into a temp dir and move (non-interactive):

```bash
cd /Users/sasha/Documents/spotifyKondo
npm create vite@latest tmp-scaffold -- --template react-ts
mv tmp-scaffold/* tmp-scaffold/.gitignore .
rmdir tmp-scaffold
npm install
```

- [ ] **Step 2: Add Vitest + Testing Library**

```bash
npm install -D vitest jsdom @testing-library/react @testing-library/jest-dom
```

Replace `vite.config.ts` with:

```ts
/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
  },
});
```

Create `src/test/setup.ts`:

```ts
import '@testing-library/jest-dom/vitest';
```

Create `.env.local` (placeholder until the user pastes the real ID):

```
VITE_SPOTIFY_CLIENT_ID=REPLACE_ME
```

- [ ] **Step 3: Write the smoke test**

Create `src/App.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import App from './App';

it('renders the app shell', () => {
  render(<App />);
  expect(screen.getByText(/spotifyKondo/i)).toBeInTheDocument();
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run`
Expected: FAIL — the template `App` renders "Vite + React", not "spotifyKondo".

- [ ] **Step 5: Minimal App to pass**

Replace `src/App.tsx` with:

```tsx
function App() {
  return (
    <main>
      <h1>spotifyKondo</h1>
    </main>
  );
}

export default App;
```

- [ ] **Step 6: Run tests to verify pass**

Run: `npx vitest run`
Expected: PASS (1 test). Also run `npm run dev` briefly and confirm http://127.0.0.1:5173 shows "spotifyKondo".

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: scaffold Vite + React + TS app with Vitest"
```

### Task 2: PKCE primitives

**Files:**
- Create: `src/auth/pkce.ts`, `src/auth/pkce.test.ts`

**Interfaces:**
- Consumes: nothing (pure; uses Web Crypto, available in browsers and Node 20 test env).
- Produces: `generateVerifier(length?: number): string`, `challengeFromVerifier(verifier: string): Promise<string>`, `buildAuthUrl(opts: { clientId: string; redirectUri: string; scopes: string[]; verifier: string }): Promise<string>` — used by Task 10's Login flow.

- [ ] **Step 1: Write the failing tests**

Create `src/auth/pkce.test.ts`:

```ts
import { generateVerifier, challengeFromVerifier, buildAuthUrl } from './pkce';

it('generates a 64-char verifier from the RFC 7636 unreserved set', () => {
  const v = generateVerifier();
  expect(v).toHaveLength(64);
  expect(v).toMatch(/^[A-Za-z0-9\-._~]+$/);
  expect(generateVerifier()).not.toBe(generateVerifier());
});

it('computes the RFC 7636 appendix B challenge', async () => {
  // Known test vector from RFC 7636.
  const challenge = await challengeFromVerifier('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');
  expect(challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

it('builds the Spotify authorize URL', async () => {
  const url = new URL(
    await buildAuthUrl({
      clientId: 'abc123',
      redirectUri: 'http://127.0.0.1:5173/callback',
      scopes: ['user-library-read', 'streaming'],
      verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    }),
  );
  expect(url.origin + url.pathname).toBe('https://accounts.spotify.com/authorize');
  expect(url.searchParams.get('client_id')).toBe('abc123');
  expect(url.searchParams.get('response_type')).toBe('code');
  expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:5173/callback');
  expect(url.searchParams.get('scope')).toBe('user-library-read streaming');
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  expect(url.searchParams.get('code_challenge')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/auth/pkce.test.ts`
Expected: FAIL — module `./pkce` not found.

- [ ] **Step 3: Implement**

Create `src/auth/pkce.ts`:

```ts
const UNRESERVED = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';

export function generateVerifier(length = 64): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => UNRESERVED[b % UNRESERVED.length]).join('');
}

export async function challengeFromVerifier(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export async function buildAuthUrl(opts: {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  verifier: string;
}): Promise<string> {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    response_type: 'code',
    redirect_uri: opts.redirectUri,
    scope: opts.scopes.join(' '),
    code_challenge_method: 'S256',
    code_challenge: await challengeFromVerifier(opts.verifier),
  });
  return `https://accounts.spotify.com/authorize?${params}`;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run src/auth/pkce.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/auth/pkce.ts src/auth/pkce.test.ts
git commit -m "feat: PKCE verifier/challenge/auth-URL primitives"
```

---

### Task 3: Token store — exchange, refresh, persistence

**Files:**
- Create: `src/auth/token.ts`, `src/auth/token.test.ts`

**Interfaces:**
- Consumes: nothing new (uses `fetch`, `localStorage`).
- Produces (used by Task 4's fetch wrapper and Task 10's callback handler):
  - `interface TokenSet { accessToken: string; refreshToken: string; expiresAt: number }`
  - `saveTokens(t: TokenSet): void`, `loadTokens(): TokenSet | null`, `clearTokens(): void`
  - `exchangeCode(code: string, verifier: string, clientId: string, redirectUri: string): Promise<TokenSet>` (saves on success)
  - `getValidAccessToken(clientId: string): Promise<string>` (returns stored token; refreshes via `refresh_token` grant when within 60 s of expiry; throws `Error('not authenticated')` when no tokens)
  - `expireAccessToken(): void` (marks stored token expired — Task 4 uses it to force a refresh after a 401)

- [ ] **Step 1: Write the failing tests**

Create `src/auth/token.test.ts`:

```ts
import { afterEach, expect, it, vi } from 'vitest';
import {
  saveTokens, loadTokens, clearTokens, exchangeCode, getValidAccessToken, expireAccessToken,
} from './token';

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

function mockTokenResponse(body: object) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(body), { status: 200 }),
  );
}

it('round-trips tokens through localStorage', () => {
  const t = { accessToken: 'a', refreshToken: 'r', expiresAt: 123 };
  saveTokens(t);
  expect(loadTokens()).toEqual(t);
  clearTokens();
  expect(loadTokens()).toBeNull();
});

it('exchangeCode POSTs the authorization_code grant and saves the result', async () => {
  const spy = mockTokenResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 });
  const t = await exchangeCode('thecode', 'theverifier', 'cid', 'http://127.0.0.1:5173/callback');
  expect(t.accessToken).toBe('at');
  expect(loadTokens()?.refreshToken).toBe('rt');
  const [url, init] = spy.mock.calls[0];
  expect(url).toBe('https://accounts.spotify.com/api/token');
  const body = new URLSearchParams(init!.body as string);
  expect(body.get('grant_type')).toBe('authorization_code');
  expect(body.get('code')).toBe('thecode');
  expect(body.get('code_verifier')).toBe('theverifier');
});

it('getValidAccessToken returns the token untouched when fresh', async () => {
  saveTokens({ accessToken: 'fresh', refreshToken: 'r', expiresAt: Date.now() + 3600_000 });
  expect(await getValidAccessToken('cid')).toBe('fresh');
});

it('getValidAccessToken refreshes when expired (and after expireAccessToken)', async () => {
  saveTokens({ accessToken: 'old', refreshToken: 'r1', expiresAt: Date.now() + 3600_000 });
  expireAccessToken();
  const spy = mockTokenResponse({ access_token: 'new', refresh_token: 'r2', expires_in: 3600 });
  expect(await getValidAccessToken('cid')).toBe('new');
  const body = new URLSearchParams(spy.mock.calls[0][1]!.body as string);
  expect(body.get('grant_type')).toBe('refresh_token');
  expect(body.get('refresh_token')).toBe('r1');
  expect(loadTokens()?.refreshToken).toBe('r2');
});

it('getValidAccessToken throws when not authenticated', async () => {
  await expect(getValidAccessToken('cid')).rejects.toThrow('not authenticated');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/auth/token.test.ts`
Expected: FAIL — module `./token` not found.

- [ ] **Step 3: Implement**

Create `src/auth/token.ts`:

```ts
export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
}

const KEY = 'kondo:tokens';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';

export function saveTokens(t: TokenSet): void {
  localStorage.setItem(KEY, JSON.stringify(t));
}

export function loadTokens(): TokenSet | null {
  const raw = localStorage.getItem(KEY);
  return raw ? (JSON.parse(raw) as TokenSet) : null;
}

export function clearTokens(): void {
  localStorage.removeItem(KEY);
}

export function expireAccessToken(): void {
  const t = loadTokens();
  if (t) saveTokens({ ...t, expiresAt: 0 });
}

async function tokenRequest(body: URLSearchParams): Promise<TokenSet> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`token request failed: ${res.status}`);
  const json = await res.json();
  const t: TokenSet = {
    accessToken: json.access_token,
    // Spotify may omit a new refresh token on refresh; keep the old one.
    refreshToken: json.refresh_token ?? loadTokens()?.refreshToken ?? '',
    expiresAt: Date.now() + json.expires_in * 1000,
  };
  saveTokens(t);
  return t;
}

export async function exchangeCode(
  code: string, verifier: string, clientId: string, redirectUri: string,
): Promise<TokenSet> {
  return tokenRequest(new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
  }));
}

export async function getValidAccessToken(clientId: string): Promise<string> {
  const t = loadTokens();
  if (!t) throw new Error('not authenticated');
  if (Date.now() < t.expiresAt - 60_000) return t.accessToken;
  const refreshed = await tokenRequest(new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: t.refreshToken,
    client_id: clientId,
  }));
  return refreshed.accessToken;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run src/auth/token.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/auth/token.ts src/auth/token.test.ts
git commit -m "feat: token exchange, refresh, and localStorage persistence"
```

### Task 4: Spotify fetch wrapper — auth, 401 refresh, 429 backoff, pagination

**Files:**
- Create: `src/api/spotify.ts`, `src/api/spotify.test.ts`

**Interfaces:**
- Consumes: `getValidAccessToken`, `expireAccessToken` from `src/auth/token.ts` (Task 3).
- Produces (used by Tasks 5, 13, 14):
  - `configureSpotify(clientId: string): void` — must be called once at app start (Task 10 does it).
  - `spotifyFetch<T>(pathOrUrl: string, init?: RequestInit): Promise<T>` — prefixes `https://api.spotify.com/v1` for relative paths, injects `Authorization`, retries once on 401 (after forcing refresh), waits and retries on 429 (`Retry-After`), returns `undefined` for 204/empty bodies, throws `Error` with status otherwise.
  - `getAllPages<T>(firstPath: string): Promise<T[]>` — follows `next` links of Spotify paging objects.

- [ ] **Step 1: Write the failing tests**

Create `src/api/spotify.test.ts`:

```ts
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { configureSpotify, spotifyFetch, getAllPages } from './spotify';
import { saveTokens } from '../auth/token';

beforeEach(() => {
  configureSpotify('cid');
  saveTokens({ accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 3600_000 });
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

it('prefixes the base URL and sends the bearer token', async () => {
  const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
  );
  const json = await spotifyFetch<{ ok: boolean }>('/me');
  expect(json.ok).toBe(true);
  const [url, init] = spy.mock.calls[0];
  expect(url).toBe('https://api.spotify.com/v1/me');
  expect(new Headers(init!.headers).get('Authorization')).toBe('Bearer tok');
});

it('retries after 429 honoring Retry-After', async () => {
  vi.useFakeTimers();
  const spy = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '2' } }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  const promise = spotifyFetch<{ ok: boolean }>('/me');
  await vi.runAllTimersAsync();
  expect((await promise).ok).toBe(true);
  expect(spy).toHaveBeenCalledTimes(2);
  vi.useRealTimers();
});

it('forces a token refresh and retries once on 401', async () => {
  const spy = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response('', { status: 401 }))
    // refresh_token grant fired by getValidAccessToken:
    .mockResolvedValueOnce(new Response(
      JSON.stringify({ access_token: 'tok2', expires_in: 3600 }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  expect((await spotifyFetch<{ ok: boolean }>('/me')).ok).toBe(true);
  const lastInit = spy.mock.calls[2][1]!;
  expect(new Headers(lastInit.headers).get('Authorization')).toBe('Bearer tok2');
});

it('throws on non-retryable errors', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 403 }));
  await expect(spotifyFetch('/me')).rejects.toThrow('403');
});

it('getAllPages follows next links', async () => {
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response(JSON.stringify({
      items: [1, 2], next: 'https://api.spotify.com/v1/me/tracks?offset=2',
    }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({
      items: [3], next: null,
    }), { status: 200 }));
  expect(await getAllPages<number>('/me/tracks?limit=2')).toEqual([1, 2, 3]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/api/spotify.test.ts`
Expected: FAIL — module `./spotify` not found.

- [ ] **Step 3: Implement**

Create `src/api/spotify.ts`:

```ts
import { expireAccessToken, getValidAccessToken } from '../auth/token';

const BASE = 'https://api.spotify.com/v1';

let clientId = '';

export function configureSpotify(id: string): void {
  clientId = id;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function spotifyFetch<T>(pathOrUrl: string, init: RequestInit = {}): Promise<T> {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : BASE + pathOrUrl;
  let retried401 = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    const token = await getValidAccessToken(clientId);
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    if (init.body) headers.set('Content-Type', 'application/json');
    const res = await fetch(url, { ...init, headers });
    if (res.status === 429) {
      await sleep((Number(res.headers.get('Retry-After') ?? '1') + 0.5) * 1000);
      continue;
    }
    if (res.status === 401 && !retried401) {
      retried401 = true;
      expireAccessToken(); // next getValidAccessToken call runs the refresh grant
      continue;
    }
    if (!res.ok) throw new Error(`Spotify API ${res.status} for ${url}`);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
  throw new Error(`Spotify API gave up after retries: ${url}`);
}

interface Page<T> {
  items: T[];
  next: string | null;
}

export async function getAllPages<T>(firstPath: string): Promise<T[]> {
  const items: T[] = [];
  let url: string | null = firstPath;
  while (url) {
    const page: Page<T> = await spotifyFetch<Page<T>>(url);
    items.push(...page.items);
    url = page.next;
  }
  return items;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run src/api/spotify.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/api/spotify.ts src/api/spotify.test.ts
git commit -m "feat: Spotify fetch wrapper with 401 refresh, 429 backoff, pagination"
```

---

### Task 5: Domain types, Spotify endpoints, and the capability probe

**Files:**
- Create: `src/types.ts`, `src/dev/probe.ts`
- Modify: `src/api/spotify.ts` (append endpoint functions)
- Test: `src/api/endpoints.test.ts`

**Interfaces:**
- Consumes: `spotifyFetch`, `getAllPages` (Task 4).
- Produces:
  - `src/types.ts`:
    ```ts
    export interface Track {
      id: string; uri: string; name: string;
      artists: { id: string; name: string }[];
      albumName: string; releaseYear: number | null;
      isrc: string | null; addedAt: string; // ISO date from Spotify
    }
    export interface Playlist { id: string; name: string; trackCount: number }
    export interface PlaylistTrack { artists: { id: string; name: string }[]; releaseYear: number | null }
    export interface GenreInfo { genres: string[]; source: 'spotify' | 'musicbrainz' | 'none' }
    export interface MatchResult { playlistId: string; score: number }
    export interface SongMatch { best: MatchResult | null; alternates: MatchResult[]; belowThreshold: boolean }
    ```
  - New functions in `src/api/spotify.ts` (all endpoint paths stay in this one file):
    - `getMe(): Promise<{ id: string }>`
    - `getSavedTracks(): Promise<Track[]>`
    - `getMyPlaylists(): Promise<Playlist[]>` (only playlists owned by the current user)
    - `getPlaylistTracks(playlistId: string): Promise<PlaylistTrack[]>`
    - `addTracksToPlaylist(playlistId: string, uris: string[]): Promise<void>`
    - `removeTracksFromPlaylist(playlistId: string, uris: string[]): Promise<void>` (for undo)
    - `removeSavedTracks(ids: string[]): Promise<void>` (unlike)
    - `saveTracks(ids: string[]): Promise<void>` (re-like, for undo)
    - `getArtistGenres(artistId: string): Promise<string[]>` (may be dead per Feb 2026 changes — resolver handles failure)
  - `src/dev/probe.ts`: `runCapabilityProbe(): Promise<string[]>` — returns human-readable result lines; Task 10 wires a DEV-only button.

- [ ] **Step 1: Create `src/types.ts`** with exactly the content shown in the Interfaces block above.

- [ ] **Step 2: Write the failing tests**

Create `src/api/endpoints.test.ts`:

```ts
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  configureSpotify, getSavedTracks, getMyPlaylists, getPlaylistTracks,
  addTracksToPlaylist, removeSavedTracks,
} from './spotify';
import { saveTokens } from '../auth/token';

beforeEach(() => {
  configureSpotify('cid');
  saveTokens({ accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 3600_000 });
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

const page = (items: unknown[]) =>
  new Response(JSON.stringify({ items, next: null }), { status: 200 });

it('maps saved tracks to the Track shape', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(page([{
    added_at: '2024-03-01T00:00:00Z',
    track: {
      id: 't1', uri: 'spotify:track:t1', name: 'Song',
      artists: [{ id: 'a1', name: 'Artist' }],
      album: { name: 'Album', release_date: '1998-05-01' },
      external_ids: { isrc: 'USUM71703861' },
    },
  }]));
  const tracks = await getSavedTracks();
  expect(tracks).toEqual([{
    id: 't1', uri: 'spotify:track:t1', name: 'Song',
    artists: [{ id: 'a1', name: 'Artist' }],
    albumName: 'Album', releaseYear: 1998,
    isrc: 'USUM71703861', addedAt: '2024-03-01T00:00:00Z',
  }]);
});

it('keeps only playlists owned by me', async () => {
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'me1' }), { status: 200 }))
    .mockResolvedValueOnce(page([
      { id: 'p1', name: 'Mine', owner: { id: 'me1' }, tracks: { total: 10 } },
      { id: 'p2', name: 'Theirs', owner: { id: 'other' }, tracks: { total: 5 } },
    ]));
  expect(await getMyPlaylists()).toEqual([{ id: 'p1', name: 'Mine', trackCount: 10 }]);
});

it('maps playlist tracks and skips null tracks (local files)', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(page([
    { track: { artists: [{ id: 'a1', name: 'A' }], album: { release_date: '2011' } } },
    { track: null },
  ]));
  expect(await getPlaylistTracks('p1')).toEqual([
    { artists: [{ id: 'a1', name: 'A' }], releaseYear: 2011 },
  ]);
});

it('POSTs uris when adding to a playlist and DELETEs ids when unliking', async () => {
  const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 200 }));
  await addTracksToPlaylist('p1', ['spotify:track:t1']);
  await removeSavedTracks(['t1']);
  expect(spy.mock.calls[0][0]).toBe('https://api.spotify.com/v1/playlists/p1/tracks');
  expect(spy.mock.calls[0][1]!.method).toBe('POST');
  expect(JSON.parse(spy.mock.calls[0][1]!.body as string)).toEqual({ uris: ['spotify:track:t1'] });
  expect(spy.mock.calls[1][0]).toBe('https://api.spotify.com/v1/me/tracks');
  expect(spy.mock.calls[1][1]!.method).toBe('DELETE');
  expect(JSON.parse(spy.mock.calls[1][1]!.body as string)).toEqual({ ids: ['t1'] });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/api/endpoints.test.ts`
Expected: FAIL — the endpoint functions are not exported yet.

- [ ] **Step 4: Implement the endpoints**

Append to `src/api/spotify.ts`:

```ts
import type { Playlist, PlaylistTrack, Track } from '../types';

interface RawTrack {
  id: string; uri: string; name: string;
  artists: { id: string; name: string }[];
  album: { name: string; release_date?: string };
  external_ids?: { isrc?: string };
}

const yearOf = (releaseDate?: string): number | null => {
  const y = Number(releaseDate?.slice(0, 4));
  return Number.isFinite(y) && y > 0 ? y : null;
};

export async function getMe(): Promise<{ id: string }> {
  return spotifyFetch('/me');
}

export async function getSavedTracks(): Promise<Track[]> {
  const items = await getAllPages<{ added_at: string; track: RawTrack | null }>('/me/tracks?limit=50');
  return items
    .filter((i): i is { added_at: string; track: RawTrack } => i.track?.id != null)
    .map((i) => ({
      id: i.track.id,
      uri: i.track.uri,
      name: i.track.name,
      artists: i.track.artists.map((a) => ({ id: a.id, name: a.name })),
      albumName: i.track.album.name,
      releaseYear: yearOf(i.track.album.release_date),
      isrc: i.track.external_ids?.isrc ?? null,
      addedAt: i.added_at,
    }));
}

export async function getMyPlaylists(): Promise<Playlist[]> {
  const me = await getMe();
  const items = await getAllPages<{
    id: string; name: string; owner: { id: string }; tracks: { total: number };
  }>('/me/playlists?limit=50');
  return items
    .filter((p) => p.owner.id === me.id)
    .map((p) => ({ id: p.id, name: p.name, trackCount: p.tracks.total }));
}

export async function getPlaylistTracks(playlistId: string): Promise<PlaylistTrack[]> {
  const fields = encodeURIComponent('items(track(artists(id,name),album(release_date))),next');
  const items = await getAllPages<{ track: RawTrack | null }>(
    `/playlists/${playlistId}/tracks?limit=100&fields=${fields}`,
  );
  return items
    .filter((i): i is { track: RawTrack } => i.track != null)
    .map((i) => ({
      artists: i.track.artists.map((a) => ({ id: a.id, name: a.name })),
      releaseYear: yearOf(i.track.album.release_date),
    }));
}

export async function addTracksToPlaylist(playlistId: string, uris: string[]): Promise<void> {
  await spotifyFetch(`/playlists/${playlistId}/tracks`, {
    method: 'POST',
    body: JSON.stringify({ uris }),
  });
}

export async function removeTracksFromPlaylist(playlistId: string, uris: string[]): Promise<void> {
  await spotifyFetch(`/playlists/${playlistId}/tracks`, {
    method: 'DELETE',
    body: JSON.stringify({ tracks: uris.map((uri) => ({ uri })) }),
  });
}

export async function removeSavedTracks(ids: string[]): Promise<void> {
  await spotifyFetch('/me/tracks', { method: 'DELETE', body: JSON.stringify({ ids }) });
}

export async function saveTracks(ids: string[]): Promise<void> {
  await spotifyFetch('/me/tracks', { method: 'PUT', body: JSON.stringify({ ids }) });
}

export async function getArtistGenres(artistId: string): Promise<string[]> {
  const artist = await spotifyFetch<{ genres?: string[] }>(`/artists/${artistId}`);
  return artist.genres ?? [];
}
```

- [ ] **Step 5: Run tests to verify pass**

Run: `npx vitest run src/api/endpoints.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Write the capability probe (no unit test — it exists to be run live)**

Create `src/dev/probe.ts`:

```ts
// DEV-only: answers "what does a fresh Spotify app still get in 2026?"
// Run it once after first login (button on the login/sorter screen in DEV builds)
// and read the lines it returns. If `GET /artists/{id}` is dead, the genre
// resolver (src/genre/resolver.ts) will rely on MusicBrainz — no code change
// needed. If a library endpoint is dead, fix its path in src/api/spotify.ts.
import { getArtistGenres, getSavedTracks, spotifyFetch } from '../api/spotify';

export async function runCapabilityProbe(): Promise<string[]> {
  const lines: string[] = [];
  const probe = async (label: string, fn: () => Promise<unknown>) => {
    try {
      const result = await fn();
      lines.push(`OK   ${label}: ${JSON.stringify(result)?.slice(0, 120)}`);
    } catch (e) {
      lines.push(`FAIL ${label}: ${(e as Error).message}`);
    }
  };

  await probe('GET /me/tracks (1 item)', async () => {
    const tracks = await getSavedTracks();
    return { count: tracks.length, first: tracks[0]?.name, isrc: tracks[0]?.isrc };
  });

  const tracks = await getSavedTracks().catch(() => []);
  const artistId = tracks[0]?.artists[0]?.id;
  if (artistId) {
    await probe(`GET /artists/${artistId} genres`, () => getArtistGenres(artistId));
    await probe('GET /artists?ids= (batch)', () =>
      spotifyFetch<{ artists: { genres?: string[] }[] }>(`/artists?ids=${artistId}`));
  }
  await probe('GET /me/playlists', () => spotifyFetch('/me/playlists?limit=1'));
  return lines;
}
```

- [ ] **Step 7: Full test suite + commit**

Run: `npx vitest run`
Expected: PASS (all tests so far).

```bash
git add src/types.ts src/api/spotify.ts src/api/endpoints.test.ts src/dev/probe.ts
git commit -m "feat: domain types, Spotify library/playlist endpoints, capability probe"
```

### Task 6: MusicBrainz client — rate-limited artist genre lookup

**Files:**
- Create: `src/api/musicbrainz.ts`, `src/api/musicbrainz.test.ts`

**Interfaces:**
- Consumes: nothing project-internal.
- Produces (used by Task 7):
  - `lookupArtistGenres(artistName: string): Promise<string[]>` — searches MusicBrainz for the artist, and when the top hit scores ≥ 90 fetches its genres, returning up to 5 genre names sorted by vote count (lowercase). Returns `[]` on no confident match. Never throws for 404/no-match; throws on network/5xx (caller treats as retryable-later).
  - All requests flow through one sequential queue with ≥ 1.1 s spacing (MusicBrainz rate policy). Browsers can't set `User-Agent` on fetch (forbidden header); we set it anyway so Node-side tests/tools identify politely, and browsers just ignore it.

- [ ] **Step 1: Write the failing tests**

Create `src/api/musicbrainz.test.ts`:

```ts
import { afterEach, expect, it, vi } from 'vitest';
import { lookupArtistGenres } from './musicbrainz';

afterEach(() => vi.restoreAllMocks());

const json = (body: object) => new Response(JSON.stringify(body), { status: 200 });

it('searches then fetches genres for a confident match', async () => {
  const spy = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(json({ artists: [{ id: 'mbid-1', score: 100 }] }))
    .mockResolvedValueOnce(json({
      genres: [
        { name: 'Downtempo', count: 5 },
        { name: 'trip hop', count: 9 },
        { name: 'zero votes', count: 0 },
      ],
    }));
  const genres = await lookupArtistGenres('Portishead');
  expect(genres).toEqual(['trip hop', 'downtempo']); // sorted by count, lowercased, count>0 only
  expect(String(spy.mock.calls[0][0])).toContain('/ws/2/artist?query=');
  expect(String(spy.mock.calls[1][0])).toContain('/ws/2/artist/mbid-1?inc=genres');
});

it('returns [] when the top hit is not confident', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
    json({ artists: [{ id: 'mbid-2', score: 60 }] }),
  );
  expect(await lookupArtistGenres('Some Obscure Name')).toEqual([]);
});

it('spaces consecutive requests by at least 1.1s', async () => {
  vi.useFakeTimers();
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ artists: [] }));
  const t0 = Date.now();
  let done1 = 0;
  let done2 = 0;
  lookupArtistGenres('A').then(() => { done1 = Date.now() - t0; });
  lookupArtistGenres('B').then(() => { done2 = Date.now() - t0; });
  await vi.runAllTimersAsync();
  expect(done2 - done1).toBeGreaterThanOrEqual(1100);
  vi.useRealTimers();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/api/musicbrainz.test.ts`
Expected: FAIL — module `./musicbrainz` not found.

- [ ] **Step 3: Implement**

Create `src/api/musicbrainz.ts`:

```ts
const MB = 'https://musicbrainz.org/ws/2';
const UA = 'spotifyKondo/0.1.0 (alexshikhanovich@gmail.com)';
const MIN_SPACING_MS = 1100;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let lastRequestAt = 0;
let queue: Promise<unknown> = Promise.resolve();

function mbFetch<T>(path: string): Promise<T> {
  const run = async (): Promise<T> => {
    const wait = lastRequestAt + MIN_SPACING_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    const res = await fetch(`${MB}${path}`, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`MusicBrainz ${res.status} for ${path}`);
    return res.json();
  };
  const p = queue.then(run);
  queue = p.catch(() => {}); // one failure must not poison the queue
  return p;
}

export async function lookupArtistGenres(artistName: string): Promise<string[]> {
  const query = encodeURIComponent(`artist:"${artistName}"`);
  const search = await mbFetch<{ artists?: { id: string; score: number }[] }>(
    `/artist?query=${query}&fmt=json&limit=1`,
  );
  const top = search.artists?.[0];
  if (!top || top.score < 90) return [];
  const artist = await mbFetch<{ genres?: { name: string; count: number }[] }>(
    `/artist/${top.id}?inc=genres&fmt=json`,
  );
  return (artist.genres ?? [])
    .filter((g) => g.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map((g) => g.name.toLowerCase());
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run src/api/musicbrainz.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/api/musicbrainz.ts src/api/musicbrainz.test.ts
git commit -m "feat: rate-limited MusicBrainz artist genre lookup"
```

---

### Task 7: Genre resolver — Spotify→MusicBrainz chain with localStorage cache

**Files:**
- Create: `src/genre/resolver.ts`, `src/genre/resolver.test.ts`

**Interfaces:**
- Consumes: `getArtistGenres` (Task 5), `lookupArtistGenres` (Task 6), `GenreInfo` from `src/types.ts`.
- Produces (used by Task 11's `useLibrary`):
  - `resolveArtistGenres(artist: { id: string; name: string }): Promise<GenreInfo>` — order: cache → Spotify (`getArtistGenres`) → MusicBrainz → `{ genres: [], source: 'none' }`. Every resolved result (including `none`) is cached in `localStorage` under `kondo:genres:v1` keyed by artist id. If a Spotify genre call fails (endpoint removed for new apps), a **sticky module flag** disables Spotify for the rest of the session so we don't hammer a dead endpoint.
  - `resetResolverForTests(): void` — clears the sticky flag (test hook).
  - All genre strings are lowercased.

- [ ] **Step 1: Write the failing tests**

Create `src/genre/resolver.test.ts`:

```ts
import { afterEach, expect, it, vi } from 'vitest';
import { resolveArtistGenres, resetResolverForTests } from './resolver';
import * as spotify from '../api/spotify';
import * as mb from '../api/musicbrainz';

vi.mock('../api/spotify', () => ({ getArtistGenres: vi.fn() }));
vi.mock('../api/musicbrainz', () => ({ lookupArtistGenres: vi.fn() }));

const artist = { id: 'a1', name: 'Portishead' };

afterEach(() => {
  localStorage.clear();
  resetResolverForTests();
  vi.clearAllMocks();
});

it('uses Spotify genres when available and caches them', async () => {
  vi.mocked(spotify.getArtistGenres).mockResolvedValue(['Trip Hop']);
  expect(await resolveArtistGenres(artist)).toEqual({ genres: ['trip hop'], source: 'spotify' });
  // Second call is served from cache — no new API calls.
  expect(await resolveArtistGenres(artist)).toEqual({ genres: ['trip hop'], source: 'spotify' });
  expect(spotify.getArtistGenres).toHaveBeenCalledTimes(1);
  expect(mb.lookupArtistGenres).not.toHaveBeenCalled();
});

it('falls back to MusicBrainz when Spotify has no genres', async () => {
  vi.mocked(spotify.getArtistGenres).mockResolvedValue([]);
  vi.mocked(mb.lookupArtistGenres).mockResolvedValue(['trip hop']);
  expect(await resolveArtistGenres(artist)).toEqual({ genres: ['trip hop'], source: 'musicbrainz' });
});

it('disables Spotify for the session after its first failure', async () => {
  vi.mocked(spotify.getArtistGenres).mockRejectedValue(new Error('Spotify API 404'));
  vi.mocked(mb.lookupArtistGenres).mockResolvedValue([]);
  await resolveArtistGenres(artist);
  await resolveArtistGenres({ id: 'a2', name: 'Other' });
  expect(spotify.getArtistGenres).toHaveBeenCalledTimes(1); // sticky flag stopped call #2
});

it('returns source none when nothing is found (and caches it)', async () => {
  vi.mocked(spotify.getArtistGenres).mockResolvedValue([]);
  vi.mocked(mb.lookupArtistGenres).mockResolvedValue([]);
  expect(await resolveArtistGenres(artist)).toEqual({ genres: [], source: 'none' });
  expect(await resolveArtistGenres(artist)).toEqual({ genres: [], source: 'none' });
  expect(mb.lookupArtistGenres).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/genre/resolver.test.ts`
Expected: FAIL — module `./resolver` not found.

- [ ] **Step 3: Implement**

Create `src/genre/resolver.ts`:

```ts
import { getArtistGenres } from '../api/spotify';
import { lookupArtistGenres } from '../api/musicbrainz';
import type { GenreInfo } from '../types';

const CACHE_KEY = 'kondo:genres:v1';

type GenreCache = Record<string, GenreInfo>;

function readCache(): GenreCache {
  const raw = localStorage.getItem(CACHE_KEY);
  return raw ? (JSON.parse(raw) as GenreCache) : {};
}

function writeCache(id: string, info: GenreInfo): void {
  const cache = readCache();
  cache[id] = info;
  localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
}

// Fresh Spotify apps may have lost artist-genre access entirely (Feb 2026
// removals). One failure flips this for the whole session.
let spotifyGenresAvailable = true;

export function resetResolverForTests(): void {
  spotifyGenresAvailable = true;
}

export async function resolveArtistGenres(artist: { id: string; name: string }): Promise<GenreInfo> {
  const cached = readCache()[artist.id];
  if (cached) return cached;

  if (spotifyGenresAvailable) {
    try {
      const genres = await getArtistGenres(artist.id);
      if (genres.length > 0) {
        const info: GenreInfo = { genres: genres.map((g) => g.toLowerCase()), source: 'spotify' };
        writeCache(artist.id, info);
        return info;
      }
    } catch {
      spotifyGenresAvailable = false;
    }
  }

  const mbGenres = await lookupArtistGenres(artist.name);
  const info: GenreInfo = mbGenres.length > 0
    ? { genres: mbGenres, source: 'musicbrainz' }
    : { genres: [], source: 'none' };
  writeCache(artist.id, info);
  return info;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run src/genre/resolver.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/genre/resolver.ts src/genre/resolver.test.ts
git commit -m "feat: genre resolver with Spotify-first chain and local cache"
```

---

### Task 8: Matching engine — fingerprints, scoring, top-3 matches

**Files:**
- Create: `src/matching/engine.ts`, `src/matching/engine.test.ts`

**Interfaces:**
- Consumes: `MatchResult`, `SongMatch` from `src/types.ts`.
- Produces (used by Tasks 11–13):
  - `interface Fingerprint { genreWeights: Map<string, number>; decadeWeights: Map<number, number>; size: number }`
  - `DEFAULT_THRESHOLD = 0.3`
  - `buildFingerprint(songs: { genres: string[]; releaseYear: number | null }[]): Fingerprint` — genre weight = fraction of the playlist's songs carrying that genre; decade weight = fraction in that decade. Songs with no genres still count toward `size`.
  - `scoreSong(song: { genres: string[]; releaseYear: number | null }, fp: Fingerprint): number` — `0.85 × genreScore + 0.15 × eraScore`, where genreScore = mean playlist-weight of the song's genres and eraScore = playlist weight of the song's decade. Returns 0 when the song has no genres or the fingerprint is empty. Range [0, 1].
  - `matchSong(song, fingerprints: Map<string, Fingerprint>, threshold: number): SongMatch` — ranks all playlists by score; `best` = top (or `null` if no playlists), `alternates` = next two, `belowThreshold` = no best or best.score < threshold.

- [ ] **Step 1: Write the failing tests**

Create `src/matching/engine.test.ts`:

```ts
import { expect, it } from 'vitest';
import { buildFingerprint, scoreSong, matchSong, DEFAULT_THRESHOLD } from './engine';

const song = (genres: string[], releaseYear: number | null = null) => ({ genres, releaseYear });

it('builds normalized genre and decade weights', () => {
  const fp = buildFingerprint([
    song(['trip hop', 'downtempo'], 1994),
    song(['trip hop'], 1998),
    song([], 2011),
  ]);
  expect(fp.size).toBe(3);
  expect(fp.genreWeights.get('trip hop')).toBeCloseTo(2 / 3);
  expect(fp.genreWeights.get('downtempo')).toBeCloseTo(1 / 3);
  expect(fp.decadeWeights.get(1990)).toBeCloseTo(2 / 3);
  expect(fp.decadeWeights.get(2010)).toBeCloseTo(1 / 3);
});

it('scores a perfectly matching song near 1 and an unrelated song at 0', () => {
  const fp = buildFingerprint([song(['trip hop'], 1994), song(['trip hop'], 1998)]);
  expect(scoreSong(song(['trip hop'], 1995), fp)).toBeCloseTo(0.85 * 1 + 0.15 * 1);
  expect(scoreSong(song(['death metal'], 2020), fp)).toBe(0);
  expect(scoreSong(song([], 1995), fp)).toBe(0); // no genres → no claim
});

it('era is a secondary signal only', () => {
  const fp = buildFingerprint([song(['trip hop'], 1994)]);
  const rightGenreWrongEra = scoreSong(song(['trip hop'], 2020), fp);
  const wrongGenreRightEra = scoreSong(song(['polka'], 1995), fp);
  expect(rightGenreWrongEra).toBeCloseTo(0.85);
  expect(wrongGenreRightEra).toBeCloseTo(0.15);
  expect(rightGenreWrongEra).toBeGreaterThan(wrongGenreRightEra);
});

it('matchSong ranks playlists, returns two alternates, and flags below-threshold', () => {
  const fingerprints = new Map([
    ['pTrip', buildFingerprint([song(['trip hop'], 1994)])],
    ['pRock', buildFingerprint([song(['rock'], 1994)])],
    ['pJazz', buildFingerprint([song(['jazz'], 1960)])],
  ]);
  const hit = matchSong(song(['trip hop'], 1995), fingerprints, DEFAULT_THRESHOLD);
  expect(hit.best?.playlistId).toBe('pTrip');
  expect(hit.alternates).toHaveLength(2);
  expect(hit.belowThreshold).toBe(false);

  const miss = matchSong(song(['reggaeton'], 2019), fingerprints, DEFAULT_THRESHOLD);
  expect(miss.belowThreshold).toBe(true);
  expect(miss.best).not.toBeNull(); // still shows a greyed-out best guess

  const none = matchSong(song(['anything']), new Map(), DEFAULT_THRESHOLD);
  expect(none.best).toBeNull();
  expect(none.belowThreshold).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/matching/engine.test.ts`
Expected: FAIL — module `./engine` not found.

- [ ] **Step 3: Implement**

Create `src/matching/engine.ts`:

```ts
import type { SongMatch } from '../types';

export interface Fingerprint {
  genreWeights: Map<string, number>;
  decadeWeights: Map<number, number>;
  size: number;
}

export const DEFAULT_THRESHOLD = 0.3;

const GENRE_WEIGHT = 0.85;
const ERA_WEIGHT = 0.15;

const decadeOf = (year: number) => Math.floor(year / 10) * 10;

interface GenredSong {
  genres: string[];
  releaseYear: number | null;
}

export function buildFingerprint(songs: GenredSong[]): Fingerprint {
  const genreCounts = new Map<string, number>();
  const decadeCounts = new Map<number, number>();
  for (const s of songs) {
    for (const g of new Set(s.genres.map((x) => x.toLowerCase()))) {
      genreCounts.set(g, (genreCounts.get(g) ?? 0) + 1);
    }
    if (s.releaseYear != null) {
      const d = decadeOf(s.releaseYear);
      decadeCounts.set(d, (decadeCounts.get(d) ?? 0) + 1);
    }
  }
  const genreWeights = new Map(
    [...genreCounts].map(([g, n]) => [g, n / songs.length] as const),
  );
  const decadeWeights = new Map(
    [...decadeCounts].map(([d, n]) => [d, n / songs.length] as const),
  );
  return { genreWeights, decadeWeights, size: songs.length };
}

export function scoreSong(song: GenredSong, fp: Fingerprint): number {
  const genres = [...new Set(song.genres.map((g) => g.toLowerCase()))];
  if (genres.length === 0 || fp.size === 0) return 0;
  const genreScore =
    genres.reduce((sum, g) => sum + (fp.genreWeights.get(g) ?? 0), 0) / genres.length;
  const eraScore =
    song.releaseYear != null ? fp.decadeWeights.get(decadeOf(song.releaseYear)) ?? 0 : 0;
  return Math.min(1, GENRE_WEIGHT * genreScore + ERA_WEIGHT * eraScore);
}

export function matchSong(
  song: GenredSong,
  fingerprints: Map<string, Fingerprint>,
  threshold: number,
): SongMatch {
  const ranked = [...fingerprints]
    .map(([playlistId, fp]) => ({ playlistId, score: scoreSong(song, fp) }))
    .sort((a, b) => b.score - a.score);
  const best = ranked[0] ?? null;
  return {
    best,
    alternates: ranked.slice(1, 3),
    belowThreshold: best === null || best.score < threshold,
  };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run src/matching/engine.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/matching/engine.ts src/matching/engine.test.ts
git commit -m "feat: playlist fingerprints and deterministic match scoring"
```

---

### Task 9: New-playlist suggestions for no-fit songs

**Files:**
- Create: `src/matching/clusters.ts`, `src/matching/clusters.test.ts`

**Interfaces:**
- Consumes: nothing project-internal.
- Produces (used by Task 12's Sorter footer):
  - `suggestClusters(songs: { trackId: string; genres: string[] }[], minSize?: number): { genre: string; trackIds: string[] }[]` — greedy: repeatedly take the genre shared by the most unclaimed songs, claim those songs, stop when the biggest remaining group < `minSize` (default 5). Result ordered largest-first.

- [ ] **Step 1: Write the failing test**

Create `src/matching/clusters.test.ts`:

```ts
import { expect, it } from 'vitest';
import { suggestClusters } from './clusters';

it('greedily clusters no-fit songs by their most common shared genre', () => {
  const songs = [
    { trackId: 't1', genres: ['downtempo', 'chill'] },
    { trackId: 't2', genres: ['downtempo'] },
    { trackId: 't3', genres: ['downtempo', 'idm'] },
    { trackId: 't4', genres: ['idm'] },
    { trackId: 't5', genres: [] },
  ];
  const clusters = suggestClusters(songs, 3);
  expect(clusters).toEqual([{ genre: 'downtempo', trackIds: ['t1', 't2', 't3'] }]);
  // t4's idm group only has size 1 after downtempo claimed t3 → below minSize.
});

it('returns [] when nothing reaches minSize', () => {
  expect(suggestClusters([{ trackId: 't1', genres: ['x'] }], 5)).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/matching/clusters.test.ts`
Expected: FAIL — module `./clusters` not found.

- [ ] **Step 3: Implement**

Create `src/matching/clusters.ts`:

```ts
export interface ClusterSuggestion {
  genre: string;
  trackIds: string[];
}

export function suggestClusters(
  songs: { trackId: string; genres: string[] }[],
  minSize = 5,
): ClusterSuggestion[] {
  const remaining = new Map(songs.map((s) => [s.trackId, s] as const));
  const out: ClusterSuggestion[] = [];
  for (;;) {
    const byGenre = new Map<string, string[]>();
    for (const s of remaining.values()) {
      for (const g of new Set(s.genres.map((x) => x.toLowerCase()))) {
        byGenre.set(g, [...(byGenre.get(g) ?? []), s.trackId]);
      }
    }
    const biggest = [...byGenre.entries()].sort((a, b) => b[1].length - a[1].length)[0];
    if (!biggest || biggest[1].length < minSize) return out;
    out.push({ genre: biggest[0], trackIds: biggest[1] });
    for (const id of biggest[1]) remaining.delete(id);
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run src/matching/clusters.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/matching/clusters.ts src/matching/clusters.test.ts
git commit -m "feat: cluster no-fit songs into new-playlist suggestions"
```

### Task 10: App shell — config, login, OAuth callback, tabs

**Files:**
- Create: `src/config.ts`, `src/components/Login.tsx`, `src/components/Sorter.tsx` (placeholder), `src/components/Settings.tsx` (placeholder)
- Modify: `src/App.tsx`, `src/App.test.tsx`

**Interfaces:**
- Consumes: `generateVerifier`/`buildAuthUrl` (Task 2), `exchangeCode`/`loadTokens`/`clearTokens` (Task 3), `configureSpotify` (Task 4), `runCapabilityProbe` (Task 5).
- Produces:
  - `src/config.ts` (browser-only — never import from pure modules or their tests):
    ```ts
    export const CLIENT_ID = import.meta.env.VITE_SPOTIFY_CLIENT_ID as string;
    export const REDIRECT_URI = `${window.location.origin}${import.meta.env.BASE_URL}callback`;
    export const SCOPES = [
      'user-library-read', 'user-library-modify',
      'playlist-read-private', 'playlist-modify-public', 'playlist-modify-private',
      'streaming', 'user-read-email', 'user-read-private',
    ];
    ```
  - `App` renders `Login` when unauthenticated; when authenticated renders tab nav (Sorter / Analyzer / Settings) with Analyzer as a hardcoded "coming soon" stub. Placeholder `Sorter`/`Settings` components (no props yet — Tasks 13/15 replace them and thread props through `App`).
  - Verifier is stashed in `sessionStorage` under `kondo:verifier` before redirecting to Spotify.

- [ ] **Step 1: Replace `src/App.test.tsx` with failing tests**

```tsx
import { render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import App from './App';
import { saveTokens } from './auth/token';

afterEach(() => localStorage.clear());

it('shows the login button when unauthenticated', () => {
  render(<App />);
  expect(screen.getByRole('button', { name: /log in with spotify/i })).toBeInTheDocument();
});

it('shows the tab nav when authenticated', () => {
  saveTokens({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 });
  render(<App />);
  expect(screen.getByRole('button', { name: /sorter/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /analyzer/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /settings/i })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/App.test.tsx`
Expected: FAIL — no login button / no tabs in the Task 1 shell.

- [ ] **Step 3: Implement**

Create `src/config.ts` exactly as in the Interfaces block above.

Create `src/components/Login.tsx`:

```tsx
import { useState } from 'react';
import { buildAuthUrl, generateVerifier } from '../auth/pkce';
import { CLIENT_ID, REDIRECT_URI, SCOPES } from '../config';
import { runCapabilityProbe } from '../dev/probe';

export default function Login() {
  const [probeLines, setProbeLines] = useState<string[]>([]);

  const login = async () => {
    const verifier = generateVerifier();
    sessionStorage.setItem('kondo:verifier', verifier);
    window.location.href = await buildAuthUrl({
      clientId: CLIENT_ID, redirectUri: REDIRECT_URI, scopes: SCOPES, verifier,
    });
  };

  return (
    <div>
      <p>Sort your Liked Songs into playlists. Everything stays in this browser.</p>
      <button onClick={login}>Log in with Spotify</button>
      {import.meta.env.DEV && (
        <div>
          <button onClick={() => runCapabilityProbe().then(setProbeLines)}>
            Run API capability probe (needs prior login)
          </button>
          <pre>{probeLines.join('\n')}</pre>
        </div>
      )}
    </div>
  );
}
```

Create placeholder `src/components/Sorter.tsx`:

```tsx
export default function Sorter() {
  return <p>Sorter loading…</p>;
}
```

Create placeholder `src/components/Settings.tsx`:

```tsx
export default function Settings() {
  return <p>Settings coming soon.</p>;
}
```

Replace `src/App.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { configureSpotify } from './api/spotify';
import { clearTokens, exchangeCode, loadTokens } from './auth/token';
import { CLIENT_ID, REDIRECT_URI } from './config';
import Login from './components/Login';
import Sorter from './components/Sorter';
import Settings from './components/Settings';

configureSpotify(CLIENT_ID);

type Tab = 'sorter' | 'analyzer' | 'settings';

export default function App() {
  const [authed, setAuthed] = useState(() => loadTokens() !== null);
  const [tab, setTab] = useState<Tab>('sorter');
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('code');
    if (!code) return;
    // Consume the verifier: StrictMode double-invokes effects in dev, and an
    // auth code is single-use — the second pass must not re-exchange.
    const verifier = sessionStorage.getItem('kondo:verifier');
    if (!verifier) return;
    sessionStorage.removeItem('kondo:verifier');
    exchangeCode(code, verifier, CLIENT_ID, REDIRECT_URI)
      .then(() => setAuthed(true))
      .catch((e) => setAuthError(String(e)))
      .finally(() => window.history.replaceState(null, '', import.meta.env.BASE_URL));
  }, []);

  const logout = () => {
    clearTokens();
    setAuthed(false);
  };

  return (
    <main>
      <header>
        <h1>spotifyKondo</h1>
        {authed && (
          <nav>
            <button onClick={() => setTab('sorter')}>Sorter</button>
            <button onClick={() => setTab('analyzer')}>Analyzer</button>
            <button onClick={() => setTab('settings')}>Settings</button>
            <button onClick={logout}>Log out</button>
          </nav>
        )}
      </header>
      {authError && <p role="alert">{authError}</p>}
      {!authed && <Login />}
      {authed && tab === 'sorter' && <Sorter />}
      {authed && tab === 'analyzer' && <p>Analyzer — coming soon (separate plan).</p>}
      {authed && tab === 'settings' && <Settings />}
    </main>
  );
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run`
Expected: PASS (all suites).

- [ ] **Step 5: Live verification (requires the manual Spotify app setup)**

Run `npm run dev`, open http://127.0.0.1:5173, click "Log in with Spotify", approve, land back authenticated with tabs visible. Then log in, reload, and click **Run API capability probe** — record its output lines in a new section at the bottom of `implementation.md` titled `## Probe results (YYYY-MM-DD)`. If `GET /artists/{id}` reports FAIL, note "genre source = MusicBrainz only" (the resolver already handles this). If any library/playlist endpoint FAILs, fix its path in `src/api/spotify.ts` (check the current Web API reference) before continuing.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: app shell with PKCE login, OAuth callback, and tab nav"
```

---

### Task 11: Settings storage + `useLibrary` orchestration hook

**Files:**
- Create: `src/storage/settings.ts`, `src/storage/settings.test.ts`, `src/hooks/useLibrary.ts`, `src/hooks/useLibrary.test.ts`

**Interfaces:**
- Consumes: `getSavedTracks`, `getMyPlaylists`, `getPlaylistTracks` (Task 5), `resolveArtistGenres` (Task 7), `buildFingerprint`/`matchSong`/`DEFAULT_THRESHOLD` (Task 8), types (Task 5).
- Produces:
  - `src/storage/settings.ts`:
    ```ts
    export interface KondoSettings {
      targetPlaylistIds: string[] | null; // null = all owned playlists
      threshold: number;
      sortOrder: 'oldest' | 'newest';
    }
    export function loadSettings(): KondoSettings; // defaults: { targetPlaylistIds: null, threshold: DEFAULT_THRESHOLD, sortOrder: 'oldest' }
    export function saveSettings(s: KondoSettings): void; // key 'kondo:settings:v1'
    ```
  - `src/hooks/useLibrary.ts`:
    ```ts
    export interface LibraryData {
      tracks: Track[];
      playlists: Playlist[];
      genresByTrack: Map<string, string[]>;
      matches: Map<string, SongMatch>;
    }
    // Pure async orchestrator (exported for tests); onProgress fires per resolved artist.
    export async function loadLibrary(
      settings: KondoSettings,
      onProgress: (resolved: number, total: number) => void,
    ): Promise<LibraryData>;
    export interface LibraryState extends LibraryData {
      status: 'loading' | 'ready' | 'error';
      error: string | null;
      progress: { resolved: number; total: number };
      removeTrackLocally(id: string): void;
      restoreTrackLocally(t: Track): void;
    }
    export function useLibrary(settings: KondoSettings): LibraryState;
    ```
  - Genre resolution is per **unique artist** across liked + playlist tracks (the localStorage cache from Task 7 makes reruns cheap; MusicBrainz's 1 req/s limit makes the first run slow — that's why progress is surfaced).

- [ ] **Step 1: Write the failing tests**

Create `src/storage/settings.test.ts`:

```ts
import { afterEach, expect, it } from 'vitest';
import { loadSettings, saveSettings } from './settings';
import { DEFAULT_THRESHOLD } from '../matching/engine';

afterEach(() => localStorage.clear());

it('returns defaults when nothing is stored', () => {
  expect(loadSettings()).toEqual({
    targetPlaylistIds: null, threshold: DEFAULT_THRESHOLD, sortOrder: 'oldest',
  });
});

it('round-trips saved settings', () => {
  saveSettings({ targetPlaylistIds: ['p1'], threshold: 0.5, sortOrder: 'newest' });
  expect(loadSettings()).toEqual({ targetPlaylistIds: ['p1'], threshold: 0.5, sortOrder: 'newest' });
});
```

Create `src/hooks/useLibrary.test.ts`:

```ts
import { expect, it, vi } from 'vitest';
import { loadLibrary } from './useLibrary';
import * as spotify from '../api/spotify';
import * as resolver from '../genre/resolver';

vi.mock('../api/spotify', () => ({
  getSavedTracks: vi.fn(),
  getMyPlaylists: vi.fn(),
  getPlaylistTracks: vi.fn(),
}));
vi.mock('../genre/resolver', () => ({ resolveArtistGenres: vi.fn() }));

const likedTrack = {
  id: 't1', uri: 'spotify:track:t1', name: 'Glory Box',
  artists: [{ id: 'a1', name: 'Portishead' }],
  albumName: 'Dummy', releaseYear: 1994, isrc: null, addedAt: '2024-01-01T00:00:00Z',
};

it('loads, resolves genres per unique artist, fingerprints, and matches', async () => {
  vi.mocked(spotify.getSavedTracks).mockResolvedValue([likedTrack]);
  vi.mocked(spotify.getMyPlaylists).mockResolvedValue([
    { id: 'p1', name: 'Trip', trackCount: 1 },
    { id: 'p2', name: 'Excluded', trackCount: 1 },
  ]);
  vi.mocked(spotify.getPlaylistTracks).mockResolvedValue([
    { artists: [{ id: 'a2', name: 'Massive Attack' }], releaseYear: 1998 },
  ]);
  vi.mocked(resolver.resolveArtistGenres).mockResolvedValue({
    genres: ['trip hop'], source: 'musicbrainz',
  });

  const progress: [number, number][] = [];
  const lib = await loadLibrary(
    { targetPlaylistIds: ['p1'], threshold: 0.3, sortOrder: 'oldest' },
    (r, t) => progress.push([r, t]),
  );

  expect(lib.playlists.map((p) => p.id)).toEqual(['p1']); // p2 filtered out
  expect(spotify.getPlaylistTracks).toHaveBeenCalledTimes(1); // only target playlists fetched
  // 2 unique artists (a1 liked, a2 in playlist) → resolver called once each.
  expect(resolver.resolveArtistGenres).toHaveBeenCalledTimes(2);
  expect(progress.at(-1)).toEqual([2, 2]);
  expect(lib.genresByTrack.get('t1')).toEqual(['trip hop']);
  const match = lib.matches.get('t1')!;
  expect(match.best?.playlistId).toBe('p1');
  expect(match.belowThreshold).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/storage/settings.test.ts src/hooks/useLibrary.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

Create `src/storage/settings.ts`:

```ts
import { DEFAULT_THRESHOLD } from '../matching/engine';

export interface KondoSettings {
  targetPlaylistIds: string[] | null;
  threshold: number;
  sortOrder: 'oldest' | 'newest';
}

const KEY = 'kondo:settings:v1';

const DEFAULTS: KondoSettings = {
  targetPlaylistIds: null,
  threshold: DEFAULT_THRESHOLD,
  sortOrder: 'oldest',
};

export function loadSettings(): KondoSettings {
  const raw = localStorage.getItem(KEY);
  return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<KondoSettings>) } : { ...DEFAULTS };
}

export function saveSettings(s: KondoSettings): void {
  localStorage.setItem(KEY, JSON.stringify(s));
}
```

Create `src/hooks/useLibrary.ts`:

```ts
import { useEffect, useState } from 'react';
import { getMyPlaylists, getPlaylistTracks, getSavedTracks } from '../api/spotify';
import { resolveArtistGenres } from '../genre/resolver';
import { buildFingerprint, matchSong, type Fingerprint } from '../matching/engine';
import type { KondoSettings } from '../storage/settings';
import type { Playlist, PlaylistTrack, SongMatch, Track } from '../types';

export interface LibraryData {
  tracks: Track[];
  playlists: Playlist[];
  genresByTrack: Map<string, string[]>;
  matches: Map<string, SongMatch>;
}

export async function loadLibrary(
  settings: KondoSettings,
  onProgress: (resolved: number, total: number) => void,
): Promise<LibraryData> {
  const [tracks, allPlaylists] = await Promise.all([getSavedTracks(), getMyPlaylists()]);
  const playlists = settings.targetPlaylistIds
    ? allPlaylists.filter((p) => settings.targetPlaylistIds!.includes(p.id))
    : allPlaylists;

  const playlistTracks = new Map<string, PlaylistTrack[]>();
  for (const p of playlists) {
    playlistTracks.set(p.id, await getPlaylistTracks(p.id));
  }

  // Genre resolution is per unique artist — the cache and MB rate limit both
  // work in our favor this way.
  const artists = new Map<string, { id: string; name: string }>();
  for (const t of tracks) for (const a of t.artists) artists.set(a.id, a);
  for (const pts of playlistTracks.values()) {
    for (const pt of pts) for (const a of pt.artists) artists.set(a.id, a);
  }

  const genresByArtist = new Map<string, string[]>();
  let resolved = 0;
  for (const a of artists.values()) {
    genresByArtist.set(a.id, (await resolveArtistGenres(a)).genres);
    resolved += 1;
    onProgress(resolved, artists.size);
  }

  const genresOf = (as: { id: string }[]) =>
    [...new Set(as.flatMap((a) => genresByArtist.get(a.id) ?? []))];

  const fingerprints = new Map<string, Fingerprint>(
    playlists.map((p) => [
      p.id,
      buildFingerprint(
        (playlistTracks.get(p.id) ?? []).map((pt) => ({
          genres: genresOf(pt.artists),
          releaseYear: pt.releaseYear,
        })),
      ),
    ]),
  );

  const genresByTrack = new Map(tracks.map((t) => [t.id, genresOf(t.artists)]));
  const matches = new Map(
    tracks.map((t) => [
      t.id,
      matchSong(
        { genres: genresByTrack.get(t.id) ?? [], releaseYear: t.releaseYear },
        fingerprints,
        settings.threshold,
      ),
    ]),
  );

  return { tracks, playlists, genresByTrack, matches };
}

export interface LibraryState extends LibraryData {
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  progress: { resolved: number; total: number };
  removeTrackLocally(id: string): void;
  restoreTrackLocally(t: Track): void;
}

const EMPTY: LibraryData = {
  tracks: [], playlists: [], genresByTrack: new Map(), matches: new Map(),
};

export function useLibrary(settings: KondoSettings): LibraryState {
  const [data, setData] = useState<LibraryData>(EMPTY);
  const [status, setStatus] = useState<LibraryState['status']>('loading');
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState({ resolved: 0, total: 0 });

  const settingsKey = `${settings.threshold}|${settings.targetPlaylistIds?.join(',') ?? '*'}`;

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    loadLibrary(settings, (resolved, total) => {
      if (!cancelled) setProgress({ resolved, total });
    })
      .then((lib) => {
        if (cancelled) return;
        setData(lib);
        setStatus('ready');
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e));
        setStatus('error');
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsKey]);

  return {
    ...data,
    status,
    error,
    progress,
    removeTrackLocally: (id) =>
      setData((d) => ({ ...d, tracks: d.tracks.filter((t) => t.id !== id) })),
    restoreTrackLocally: (t) =>
      setData((d) => ({ ...d, tracks: [...d.tracks, t] })),
  };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run`
Expected: PASS (all suites).

- [ ] **Step 5: Commit**

```bash
git add src/storage/settings.ts src/storage/settings.test.ts src/hooks/useLibrary.ts src/hooks/useLibrary.test.ts
git commit -m "feat: settings storage and library-loading orchestration hook"
```

### Task 12: Presentational components — SongRow and MatchPicker

**Files:**
- Create: `src/components/MatchPicker.tsx`, `src/components/MatchPicker.test.tsx`, `src/components/SongRow.tsx`, `src/components/SongRow.test.tsx`

**Interfaces:**
- Consumes: `SongMatch`, `Track` types.
- Produces (used by Task 13's Sorter):
  - `MatchPicker({ match, playlistNames, onAdd }: { match: SongMatch | undefined; playlistNames: Map<string, string>; onAdd: (playlistIds: string[]) => void })` — shows the best match with a `<select>` swapping among the top 3, an **Add** button, a `<details>` "add to multiple" checkbox list of the top 3, and a "no strong match" badge + `no-match` CSS class when `belowThreshold`. Renders `…` while `match` is `undefined` (genres still resolving).
  - `SongRow({ track, genres, matchSlot }: { track: Track; genres: string[] | undefined; matchSlot: React.ReactNode })` — one `<li>` with song name, artists, genres (or `…`), date added (YYYY-MM-DD), and the match slot (MatchPicker + play button injected by the Sorter).

- [ ] **Step 1: Write the failing tests**

Create `src/components/MatchPicker.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import MatchPicker from './MatchPicker';

const playlistNames = new Map([
  ['p1', 'Trip Hop'], ['p2', 'Chill'], ['p3', 'Rock'],
]);
const match = {
  best: { playlistId: 'p1', score: 0.8 },
  alternates: [
    { playlistId: 'p2', score: 0.5 },
    { playlistId: 'p3', score: 0.2 },
  ],
  belowThreshold: false,
};

it('adds the best match by default', async () => {
  const onAdd = vi.fn();
  render(<MatchPicker match={match} playlistNames={playlistNames} onAdd={onAdd} />);
  await userEvent.click(screen.getByRole('button', { name: /^add$/i }));
  expect(onAdd).toHaveBeenCalledWith(['p1']);
});

it('swaps the target via the dropdown', async () => {
  const onAdd = vi.fn();
  render(<MatchPicker match={match} playlistNames={playlistNames} onAdd={onAdd} />);
  await userEvent.selectOptions(screen.getByRole('combobox'), 'p2');
  await userEvent.click(screen.getByRole('button', { name: /^add$/i }));
  expect(onAdd).toHaveBeenCalledWith(['p2']);
});

it('supports adding to multiple playlists', async () => {
  const onAdd = vi.fn();
  render(<MatchPicker match={match} playlistNames={playlistNames} onAdd={onAdd} />);
  await userEvent.click(screen.getByText(/multiple/i));
  await userEvent.click(screen.getByRole('checkbox', { name: /chill/i }));
  await userEvent.click(screen.getByRole('button', { name: /^add$/i }));
  expect(onAdd).toHaveBeenCalledWith(['p1', 'p2']);
});

it('badges below-threshold matches but keeps them usable', () => {
  render(
    <MatchPicker
      match={{ ...match, belowThreshold: true }}
      playlistNames={playlistNames}
      onAdd={vi.fn()}
    />,
  );
  expect(screen.getByText(/no strong match/i)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^add$/i })).toBeEnabled();
});

it('renders a placeholder while match is undefined', () => {
  render(<MatchPicker match={undefined} playlistNames={playlistNames} onAdd={vi.fn()} />);
  expect(screen.getByText('…')).toBeInTheDocument();
});
```

Create `src/components/SongRow.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import SongRow from './SongRow';

const track = {
  id: 't1', uri: 'spotify:track:t1', name: 'Glory Box',
  artists: [{ id: 'a1', name: 'Portishead' }],
  albumName: 'Dummy', releaseYear: 1994, isrc: null, addedAt: '2024-03-05T12:00:00Z',
};

it('renders name, artists, genres, and date added', () => {
  render(
    <ul>
      <SongRow track={track} genres={['trip hop']} matchSlot={<span>MATCH</span>} />
    </ul>,
  );
  expect(screen.getByText('Glory Box')).toBeInTheDocument();
  expect(screen.getByText('Portishead')).toBeInTheDocument();
  expect(screen.getByText('trip hop')).toBeInTheDocument();
  expect(screen.getByText('2024-03-05')).toBeInTheDocument();
  expect(screen.getByText('MATCH')).toBeInTheDocument();
});
```

Install the missing dev dependency first:

```bash
npm install -D @testing-library/user-event
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

Create `src/components/MatchPicker.tsx`:

```tsx
import { useState } from 'react';
import type { SongMatch } from '../types';

interface Props {
  match: SongMatch | undefined;
  playlistNames: Map<string, string>;
  onAdd: (playlistIds: string[]) => void;
}

export default function MatchPicker({ match, playlistNames, onAdd }: Props) {
  const [selected, setSelected] = useState<string | null>(null);
  const [extra, setExtra] = useState<string[]>([]);

  if (!match) return <span>…</span>;
  if (!match.best) return <span className="no-match">no candidate playlists</span>;

  const options = [match.best, ...match.alternates];
  const current = selected ?? match.best.playlistId;
  const nameOf = (id: string) => playlistNames.get(id) ?? id;

  const toggleExtra = (id: string) =>
    setExtra((xs) => (xs.includes(id) ? xs.filter((x) => x !== id) : [...xs, id]));

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
      <button onClick={() => onAdd([...new Set([current, ...extra])])}>Add</button>
      <details>
        <summary>multiple</summary>
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
      </details>
    </span>
  );
}
```

Create `src/components/SongRow.tsx`:

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
      <span className="song-name">{track.name}</span>
      <span className="song-artists">{track.artists.map((a) => a.name).join(', ')}</span>
      <span className="song-genres">{genres ? genres.join(', ') || '—' : '…'}</span>
      <span className="song-added">{track.addedAt.slice(0, 10)}</span>
      {matchSlot}
    </li>
  );
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run src/components`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/components/MatchPicker.tsx src/components/MatchPicker.test.tsx src/components/SongRow.tsx src/components/SongRow.test.tsx
git commit -m "feat: SongRow and MatchPicker presentational components"
```

---

### Task 13: Removal log, undo toast, and the Sorter container

**Files:**
- Create: `src/storage/removalLog.ts`, `src/storage/removalLog.test.ts`, `src/components/UndoToast.tsx`
- Modify: `src/components/Sorter.tsx` (replace placeholder), `src/App.tsx` (lift settings state)
- Test: `src/components/Sorter.test.tsx`

**Interfaces:**
- Consumes: `useLibrary` (Task 11), `SongRow`/`MatchPicker` (Task 12), `addTracksToPlaylist`/`removeSavedTracks`/`saveTracks`/`removeTracksFromPlaylist` (Task 5), `suggestClusters` (Task 9), `loadSettings`/`saveSettings`/`KondoSettings` (Task 11).
- Produces:
  - `src/storage/removalLog.ts`:
    ```ts
    export interface RemovalEntry {
      trackId: string; name: string; artists: string;
      addedAt: string; removedAt: string; playlistIds: string[];
    }
    export function logRemoval(entry: RemovalEntry): void;   // appends to 'kondo:removals:v1'
    export function removeFromLog(trackId: string, removedAt: string): void; // for undo
    export function getRemovalLog(): RemovalEntry[];
    ```
  - `UndoToast({ message, onUndo, onDismiss }: { message: string; onUndo: () => void; onDismiss: () => void })` — renders message + Undo button, auto-calls `onDismiss` after 8 s.
  - `Sorter({ settings }: { settings: KondoSettings })` — full sorter: remaining count ("N songs remaining in Liked"), oldest↔newest toggle, song list, add+unlike flow with undo, cluster suggestions footer.
  - `App` gains `const [settings, setSettings] = useState(loadSettings)` and passes `settings` to `Sorter` and (Task 15) `settings`/`onChange` to `Settings`.

- [ ] **Step 1: Write the failing removal-log test**

Create `src/storage/removalLog.test.ts`:

```ts
import { afterEach, expect, it } from 'vitest';
import { getRemovalLog, logRemoval, removeFromLog } from './removalLog';

afterEach(() => localStorage.clear());

const entry = {
  trackId: 't1', name: 'Glory Box', artists: 'Portishead',
  addedAt: '2024-01-01T00:00:00Z', removedAt: '2026-07-14T00:00:00Z', playlistIds: ['p1'],
};

it('appends and reads entries', () => {
  logRemoval(entry);
  logRemoval({ ...entry, trackId: 't2' });
  expect(getRemovalLog()).toHaveLength(2);
  expect(getRemovalLog()[0]).toEqual(entry);
});

it('removes an entry on undo', () => {
  logRemoval(entry);
  removeFromLog('t1', entry.removedAt);
  expect(getRemovalLog()).toEqual([]);
});
```

- [ ] **Step 2: Run + implement removal log**

Run: `npx vitest run src/storage/removalLog.test.ts` → FAIL (module not found). Then create `src/storage/removalLog.ts`:

```ts
export interface RemovalEntry {
  trackId: string;
  name: string;
  artists: string;
  addedAt: string;   // original Liked date — lost on Spotify's side once unliked
  removedAt: string;
  playlistIds: string[];
}

const KEY = 'kondo:removals:v1';

export function getRemovalLog(): RemovalEntry[] {
  const raw = localStorage.getItem(KEY);
  return raw ? (JSON.parse(raw) as RemovalEntry[]) : [];
}

export function logRemoval(entry: RemovalEntry): void {
  localStorage.setItem(KEY, JSON.stringify([...getRemovalLog(), entry]));
}

export function removeFromLog(trackId: string, removedAt: string): void {
  localStorage.setItem(
    KEY,
    JSON.stringify(
      getRemovalLog().filter((e) => !(e.trackId === trackId && e.removedAt === removedAt)),
    ),
  );
}
```

Run again → PASS (2 tests).

- [ ] **Step 3: Write the failing Sorter test**

Create `src/components/Sorter.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import Sorter from './Sorter';
import * as spotify from '../api/spotify';
import * as lib from '../hooks/useLibrary';
import { getRemovalLog } from '../storage/removalLog';

vi.mock('../api/spotify', () => ({
  addTracksToPlaylist: vi.fn().mockResolvedValue(undefined),
  removeSavedTracks: vi.fn().mockResolvedValue(undefined),
  saveTracks: vi.fn().mockResolvedValue(undefined),
  removeTracksFromPlaylist: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../hooks/useLibrary');

const track = (id: string, addedAt: string) => ({
  id, uri: `spotify:track:${id}`, name: `Song ${id}`,
  artists: [{ id: 'a1', name: 'Artist' }],
  albumName: 'Album', releaseYear: 2000, isrc: null, addedAt,
});

const settings = { targetPlaylistIds: null, threshold: 0.3, sortOrder: 'oldest' as const };

function mockLibrary(tracks: ReturnType<typeof track>[]) {
  const removeTrackLocally = vi.fn();
  vi.mocked(lib.useLibrary).mockReturnValue({
    status: 'ready', error: null,
    tracks,
    playlists: [{ id: 'p1', name: 'Trip Hop', trackCount: 5 }],
    genresByTrack: new Map(tracks.map((t) => [t.id, ['trip hop']])),
    matches: new Map(tracks.map((t) => [t.id, {
      best: { playlistId: 'p1', score: 0.9 }, alternates: [], belowThreshold: false,
    }])),
    progress: { resolved: 1, total: 1 },
    removeTrackLocally,
    restoreTrackLocally: vi.fn(),
  });
  return { removeTrackLocally };
}

afterEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

it('shows the remaining count and sorts oldest-first by default', () => {
  mockLibrary([track('t1', '2024-06-01T00:00:00Z'), track('t2', '2023-01-01T00:00:00Z')]);
  render(<Sorter settings={settings} />);
  expect(screen.getByText(/2 songs remaining in liked/i)).toBeInTheDocument();
  const rows = screen.getAllByRole('listitem');
  expect(rows[0]).toHaveTextContent('Song t2'); // older first
});

it('flips the order with the toggle', async () => {
  mockLibrary([track('t1', '2024-06-01T00:00:00Z'), track('t2', '2023-01-01T00:00:00Z')]);
  render(<Sorter settings={settings} />);
  await userEvent.click(screen.getByRole('button', { name: /newest/i }));
  expect(screen.getAllByRole('listitem')[0]).toHaveTextContent('Song t1');
});

it('add → adds to playlist, unlikes, logs, removes row, offers undo', async () => {
  const { removeTrackLocally } = mockLibrary([track('t1', '2024-06-01T00:00:00Z')]);
  render(<Sorter settings={settings} />);
  await userEvent.click(screen.getByRole('button', { name: /^add$/i }));
  await waitFor(() => {
    expect(spotify.addTracksToPlaylist).toHaveBeenCalledWith('p1', ['spotify:track:t1']);
    expect(spotify.removeSavedTracks).toHaveBeenCalledWith(['t1']);
  });
  expect(removeTrackLocally).toHaveBeenCalledWith('t1');
  expect(getRemovalLog()).toHaveLength(1);
  expect(screen.getByRole('button', { name: /undo/i })).toBeInTheDocument();
});

it('undo re-likes and removes from the playlist again', async () => {
  mockLibrary([track('t1', '2024-06-01T00:00:00Z')]);
  render(<Sorter settings={settings} />);
  await userEvent.click(screen.getByRole('button', { name: /^add$/i }));
  await userEvent.click(await screen.findByRole('button', { name: /undo/i }));
  await waitFor(() => {
    expect(spotify.saveTracks).toHaveBeenCalledWith(['t1']);
    expect(spotify.removeTracksFromPlaylist).toHaveBeenCalledWith('p1', ['spotify:track:t1']);
  });
  expect(getRemovalLog()).toHaveLength(0);
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx vitest run src/components/Sorter.test.tsx`
Expected: FAIL — Sorter is still the Task 10 placeholder.

- [ ] **Step 5: Implement**

Create `src/components/UndoToast.tsx`:

```tsx
import { useEffect } from 'react';

interface Props {
  message: string;
  onUndo: () => void;
  onDismiss: () => void;
}

export default function UndoToast({ message, onUndo, onDismiss }: Props) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 8000);
    return () => clearTimeout(t);
  }, [onDismiss]);

  return (
    <div className="undo-toast" role="status">
      <span>{message}</span>
      <button onClick={onUndo}>Undo</button>
    </div>
  );
}
```

Replace `src/components/Sorter.tsx`:

```tsx
import { useState } from 'react';
import {
  addTracksToPlaylist, removeSavedTracks, removeTracksFromPlaylist, saveTracks,
} from '../api/spotify';
import { useLibrary } from '../hooks/useLibrary';
import { suggestClusters } from '../matching/clusters';
import type { KondoSettings } from '../storage/settings';
import { logRemoval, removeFromLog } from '../storage/removalLog';
import type { Track } from '../types';
import MatchPicker from './MatchPicker';
import SongRow from './SongRow';
import UndoToast from './UndoToast';

interface UndoState {
  track: Track;
  playlistIds: string[];
  removedAt: string;
}

export default function Sorter({ settings }: { settings: KondoSettings }) {
  const lib = useLibrary(settings);
  const [order, setOrder] = useState<'oldest' | 'newest'>(settings.sortOrder);
  const [undo, setUndo] = useState<UndoState | null>(null);

  if (lib.status === 'error') return <p role="alert">{lib.error}</p>;

  const playlistNames = new Map(lib.playlists.map((p) => [p.id, p.name]));
  const sorted = [...lib.tracks].sort((a, b) =>
    order === 'oldest'
      ? a.addedAt.localeCompare(b.addedAt)
      : b.addedAt.localeCompare(a.addedAt),
  );

  const handleAdd = async (track: Track, playlistIds: string[]) => {
    for (const pid of playlistIds) await addTracksToPlaylist(pid, [track.uri]);
    await removeSavedTracks([track.id]);
    const removedAt = new Date().toISOString();
    logRemoval({
      trackId: track.id,
      name: track.name,
      artists: track.artists.map((a) => a.name).join(', '),
      addedAt: track.addedAt,
      removedAt,
      playlistIds,
    });
    lib.removeTrackLocally(track.id);
    setUndo({ track, playlistIds, removedAt });
  };

  const handleUndo = async () => {
    if (!undo) return;
    await saveTracks([undo.track.id]);
    for (const pid of undo.playlistIds) {
      await removeTracksFromPlaylist(pid, [undo.track.uri]);
    }
    removeFromLog(undo.track.id, undo.removedAt);
    lib.restoreTrackLocally(undo.track);
    setUndo(null);
  };

  const noFit = sorted.filter((t) => lib.matches.get(t.id)?.belowThreshold);
  const clusters = suggestClusters(
    noFit.map((t) => ({ trackId: t.id, genres: lib.genresByTrack.get(t.id) ?? [] })),
  );

  return (
    <section>
      <p>{lib.tracks.length} songs remaining in Liked</p>
      {lib.status === 'loading' && (
        <p>
          Loading library… resolving genres {lib.progress.resolved}/{lib.progress.total}
          {lib.progress.total > 0 && ' (first run is slow; results are cached)'}
        </p>
      )}
      <button onClick={() => setOrder(order === 'oldest' ? 'newest' : 'oldest')}>
        {order === 'oldest' ? 'oldest → newest' : 'newest → oldest'}
      </button>
      <ul className="song-list">
        {sorted.map((t) => (
          <SongRow
            key={t.id}
            track={t}
            genres={lib.genresByTrack.get(t.id)}
            matchSlot={
              <MatchPicker
                match={lib.matches.get(t.id)}
                playlistNames={playlistNames}
                onAdd={(ids) => void handleAdd(t, ids)}
              />
            }
          />
        ))}
      </ul>
      {clusters.length > 0 && (
        <footer>
          <h2>New playlist ideas (songs with no strong match)</h2>
          <ul>
            {clusters.map((c) => (
              <li key={c.genre}>
                {c.trackIds.length} unsorted “{c.genre}” songs — maybe a new playlist?
              </li>
            ))}
          </ul>
        </footer>
      )}
      {undo && (
        <UndoToast
          message={`Moved “${undo.track.name}” — heads up: re-liking later resets its added date`}
          onUndo={() => void handleUndo()}
          onDismiss={() => setUndo(null)}
        />
      )}
    </section>
  );
}
```

Modify `src/App.tsx` — add imports and lift settings:

```tsx
import { loadSettings, saveSettings, type KondoSettings } from './storage/settings';
```

Inside `App`, add:

```tsx
const [settings, setSettings] = useState<KondoSettings>(loadSettings);
const updateSettings = (s: KondoSettings) => {
  saveSettings(s);
  setSettings(s);
};
```

and change the sorter line to `{authed && tab === 'sorter' && <Sorter settings={settings} />}`. (`updateSettings` is consumed in Task 15 — until then, suppress the unused warning by passing it now if TypeScript complains: keep it and add `void updateSettings;` on the next line, removed in Task 15.)

- [ ] **Step 6: Run tests to verify pass**

Run: `npx vitest run`
Expected: PASS (all suites).

- [ ] **Step 7: Live check + commit**

`npm run dev` → log in → sorter lists your liked songs oldest-first with genres filling in, count header updates after an Add, undo restores.

```bash
git add -A
git commit -m "feat: sorter with add+unlike flow, undo toast, removal log, cluster ideas"
```

### Task 14: In-app playback via the Web Playback SDK

**Files:**
- Create: `src/player/spotifyPlayer.ts`, `src/player/spotifyPlayer.test.ts`
- Modify: `src/components/Sorter.tsx` (play/pause button per row)

**Interfaces:**
- Consumes: `spotifyFetch` (Task 4), `getValidAccessToken` (Task 3), `CLIENT_ID` (Task 10 — imported only in Sorter, which passes a token getter down; the player module itself stays config-free).
- Produces:
  - `initPlayer(getToken: () => Promise<string>): Promise<{ deviceId: string; pause: () => Promise<void> }>` — injects `https://sdk.scdn.co/spotify-player.js` once, creates a `Spotify.Player` named `spotifyKondo`, resolves on the SDK `ready` event. Idempotent (returns the same promise on later calls).
  - `playTrack(deviceId: string, uri: string): Promise<void>` — `PUT /me/player/play?device_id=…` with `{ uris: [uri] }`.
  - **Requires Spotify Premium** — surface SDK `account_error` as a readable message.

- [ ] **Step 1: Write the failing tests**

Create `src/player/spotifyPlayer.test.ts`:

```ts
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initPlayer, playTrack, resetPlayerForTests } from './spotifyPlayer';
import { configureSpotify } from '../api/spotify';
import { saveTokens } from '../auth/token';

type Listener = (payload: { device_id: string }) => void;

class FakePlayer {
  listeners = new Map<string, Listener>();
  addListener(event: string, cb: Listener) { this.listeners.set(event, cb); }
  connect() { this.listeners.get('ready')?.({ device_id: 'dev42' }); return Promise.resolve(true); }
  pause() { return Promise.resolve(); }
}

beforeEach(() => {
  configureSpotify('cid');
  saveTokens({ accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 3600_000 });
});

afterEach(() => {
  localStorage.clear();
  resetPlayerForTests();
  document.querySelectorAll('script').forEach((s) => s.remove());
  vi.restoreAllMocks();
});

it('loads the SDK script and resolves with the device id on ready', async () => {
  const promise = initPlayer(async () => 'tok');
  const script = document.querySelector('script[src="https://sdk.scdn.co/spotify-player.js"]');
  expect(script).not.toBeNull();
  // Simulate the SDK arriving:
  (window as unknown as { Spotify: unknown }).Spotify = { Player: FakePlayer };
  window.onSpotifyWebPlaybackSDKReady();
  const { deviceId } = await promise;
  expect(deviceId).toBe('dev42');
  // Idempotent — second call returns the same promise, no second script.
  await initPlayer(async () => 'tok');
  expect(document.querySelectorAll('script').length).toBe(1);
});

it('playTrack PUTs the uri to the device', async () => {
  const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 204 }));
  await playTrack('dev42', 'spotify:track:t1');
  expect(spy.mock.calls[0][0]).toBe('https://api.spotify.com/v1/me/player/play?device_id=dev42');
  expect(spy.mock.calls[0][1]!.method).toBe('PUT');
  expect(JSON.parse(spy.mock.calls[0][1]!.body as string)).toEqual({ uris: ['spotify:track:t1'] });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/player/spotifyPlayer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/player/spotifyPlayer.ts`:

```ts
import { spotifyFetch } from '../api/spotify';

interface SdkPlayer {
  addListener(event: string, cb: (payload: never) => void): void;
  connect(): Promise<boolean>;
  pause(): Promise<void>;
}

declare global {
  interface Window {
    onSpotifyWebPlaybackSDKReady: () => void;
    Spotify: {
      Player: new (opts: {
        name: string;
        getOAuthToken: (cb: (token: string) => void) => void;
        volume: number;
      }) => SdkPlayer;
    };
  }
}

export interface PlayerHandle {
  deviceId: string;
  pause: () => Promise<void>;
}

let handle: Promise<PlayerHandle> | null = null;

export function resetPlayerForTests(): void {
  handle = null;
}

export function initPlayer(getToken: () => Promise<string>): Promise<PlayerHandle> {
  if (handle) return handle;
  handle = new Promise<PlayerHandle>((resolve, reject) => {
    window.onSpotifyWebPlaybackSDKReady = () => {
      const player = new window.Spotify.Player({
        name: 'spotifyKondo',
        getOAuthToken: (cb) => void getToken().then(cb),
        volume: 0.8,
      });
      player.addListener('ready', ({ device_id }: { device_id: string }) =>
        resolve({ deviceId: device_id, pause: () => player.pause() }));
      player.addListener('account_error', () =>
        reject(new Error('Playback needs Spotify Premium')));
      player.addListener('initialization_error', ({ message }: { message: string }) =>
        reject(new Error(message)));
      player.addListener('authentication_error', ({ message }: { message: string }) =>
        reject(new Error(message)));
      void player.connect();
    };
    const script = document.createElement('script');
    script.src = 'https://sdk.scdn.co/spotify-player.js';
    script.onerror = () => reject(new Error('Failed to load the Spotify player SDK'));
    document.body.appendChild(script);
  });
  return handle;
}

export async function playTrack(deviceId: string, uri: string): Promise<void> {
  await spotifyFetch(`/me/player/play?device_id=${deviceId}`, {
    method: 'PUT',
    body: JSON.stringify({ uris: [uri] }),
  });
}
```

- [ ] **Step 4: Wire play/pause into the Sorter**

In `src/components/Sorter.tsx`, add imports:

```tsx
import { getValidAccessToken } from '../auth/token';
import { CLIENT_ID } from '../config';
import { initPlayer, playTrack } from '../player/spotifyPlayer';
```

Add state and handler inside the component:

```tsx
const [playingUri, setPlayingUri] = useState<string | null>(null);
const [playerError, setPlayerError] = useState<string | null>(null);

const handlePlay = async (uri: string) => {
  try {
    const player = await initPlayer(() => getValidAccessToken(CLIENT_ID));
    if (playingUri === uri) {
      await player.pause();
      setPlayingUri(null);
    } else {
      await playTrack(player.deviceId, uri);
      setPlayingUri(uri);
    }
  } catch (e) {
    setPlayerError(String(e));
  }
};
```

Render `{playerError && <p role="alert">{playerError}</p>}` under the count header, and extend each row's `matchSlot` with a play button before the `MatchPicker`:

```tsx
matchSlot={
  <>
    <button aria-label={playingUri === t.uri ? 'pause' : 'play'} onClick={() => void handlePlay(t.uri)}>
      {playingUri === t.uri ? '⏸' : '▶'}
    </button>
    <MatchPicker … (unchanged) />
  </>
}
```

- [ ] **Step 5: Run tests, live-check, commit**

Run: `npx vitest run` → PASS (all suites; existing Sorter tests unaffected — the play button adds a labeled button only).
Live: `npm run dev` → click ▶ on a row → audio plays in the tab (Premium account); ⏸ pauses.

```bash
git add -A
git commit -m "feat: in-app playback via Spotify Web Playback SDK"
```

---

### Task 15: Settings tab — target playlists + threshold slider

**Files:**
- Modify: `src/components/Settings.tsx` (replace placeholder), `src/App.tsx` (pass props)
- Test: `src/components/Settings.test.tsx`

**Interfaces:**
- Consumes: `getMyPlaylists` (Task 5), `KondoSettings` (Task 11).
- Produces: `Settings({ settings, onChange }: { settings: KondoSettings; onChange: (s: KondoSettings) => void })` — checkbox per owned playlist (all checked when `targetPlaylistIds` is `null`; unchecking materializes the explicit list), plus a threshold `<input type="range">` (0–1, step 0.05). Every change calls `onChange` with the full new settings object; `App`'s `updateSettings` persists it, and the changed `settings` prop makes `useLibrary` reload/re-match automatically.

- [ ] **Step 1: Write the failing tests**

Create `src/components/Settings.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import Settings from './Settings';
import * as spotify from '../api/spotify';

vi.mock('../api/spotify', () => ({ getMyPlaylists: vi.fn() }));

const settings = { targetPlaylistIds: null, threshold: 0.3, sortOrder: 'oldest' as const };

it('lists owned playlists all-checked and materializes the list on uncheck', async () => {
  vi.mocked(spotify.getMyPlaylists).mockResolvedValue([
    { id: 'p1', name: 'Trip Hop', trackCount: 10 },
    { id: 'p2', name: 'Road Trip', trackCount: 20 },
  ]);
  const onChange = vi.fn();
  render(<Settings settings={settings} onChange={onChange} />);
  const roadTrip = await screen.findByRole('checkbox', { name: /road trip/i });
  expect(roadTrip).toBeChecked();
  await userEvent.click(roadTrip);
  expect(onChange).toHaveBeenCalledWith({ ...settings, targetPlaylistIds: ['p1'] });
});

it('changes the threshold via the slider', async () => {
  vi.mocked(spotify.getMyPlaylists).mockResolvedValue([]);
  const onChange = vi.fn();
  render(<Settings settings={settings} onChange={onChange} />);
  const slider = await screen.findByRole('slider');
  // range inputs don't work with userEvent.type; fire a change directly:
  const { fireEvent } = await import('@testing-library/react');
  fireEvent.change(slider, { target: { value: '0.5' } });
  expect(onChange).toHaveBeenCalledWith({ ...settings, threshold: 0.5 });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components/Settings.test.tsx`
Expected: FAIL — placeholder Settings takes no props and renders none of this.

- [ ] **Step 3: Implement**

Replace `src/components/Settings.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { getMyPlaylists } from '../api/spotify';
import type { KondoSettings } from '../storage/settings';
import type { Playlist } from '../types';

interface Props {
  settings: KondoSettings;
  onChange: (s: KondoSettings) => void;
}

export default function Settings({ settings, onChange }: Props) {
  const [playlists, setPlaylists] = useState<Playlist[] | null>(null);

  useEffect(() => {
    void getMyPlaylists().then(setPlaylists);
  }, []);

  if (!playlists) return <p>Loading playlists…</p>;

  const isTarget = (id: string) =>
    settings.targetPlaylistIds === null || settings.targetPlaylistIds.includes(id);

  const toggle = (id: string) => {
    const current = settings.targetPlaylistIds ?? playlists.map((p) => p.id);
    const next = current.includes(id)
      ? current.filter((x) => x !== id)
      : [...current, id];
    onChange({ ...settings, targetPlaylistIds: next });
  };

  return (
    <section>
      <h2>Sorting destinations</h2>
      <p>Unchecked playlists are ignored by the sorter (road-trip mixes etc.).</p>
      <ul>
        {playlists.map((p) => (
          <li key={p.id}>
            <label>
              <input type="checkbox" checked={isTarget(p.id)} onChange={() => toggle(p.id)} />
              {p.name} ({p.trackCount})
            </label>
          </li>
        ))}
      </ul>
      <h2>Match threshold</h2>
      <label>
        Songs scoring below {settings.threshold.toFixed(2)} are marked “no strong match”
        <input
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={settings.threshold}
          onChange={(e) => onChange({ ...settings, threshold: Number(e.target.value) })}
        />
      </label>
    </section>
  );
}
```

Modify `src/App.tsx`: change the settings line to
`{authed && tab === 'settings' && <Settings settings={settings} onChange={updateSettings} />}`
and delete the temporary `void updateSettings;` from Task 13.

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run`
Expected: PASS (all suites).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: settings tab with target playlists and threshold slider"
```

---

### Task 16: README, build check, end-to-end verification

**Files:**
- Create: `README.md`
- Modify: none

- [ ] **Step 1: Write `README.md`**

```markdown
# spotifyKondo

Sort your Spotify Liked Songs (the *cache*) into your playlists (the *storage*),
one song at a time — genre-matched, privacy-first.

Everything runs in your browser: no backend, no analytics. The only services
contacted are Spotify and MusicBrainz (open genre data). Tokens and caches
live in your browser's localStorage.

## Setup

1. Create an app at https://developer.spotify.com/dashboard with redirect URI
   `http://127.0.0.1:5173/callback` (Web API + Web Playback SDK).
2. Create `.env.local` in the repo root:
   `VITE_SPOTIFY_CLIENT_ID=<your client id>`
3. `npm install && npm run dev`, then open **http://127.0.0.1:5173**
   (must be 127.0.0.1, not localhost — Spotify requires a loopback IP).

Playback requires Spotify Premium. The first library load is slow
(MusicBrainz allows 1 request/second); genre lookups are cached, so
later loads are fast.

## Notes

- Removing a song from Liked permanently loses its original added date on
  Spotify's side. The app keeps a local log (`kondo:removals:v1`) and offers
  an 8-second undo after every move.
- The Analyzer tab (too-broad playlist detection) is a planned follow-up.

## Development

- `npx vitest run` — tests
- `npm run build` — production build (static; deployable to any static host
  after registering an HTTPS redirect URI with Spotify)
```

- [ ] **Step 2: Full verification**

Run and confirm all pass:

```bash
npx vitest run        # all suites green
npx tsc --noEmit      # (or `npm run build`, which typechecks) — no errors
npm run build         # emits dist/ without errors
```

- [ ] **Step 3: Manual end-to-end checklist (real Spotify account)**

1. `npm run dev`, open http://127.0.0.1:5173 → login round-trips.
2. Sorter shows liked songs oldest-first: name, artist, genre (fills in progressively), date added, remaining count.
3. Sort toggle flips the order.
4. Best match + two alternates in the dropdown look sane against your library.
5. ▶ plays audio in the tab (Premium); ⏸ pauses.
6. Add on a *test* song: it appears in the playlist on Spotify, disappears from Liked, count decrements, undo toast shows.
7. Undo: song is back in Liked, gone from the playlist.
8. Below-threshold songs show the greyed "no strong match" badge; cluster suggestions appear if ≥5 share a genre.
9. Settings: uncheck a playlist → it stops appearing as a match; move the slider → badges update after reload of matches.
10. Reload the page: still logged in, genre resolution is near-instant (cache hit).

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: README with setup, privacy notes, and dev workflow"
```

---

## Verification (plan-level)

- **Automated:** every task carries its own Vitest cycle; Task 16 runs the full suite, `tsc`, and a production build.
- **Live:** Task 10 Step 5 (capability probe — records what the Spotify API still grants and adjusts endpoint paths if needed) and Task 16 Step 3 (full manual E2E against a real account, using a throwaway test song for the destructive add+unlike step).
- **Riskiest assumption:** Spotify artist-genre availability. It's isolated behind `src/genre/resolver.ts` with a sticky fallback to MusicBrainz, so a dead endpoint degrades gracefully rather than blocking.

## Out of scope (follow-up plans)

- **Analyzer tab** — playlist genre-spread scoring, too-broad detection, break-off suggestions with actual song lists. Read-only; gets its own plan. The `buildFingerprint` output (genre weights per playlist) is the intended input for its spread metric.
- **Static hosting deploy** — already migration-ready (derived redirect URI, relative `BASE_URL`); needs only a host + registering the HTTPS redirect URI.
- **ISRC-based MusicBrainz recording lookups** — artist-level genres may prove too coarse; `Track.isrc` is already captured for this upgrade.