# Wikipedia vs MusicBrainz as the genre fallback

**Status: measured, decided, shipped in deep runs.** The prototype was built in
a sandbox with no network egress, so the first version of this document could
only model the decisive number. It has since been measured against a real
authenticated library, the model turned out to be wrong in an interesting way,
and the conclusion changed as a result. Both versions are kept below —
§"What the model got wrong" is the useful part.

- Design/brainstorm: `docs/superpowers/specs/2026-08-03-wikipedia-genre-resolver-design.md`
- Plan: `docs/superpowers/plans/2026-08-03-wikipedia-genre-resolver.md`
- Code: `src/api/wikipedia.ts`, `src/genre/resolver.ts`, `src/genre/benchmark.ts`, `src/genre/benchmark.live.test.ts`

## Outcome, in one paragraph

The Wikidata P1902 join resolves **46.9% of a real library (1727 / 3685
artists)** on its own, in **~110 s**. That is too slow for the default
(non-deep) phase — which kills this document's original recommendation — but it
is a clean win inside a **deep** run, which is already an explicit
"this takes a while" operation. So the join now runs first in a deep run, ahead
of MusicBrainz, and only the artists it misses go through the existing MB path
unchanged. The name-search + infobox combination was **not** adopted: its
measured precision/recall was too weak to trust.

## Why this was worth trying

The waterfall is `cache → Spotify /artists/{id} → MusicBrainz`, and MusicBrainz
is slow *by construction*: `src/api/musicbrainz.ts` serializes every request
through one promise chain at `MIN_SPACING_MS = 1100`. That is not a tuning
choice, it is MB's stated rate limit, and it cannot be parallelised. It is also
the reason `resolveAllGenres` skips MB entirely on a default run and caches
misses as retryable `unresolved` — the fallback is too expensive to put in
front of the user.

MB's answers are also coarse: `tagsToGenres` filters raw folksonomy tags against
MB's canonical `/genre/all` list, which is the correct thing to do with a tag
cloud and also the thing that discards subgenre detail.

## What "a Wikipedia lookup" turned out to be

The single most useful finding from the brainstorm is that the chosic-style
approach is **two** strategies with very different cost profiles, and the cheap
one is not the one you'd reach for first:

- **W-TEXT** — article title → lead wikitext (`rvsection=0`) → parse the
  `genre =` field out of `{{Infobox musical artist}}`. One request per artist.
  Highest resolution: infobox editors write *shoegaze*, *witch house*, *UK
  garage*, *city pop* — labels MB's canonical list frequently does not carry.
- **W-DATA** — one Wikidata SPARQL query joins Spotify artist IDs (property
  **P1902**) to genre statements (**P136**) *and* returns the enwiki article
  title. One request covers ~150 artists. Coarser than the infobox, but its
  marginal cost per artist is effectively zero.

They compose: W-DATA hands W-TEXT a set of already-correct article titles.

**That composition removes the disambiguation problem entirely.** The obvious
W-TEXT design is `artist name → search → title`, which is the exact trap
`musicbrainz.ts` already documents — name search misses transliterated artists,
and Spotify transliterates non-Latin artist names. Keying the join on the
Spotify ID means no name search, no `Bush` vs `Bush (band)`, no transliteration
failure mode. It is the same reason MB prefers `/url?resource=` over name search.

## (A) Effectiveness — **measured**

**The decisive number: the Wikidata P1902 join resolves 46.9% of a real library
(1727 / 3685 artists) on its own** — no name search, no infobox parse. Measured
directly against an authenticated library via the DEV-only "Wikidata join-hit
rate (real library)" probe in `src/components/Settings.tsx`, because that number
is not obtainable any other way: it needs real Spotify artist IDs, which means a
real OAuth session, which no sandbox or Node script has.

The name-search + infobox combination was measured too and **was not adopted** —
its precision/recall came back too weak to trust. So the thing that shipped is
the *coarser, cheaper* half of the original design, not the high-resolution half
that motivated it. Wikidata's P136 statements are curated; the infobox path's
extra specificity did not survive contact with the accuracy check.

A harness bug had to be fixed before any of this was real: Node's `fetch` sends
no `User-Agent`, and both MusicBrainz (403, "has not identified itself") and
Wikipedia (429) treat that far more harshly than a real browser, which always
sends one. Unpatched, the harness reported **0% coverage for both providers** —
a clean-looking result that was pure artifact. Fixed in the Node-only benchmark
script; no production code changed, since browsers cannot set a UA regardless
(which is why `wikipedia.ts` and `musicbrainz.ts` still send none).

The offline parse benchmark still stands as a narrower check — that the infobox
parser handles the markup shapes real articles use:

| provider | artists | answered | absent | coverage | precision | recall | f1 | specificity | labels |
|---|---|---|---|---|---|---|---|---|---|
| wikipedia-parser (offline, authored fixtures) | 16 | 16 | 0 | 75.0% | 100.0% | 100.0% | 100.0% | 72.0% | 25 |

*(`npx vitest run src/genre/benchmark.test.ts`, real output.)*

Read this correctly: the fixtures in `src/genre/fixtures/wikitext.ts` are
**authored from knowledge, not recorded from live Wikipedia**. Precision 1.0
means the parser extracted what the fixture author put there. It measures
*parser* correctness against realistic markup — `{{hlist|a|b}}`, `{{flatlist}}`,
piped links, `<ref>` noise, malformed braces — and it says **nothing** about how
many real artists have a usable infobox genre field. The 4 fixtures with no
genre field / no infobox / malformed braces correctly return `[]` and are
excluded from precision as undefined rather than scored as failures. The 75%
coverage figure is a property of the fixture mix, not of Wikipedia.

## (B) Latency — **measured: ~110 s for 3685 artists**

The join-only pass takes **~110 s on a 3685-artist library**. That single number
is what settled the placement question, and it settled it against the original
recommendation.

### What the model got wrong

The pre-measurement model below predicted the join at **~2–10 s for 500
artists**, reasoning from request count: 4 SPARQL requests, no mandated spacing,
therefore fast. The real figure works out to roughly **4.4 s per SPARQL
request** (≈25 requests for 3685 artists at 150/chunk).

The error was assuming request *count* was the cost driver, because that is what
dominates MusicBrainz. For WDQS it isn't: each query carries a `VALUES` clause
with 150 IDs, and query *evaluation* time dominates round-trip time. Batching
harder makes each request proportionally slower — it does not buy the win that
the same batching buys against MB's fixed 1100 ms spacing.

The general lesson, worth carrying to the next API comparison: a rate-limit
model transfers between services, a *query-cost* model does not.

### The original model, kept for the comparison

For **N = 500** uncached artists, with `h` = the fraction the ID-join resolves:

| path | requests | wall-clock |
|---|---|---|
| **MB deep** (`nameSearch: true`) | `⌈N/50⌉` URL-join + `N(1−h)` serial name searches + `⌈Nh/50⌉` arid | `× 1100 ms`, strictly serial |
| — at h = 1.0 (best case) | 10 + 0 + 10 = **20** | **~22 s** |
| — at h = 0.6 | 10 + 200 + 6 = **216** | **~4 min** |
| **W-DATA only** (join, no infobox) | `⌈N/150⌉` = **4** | **~2–10 s**, no per-second cap |
| **W-TEXT deep** (join + infobox) | 4 + `Nh` titles at concurrency 4 | ~4 + (300/4 × ~250 ms) ≈ **~25 s** |

Of the two claims drawn from that table, one held and one did not:

1. **"MB's floor is the serial queue, not the request count."** Held. Its best
   case is ~22 s for 500 artists and degrades linearly with join misses at 1.1 s
   each — still why deep runs take minutes.
2. **"W-DATA has no equivalent floor, so it could run inside phase 1."** Wrong.
   It has a different floor — per-query evaluation cost — and at ~110 s for a
   real library it does not fit phase 1's budget at all.

`h`, the ID-join hit rate, came back at **46.9%**.

## (C) Pipeline placement — what shipped

**MusicBrainz was not replaced.** It still handles every artist the join misses,
unchanged, and `fallback: 'wikipedia'` still exists to route a deep run through
Wikipedia end-to-end.

**The original recommendation — the join in the default phase — is dead.**
`useLibrary`'s phase 1 budget is "seconds, not blocked on genres"; ~110 s is not
that. The structural argument for it (few requests, no mandated spacing) was
sound about MusicBrainz and simply wrong about WDQS.

**What shipped instead: the join runs first inside a *deep* run**, ahead of
MusicBrainz (`src/genre/resolver.ts`). A deep run is already an explicit
"this takes a while" operation the user opts into, so 110 s buys 46.9% of the
library at a cost the user has already accepted. Properties that make it low
risk:

- **It only ever adds.** A join miss is never cached, so the artist falls
  through to MusicBrainz exactly as before. A miss changes nothing.
- **A transient WDQS failure is not a miss.** Failed SPARQL chunks come back
  absent rather than `[]`, so they are not cached as durable `none` — the same
  absent-vs-empty contract MB follows.
- **It does not double-run.** When `fallback: 'wikipedia'` is already selected,
  the supplement is skipped, because `lookupGenresBulk` runs this same join as
  its own first phase.
- **Join-only, deliberately.** No name search, no infobox parse — that
  combination's measured precision/recall was too weak to trust.

This *does* change default deep-run behaviour, which the earlier version of this
document promised it would not. That promise was conditional on the measurement,
and the measurement came back in favour.

The end state is a three-tier waterfall, one tier lower than originally hoped:
Spotify (fast phase) → **W-DATA join → MusicBrainz** (both deep). MB stays in
the deep tier because it and Wikidata miss *different* artists, and the deep
path's whole justification is that the user asked for it and will wait.

### Still open

- **The offline fixture is still `spotifyId: null` throughout.** The join-hit
  rate was measured through the Settings probe against a real library instead,
  which is the better measurement, but it means
  `src/genre/benchmark.live.test.ts` still drives both providers down their
  name-search path rather than the ID-join path production uses. Backfilling
  real IDs would make that harness match production.
- **Specificity was never re-measured live.** The 72% figure below is from
  authored fixtures. Since the infobox path did not ship, this matters less than
  it did — but "are MB's labels too broad" remains formally unanswered on real
  data.
- **~110 s is unoptimised.** Nobody has tried tuning the 150-ID chunk size
  against WDQS query cost, and per-query evaluation time being the driver means
  *smaller* chunks might well be faster overall.

## What is committed here

| file | what it is |
|---|---|
| `src/api/wikipedia.ts` | the provider — SPARQL join, opt-in name search, opt-in infobox phase, brace-depth-aware parser |
| `src/api/wikipedia.test.ts` | 26 tests, all offline |
| `src/genre/resolver.ts` | the deep-run join supplement, plus `fallback?: 'musicbrainz' \| 'wikipedia'` |
| `src/components/Settings.tsx` | DEV-only "Wikidata join-hit rate (real library)" probe — how 46.9% was measured |
| `src/genre/fixtures/` | 50 ground-truth artists (mainstream / niche / non-latin), 16 wikitext samples |
| `src/genre/benchmark.ts` | pure scorers incl. specificity |
| `src/genre/benchmark.test.ts` | scorer units + the offline parse benchmark |
| `src/genre/benchmark.live.test.ts` | the real A/B, skipped unless `KONDO_LIVE_BENCH=1`; stamps a User-Agent because Node's fetch sends none |

`npx vitest run` — 367 passed, 1 skipped (the live bench). `npm run lint` — two
pre-existing warnings, none new. `npm run build` — passes.

One unrelated fix rode along: `npm run build` was already failing on `main`
(`src/components/MatchPicker.test.tsx`, `querySelector` returning `Element` where
`toContainElement` wants `HTMLElement`). Fixed in its own commit so the branch
could be verified at all.
