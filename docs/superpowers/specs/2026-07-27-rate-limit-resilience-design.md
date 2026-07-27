# Surviving Spotify's rate limiter

## The report

> after using the tool and adding a few songs i hit the SpotifyApiError: Spotify is
> rate-limiting this app (429).

## What the code actually does

Adds are cheap. `handleAdd` (`Sorter.tsx:44-67`) costs one POST per target playlist plus one
DELETE — a few songs is under a dozen requests. That cannot trip Spotify on its own.

Mounting is expensive, and none of it is cached. `useLibrary`'s effect (`useLibrary.ts:148-189`)
refetches on every mount:

- every saved-tracks page, fired in parallel after page one (`spotify.ts:186-199`),
- every playlist page,
- **every target playlist's full item list, all playlists in parallel** (`useLibrary.ts:42-54`).

Only genres persist, in `kondo:genres:v2`. At ~1k-3k saved songs and 20-60 playlists that is
roughly **150-250 requests per mount**, plus ~30 artist batches on a cold genre cache.

`MAX_IN_FLIGHT = 6` bounds *concurrency*, not *rate*. At ~150ms latency six slots sustain tens of
requests per second — the shape a rolling-window limiter punishes hardest.

Three consequences:

1. **The error text tells you to make it worse.** `spotify.ts:141` says "wait a few minutes and
   reload", but `rateLimitedUntil` is a module variable. A reload wipes the gate and re-fires the
   whole burst, extending the penalty.
2. **A 429 anywhere is a dead end.** Over `MAX_RETRY_AFTER_MS` it throws at once; five exhausted
   attempts throw a vague message. Nothing resumes on its own.
3. **A 429 mid-add can corrupt state.** `Sorter.tsx:51-52` adds to playlists, then unsaves. If the
   unsave fails, the catch restores the row locally while the song is already in the playlist —
   retrying duplicates it.

The precise trigger was not observed, so this design covers every plausible branch rather than
betting on one. That is affordable because each piece is small.

## Scope

Prevention (governor + snapshot cache) and recovery (persisted gate + countdown + self-heal).
Playlist reads stay complete — fingerprint accuracy is not traded away.

## Part 1 — Prevention

### Request governor (`src/api/spotify.ts`)

A token bucket beside the existing concurrency pool: refill ~8 tokens/sec, capacity ~20 so short
interactive bursts stay instant. `await takeToken()` sits immediately before the `fetch()` inside
`request()`, so retries consume a token too — they are real requests. `resetRateLimitForTests()`
resets the bucket.

FIFO starves the user: an add issued during a load queues behind ~100 background requests, a
~12-second wait, which is the reported scenario. `spotifyFetch` takes an optional `priority` flag;
the four mutating calls (`addTracksToPlaylist`, `removeTracksFromPlaylist`, `saveTracks`,
`removeSavedTracks`) set it and `unshift` onto the waiter queue instead of `push`.

### Library snapshot (`src/storage/librarySnapshot.ts`, new — `kondo:library:v1`)

```ts
{
  savedAt: number,
  userId: string,                          // guards against another account's snapshot
  tracks: Track[],                         // verbatim — these are rendered
  playlists: Playlist[],
  artistNames: Record<string, string>,     // deduped; MusicBrainz name-search needs these
  items: Record<string, CompactItem[]>,    // keyed by playlist id
}

type CompactItem = { a: string[]; y: number | null; s: string | null; c: string | null };
```

`CompactItem` is exactly `buildFingerprint`'s input (`engine.ts:61-68`). Genres come from artist
ids via `kondo:genres:v2`; `script` and `country` are pure outputs of `langSignals`
(`engine.ts:52-59`), which reads only fields we would otherwise store verbatim. Storing the
derived form is lossless for the sole consumer and several times smaller. Playlist item track
names and ISRCs are never needed again; saved-track names are, so `tracks` stays raw.

Approximately 1MB of characters at the stated library size, against a ~5MB origin budget shared
with `kondo:genres:v2`.

Three properties make this work:

- **TTL, not revalidate-per-mount.** Plain stale-while-revalidate refetches every mount, cutting
  latency but not request volume — no help against a 429. Instead: render from cache immediately,
  refetch only when the snapshot exceeds the TTL (6 hours) or the user presses Refresh. Snapshot
  age renders in the toolbar.
- **Write-through on mutation.** `removeTrackLocally` and `restoreTrackLocally`
  (`useLibrary.ts:217-224`) update the snapshot's `tracks`. Without this, a reload inside the TTL
  resurrects every sorted song. This is the one place the cache can be actively wrong.
- **Per-playlist granularity.** `items` is keyed by playlist id, so adding a target playlist in
  Settings fetches that one playlist rather than invalidating the snapshot.

The snapshot is written after a successful fetch — `tracks`/`playlists` when phase 1 completes,
`items`/`artistNames` when phase 2 does — so a load interrupted partway never persists a
half-built snapshot. Mutations write through immediately.

Writes are wrapped. On `QuotaExceededError`: drop `items` (the bulk) and retry; if that also
fails, disable caching for the session and `console.warn`. A cache write must never break a load.

Consequence worth noting: fingerprints rebuild from cached artist ids plus the genre cache, so a
deep MusicBrainz run needs zero Spotify requests.

## Part 2 — Recovery

### Persist the gate

`rateLimitedUntil` moves to `kondo:ratelimit:v1` (one timestamp), read at module init and written
on every set, so it survives a reload. The "wait a few minutes and reload" text is removed.

### Park, don't guess-and-throw

The persisted gate becomes the single source of truth with no ceiling on how far ahead it sits.
`spotifyFetch` waits on it up to a bounded park (~90s); past that it throws a typed
`RateLimitedError extends SpotifyApiError` carrying `retryAt`. That park bound replaces
`MAX_RETRY_AFTER_MS`, which exists today only to turn a long penalty into an immediate throw. The
UI observes the *gate*, not the error, so one banner explains every stalled request at once.

### Honest countdown

Spotify omits `Access-Control-Expose-Headers`, so in a browser `Retry-After` is usually
unreadable and the backoff is our own estimate. The countdown presents an estimate; because the
gate already extends via `Math.max`, a fresh 429 after expiry pushes it out rather than flapping.
The banner reads "Spotify is rate-limiting this app — resuming in 4:32" plus one line noting it
may extend.

### Plumbing

`spotify.ts` exports `getRateLimitedUntil()` and `subscribeRateLimit(cb)`. `useRateLimit()`
subscribes and runs a 1s interval **only while a penalty is active** — no permanent timer.
`<RateLimitBanner>` renders the countdown.

### Self-heal

With a snapshot on disk, a rate-limited refresh stops being fatal: `useLibrary` keeps rendering
cached data and shows the banner instead of replacing the app with an error screen. When the
countdown reaches zero the hook increments a `retryTick` that the load effect keys on alongside
`settingsKey`, and the refresh resumes unattended.

An empty cache plus an active penalty is still an error state — there is nothing to render. It
shows the banner and its countdown rather than the old dead-end message, and retries itself when
the gate clears.

### Add-path correctness

The order in `handleAdd` is right — unsaving first risks losing the song outright if the add
fails. The fix is to stop rolling back once the adds have succeeded: keep the row removed, keep
the undo toast (undo already re-saves *and* removes from the playlists, `Sorter.tsx:114-128`), and
report "added to your playlist, but couldn't remove it from Liked". Priority tokens make this
rare; it must still be correct when it happens.

## Testing

- `spotify.test.ts` — the bucket spaces requests under fake timers; a priority mutation overtakes
  queued background reads; the gate survives a simulated reload via localStorage.
- `librarySnapshot.test.ts` — round-trip; **invariance: a fingerprint rebuilt from compact cached
  items equals one built from raw playlist tracks**; `QuotaExceededError` degrades without
  throwing; write-through drops a removed track.
- `useLibrary.test.ts` — a warm mount issues zero Spotify requests; a stale snapshot refetches; a
  rate-limited refresh keeps cached data on screen rather than erroring.
- `RateLimitBanner.test.tsx` — the countdown renders, then clears itself at zero.

Modules with session-global state export `reset*ForTests()`, called in `beforeEach`, per existing
convention.

## Verification

```bash
npx vitest run
npm run lint
npm run build
npm run dev        # 127.0.0.1:5173 — localhost breaks Spotify auth
```

Requires `.env.local` with `VITE_SPOTIFY_CLIENT_ID`; it is git-ignored and per-directory, so a
fresh worktree needs it copied or login fails with `client_id=undefined`.

End to end:

1. Load the app, then reload twice inside the TTL — the network panel shows no Spotify traffic on
   the second and third loads.
2. Sort a song, reload — it stays gone.
3. Press Refresh — traffic resumes, spaced rather than bursted.
4. Force a penalty (temporarily shrink the bucket), confirm the banner counts down, the song list
   stays on screen and usable, and the refresh resumes on its own at zero.

## Out of scope

- A durable retry queue for failed adds. The banner plus an inline retry covers the reported case;
  a queue brings its own partial-add and undo-interaction edge cases.
- IndexedDB. localStorage fits at the stated library size with the compact item form; the quota
  fallback exists for the case where it does not.
- Any change to genre resolution or scoring.
