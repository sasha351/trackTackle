# Wikipedia vs MusicBrainz as the genre fallback

**Status: prototype landed, live A/B not yet run.** Everything in this document
that is *measured* is labelled measured; everything *modeled* is labelled modeled
and shows its arithmetic. The one number that decides the recommendation has not
been measured yet, and the harness to measure it is committed here.

- Design/brainstorm: `docs/superpowers/specs/2026-08-03-wikipedia-genre-resolver-design.md`
- Plan: `docs/superpowers/plans/2026-08-03-wikipedia-genre-resolver.md`
- Code: `src/api/wikipedia.ts`, `src/genre/benchmark.ts`, `src/genre/benchmark.live.test.ts`

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

## (A) Effectiveness — **not yet measured**

The accuracy half of the benchmark requires network access to both services.
This environment's egress policy returns **403 on CONNECT** for
`en.wikipedia.org`, `query.wikidata.org`, and `musicbrainz.org` (verified with
`curl` and with the WebFetch tool). So the honest answer is: **unknown**, and
nothing here should be read as evidence that Wikipedia resolves genres better
than MusicBrainz in practice.

What *was* measured is narrower — that the infobox parser handles the markup
shapes real articles use:

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

The specificity figure (72% of labels outside the 25 coarse buckets) is the one
worth re-measuring live, because it is the metric that encodes the actual
complaint. MB does return labels; the question is whether they are broad ones.

## (B) Latency — **modeled, with the arithmetic shown**

Not measured, for the same reason. But the request-count model is derivable from
the code and is where the real difference lives, because MB multiplies its
request count by a hard 1100 ms and Wikipedia does not.

For **N = 500** uncached artists, with `h` = the fraction the ID-join resolves:

| path | requests | wall-clock |
|---|---|---|
| **MB deep** (`nameSearch: true`) | `⌈N/50⌉` URL-join + `N(1−h)` serial name searches + `⌈Nh/50⌉` arid | `× 1100 ms`, strictly serial |
| — at h = 1.0 (best case) | 10 + 0 + 10 = **20** | **~22 s** |
| — at h = 0.6 | 10 + 200 + 6 = **216** | **~4 min** |
| **W-DATA only** (join, no infobox) | `⌈N/150⌉` = **4** | **~2–10 s**, no per-second cap |
| **W-TEXT deep** (join + infobox) | 4 + `Nh` titles at concurrency 4 | ~4 + (300/4 × ~250 ms) ≈ **~25 s** |

Two things follow that do *not* depend on the unmeasured numbers:

1. **MB's floor is the serial queue, not the request count.** Even its best case
   is ~22 s for 500 artists, and it degrades linearly with join misses — one
   name search per miss, 1.1 s each. This is why deep runs take minutes today.
2. **W-DATA has no equivalent floor.** Four requests for 500 artists, with no
   mandated spacing. That is the first fallback in this app's history that could
   plausibly run inside phase 1.

`h` — the ID-join hit rate, Wikidata P1902 coverage vs MB's Spotify-URL relation
coverage — is the decisive unknown, and it is the number the live harness
reports as `joinHits`.

## (C) Pipeline placement — the actual recommendation

**Do not replace MusicBrainz.** The accuracy comparison has not been run, and
replacing a working fallback on the strength of a parser unit test would be
backwards. The prototype is wired in behind
`resolveAllGenres(..., { fallback: 'wikipedia' })`, defaulting to
`'musicbrainz'`, so the shipped path is byte-for-byte unchanged.

**The promising move is placement, not replacement**, and it is a supplement
rather than a swap: put the **W-DATA join alone** — no infobox phase — into the
default (non-deep) phase alongside Spotify. The argument is structural:
`useLibrary`'s phase 1 budget is "seconds, not blocked on genres", and 4
requests with no rate-limit spacing fits inside it in a way MB's serial queue
never could. Every artist it resolves is one fewer cached as `unresolved`, and
artists it misses fall through to exactly today's behaviour.

**Conditions before that ships** — in order:

1. Run `KONDO_LIVE_BENCH=1 npx vitest run src/genre/benchmark.live.test.ts` on a
   machine with egress. It reports coverage, precision/recall, specificity,
   wall-clock, request count, and `joinHits` for both providers.
2. Backfill real Spotify IDs into `src/genre/fixtures/benchmarkArtists.ts`.
   Every `spotifyId` is currently `null` — there is no Spotify OAuth in a cloud
   sandbox, and fabricating IDs would have silently poisoned the P1902 join and
   produced a fake measurement. Without real IDs the harness drives **both**
   providers down their name-search path, which is fair but is not the path
   production uses and is slower for both.
3. Gate on the measured W-DATA join wall-clock actually landing in the low
   seconds for a realistic library, not on the model above.

**If the live numbers come back good**, the end state is a three-tier waterfall:
Spotify → W-DATA join (default phase, cheap, coarse) → infobox + MB (deep,
expensive, specific). MB is worth keeping in the deep tier even then: it and
Wikipedia miss *different* artists, and the deep path's whole justification is
that the user asked for it and will wait.

**If they come back bad** — if P1902 coverage is low, or WDQS is slow or flaky
under real query load — then MB stays as-is and this branch is a documented
negative result. `src/api/wikipedia.ts` is self-contained and deleting it
touches nothing but the one `fallback` option.

## What is committed here

| file | what it is |
|---|---|
| `src/api/wikipedia.ts` | the provider — SPARQL join, opt-in name search, opt-in infobox phase, brace-depth-aware parser |
| `src/api/wikipedia.test.ts` | 26 tests, all offline |
| `src/genre/resolver.ts` | `fallback?: 'musicbrainz' \| 'wikipedia'`, default unchanged |
| `src/genre/fixtures/` | 50 ground-truth artists (mainstream / niche / non-latin), 16 wikitext samples |
| `src/genre/benchmark.ts` | pure scorers incl. specificity |
| `src/genre/benchmark.test.ts` | scorer units + the offline parse benchmark |
| `src/genre/benchmark.live.test.ts` | the real A/B, skipped unless `KONDO_LIVE_BENCH=1` |

`npx vitest run` — 365 passed, 1 skipped (the live bench). `npm run lint` — two
pre-existing warnings, none new. `npm run build` — passes.

One unrelated fix rode along: `npm run build` was already failing on `main`
(`src/components/MatchPicker.test.tsx`, `querySelector` returning `Element` where
`toContainElement` wants `HTMLElement`). Fixed in its own commit so the branch
could be verified at all.
