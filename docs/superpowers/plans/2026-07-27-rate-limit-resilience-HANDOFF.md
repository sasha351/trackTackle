# Handoff — rate-limit resilience execution

Paused 2026-07-27 to conserve credits. Resume with the
**superpowers:subagent-driven-development** skill.

- **Plan:** `docs/superpowers/plans/2026-07-27-rate-limit-resilience.md`
- **Spec:** `docs/superpowers/specs/2026-07-27-rate-limit-resilience-design.md`
- **Ledger:** `.superpowers/sdd/progress.md` (git-ignored; recover from `git log` if lost)
- **Baseline:** `ce5930e`. Workflow is **one feature branch per task**, merged
  `--ff-only` into `main` after its review comes back clean.

## State

| Task | Branch | Status |
|---|---|---|
| 1 — Token bucket governor | `task-1-token-bucket` | ✅ merged `7082b98` |
| 2 — Priority slots | `task-2-priority-slots` | ✅ merged `8fe2d1c` |
| 3 — Persisted gate + `RateLimitedError` | `task-3-persisted-gate` | ✅ merged `d512a5e` (incl. 1 fix round) |
| 4 — Library snapshot module | `task-4-library-snapshot` | ✅ merged `88c46d9` |
| 5 — Snapshot wiring into `useLibrary` | `task-5-snapshot-wiring` | ⚠️ **committed `035770b`, NOT merged — review returned Needs fixes** |
| 6 — Countdown hook + banner | — | not started |
| 7 — Self-heal, `refresh()`, `snapshotAge` | — | not started |
| 8 — Add-path rollback fix | — | not started |
| 9 — Toolbar cache age + Refresh | — | not started |

`main` is at `88c46d9`. Tests at that point: 173 passing, lint and build clean.

## PICK UP HERE — Task 5's open Important finding

Task 5 is implemented and its spec compliance is ✅, but the review found a real
bug. **Do not merge `task-5-snapshot-wiring` until this is fixed.**

**The bug: playlist items are pinned forever, so fingerprints silently go stale.**

`writeSnapshot` merges into the stored record and re-stamps `savedAt = Date.now()`
(`librarySnapshot.ts:97`), and `readSnapshot` does not check freshness. Two effects
compound:

- `useLibrary.ts:147` writes unconditionally, even on a load where `missing.length === 0`
  and nothing was fetched — so every successful load extends the TTL by another 6h.
- When the TTL does expire, `useLibrary.ts:36` refetches tracks/playlists and writes,
  carrying the *expired* `items`/`artistNames` forward and stamping them fresh.
  `enrichLibrary` then sees them as fresh, `missing` is empty, and playlist items are
  never refetched again.

Net: a song added to a target playlist in the Spotify app never influences that
playlist's fingerprint again — cumulative matching drift with no expiry path until
Task 9's Refresh button ships. The reviewer's two-line fix, both in `src/hooks/useLibrary.ts`:

```ts
// :36 — an expired snapshot's items expired too; don't carry them forward as fresh
writeSnapshot({ tracks, playlists: allPlaylists, items: {}, artistNames: {} });

// :147 — a write that fetched nothing must not re-stamp the TTL
if (missing.length > 0) writeSnapshot({ items, artistNames });
```

Dispatch a fix subagent with that finding, have it add a covering test
(a snapshot whose TTL expires must refetch playlist items, and a no-op load must not
extend `savedAt`), re-run `npx vitest run` + `npm run lint` + `npm run build`, then
re-review with `scripts/review-package 88c46d9 HEAD` before merging.

Task 5's three Minor findings are recorded in the ledger and deferred to the final
whole-branch review — the most actionable is that `items` gets narrowed to the current
target-playlist set on every write while `artistNames` only ever grows.

## After Task 5 merges

Tasks 6-9 are unstarted and fully specified in the plan. Per-task loop:

```bash
WS=$(.../skills/subagent-driven-development/scripts/sdd-workspace)
.../scripts/task-brief docs/superpowers/plans/2026-07-27-rate-limit-resilience.md N
git checkout -b task-N-<slug>
# dispatch implementer with the brief path + report path
.../scripts/review-package <main-tip> HEAD
# dispatch reviewer with brief + report + package
git checkout main && git merge --ff-only task-N-<slug>
```

Note for **Task 7**: it widens `LibraryState` with `refresh` and `snapshotAge`, which
breaks `mockLibrary` in `src/components/Sorter.test.tsx`. The plan already carries that
as a step inside Task 7 — don't let it surface as a surprise in Task 9.

Note for **Task 6**: it adds the first real subscriber to the rate-limit gate. Task 3's
subscriber guard catches throws silently; if a countdown bug ever needs debugging, add a
`console.error` in that catch (`src/api/spotify.ts`).

## Deferred minors for the final whole-branch review

Carried in `.superpowers/sdd/progress.md`, one line per task. Point the final reviewer at
that list so they get triaged rather than silently discarded.

## Not yet done at all

The plan's **Final Verification** section — the manual pass against a real library
(cold load spacing, two free reloads, sorted song staying gone, forced-penalty countdown).
Needs `.env.local` with `VITE_SPOTIFY_CLIENT_ID` and `npm run dev` on `127.0.0.1:5173`
(**not** `localhost` — it resolves to `::1` and breaks Spotify auth).
