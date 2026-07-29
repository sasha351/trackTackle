# Public Launch of spotifyKondo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. On execution, copy this plan to `docs/superpowers/plans/2026-07-19-public-launch.md`.

**Goal:** Take spotifyKondo from localhost-only to a shareable public URL — live immediately for up to 25 invited Spotify users, with the groundwork laid to pursue Spotify's Extended Quota Mode for unlimited public access.

**Architecture:** Stays a pure static React 19 + Vite SPA (PKCE OAuth, no backend). Deployed to Vercel Hobby, served from a custom subdomain `kondo.shikhanovich.me`. No server is added — that's deliberate; a backend would only exist to hide a client ID that PKCE makes public anyway.

**Tech Stack:** TypeScript, React 19, Vite 8, Vitest + Testing Library (jsdom), plain CSS. Host: Vercel. DNS: the user's `.me` domain (GitHub Student Pack / Namecheap).

## Context

The app works locally but nobody else can use it. Two hard gates stand between "works on my machine" and "usable by anyone I share the link with":

1. **Hosting** — there is no deploy target today (no `vercel.json`, no CI, dev server pinned to `127.0.0.1`). Needs a real HTTPS origin with the OAuth `/callback` route working.
2. **Spotify Development Mode** — Spotify caps unreviewed apps at **25 users**, each added by email in the dashboard. A shared link does nothing for anyone outside that list (they get an auth error). True public access requires submitting for **Extended Quota Mode** review — a real approval with eligibility criteria and no guaranteed outcome.

Plus resilience gaps that are fine for a solo dev but not for strangers: no global ErrorBoundary (any render throw white-screens the whole app), and `.env.local` is tracked in git (a cleanliness bug — the value is only the public client ID, so not a credential leak, but the ignore rule is silently not protecting the file).

**Outcome:** a link the user can hand to 25 friends today, and a submission-ready app to unlock the general public next.

---

## Status — every code task is done; only the ops tasks remain

Verified against the tree on 2026-07-29. Per-step checkboxes below are left
unticked as a record of the original plan; this table is the live status.

| Task | Status |
|---|---|
| 1 — Verify build config for the target origin | ⬜ blocked on the deploy target existing |
| 2 — Stop tracking `.env.local` | ✅ shipped — `git ls-files` returns nothing for it, `*.local` now actually protects |
| 3 — Global ErrorBoundary | ✅ shipped — `ErrorBoundary.tsx` + test, wraps `<App />` in `main.tsx` |
| 4 — Non-Premium degradation | ✅ shipped — `Sorter.tsx` reassures that sorting works without Premium; covered in `Sorter.test.tsx` |
| 5 — Deploy to Vercel + custom domain (OPS) | ⬜ not started — no `vercel.json`, nothing deployed |
| 6 — Invite the first users (OPS) | ⬜ blocked on Task 5 |
| 7 — Privacy policy + terms page | ✅ shipped — `LegalPage.tsx` + test, reachable from the footer |
| 8 — Landing explainer + Spotify attribution | ✅ shipped — `login-explainer` in `Login.tsx`, `footer-attribution` in `App.tsx` |
| 9 — Submit for Extended Quota Mode (OPS) | ⬜ blocked on Task 5 |
| 10 — Fill thinnest-tested critical paths (optional) | ⬜ not started (243 tests as of 2026-07-29) |

**The whole plan is now gated on Task 5**, which is a Vercel account and a DNS
record — no code. The Context section above is stale on two counts: the
ErrorBoundary now exists, and `.env.local` is no longer tracked.

---

## Global Constraints

- **Test command:** `npx vitest run` (there is no `npm test` script). **Lint:** `npm run lint` (oxlint). **Typecheck+build:** `npm run build` (`tsc -b && vite build`).
- **Never `git add -A` / `git add .`** — the working tree carries unrelated changes and untracked screenshots. Stage only the exact files each task names.
- **Sasha sometimes edits files while agents run.** Read the current file content immediately before editing; adapt if it differs from snippets here.
- **The client ID `1aa1a441536d4ad8a7790b1cff55050d` is a public PKCE identifier** — it is safe in the bundle and in dashboards. It is NOT a secret. Do not treat it as one.
- **Do not add a backend, a router library, or any new runtime dependency.** The app has exactly two deps (`react`, `react-dom`); keep it that way. Legal/landing pages are plain components, not new routes.
- **Redirect URIs must match Spotify's registered value exactly** (scheme + host + path, no trailing slash mismatch). `src/config.ts` derives it as `` `${window.location.origin}${import.meta.env.BASE_URL}callback` ``.

---

## Domain decision (read before Task 6)

**Recommended: subdomain `kondo.shikhanovich.me`.**
- Vite `base` stays `/` (default). `BASE_URL` = `/`. Redirect URI = `https://kondo.shikhanovich.me/callback` — clean.
- One standalone Vercel project owns the whole subdomain. SPA routing and `/callback` "just work" (Vercel serves `index.html` for unknown paths by default).
- Keeps this project fully decoupled from the future `shikhanovich.me` personal site.

**Alternative: subpath `shikhanovich.me/kondo`.** Only if the user insists. Costs:
- Set Vite `base: '/kondo/'` (Task 1 variant). Redirect becomes `https://shikhanovich.me/kondo/callback`.
- The apex `shikhanovich.me` must be a *different* Vercel project, and you need a **rewrite** proxying `/kondo/*` to this deployment — one domain cannot natively split across two projects by path otherwise. More moving parts, more failure surface.

**This plan is written for the subdomain.** Subpath deltas are called out inline where they differ.

---

# TRACK A — Ship to 25 invited users (do first; fully unblocks a shareable link)

### Task 1: Verify build config for the target origin

**Files:**
- Modify (subpath variant only): `vite.config.ts`
- Read: `src/config.ts` (no change — redirect URI is already origin-derived)

**Interfaces:**
- Produces: a production build whose `import.meta.env.BASE_URL` matches the deploy path, so `REDIRECT_URI` resolves to the exact string registered in Spotify.

- [ ] **Step 1: Confirm no base change needed (subdomain path)**

For `kondo.shikhanovich.me`, `base` defaults to `/`. Nothing to change in `vite.config.ts`. Confirm by reading it — the only server config present is `server: { host: '127.0.0.1' }` (dev only, irrelevant to the build).

- [ ] **Step 2 (SUBPATH VARIANT ONLY): set base**

Only if hosting at `shikhanovich.me/kondo`. Add `base: '/kondo/'` to the `defineConfig` object in `vite.config.ts`:

```ts
export default defineConfig({
  plugins: [react()],
  base: '/kondo/',
  server: { host: '127.0.0.1' },
  test: { environment: 'jsdom', globals: true, setupFiles: './src/test/setup.ts' },
});
```

- [ ] **Step 3: Build and confirm asset paths**

Run: `npm run build`
Expected: build succeeds. For subdomain, `dist/index.html` references `/assets/…`. For subpath, it references `/kondo/assets/…`. Mismatched base is the #1 cause of a blank deploy.

- [ ] **Step 4: Commit (only if vite.config.ts changed)**

```bash
git add vite.config.ts
git commit -m "chore: set vite base for production subpath deploy"
```

---

### Task 2: Git hygiene — stop tracking .env.local

**Files:**
- Untrack: `.env.local` (stays on disk, keeps working locally)
- Read: `.gitignore` (already contains `*.local` — no change needed)

**Why:** `.env.local` is tracked despite `*.local` being gitignored (force-added before the rule mattered). The value is only the public client ID, so this is hygiene, not a leak — but a tracked-but-"ignored" file silently defeats the ignore rule for anything added later.

- [ ] **Step 1: Untrack without deleting**

```bash
git rm --cached .env.local
```

- [ ] **Step 2: Confirm it's gone from the index but present on disk**

Run: `git status` → shows `deleted: .env.local` staged; `ls .env.local` → still there.
Run: `git check-ignore .env.local` → prints `.env.local` (now actually ignored).

- [ ] **Step 3: Commit**

```bash
git add .env.local
git commit -m "chore: stop tracking .env.local (client id lives in host env)"
```

---

### Task 3: Global ErrorBoundary — no more white-screens

**Files:**
- Create: `src/components/ErrorBoundary.tsx`
- Create: `src/components/ErrorBoundary.test.tsx`
- Modify: `src/main.tsx` (wrap `<App />`)
- Modify: `src/index.css` (append `.error-fallback` styles)

**Interfaces:**
- Produces: `ErrorBoundary` — a class component (React error boundaries must be classes) with props `{ children: ReactNode }`. Renders a friendly fallback with a "Reload" button (`window.location.reload()`) on any caught render error, and logs the error to `console.error`.

- [ ] **Step 1: Write the failing test**

`src/components/ErrorBoundary.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import ErrorBoundary from './ErrorBoundary';

function Boom(): never {
  throw new Error('kaboom');
}

it('renders children when nothing throws', () => {
  render(<ErrorBoundary><p>hello</p></ErrorBoundary>);
  expect(screen.getByText('hello')).toBeInTheDocument();
});

it('shows a recoverable fallback when a child throws', () => {
  // React logs the caught error; silence it so the test output stays clean.
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  render(<ErrorBoundary><Boom /></ErrorBoundary>);
  expect(screen.getByRole('alert')).toHaveTextContent(/something went wrong/i);
  expect(screen.getByRole('button', { name: /reload/i })).toBeInTheDocument();
  spy.mockRestore();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components/ErrorBoundary.test.tsx`
Expected: FAIL — module `./ErrorBoundary` does not exist.

- [ ] **Step 3: Implement**

`src/components/ErrorBoundary.tsx`:

```tsx
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props { children: ReactNode }
interface State { error: Error | null }

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Unhandled render error:', error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="error-fallback" role="alert">
        <h2>Something went wrong.</h2>
        <p>The app hit an unexpected error. Reloading usually fixes it.</p>
        <button className="pill-green" onClick={() => window.location.reload()}>Reload</button>
      </div>
    );
  }
}
```

- [ ] **Step 4: Wrap the app**

Modify `src/main.tsx` — wrap `<App />` (inside `StrictMode`):

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import ErrorBoundary from './components/ErrorBoundary.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
```

- [ ] **Step 5: Add fallback styles**

Append to `src/index.css` (reuse existing tokens/`.pill-green`):

```css
.error-fallback {
  max-width: 28rem;
  margin: 4rem auto;
  padding: 1.5rem;
  text-align: center;
  color: var(--text-h);
}
.error-fallback h2 { margin-bottom: 0.5rem; }
.error-fallback p { color: var(--text); margin-bottom: 1rem; }
```

- [ ] **Step 6: Run tests + build to verify**

Run: `npx vitest run src/components/ErrorBoundary.test.tsx` → PASS (2 tests)
Run: `npm run build` → succeeds.

- [ ] **Step 7: Commit**

```bash
git add src/components/ErrorBoundary.tsx src/components/ErrorBoundary.test.tsx src/main.tsx src/index.css
git commit -m "feat: global ErrorBoundary so a render throw can't white-screen the app"
```

---

### Task 4: Non-Premium degradation — make the Premium requirement legible

**Files:**
- Modify: `src/components/Sorter.tsx` (play handler / `playerError` display around lines 27, 67, 121)
- Modify: `src/components/Sorter.test.tsx` (add a case)

**Context (verified):** Playback is already lazy (player boots on first play click, `Sorter.tsx:67`) and non-Premium already surfaces as an alert — `spotifyPlayer.ts` rejects `account_error` with `Error('Playback needs Spotify Premium')`, caught into `playerError` and shown via `<p role="alert">` at `Sorter.tsx:121`. **So there is no white-screen risk and the core sort flow works without Premium.** The only gap is discoverability: a public visitor without Premium only learns playback is unavailable *after* clicking play, and the message doesn't say the rest of the app still works.

- [ ] **Step 1: Write the failing test**

Add to `src/components/Sorter.test.tsx` — assert the Premium error copy reassures that sorting still works. (Read the current test file first to match its render/mock setup; adapt the trigger to how existing tests fire a play click.)

```tsx
it('tells non-Premium users playback is optional and sorting still works', async () => {
  // Arrange a Sorter whose play action rejects with the Premium error
  // (mirror the existing player-error test setup in this file), click play,
  // then assert the reassuring copy is present.
  // expect(screen.getByRole('alert')).toHaveTextContent(/premium/i);
  // expect(screen.getByRole('alert')).toHaveTextContent(/sorting still works|no premium needed/i);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/Sorter.test.tsx`
Expected: FAIL on the new assertion.

- [ ] **Step 3: Implement**

In `src/components/Sorter.tsx`, where `playerError` is rendered (line ~121), broaden the copy so a Premium rejection reads as expected, not broken:

```tsx
{playerError && (
  <p role="alert" className="player-note">
    {playerError}. Previews need Spotify Premium — but sorting your library
    works without it, no Premium needed.
  </p>
)}
```

If the raw error string already ends with punctuation, adjust so the sentence reads cleanly. Keep the single `role="alert"`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/Sorter.test.tsx` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/Sorter.tsx src/components/Sorter.test.tsx
git commit -m "feat: reassure non-Premium users that sorting works without playback"
```

> **ponytail note:** this is a copy change, not a feature. Skipped disabling the play button preemptively (would need a Premium probe on load = extra API call for every user); the post-click message is enough. Add the probe only if users report confusion.

---

### Task 5: Deploy to Vercel + wire the custom domain (OPS — no code)

This is a runbook, not code. Do it in order; each step gates the next. The **app owner (Sasha) must be logged into Vercel, Spotify Developer Dashboard, and the domain registrar** — an agent cannot do these.

- [ ] **Step 1: Push the branch and connect the repo to Vercel**
  - Ensure Tasks 1–4 are committed and pushed to GitHub.
  - vercel.com → "Add New Project" → import the `spotifyKondo` repo → sign in with GitHub.
  - Framework preset: **Vite**. Build command `npm run build`, output dir `dist` (Vercel auto-detects both).

- [ ] **Step 2: Set the environment variable**
  - Vercel project → Settings → Environment Variables → add `VITE_SPOTIFY_CLIENT_ID = 1aa1a441536d4ad8a7790b1cff55050d` for the **Production** (and Preview) environments.
  - Trigger a redeploy so the var is baked in (`import.meta.env.VITE_SPOTIFY_CLIENT_ID` is inlined at build time — it will NOT pick up a var added after the build).

- [ ] **Step 3: Confirm the default deploy works**
  - Open the auto-assigned `*.vercel.app` URL. The login screen should render. Do NOT test OAuth yet — the redirect URI isn't registered.

- [ ] **Step 4: Add the custom subdomain**
  - Vercel project → Settings → Domains → add `kondo.shikhanovich.me`.
  - Vercel shows a DNS record to create (a `CNAME` `kondo` → `cname.vercel-dns.com`, or the value it displays).
  - At the domain registrar (Namecheap etc.), add that CNAME. Wait for Vercel to show "Valid Configuration" (minutes to ~an hour).
  - **SUBPATH VARIANT:** instead, point apex `shikhanovich.me` at a separate "hub" Vercel project and add a rewrite `{"source":"/kondo/:path*","destination":"https://<this-project>.vercel.app/kondo/:path*"}`. Verify `/kondo/callback` resolves before continuing.

- [ ] **Step 5: Register the production redirect URI in Spotify**
  - developer.spotify.com/dashboard → this app → Settings → Redirect URIs → add **exactly** `https://kondo.shikhanovich.me/callback` (subpath variant: `https://shikhanovich.me/kondo/callback`). Save.
  - Also confirm `http://127.0.0.1:5173/callback` stays listed for local dev.

- [ ] **Step 6: End-to-end smoke test on the live domain** — see **Verification** section below. Must pass before inviting anyone.

---

### Task 6: Invite the first users (OPS — no code)

- [ ] **Step 1: Add users in Spotify**
  - Spotify Dashboard → this app → **User Management** → add each tester's **Spotify account email** (the email on their Spotify account, not any other). Max 25 including yourself.
- [ ] **Step 2: Send them the link** `https://kondo.shikhanovich.me` with a one-line note: needs a Spotify account; playback previews need Premium but sorting doesn't.
- [ ] **Step 3: Confirm at least one non-owner tester can log in and sort a song end-to-end.**

**At this point the link is shareable to up to 25 people. Track B unlocks everyone else.**

---

# TRACK B — Pursue Extended Quota Mode (unlimited public)

> **Reality check (state honestly to the user):** Extended Quota Mode is a **Spotify review**, not a toggle. You submit the app with a description, screenshots/short video, and confirmation it complies with Spotify's Developer Policy + Design Guidelines. Approval is **not guaranteed**, can take **weeks**, and Spotify has rejected hobby apps. Do Track A first so you're live regardless. Verify current requirements in the dashboard at submission time — Spotify changes them.

### Task 7: Privacy policy + terms page

**Files:**
- Create: `src/components/LegalPage.tsx` (renders privacy + terms content; no new route lib — toggled by App tab/state)
- Create: `src/components/LegalPage.test.tsx`
- Modify: `src/App.tsx` (add a footer link that reveals the legal view)
- Modify: `src/index.css` (footer/legal styling)

**Why:** Spotify's review expects a reachable privacy policy. It's also just correct — the app touches users' Spotify libraries.

**Content requirements (all true for this app, state them plainly):**
- No backend, no analytics, no tracking. The only third parties contacted are **Spotify** and **MusicBrainz**.
- All data (tokens, caches, removal log) lives in the user's browser `localStorage`/`sessionStorage` and never leaves the device except as direct Spotify/MusicBrainz API calls.
- The app modifies Liked Songs and playlists only on explicit user action; removing a Liked song loses its original added-date on Spotify's side (mirror README wording), mitigated by the local removal log + 8s undo.
- Not affiliated with or endorsed by Spotify.
- A contact email for data questions.

- [ ] **Step 1: Write the failing test** — assert `LegalPage` renders headings "Privacy" and "Terms" and mentions "localStorage" and "not affiliated with Spotify". (Full assertions; no placeholders.)
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement `LegalPage.tsx`** with the content above as real prose (not TODOs).
- [ ] **Step 4: Add a persistent footer link in `App.tsx`** (`<footer>` with a button toggling a `showLegal` state; render `<LegalPage />` when true). Reuse existing header/nav button styling.
- [ ] **Step 5: Style + run tests + build.**
- [ ] **Step 6: Commit** `feat: privacy policy + terms page`.

---

### Task 8: First-visit landing / explainer + Spotify attribution

**Files:**
- Modify: `src/components/Login.tsx` (add explainer copy above the login button)
- Modify: `src/components/Login.test.tsx`
- Modify: `src/index.css`

**Why:** A stranger hitting the bare login button has no idea what the app does or that it's safe. Spotify's **Design Guidelines** also require attribution when displaying Spotify content (the Sorter shows tracks/album art) — at minimum a "Powered by Spotify" / "not affiliated with Spotify" line and linking tracks back to Spotify. Confirm exact current logo/attribution rules at submission time.

- [ ] **Step 1: Write the failing test** — `Login` renders a one-paragraph explainer (what it does + privacy stance + Premium-optional) and a "not affiliated with Spotify" line.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** the explainer block in `Login.tsx` above the existing login button. Keep it short: what Kondo does (sort Liked Songs into playlists by genre), that everything runs in the browser, that playback previews need Premium but sorting doesn't.
- [ ] **Step 4 (attribution audit):** grep the Sorter/SongRow for where track name + album art render; ensure each links to the track's Spotify URL (`spotify_url`/`external_urls` already on the track objects). Add links if missing. Add a footer "Music data and playback provided by Spotify. Not affiliated with Spotify AB."
- [ ] **Step 5: Style + run tests + build.**
- [ ] **Step 6: Commit** `feat: landing explainer + Spotify attribution for public visitors`.

---

### Task 9: Submit for Extended Quota Mode (OPS — no code)

- [ ] **Step 1:** Confirm Tasks 7–8 are live on `kondo.shikhanovich.me`.
- [ ] **Step 2:** Spotify Dashboard → this app → **Extended Quota Mode** request form. Provide: app name, the live URL, a clear description ("sorts a user's Liked Songs into their existing playlists by genre; browser-only; non-commercial"), screenshots or a <2-min screen recording of the real flow, the privacy-policy URL, and commercial = **No**.
- [ ] **Step 3:** Explicitly confirm compliance with the Developer Policy + Design Guidelines (attribution from Task 8, no data resale, user-initiated actions only).
- [ ] **Step 4:** Submit. Track the response; expect weeks. If rejected, read the reason — it's usually a specific fixable policy/attribution gap, not a permanent no.

---

# OPTIONAL — Hardening (not launch-blocking)

### Task 10 (optional): Fill the thinnest-tested critical paths

Only if time allows before wide sharing. **Files/tests:** `src/App.test.tsx` (or a new `src/auth/flow.test.tsx`) for the `?code` → `exchangeCode` → `setAuthed` callback effect (`App.tsx:50-60`), currently only unit-tested at the token layer; and `src/components/Sorter.test.tsx` for the play/action error branches (`Sorter.tsx:98,121`). Standard TDD: write the integration test, watch it fail against a mocked `exchangeCode`, then confirm it passes against real wiring. Commit `test: cover auth callback flow and playback error branches`.

---

## Verification (end-to-end, on the live domain — gates Task 6)

Run these against `https://kondo.shikhanovich.me` after Task 5, in a browser where you are NOT already logged into the app (use a fresh profile / incognito, signed into a Spotify account that IS in the 25-user list):

1. **Login round-trip:** click "Log in with Spotify" → Spotify consent screen → redirects back to `…/callback?code=…` → lands authenticated on the Sorter. (If it errors with "INVALID_CLIENT" or redirect mismatch, the registered URI ≠ actual origin — recheck Task 5 Step 5.)
2. **Library loads:** playlists + Liked Songs appear (first load is slow — MusicBrainz 1 req/s — expected).
3. **Sort a song:** pick a Liked Song, add it to a playlist via MatchPicker, confirm the 8s undo appears and the song moves in Spotify.
4. **Non-Premium path (if you have a non-Premium tester):** clicking play shows the reassuring Premium message (Task 4), and sorting still works.
5. **ErrorBoundary:** no white-screen on any tab switch or transient API error — errors show as inline alerts or the fallback card, never a blank page.
6. **Legal + explainer (after Track B):** footer legal link opens the policy; logged-out landing shows the explainer + "not affiliated with Spotify".
7. **Automated gate at every commit:** `npx vitest run` (all pass), `npm run lint` (clean), `npm run build` (tsc + vite succeed).

## Self-review notes

- Spec coverage: hosting (T1,T5), the tracked-secret hygiene (T2), white-screen resilience (T3), Premium legibility (T4), the 25-user gate (T6), the Extended-Quota gate + its prerequisites — privacy policy (T7), landing/attribution (T8), submission (T9) — all have tasks.
- The one genuinely uncertain, out-of-our-control item is Spotify's approval (Task 9); flagged honestly rather than promised.
