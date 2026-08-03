# Wikipedia Genre Resolver — Implementation Plan

**Goal:** Prototype a Wikipedia/Wikidata genre resolver as a *challenger* to the
MusicBrainz fallback, benchmark the two, and land a recommendation. MusicBrainz
stays the default until the benchmark says otherwise.

**Spec:** `docs/superpowers/specs/2026-08-03-wikipedia-genre-resolver-design.md`

**Architecture:** One new module `src/api/wikipedia.ts` exporting a function with
the *same signature* as `musicbrainz.ts`'s `lookupGenresBulk`, so `resolver.ts`
can swap providers behind one option and the benchmark can drive both through
one code path. Two internal phases: a Wikidata SPARQL join (Spotify id → enwiki
title + P136 genres, one request) and a per-title infobox wikitext parse.

## Global Constraints

- **No new runtime dependencies.** The app has exactly two: `react`, `react-dom`.
  `fetch` is native; the infobox extractor is hand-written (a wikitext library
  for one field is not justified).
- Full suite: `npx vitest run`. Lint: `npm run lint`. Build: `npm run build`.
- Tests colocated as `*.test.ts`, vitest + jsdom, globals on. Session-global
  state exports `reset*ForTests()` called in `beforeEach`/`afterEach`.
- Non-obvious code carries a *why* comment. `ponytail:` marks deliberate
  simplifications and names their ceiling.
- **Never touch `main`.** All work on `explore/wikipedia-genre-resolver`.
- **Do not change MusicBrainz's default.** `resolveAllGenres` keeps MB as the
  fallback unless a caller opts in.
- No live network in this sandbox (egress policy 403s Wikimedia and MusicBrainz).
  Every test must pass offline with `fetch` mocked. The live harness is gated
  behind an env var.

---

## Task 1 — `src/api/wikipedia.ts` (+ tests)

**Files:** create `src/api/wikipedia.ts`, `src/api/wikipedia.test.ts`

**Exports:**
- `lookupGenresBulk(artists, onProgress?, onResult?, opts?)` — signature-compatible
  with `musicbrainz.ts`. `opts: { nameSearch?: boolean; infobox?: boolean; onPhase?: (p: WikiPhase, artist?: string) => void }`.
- `parseInfoboxGenres(wikitext: string): string[]` — pure, exported for tests.
- `resetWikipediaForTests()`.
- `type WikiPhase = 'joining' | 'searching' | 'fetching'`.

**Behaviour:**
1. **Join phase** — one WDQS SPARQL POST/GET for all Spotify ids via `wdt:P1902`,
   yielding `{ spotifyId → { title, genres[] } }`. Chunked if the query gets long.
2. **Name-search fallback** — only when `opts.nameSearch`, for ids the join missed.
3. **Infobox phase** — only when `opts.infobox`, concurrency-4 pool over titles,
   `action=query&prop=revisions&rvslots=main&rvprop=content&rvsection=0&origin=*`,
   parse the `genre =` field. Infobox genres take precedence over P136 genres
   when both exist; the two are unioned.
4. **Absent vs empty** contract must match MB exactly: an artist *absent* from
   the returned map = transient failure (leave uncached); mapped to `[]` = durable
   "nothing there". `resolveAllGenres` depends on this distinction.
5. `origin=*` on every Action API URL — required for anonymous CORS; a why-comment
   must say so.
6. Title → `kondo:wd-titles:v1` cache so a repeat deep run skips the join.

**Parser requirements** (drive these as tests first):
- brace/bracket-depth-aware field slicing — `{{hlist|a|b}}` pipes are not separators
- `{{flatlist| * [[X]] * [[Y]] }}`, `{{hlist|…}}`, plain comma lists, bare `[[X]]`
- strip `<ref …>…</ref>`, `<ref …/>`, `<!-- … -->`
- `[[Target|Display]] → display`, `[[Target]] → target`
- normalize: lowercase, collapse whitespace, strip trailing ` music`, dedupe
- no `{{Infobox musical artist}}` or no `genre` field → `[]`, never throw

---

## Task 2 — benchmark fixture

**Files:** create `src/genre/fixtures/benchmarkArtists.ts`, `src/genre/fixtures/wikitext.ts`

- ~50 real artists: mainstream, niche/subgenre-heavy, and non-Latin-script
  (Cyrillic, Hangul, Japanese, Arabic, Chinese) — the transliteration case
  `CLAUDE.md` calls out.
- Each: `{ name, spotifyId: string | null, expected: string[] }`. `spotifyId` is
  `null` — no OAuth here, and fabricating ids would silently poison the join.
  Documented, and the harness reports the join-hit count so a real run shows it.
- `wikitext.ts`: authored-from-knowledge lead-wikitext samples reproducing real
  infobox shapes, for the offline parse benchmark. Must be labelled as authored,
  not recorded.

---

## Task 3 — resolver integration

**Files:** modify `src/genre/resolver.ts`, `src/types.ts`, `src/genre/resolver.test.ts`

- `GenreInfo['source']` gains `'wikipedia'`; `GenreCoverage` gains `wikipedia`.
  Additive — **no cache version bump**, existing entries stay valid.
- `resolveAllGenres` opts gain `fallback?: 'musicbrainz' | 'wikipedia'`, default
  `'musicbrainz'`. Nothing changes for existing callers.
- Wikipedia results write `source: 'wikipedia'`; empty-but-answered still writes
  the durable `'none'`, absent still stays uncached.
- New tests: fallback selection, source recorded, absent-vs-empty preserved,
  default unchanged.

---

## Task 4 — benchmark

**Files:** create `src/genre/benchmark.ts`, `src/genre/benchmark.test.ts`,
`src/genre/benchmark.live.test.ts`

- `benchmark.ts` — pure scorers: `coverage`, `precision`, `recall`, `f1`,
  `specificity` (share of labels outside a coarse-bucket list), `formatTable`.
- `benchmark.test.ts` — unit tests for the scorers **plus** the offline parse
  benchmark: run `parseInfoboxGenres` over the wikitext fixtures, score against
  `expected`, print the table. Runs in the normal suite, no network.
- `benchmark.live.test.ts` — `describe.skipIf(!process.env.KONDO_LIVE_BENCH)`,
  drives both providers over the fixture with real fetch and prints A/B/C tables.
  Never runs in CI or a plain `npx vitest run`.

---

## Task 5 — verify

`npx vitest run`, `npm run lint`, `npm run build` all green.

## Task 6 — report

`docs/wikipedia-genre-benchmark.md`: brainstorm findings, numbers (measured vs
modeled clearly separated), recommendation on A/B/C.
