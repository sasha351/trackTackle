# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — vite dev server, pinned to `127.0.0.1:5173` (Spotify's redirect URI is a loopback **IP**; `localhost` resolves to `::1` and breaks auth).
- `npx vitest run` — full test suite (no `test` script in package.json).
- `npx vitest run src/genre/resolver.test.ts` — one file; `-t "substring"` for one test.
- `npm run build` — `tsc -b && vite build`.
- `npm run lint` — oxlint.

Requires `.env.local` with `VITE_SPOTIFY_CLIENT_ID=<id>`. It is git-ignored and **per-directory**, so a fresh git worktree has none and login fails with `client_id=undefined`.

## Architecture

Browser-only SPA. No backend, no server proxy. All state lives in `localStorage`; the only network peers are Spotify and MusicBrainz.

**Auth** (`src/auth/`): PKCE authorization-code flow. `App.tsx` consumes the `?code=` param and deletes the sessionStorage verifier immediately, because StrictMode double-invokes effects and auth codes are single-use. `token.ts` funnels concurrent refreshes through one shared in-flight promise — Spotify rotates the refresh token on every use, so two parallel refreshes kill each other.

**Spotify client** (`src/api/spotify.ts`): every call goes through `spotifyFetch`, which owns a module-global `rateLimitedUntil` gate (429 backoff is app-wide, not per-request), one 401 → refresh → retry, and 5xx retries. Paths reflect the **Feb 2026 API migration**: `/playlists/{id}/items` (entries nested under `item`, not `track`), `/me/library` for save/unsave, `playlist.items.total` with `tracks.total` fallback. `src/dev/probe.ts` (DEV-only button) reports which endpoints a fresh app still gets.

**Genre resolution** (`src/genre/resolver.ts` → `src/api/musicbrainz.ts`): a waterfall, cached per Spotify artist id in `kondo:genres:v2`.
1. Cache.
2. Spotify `/artists/{id}` genres, concurrency-6 pool. A single 403 flips `spotifyGenresAvailable` off for the whole session (Spotify may have revoked genre data entirely).
3. MusicBrainz bulk lookup — batches ~50 artists per request: `/url?resource=…` maps Spotify artist URLs → MBIDs (immune to transliterated names, unlike name search), then one `arid:(… OR …)` search fetches tags, filtered against MB's canonical genre list (`/genre/all`, cached in `kondo:mb-genres:v1`).

To keep startup fast, the default (non-deep) flow intentionally skips the expensive MusicBrainz bulk phase for unresolved artists: those artists are cached as `[]` with source `none` so the app can become interactive quickly. A "deep" run (`resolveAllGenres(..., { deep: true })`) performs the full MB bulk lookup and updates the cache for any previously unresolved artists. If Spotify genre access is revoked mid-run (a 403), the remainder of the run routes to MusicBrainz even in a non-deep run so we can recover.

Serial per-artist name search is still off by default because it costs ~1.1s each. It is only used when `nameSearch: true` is explicitly requested (deep runs). All MusicBrainz traffic serializes through one promise chain at ≥1100ms spacing with 503/429 retry. There is no User-Agent (a forbidden header in browsers), so we share the anonymous rate-limit pool — 503s are normal.

An artist **absent** from a bulk result map means a transient failure and is deliberately left uncached; an artist mapped to `[]` is a durable "MB has nothing".

**Library loading** (`src/hooks/useLibrary.ts`): two phases so the UI isn't blocked on genres.
- Phase 1 `loadTracksAndPlaylists` — saved tracks + playlists, seconds. Status `loading` → `enriching`, songs are already sortable.
- Phase 2 `enrichLibrary` — genres, playlist fingerprints, matches. Flushes partial results (≥100 artists AND ≥2s apart) so the list improves mid-run. Playlists that 403 on their items endpoint (Blends, algorithmic) are dropped with a warning rather than failing the load.

`useLibrary` is mounted once in `App.tsx`'s `Workspace` so tab switches don't refetch. Its effect keys on `settingsKey` (target playlist ids only) — threshold changes recompute `matches` in a `useMemo` instead of triggering a reload.

**Matching** (`src/matching/engine.ts`): each playlist becomes a `Fingerprint` (weighted genre / decade / script / ISRC-country distributions). `scoreSong` = 0.7·genre cosine + 0.15·era + 0.15·language. Genreless songs score 0 unless `langOnlyClaim` fires: the playlist must be ≥50% that script/country **and** ≥2× as concentrated as the rest of the library (leave-one-out via `signalBaseline`). Script buckets are Unicode-property based, never a language list — behavior must stay symmetric whatever the user's library is mostly in. Latin only wins by default, since Spotify transliterates non-Latin artist names.

**Analyzer** (`src/analyzer/broadPlaylists.ts`): reuses the same fingerprints to flag playlists whose top genre covers <30% of their tracks.

## Conventions

- `ponytail:` comments mark deliberate simplifications and name their ceiling — read them before "fixing" the code they sit on.
- Non-obvious code carries a comment explaining the *why* (an API quirk, a race, a StrictMode interaction). Keep that density; it's load-bearing.
- Tests are vitest + Testing Library, colocated as `*.test.ts(x)`, jsdom, globals on. Modules with session-global state export `reset*ForTests()` — call it in `beforeEach`.
- Removing a song from Liked destroys its original `added_at` on Spotify's side. `src/storage/removalLog.ts` (`kondo:removals:v1`) is the only record; the 8-second undo depends on it.
