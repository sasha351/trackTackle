# Wikipedia Genre Resolver — Design

**Problem.** The genre waterfall is `cache → Spotify /artists/{id} → MusicBrainz`.
MusicBrainz is the only high-resolution fallback, and it is slow by construction:
`src/api/musicbrainz.ts` serializes *every* request through one promise chain at
`MIN_SPACING_MS = 1100`, and the per-artist name-search fallback costs ~1.1s each.
That cost is why `resolveAllGenres` skips MB entirely on a default run and caches
misses as retryable `unresolved`. MB's answers are also coarse: `tagsToGenres`
filters raw folksonomy tags against MB's canonical `/genre/all` list, which
tops out at fairly broad labels for most artists.

chosic.com gets more specific subgenre labels by combining Spotify's tags with a
Wikipedia lookup. This spec evaluates that as a challenger.

## Finding 1 — "Wikipedia lookup" is two different strategies, not one

| Endpoint | Batching | Payload | Verdict |
|---|---|---|---|
| REST `/api/rest_v1/page/summary/{title}` | 1/req | plain-text lead, **infobox stripped** | ✗ genres are almost never in lead prose |
| Action `prop=extracts&exintro` | 20 titles/req | same, infobox stripped | ✗ same |
| Action `prop=revisions&rvprop=content&rvslots=main` | 50 titles/req | **full** article wikitext | ✗ a major-artist article is 100–400 KB; 50 of them is ~10 MB/request |
| Action `prop=revisions` + `rvsection=0` | **1 title/req** — `rvsection` rejects multi-page queries | lead wikitext only, ~2–8 KB, **includes the infobox** | ✔ this is the chosic approach |
| Action `action=parse&prop=wikitext&section=0` | 1/req | equivalent | ✔ equivalent |
| Wikidata `wbgetentities` | 50 ids/req | structured claims incl. **P136 (genre)** | ✔ but needs the Q-id first |
| **WDQS SPARQL on `wdt:P1902`** | **whole library in 1 req** | Spotify artist id → genre labels **+ enwiki article title** | ✔✔ |

So there are two challengers, with different cost/resolution profiles:

- **W-TEXT (chosic-style).** Article title → lead wikitext → parse the `genre =`
  field out of `{{Infobox musical artist}}`. One request per artist. Highest
  resolution: infobox editors write *"UK garage"*, *"witch house"*, *"chillwave"*,
  *"shoegaze"* — labels MB's canonical genre list frequently does not carry.
- **W-DATA (Wikidata).** One SPARQL query joins Spotify artist IDs
  (property **P1902**) to genre statements (**P136**). Structurally the same
  trick as MB's `/url?resource=` → MBID join, except one request covers the
  entire library instead of one per 50, and it returns the enwiki sitelink too.
  Lower resolution than the infobox — P136 statements are sparser than the prose
  editors put in infoboxes — but its marginal cost per artist is ~zero.

## Finding 2 — the composite kills the disambiguation problem entirely

The obvious W-TEXT design is `artist name → search → article title`, and it is
the same trap `src/api/musicbrainz.ts` already documents: name search misses
transliterated artists, and Spotify transliterates non-Latin artist names
(`CLAUDE.md`, Matching section). It also drags in disambiguation handling —
`Bush` the shrub vs `Bush (band)`, `Nas` vs `NAS`, `Amber` (six different
musicians).

W-DATA removes it. The SPARQL join is keyed on the **Spotify artist ID**, so it
returns the exact enwiki article title for that exact artist. No name search, no
disambiguation heuristics, no transliteration failure mode. W-TEXT then fetches
lead wikitext for titles that are already known-correct.

**Composite pipeline:**

```
Spotify ids ──SPARQL(P1902)──> { Q-id, enwiki title, P136 genre labels }   1 request
                                        │
                        (deep only)     └──> lead wikitext per title ──> infobox genres
```

Name search stays as a last-resort fallback for artists with no P1902 statement,
behind an explicit opt-in flag, exactly as `nameSearch` works for MB today.

## Finding 3 — the latency gap is structural, not incidental

MusicBrainz's floor is `MIN_SPACING_MS (1100) × request count`, enforced by one
global promise chain. It cannot be parallelised without violating MB's stated
limit. For 50 uncached artists: 1 URL-join request + 1 `arid:` search + one
1.1s name search per URL-join miss.

Wikimedia has no equivalent per-second cap for anonymous browser traffic. WDQS
asks for ≤5 concurrent queries and a 60s timeout; the Action API asks for a
descriptive `User-Agent`, which — as `musicbrainz.ts` already documents in a
`ponytail:` comment — browsers forbid setting. The practical consequence is that
W-TEXT can run a concurrency-4 pool where MB must run strictly serial. **That is
the entire latency argument**, and it is a property of the two services' policies
rather than of this codebase.

Both Wikimedia APIs need CORS handled: the Action API requires `origin=*` on the
query string for anonymous cross-origin reads (omit it and the browser gets an
opaque failure); WDQS already sends `Access-Control-Allow-Origin: *`.

## Finding 4 — infobox parsing needs brace-depth awareness

Real `genre =` field shapes, all common:

```wikitext
| genre = {{flatlist|
* [[Electronic music|Electronic]]
* [[Ambient music|Ambient]]
}}
| genre = {{hlist|[[Hip hop music|Hip hop]]|[[Trap music (hip hop)|Trap]]}}
| genre = [[Alternative rock]], [[grunge]]
| genre = [[K-pop]]<ref name="billboard"/>
```

The naive `/\|\s*genre\s*=([^|]*)/` fails on the first two: `{{hlist|a|b}}`
contains pipes that are not field separators. The extractor must slice the field
by tracking `{{ }}` and `[[ ]]` depth. It then strips `<ref>…</ref>` and
`<!-- … -->`, unwraps `[[Target|Display]] → Display` and `[[Target]] → Target`,
splits on list markers and commas, and normalizes (lowercase, collapse
whitespace, strip a trailing ` music`).

## Finding 5 — vocabulary must NOT be filtered through MB's genre list

MB's `tagsToGenres` filters against `/genre/all` because the `arid:` search
returns raw folksonomy noise (`"seen live"`, `"usa"`). Wikipedia's infobox field
is already curated — it is a genre field, not a tag cloud — so filtering it
through MB's list would discard precisely the specific subgenres that motivate
this whole exercise. Normalize, drop obvious non-genres, do not whitelist.

This does mean the matching engine sees a slightly wider vocabulary. That is
benign: `scoreSong` uses cosine similarity over genre strings, and both the
playlist fingerprint and the song are resolved by the same provider, so the
vocabularies stay aligned within a run.

## Finding 6 — cache shape

`GenreInfo['source']` gains `'wikipedia'`. Additive, so `kondo:genres:v3` does
**not** need a v4 bump — existing entries simply never carry the new value, and
no user's cache is invalidated. `GenreCoverage` gains a matching counter.

## Benchmark design

Ground truth: a hardcoded fixture of ~50 real artists spanning mainstream, niche,
and non-Latin-script cases, each with expected genre labels. No live library is
available (no OAuth in a cloud sandbox), and the fixture is the substitute.

- **(A) Effectiveness** — per provider: coverage (% artists resolved to ≥1
  genre), precision and recall against the expected set, and **specificity**:
  the share of returned labels that are *not* in a ~25-item coarse-bucket list
  (rock/pop/electronic/hip hop/jazz/…). Specificity is the metric that actually
  encodes the user's complaint — MB returns labels, they are just broad ones.
- **(B) Latency** — wall-clock for the whole fixture, mean per artist, and
  request count per provider. Request count matters more than raw wall-clock
  because MB's is multiplied by a fixed 1.1s.
- **(C) Placement** — the gate is `useLibrary`'s phase-1 budget: "seconds, not
  blocked on genres". A fallback earns a place in the **default** (non-deep)
  phase only if its added wall-clock for a realistic uncached-artist count stays
  in the low seconds. One SPARQL request plausibly clears that bar; one request
  per artist plausibly does not.

## Sandbox constraint (recorded, because it bounds the results)

This environment's egress policy returns 403 on CONNECT for `en.wikipedia.org`,
`query.wikidata.org`, and `musicbrainz.org` (verified by `curl` and by the
WebFetch tool). The live benchmark therefore **cannot be executed here**. The
work is split accordingly:

- Everything that does not need the network is built and run for real: the
  resolver module, the parser, the scoring functions, the offline parse
  benchmark over authored-from-knowledge wikitext fixtures.
- The live A/B harness is written and committed, gated behind an env var so it
  never runs in `npx vitest run`, to be executed on a machine with egress.
- Latency figures in the report are labelled **modeled** (derived from request
  counts × each service's documented rate policy) wherever they are not
  measured. They are not presented as measurements.
