# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — vite dev server, pinned to `127.0.0.1:5173` (Spotify's redirect URI is a loopback **IP**; `localhost` resolves to `::1` and breaks auth).
- `npx vitest run` — full test suite (no `test` script in package.json).
- `npx vitest run src/genre/resolver.test.ts` — one file; `-t "substring"` for one test.
- `npm run build` — `tsc -b && vite build`.
- `npm run lint` — oxlint.

**Testing on a real phone.** Don't bind vite to `0.0.0.0` — `http://<lan-ip>:5173`
fails twice over: Spotify permits plain `http` redirect URIs only for loopback
literals (`http://127.0.0.1:PORT`, `http://[::1]:PORT`), and `src/auth/pkce.ts`
needs `crypto.subtle`, which is undefined outside a secure context. Use an SSH
local forward instead — loopback *on the phone* satisfies both rules:

```
ssh -L 5173:127.0.0.1:5173 <mac>     # from the phone's SSH client
```

then open `http://127.0.0.1:5173` on the phone. No code, no deps, no dashboard
change. Once the app is deployed to a real HTTPS origin this is moot.

**Manual viewport check** (no Playwright — a ~150MB browser download and a
second test runner, in a two-dependency app, to guard one assertion). After any
layout change, in devtools at 390×844:

```js
document.documentElement.scrollWidth <= document.documentElement.clientWidth
```

must be `true`. `src/index.css.test.ts` asserts the responsive *contract* — the
breakpoints exist and override the rules that overflow — but jsdom does no
layout and does not evaluate width media queries, so it cannot catch actual
overflow.

Requires `.env.local` with `VITE_SPOTIFY_CLIENT_ID=<id>`. It is git-ignored and **per-directory**, so a fresh git worktree has none and login fails with `client_id=undefined`.
Optional: `VITE_LASTFM_API_KEY=<key>` enables Last.fm as a deep-run genre source and in the DEV genre-gap diagnostic (both skip it without a key). Tests pin it empty in `vite.config.ts`; stub it with `vi.stubEnv` where needed.

## Architecture

Browser-only SPA. No backend, no server proxy. All state lives in `localStorage`; the network peers are Spotify, MusicBrainz, Wikidata, ListenBrainz and Last.fm (the last three in deep runs only; Last.fm only with a key). `src/components/LegalPage.tsx` must list every one — its test asserts the hosts.

**Auth** (`src/auth/`): PKCE authorization-code flow. `App.tsx` consumes the `?code=` param and deletes the sessionStorage verifier immediately, because StrictMode double-invokes effects and auth codes are single-use. `token.ts` funnels concurrent refreshes through one shared in-flight promise — Spotify rotates the refresh token on every use, so two parallel refreshes kill each other.

**Spotify client** (`src/api/spotify.ts`): every call goes through `spotifyFetch`, which owns a module-global `rateLimitedUntil` gate (429 backoff is app-wide, not per-request), one 401 → refresh → retry, and 5xx retries. Paths reflect the **Feb 2026 API migration**: `/playlists/{id}/items` (entries nested under `item`, not `track`), `/me/library` for save/unsave, `playlist.items.total` with `tracks.total` fallback. `src/dev/probe.ts` (DEV-only button) reports which endpoints a fresh app still gets.

**Genre resolution** (`src/genre/resolver.ts`): a waterfall, cached per Spotify artist id in `tracktackle:genres:v3` (no migration ladder — see the ponytail in `getCache`).
1. Cache.
2. Spotify `/artists?ids=` genres, 50 ids per request, concurrency-6 pool. A single 403 flips `spotifyGenresAvailable` off for the whole session (Spotify may have revoked genre data entirely).

To keep startup fast, the default (non-deep) flow stops there: misses are cached as `[]` with source `unresolved` (retryable — distinct from a durable `none`, which only a real answer from the deep sources produces). A 403 mid-run never routes a non-deep run anywhere else — it only flips `spotifyGenresAvailable` off. Only an explicit deep run (`resolveAllGenres(..., { deep: true })`) goes past Spotify, and its order is **batched and ID-keyed first, per-artist and name-keyed last**, so most genres land (and partial-flush) within the first minute and the 1.1 s serial MB name search only sees the residue (rationale and costs: `docs/genre-speed-investigation.md`, "Fetch order rebalance"):

3. Wikidata join (`src/api/wikidata.ts`) — SPARQL on P1902 → P136 genres + P434 MBIDs, 50 ids per query, 4 in parallel, cached in `tracktackle:wd-titles:v2`. Source `wikipedia` (the cache value predates the rename).
4. MusicBrainz bulk (`src/api/musicbrainz.ts` `lookupGenresBulk`) — `/url?resource=…` maps Spotify artist URLs → MBIDs (skipped for P434 hits), then one `arid:(… OR …)` search per 50 fetches tags, filtered against MB's canonical genre list (`/genre/all`, cached in `tracktackle:mb-genres:v1`). It does **not** name-search — that is step 5c.
5. Last-chance enrichment (`src/genre/enrich.ts`) on whatever is still empty, in this order: (a) MB recording + album tags by the artist's own ISRCs, batched — a solo credit also recovers an MBID `/url` can't find; (b) Last.fm artist top tags (MBID, else name; MB-whitelisted, hyphens retried as spaces; a fatal error — bad key, rate limit, CORS — stops the phase and leaves the rest retryable); (c) MB name search (1.1 s each, serial) → `arid:` tags, source `musicbrainz`; (d) ListenBrainz similar artists (labs API) → genres ≥2 of the top 10 neighbours' MB tags agree on — last because the genres are borrowed. Sources `recordings` / `lastfm` / `musicbrainz` / `neighbours`, top 3 genres each (5 for MB tags).

All MusicBrainz traffic serializes through one promise chain at ≥1100ms spacing with 503/429 retry. There is no User-Agent (a forbidden header in browsers), so we share the anonymous rate-limit pool — 503s are normal. Last.fm has its own 250 ms chain; Wikidata and ListenBrainz use small concurrency pools.

A `none` carries `checked` (= `noneSourcesVersion()`: `NONE_SOURCES_VERSION` = 3 with a Last.fm key, 2 without, so a keyless build neither stamps 3 nor flags every 2 as stale) and `at`; `isStaleNone` sends one behind the version or older than 90 days back through the next deep run (skipping its MB name search). **Bump `NONE_SOURCES_VERSION` whenever a deep run gains a new source** (reordering existing ones doesn't need it), or existing `none` artists never see it. A request failure anywhere in enrichment leaves an unversioned `none` (retryable).

**Genre-gap diagnostic** (`src/dev/genreGaps.ts`, DEV button in Settings): on a real library, buckets untagged artists by cause (no MBID / MB has no tags / whitelist dropped the tags) and measures the enrichment sources on a sample. It writes nothing to the genre cache. Re-run it before adding any new source. No LLM/AI calls anywhere in genre resolution — a hard product rule.

An artist **absent** from a bulk result map (Wikidata or MB) means a transient failure and is deliberately left uncached; an artist mapped to `[]` is a durable "has nothing".

**Library loading** (`src/hooks/useLibrary.ts`): two phases so the UI isn't blocked on genres.
- Phase 1 `loadTracksAndPlaylists` — saved tracks + playlists, seconds. Status `loading` → `enriching`, songs are already sortable.
- Phase 2 `enrichLibrary` — genres, playlist fingerprints, matches. Flushes partial results (≥100 artists AND ≥2s apart) so the list improves mid-run. Playlists that 403 on their items endpoint (Blends, algorithmic) are dropped with a warning rather than failing the load.

`useLibrary` is mounted once in `App.tsx`'s `Workspace` so tab switches don't refetch. Its effect keys on `settingsKey` (target playlist ids only) — threshold changes recompute `matches` in a `useMemo` instead of triggering a reload.

**Matching** (`src/matching/engine.ts`): each playlist becomes a `Fingerprint` (weighted genre / decade / script / ISRC-country distributions). `scoreSong` = 0.65·genre cosine + 0.2·era + 0.15·language. **Era only scores on top of a real genre match** — alone it equals exactly `MIN_GUESS`, so crediting it made every genreless song a 20% "best guess" for whichever playlist held the most songs from its decade. A song with **no genres** (still `unresolved`, or a durable `none` after both resolver passes) scores 0 against every playlist and is never recommended — language and era are modifiers on genre evidence, never evidence alone (the old language-only claim was removed). Script buckets are Unicode-property based, never a language list — behavior must stay symmetric whatever the user's library is mostly in. Latin only wins by default, since Spotify transliterates non-Latin artist names.

**Genre context** (`src/matching/genreGraph.ts`): built in `useLibrary` from every resolved artist and passed to `matchSong` as the optional last arg. Without it scoring is the legacy exact-string cosine (most engine tests run that way). With it: genres are IDF-weighted (so a library-ubiquitous "pop" can't make a pop-heavy playlist a dumping ground), the song vector is expanded with **adjacent** genres (co-occurrence on ≥2 artists, cosine-normalized, plus head-word links like "uk drill"→"drill") at ≤0.5× weight, and the genre score is shrunk by `genred/(genred+2)` so tiny playlists stop winning on a perfect 1-song cosine. Adjacency-only matches below `ADJ_ONLY_FLOOR` are zeroed so a faint link can't un-gate era. Adjacency is derived from the library, never a hand-written table. The DEV score report's hotspot section (wins vs playlist size) is how to check it on a real library.

**Analyzer** (`src/analyzer/broadPlaylists.ts`): reuses the same fingerprints to flag playlists whose top genre covers <30% of their tracks.

## Conventions

- `ponytail:` comments mark deliberate simplifications and name their ceiling — read them before "fixing" the code they sit on.
- Non-obvious code carries a comment explaining the *why* (an API quirk, a race, a StrictMode interaction). Keep that density; it's load-bearing.
- Tests are vitest + Testing Library, colocated as `*.test.ts(x)`, jsdom, globals on. Modules with session-global state export `reset*ForTests()` — call it in `beforeEach`.
- Removing a song from Liked destroys its original `added_at` on Spotify's side. `src/storage/removalLog.ts` (`tracktackle:removals:v1`) is the only record; the 8-second undo depends on it.
- `src/index.css` is tokens-first: every gap/margin/padding uses the `--sp-*` scale, every hover/focus transition uses `--t`, and font sizes are px (no rem/em). Motion is opted **out** once, by the `prefers-reduced-motion: reduce` damper at the end of the file — don't add per-rule `animation: none` blocks, new animations are covered automatically.
- `src/index.css.test.ts` asserts the stylesheet's *contract* as text (breakpoints exist, desktop grid untouched, popover outranks the sticky header) because jsdom does no layout. Editing a base rule to fix mobile is what it exists to catch.
