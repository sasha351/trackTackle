# Handoff — rate-limit resilience execution

Paused 2026-07-28 to conserve tokens. Resume with the
**superpowers:subagent-driven-development** skill.

- **Plan:** `docs/superpowers/plans/2026-07-27-rate-limit-resilience.md`
- **Spec:** `docs/superpowers/specs/2026-07-27-rate-limit-resilience-design.md`
- **Ledger:** `.superpowers/sdd/progress.md` (git-ignored; recover from `git log` if lost)
- **Baseline:** `ce5930e`. Workflow is **one feature branch per task**, merged
  `--ff-only` into `main` after its review comes back clean.

## State — 7 of 9 tasks merged

| Task | Branch | Status |
|---|---|---|
| 1 — Token bucket governor | `task-1-token-bucket` | ✅ merged `7082b98` |
| 2 — Priority slots | `task-2-priority-slots` | ✅ merged `8fe2d1c` |
| 3 — Persisted gate + `RateLimitedError` | `task-3-persisted-gate` | ✅ merged `d512a5e` (1 fix round) |
| 4 — Library snapshot module | `task-4-library-snapshot` | ✅ merged `88c46d9` |
| 5 — Snapshot wiring into `useLibrary` | `task-5-snapshot-wiring` | ✅ merged `985b55c` (2 fix rounds) |
| 6 — Countdown hook + banner | `task-6-countdown-banner` | ✅ merged `1cf0cde` (1 fix round) |
| 7 — Self-heal, `refresh()`, `snapshotAge` | `task-7-self-heal` | ✅ merged `4419e45` (1 fix round) |
| 8 — Add-path rollback fix | — | **not started** |
| 9 — Toolbar cache age + Refresh | — | **not started** |

`main` is at `4419e45`. **193 tests passing, lint clean (2 pre-existing warnings), build clean.**

## PICK UP HERE — Task 8

Nothing is blocked. Both remaining tasks are fully specified in the plan and
independent of each other. Per-task loop:

```bash
SP=~/.claude/plugins/cache/superpowers-marketplace/superpowers/6.0.3/skills/subagent-driven-development
$SP/scripts/task-brief docs/superpowers/plans/2026-07-27-rate-limit-resilience.md 8
git checkout -b task-8-add-path-rollback
# dispatch implementer with the brief path + a report path
$SP/scripts/review-package 4419e45 HEAD
# dispatch reviewer with brief + report + package
git checkout main && git merge --ff-only task-8-add-path-rollback
```

**Task 8** fixes `handleAdd` in `src/components/Sorter.tsx`: when the playlist
add succeeds but the unsave fails, the current catch restores the row while the
song is already in the playlist, so a retry duplicates it. Self-contained.

**Task 9** adds the cache-age indicator and Refresh button to Sorter's toolbar,
consuming `lib.snapshotAge` and `lib.refresh()` from Task 7. Task 7 already
widened every `LibraryState` test double, so no type breakage is expected.

**One UI decision to make during Task 9** (raised twice in review): when a
refresh is rate-limited, `useLibrary` goes straight to `status: 'ready'` with
empty fingerprints, so every row renders "no candidate playlists" rather than a
loading placeholder — in exactly the state where the data is known-incomplete.
Decide whether the degraded view should say "unknown" instead.

## After Task 9 — final whole-branch review

```bash
$SP/scripts/review-package ce5930e HEAD
```

Dispatch on the most capable model, and **point it at the deferred-Minor list in
`.superpowers/sdd/progress.md`** so those get triaged rather than silently
discarded. The highest-value ones:

- Auto-resume drops the user's `force` flag (`useLibrary.ts`, `setReload({ force: false })`)
  — a rate-limited manual Refresh inside the TTL silently resumes into a pure
  cache read. One-word fix: `setReload((r) => ({ ...r }))`.
- Two comments in `useLibrary.ts` now overstate/misdescribe behaviour (~`:210-213`
  and `:341-343`). Comment accuracy is a binding constraint in this repo.
- `writeSnapshot` replaces `items` wholesale, so narrowing the target playlist set
  evicts other playlists' cached items (self-heals, costs refetches).
- The quota fallback stores `items: {}` *with* a new `savedAt`, so on a library big
  enough to blow the quota, `tracks`/`playlists` pin fresh indefinitely. Task 9's
  Refresh is the escape hatch.

Then use **superpowers:finishing-a-development-branch**.

## Still not done at all

The plan's **Final Verification** — the manual pass against a real library: cold
load spacing, two free reloads, a sorted song staying gone, and a forced-penalty
countdown. Needs `.env.local` with `VITE_SPOTIFY_CLIENT_ID` and `npm run dev` on
`127.0.0.1:5173` (**not** `localhost` — it resolves to `::1` and breaks Spotify auth).

**None of this work has been exercised against real Spotify traffic yet.**
