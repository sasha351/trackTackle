Title: Implementing issues from docs/superpowers/plans/issues.md
Date: 2026-07-22
Author: Copilot (working autonomously per user instruction)

Summary

This spec implements Parts A–F from docs/superpowers/plans/issues.md: fixes for the blocker network errors and auth UX, diagnostics and playback investigations, play latency UX, on-demand MusicBrainz work, and Settings layout.

Scope

- Apply the changes described in each Part (A–F) with minimal invasive edits and clear tests.
- Implement sequentially in this order: A → B → C → D → E → F.
- Defer speculative optimizations (connection semaphore) until evidence from Part A's probe.

Approach

Recommended: incremental small PRs, one Part per PR where feasible, each with unit tests and verification steps.

Per-Part Design

Part A — Network-retry and labeled token errors
- Files: src/api/spotify.ts, src/auth/token.ts
- Add try/catch around fetch in spotifyFetch loop; on rejection apply existing exponential backoff and retry. On final failure, throw SpotifyApiError with URL, attempt count, and original message.
- Wrap getValidAccessToken(clientId) and tokenRequest fetch with similar retry and labeled error ("token refresh: <msg>").
- Tests: simulate fetch rejection via vi.spyOn(globalThis,'fetch') and ensure retry succeeds; exhausted retries throw SpotifyApiError containing URL; token-endpoint rejection surfaces labeled message.
- Verification: run dev server in Safari, reproduce network failure mid-load and confirm UI message names layer+URL; ensure Settings → Diagnostics reachable.

Contingency: if failures cluster in getSavedTracks burst, add semaphore (max 6) in spotifyFetch. This is conditional and gated on probe evidence.

Part B — Auth recovery and skeleton rows
- Files: src/auth/token.ts, src/hooks/useLibrary.ts, src/App.tsx, src/components/Login.tsx, src/components/Sorter.tsx
- Export AuthError class; throw from getValidAccessToken when no tokens exist and from tokenRequest on 400/401.
- useLibrary: add authExpired flag set when AuthError caught; App: handle authExpired effect to clear tokens and set login notice; Login: accept optional notice prop and render role="status" banner.
- Replace loading text in Sorter with skeleton rows using existing shimmer styles.
- Tests: auth path returns to login with notice and localStorage cleared; Sorter renders skeleton rows.

Part C — Playback investigation (do not ship fixes until confirmed)
- Run the three tests in order: warm cache, leaked player instances, sample rate check.
- If leaked player confirmed, fix spotifyPlayer.disconnect leak: ensure player.disconnect() called before nulling handle.
- Tests: console.count confirm single construction; unit test for disconnect behavior if feasible.

Part D — Play button lag UX
- Files: src/components/Sorter.tsx, src/components/SongRow.tsx, src/player/spotifyPlayer.ts, src/index.css
- Pre-warm SDK on mount with initPlayer; add pendingUri state and spinner in SongRow when pending; add player_state_changed listener surfaced via PlayerHandle.onStateChange.
- Console.time instrumentation around playUri and record metrics to console for before/after comparisons.

Part E — On-demand MusicBrainz work
- Files: src/genre/resolver.ts, src/api/musicbrainz.ts, src/components/Analyzer.tsx, src/components/Sorter.tsx, src/components/MatchPicker.tsx, CLAUDE.md
- Skip lookupGenresBulk when !opts.deep; cache unresolved artists as {genres:[], source:'none'}.
- Remove nameSearch option & tests; add per-track deepResolveTrack and UI trigger in MatchPicker. Update CLAUDE.md to reflect changes.
- Verification: clear caches, confirm no musicbrainz.org requests at startup and that each trigger contacts MusicBrainz and updates matches.

Part F — Settings layout
- Files: src/components/Settings.tsx, src/components/MatchPicker.tsx (reuse search), CSS updates
- Reorder UI: sensitivity slider first, destinations second in a bounded scrollable responsive multi-column grid with search and select-all/none.

Testing & Verification

- Run npx vitest run, tsc -b, npm run lint after each Part. All tests must pass.
- Manual verification steps listed under each Part per docs/plans/issues.md.

Docs

- Update CLAUDE.md genre resolution section to match Part E changes.

Contingency and rollbacks

- Keep commits small, include tests. If a change regresses tests, revert the PR and open a follow-up issue.

Next steps

1. Implement Part A in a small PR with tests and verification.
2. Implement Part B after Part A verification.
3. Run Part C tests; only fix leak if confirmed.
4. Continue D, E, F with tests and verification.

