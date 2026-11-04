# Genre categorization: weaknesses and faster sources

**Status: option A partly implemented (see "What shipped" at the end).** Written 2026-11-04 from a read
of `src/genre/resolver.ts`, `src/api/musicbrainz.ts`, `src/api/wikipedia.ts`,
`src/hooks/useLibrary.ts`, `src/matching/engine.ts` and
`docs/wikipedia-genre-benchmark.md`. The sandbox this was written in could not
reach Spotify, Last.fm, Deezer, iTunes, Discogs or ListenBrainz, so every
latency number below that is not quoted from the earlier benchmark is an
**estimate** and is marked as one.

## Where the time goes today

| step | runs in | cost | why |
|---|---|---|---|
| Spotify `/artists?ids=` | default run | ~seconds | 50 ids/request, pool of 6 |
| Wikidata P1902 join | deep run only | **~110 s / 3685 artists** (measured) | 25 SPARQL chunks of 150, **run one after another** |
| MB `/url?resource=` mapping | deep run, *after* the join | 1.1 s × ⌈misses/50⌉ | MB's 1 req/s queue |
| MB name search | deep run | **1.1 s per artist with no MB URL relation** | serial, unbatchable |
| MB `arid:` tag fetch | deep run | 1.1 s × ⌈hits/50⌉ | MB queue |

The name-search step is the long tail. With 1958 join misses, even a 25% MB-URL
miss rate is ~490 serial searches, about 9 minutes.

## Weaknesses, ranked

### 1. The default run may resolve nothing at all (verify first)
`resolveAllGenres` gets genres on a normal load only from Spotify's batch
`GET /artists?ids=`. The February 2026 dev-mode migration lists "Browse and
Artist endpoints" as removed. Secondary sources (rspotify issue tracker) say
that includes the batch artists endpoint. I could not open Spotify's
guide from here. If it is gone, the first 403 sets `spotifyGenresAvailable` to
false, every artist is cached `unresolved`, and **the library gets no genres
until the user clicks deep resolve**. That would match "slow on categorization".
**Check:** run the DEV capability probe (`src/dev/probe.ts`). It already calls
both `GET /artists/{id}` and `GET /artists?ids=`. Also check whether `genres`
comes back empty even when the call returns 200.

### 2. Wikidata genres never match MusicBrainz or Spotify genres (bug)
`sparqlJoin` (`src/api/wikipedia.ts`) only trims and lowercases P136 labels.
Wikidata labels read "hip hop music", "rock music", "pop music", while MB and
Spotify say "hip hop", "rock", "pop". `explainScore` does an exact string dot
product, so a song whose genres came from Wikidata shares **zero** genre weight
with a playlist whose fingerprint came from MB or Spotify. That join resolves
~47% of the library. The infobox path already strips the suffix
(`normalizeGenreItems`: `.replace(/\s+music$/, '')`). The join path does not.
Fix: about one line, plus a cache-key bump so cached Wikidata entries are
normalized again.

### 3. Exact-string genre matching, no hierarchy
"alternative rock" against "indie rock", or "trap" against "hip hop", scores 0.
The bigger the vocabulary (MB has ~2000 canonical genres), the sparser the
overlap. This is an accuracy ceiling, not a speed problem. It does make
"slow" worse, though: more resolved artists don't help if their labels don't
match. Options:
- **Parent expansion:** add each genre's parents at a lower weight. Wikidata
  `P279` (subclass of) and MB genre relationships both give a tree. One
  cached request covers the whole vocabulary.
  - Pro: big recall gain, cheap at runtime.
  - Con: the tree has to be fetched and cached. Over-broad parents ("music",
    "popular music") must be cut off.
- **Token overlap** ("indie rock" ~ "rock").
  - Pro: no data needed.
  - Con: false friends ("post-punk" ~ "punk" is fine, "k-pop" ~ "pop" is
    arguable).

### 4. The Wikidata join is serial and oversized
- Chunks run in a `for … await` loop. WDQS allows about 5 parallel queries
  per IP. **Estimate:** concurrency 4 cuts ~110 s to ~30 s.
- The benchmark doc found that query *evaluation* dominates, not round trips.
  In the default deep run (`infobox: false`), the `?article` OPTIONAL is
  dead weight: the title is only needed for the infobox phase. The
  `rdfs:label` + `FILTER(lang)` join is also slower than
  `SERVICE wikibase:label` or returning QIDs and mapping labels once.
- Smaller chunks (50) also lower the risk of the 60 s WDQS timeout, which
  fails a whole chunk.

### 5. The join and MusicBrainz run one after another, but they don't have to
They are different hosts with independent rate limits. MB's `/url` mapping
could start at t=0 instead of after ~110 s. Better still, see #6.

### 6. Wikidata already knows the MBIDs, and we don't ask for them
Wikidata property **P434** is "MusicBrainz artist ID". Adding
`OPTIONAL { ?artist wdt:P434 ?mbid }` to the same SPARQL query gives MBIDs for
most join hits. Those artists then skip MB's `/url` mapping **and** the 1.1 s
name search, and go straight to the batched `arid:` fetch. It also allows
**merging** MB tags with Wikidata P136 instead of using one or the other.
- Pro: removes the most expensive MB step for about half the library, with no
  new provider.
- Con: a little more query cost per chunk. Mis-linked P434 values exist but
  are rare.

### 7. MB name search is slow *and* the least trustworthy step
It is serial at 1.1 s, and it matches on name with `score >= 90` and
`limit=1`. Common names ("Bush", "Low", "Air") can resolve to the wrong
artist. Consider capping it, running it last as a background trickle after
the fingerprints are already built, or dropping it in favor of #8.

### 8. Durable `none` never expires
A `none` from MB is cached forever, so an artist that gets tagged later never
updates. Add a TTL (e.g. 90 days) to `none` only.

## Other databases

| source | genre data | batch? | browser-callable | limit | verdict |
|---|---|---|---|---|---|
| **Last.fm** `artist.getTopTags` | crowd tags with counts; best niche/long-tail coverage of anything free | no, 1 per artist; takes `mbid` or name | needs an API key in the bundle (same exposure as the Spotify client id); CORS untested here | no published number; ~5 req/s is the folk guideline | **Best new provider.** Filter tags through the existing MB genre whitelist (`tagsToGenres`). Est. ~4× MB name-search throughput, parallelizable. Name lookup has the same disambiguation risk unless fed MBIDs (#6). |
| **ListenBrainz** metadata API | MB tags, served from ListenBrainz | yes, several MBIDs per call | public, CORS-friendly by design | own limit, separate from MB's 1 req/s | **Worth testing.** Same data as MB's `arid:` fetch, possibly without the 1.1 s queue. Needs MBIDs (#6). Unverified. |
| Discogs | "styles": the most granular electronic/rock labels | no | needs a token, 60 req/min | release-level, not artist | No. Too slow, wrong granularity. |
| Deezer | album `genre_id`, ~25 coarse genres | ISRC lookup per track | no CORS (JSONP only) | 50 req/5 s | No. Too coarse. |
| iTunes Search | one `primaryGenreName` per track | no | yes | ~20 req/min | No. Too coarse and too slow. |
| Spotify audio-features | none | — | 403 (already probed, `issues.md` 2.4) | — | Dead. |
| AcousticBrainz / Every Noise | — | — | — | — | Shut down / frozen. |

## Architecture options for "much faster", with trade-offs

**A. Stay client-only. Do #2, #4, #5 and #6, add Last.fm as a parallel
provider.**
- Pro: no backend, keeps the "only Spotify and MusicBrainz" stance (plus
  Wikimedia and Last.fm).
- Pro: est. deep run drops from many minutes to ~1–2 min for a 3–4k artist
  library.
- Con: every new user still pays the full cost once. Rate limits are per IP
  and anonymous.

**B. Shared genre cache behind a small serverless function** (Vercel function
plus KV, keyed by Spotify artist id).
- Pro: an artist resolved for one user is instant for every later user, and
  popular artists hit cache almost always.
- Pro: the server can send a real User-Agent to MB, which gets a better rate
  pool than anonymous browsers. It can also hold the Last.fm or Discogs keys
  privately.
- Con: breaks the "no backend" architecture and adds ops, cost and abuse
  protection.
- Con: users' artist lists now reach your server, so privacy-policy
  (`LegalPage`) wording changes.

**C. Precomputed static lookup from dumps** (Wikidata P1902→P136/P434, MB
url→artist→tags), sharded by id prefix and served as static files from the
same CDN.
- Pro: fastest possible, with zero rate limits and no runtime server. Cold load
  becomes a few hundred static GETs.
- Con: needs a build pipeline over multi-GB dumps. Data goes stale between
  rebuilds. Shards add to hosting size (est. tens of MB total).

**Recommendation:** do A now. #2 is a correctness bug, and #6 and #4 are the
biggest speed wins for the least code. Add Last.fm only if coverage is still
thin after that. Hold B for after the public launch, when there are enough
users for a shared cache to pay off.

## Suggested order

1. Run the DEV probe: is `/artists?ids=` alive, and does it return genres? (#1)
2. Normalize Wikidata labels and bump the cache key. (#2)
3. Add P434 to the join and feed the MBIDs to MB `arid:`. Parallelize the
   join, and drop `?article` when infobox is off. (#4–#6)
4. Re-measure deep-run wall-clock and coverage with the existing Settings
   probe.
5. Add genre parent expansion. (#3)
6. Prototype Last.fm behind `fallback: 'lastfm'`, scored with the existing
   `src/genre/benchmark.ts` harness.

## What shipped (option A)

| item | change | where |
|---|---|---|
| #2 | Wikidata P136 labels lose the " music" suffix. Already-cached `wikipedia` entries are normalized on read (idempotent, so no cache-key bump). | `src/genre/normalize.ts`, `src/api/wikipedia.ts`, `src/genre/resolver.ts` |
| #4 | Join chunks are 50 ids (was 150) and run 4 at a time (was serial). | `src/api/wikipedia.ts` (`JOIN_CHUNK`, `JOIN_CONCURRENCY`) |
| #6 | The join also returns P434 MBIDs. The resolver passes them to MB as `knownMbids`, so those artists skip `/url` mapping and name search. | `wikipedia.ts` (`mbidsOut`), `musicbrainz.ts` (`knownMbids`), `resolver.ts` |
| cache | The title cache moves to `tracktackle:wd-titles:v2` and now also stores entities with no enwiki article, so their MBID survives a reload. v1 is deleted on load. | `src/api/wikipedia.ts` |

Not done, deliberately:
- **#5 (join and MB in parallel):** once the join supplies MBIDs, MB depends on
  its result. Starting MB at t=0 would spend its 1 req/s budget mapping
  artists the join is about to resolve for free. With the join parallelized,
  waiting for it is the cheaper order.
- **Dropping `?article` from the query:** the title is still needed by
  `fallback: 'wikipedia'` and shares a cache with it. Splitting the query by
  mode was not worth it without a measurement showing that OPTIONAL is slow.
- **Last.fm:** needs an API key registered by the owner.

**Not yet measured.** Re-run the DEV "Wikidata join-hit rate" probe in Settings
and a full deep resolve, then record wall-clock against the ~110 s baseline.
