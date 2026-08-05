import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getMyPlaylists, getPlaylistTracks, getSavedTracks, RateLimitedError } from '../api/spotify';
import { AuthError } from '../auth/token';
import { genreCoverage, resolveAllGenres } from '../genre/resolver';
import { cachedGenreVocabulary, type MbPhase } from '../api/musicbrainz';
import {
  buildFingerprint, langSignals, matchSong, signalBaseline, type Fingerprint,
} from '../matching/engine';
import {
  compactPlaylists, isFresh, readSnapshot, updateSnapshotTracks,
  writeSnapshot, type CompactItem,
} from '../storage/librarySnapshot';
import { targetedPlaylists, type AppSettings } from '../storage/settings';
import type { Playlist, PlaylistTrack, SongMatch, Track } from '../types';
import { useRateLimit } from './useRateLimit';

export interface LibraryData {
  tracks: Track[];
  playlists: Playlist[];      // filtered to sorting targets
  allPlaylists: Playlist[];   // unfiltered — Settings renders these
  genresByTrack: Map<string, string[]>;
  fingerprints: Map<string, Fingerprint>;
  artists: { id: string; name: string }[];
  /** playlist id → the track ids it already holds. Empty for a playlist whose
   *  cached items predate CompactItem.i — see the comment on that field. */
  membership: Map<string, Set<string>>;
}

/** Phase 1: everything needed to render the song list. Free from cache inside
 *  the TTL, seconds otherwise. */
export async function loadTracksAndPlaylists(
  settings: AppSettings,
  // Checked right before the write, not just at entry — this call awaited a
  // fetch, and the caller may have been unmounted while it did. Every hook
  // caller passes the mount ref; loadLibrary and direct test callers don't
  // have a mount to speak of, so the default is "still mounted".
  isCancelled: () => boolean = () => false,
  // `force` skips the freshness check — refresh() needs a real refetch without
  // deleting the snapshot first, because the snapshot is the only fallback if
  // that refetch turns out to be rate-limited.
  opts: { force?: boolean } = {},
): Promise<Pick<LibraryData, 'tracks' | 'playlists' | 'allPlaylists'>> {
  const snap = readSnapshot();
  let tracks: Track[];
  let allPlaylists: Playlist[];
  if (isFresh(snap) && opts.force !== true) {
    ({ tracks, playlists: allPlaylists } = snap!);
  } else {
    [tracks, allPlaylists] = await Promise.all([getSavedTracks(), getMyPlaylists()]);
    // Written only after both succeeded — a load interrupted partway must not
    // persist a half-built snapshot. Explicitly reset items/artistNames: an
    // expired snapshot's items expired too, and writeSnapshot merges patches —
    // without this it would carry the stale items forward and re-stamp them
    // fresh, pinning them for another TTL window even though nothing refetched.
    // Skipped if cancelled: e.g. the user logged out mid-fetch and another
    // account already logged in and wrote its own snapshot — writing now would
    // stamp this stale (or cross-account) data fresh over theirs.
    if (!isCancelled()) writeSnapshot({ tracks, playlists: allPlaylists, items: {}, artistNames: {} });
  }
  return { tracks, playlists: targetedPlaylists(allPlaylists, settings), allPlaylists };
}

const PARTIAL_FLUSH_ARTISTS = 100;
const PARTIAL_FLUSH_MS = 2000;

/** Scans playlist name+description for known genre terms, longest match
 *  first — matching "hip hop" first blanks that span out so the shorter
 *  "hop" inside it can't also match as a separate, redundant hint. */
export function extractGenreHints(text: string, vocab: Set<string>): string[] {
  let remaining = ` ${text.toLowerCase()} `;
  const hints: string[] = [];
  for (const term of [...vocab].sort((a, b) => b.length - a.length)) {
    if (remaining.includes(term)) {
      hints.push(term);
      remaining = remaining.split(term).join(' ');
    }
  }
  return hints;
}

/** Phase 2: genres and matches. Slow when uncached — runs behind the list. */
export async function enrichLibrary(
  { tracks, playlists }: Pick<LibraryData, 'tracks' | 'playlists'>,
  onProgress: (resolved: number, total: number) => void,
  onPartial?: (partial: Pick<LibraryData, 'genresByTrack' | 'fingerprints' | 'membership'>) => void,
  opts: { deep?: boolean; onPhase?: (phase: MbPhase | 'joining', artistName?: string) => void } = {},
  // Same unmount guard as loadTracksAndPlaylists — see its comment. Both hook
  // callers pass it, including deepResolveAll: a deep run takes minutes, which
  // makes it the write most likely to still be in flight at logout.
  isCancelled: () => boolean = () => false,
): Promise<Pick<LibraryData, 'genresByTrack' | 'fingerprints' | 'artists' | 'membership'>> {
  const snap = readSnapshot();
  const cached = isFresh(snap) ? snap!.items : {};
  const cachedNames = isFresh(snap) ? snap!.artistNames : {};

  // ponytail: a playlist that 403s is not cached, so it is re-attempted every
  // mount — a handful of requests. Caching the failure would strand a playlist
  // whose permissions later change.
  const missing = playlists.filter((p) => cached[p.id] === undefined);
  const fetched = new Map<string, PlaylistTrack[]>(
    (await Promise.all(
      missing.map((p) =>
        getPlaylistTracks(p.id).then(
          (ts) => [p.id, ts] as const,
          (e) => {
            // Some playlists (Blends, algorithmic ones) 403 on their items
            // endpoint under dev-mode API restrictions — they can't be read or
            // sorted into, so drop them instead of failing the whole load.
            console.warn(`Track Tackle: skipping unreadable playlist “${p.name}”`, e);
            return null;
          },
        ),
      ),
    )).filter((e) => e !== null),
  );
  const compacted = compactPlaylists(fetched);

  const items: Record<string, CompactItem[]> = {};
  for (const p of playlists) {
    const its = compacted.items[p.id] ?? cached[p.id];
    if (its) items[p.id] = its;
  }
  const artistNames = { ...cachedNames, ...compacted.artistNames };

  // Genre resolution is per unique artist — the cache and MB rate limit both
  // work in our favor this way.
  const artists = new Map<string, { id: string; name: string }>();
  for (const t of tracks) for (const a of t.artists) artists.set(a.id, a);
  for (const its of Object.values(items)) {
    for (const it of its) {
      for (const id of it.a) {
        // Names come from the snapshot's deduped directory — compact items
        // carry ids only, and MusicBrainz name search needs the name.
        if (!artists.has(id)) artists.set(id, { id, name: artistNames[id] ?? '' });
      }
    }
  }

  // Genres don't affect it, so it's built once here rather than per rebuild.
  // Items missing `i` (a snapshot older than that field) contribute nothing,
  // which leaves the duplicate guard inert rather than wrong.
  const membership = new Map<string, Set<string>>(
    Object.entries(items).map(([id, its]) => [
      id,
      new Set(its.map((it) => it.i).filter((id): id is string => id != null)),
    ]),
  );

  // Genres don't affect it either — built once, like membership above.
  const vocab = cachedGenreVocabulary();
  const hintsByPlaylist = new Map(
    playlists.map((p) => [p.id, extractGenreHints(`${p.name} ${p.description ?? ''}`, vocab)]),
  );

  // Shared by the partial and final builds — a rebuild is just "run this over
  // whatever's resolved so far"; missing artists contribute [] either way.
  const buildFrom = (
    genresByArtist: Map<string, string[]>,
  ): Pick<LibraryData, 'genresByTrack' | 'fingerprints' | 'membership'> => {
    const genresOf = (ids: string[]) =>
      [...new Set(ids.flatMap((id) => genresByArtist.get(id) ?? []))];

    const fingerprints = new Map<string, Fingerprint>(
      Object.entries(items).map(([id, its]) => [
        id,
        buildFingerprint(its.map((it) => ({
          genres: genresOf(it.a),
          releaseYear: it.y,
          script: it.s,
          country: it.c,
        })), hintsByPlaylist.get(id) ?? []),
      ]),
    );

    const genresByTrack = new Map(
      tracks.map((t) => [t.id, genresOf(t.artists.map((a) => a.id))]),
    );

    return { genresByTrack, fingerprints, membership };
  };

  // sink/wrappedProgress only matter when onPartial is wired up — no onPartial,
  // no bookkeeping, no mid-run rebuilds.
  const soFar = new Map<string, string[]>();
  let lastFlushResolved = 0;
  let lastFlushAt = 0;
  const sink = onPartial ? (id: string, genres: string[]) => soFar.set(id, genres) : undefined;
  const wrappedProgress = (resolved: number, total: number) => {
    onProgress(resolved, total);
    if (!onPartial) return;
    const now = Date.now();
    if (resolved - lastFlushResolved >= PARTIAL_FLUSH_ARTISTS && now - lastFlushAt >= PARTIAL_FLUSH_MS) {
      lastFlushResolved = resolved;
      lastFlushAt = now;
      onPartial(buildFrom(soFar));
    }
  };

  const genresByArtist = await resolveAllGenres([...artists.values()], wrappedProgress, sink, opts);
  // Phase 2 succeeded — persist what it cost the most to get, but only if a
  // fetch actually returned something. Gate on `fetched`, not `missing`:
  // a playlist that 403s is never cached (see the ponytail above), so it's
  // "missing" on every load forever — gating on missing.length alone would
  // fire this write on every load of the default (all-playlists) config and
  // re-stamp savedAt, pinning the snapshot past its TTL forever. `fetched` is
  // empty when nothing new was fetched — either nothing was missing, or every
  // attempt 403'd. Either way there is nothing new to persist.
  // ponytail: savedAt stamps the whole snapshot, so this still re-freshes
  // tracks/playlists/every other playlist's items whenever just one target
  // playlist was newly fetched — a savedAt-preserving writeSnapshot variant
  // in librarySnapshot.ts would fix that; out of scope here.
  // Also skipped if cancelled — see loadTracksAndPlaylists's comment on the
  // same race.
  // Merged over `cached`, not written as-is: `items` only covers the *target*
  // playlists, and a plain write would evict every other playlist's cached
  // items the moment the user narrows the target set in Settings. Merging at
  // the call site rather than inside writeSnapshot on purpose —
  // loadTracksAndPlaylists relies on `items: {}` still meaning "clear these"
  // when a snapshot expires.
  if (fetched.size > 0 && !isCancelled()) {
    writeSnapshot({ items: { ...cached, ...items }, artistNames });
  }
  return { ...buildFrom(genresByArtist), artists: [...artists.values()] };
}

export async function loadLibrary(
  settings: AppSettings,
  onProgress: (resolved: number, total: number) => void,
): Promise<LibraryData> {
  const base = await loadTracksAndPlaylists(settings);
  return { ...base, ...(await enrichLibrary(base, onProgress)) };
}

export interface LibraryState extends LibraryData {
  // 'enriching': songs are on screen and sortable, genres/matches still filling in.
  status: 'loading' | 'enriching' | 'ready' | 'error';
  error: string | null;
  authExpired?: boolean;
  progress: { resolved: number; total: number };
  matches: Map<string, SongMatch>;
  removeTrackLocally(id: string): void;
  restoreTrackLocally(t: Track): void;
  deepResolveAll(): Promise<void>;
  deepState: 'idle' | 'running' | 'done' | 'error';
  /** Which phase of a running deep resolve is in ('joining' is the Wikidata
   *  supplement ahead of MusicBrainz), and which artist (if 'searching'). */
  deepPhase: { phase: MbPhase | 'joining'; artist?: string } | null;
  coverage: { spotify: number; musicbrainz: number; wikipedia: number; none: number; unresolved: number };
  /** Refetch from Spotify, ignoring the cached snapshot's TTL. */
  refresh(): void;
  /** Age of the served snapshot in ms, or null when the data came from the network. */
  snapshotAge: number | null;
}

// Each auto-resume re-fetches the whole library — hundreds of requests aimed
// at a limiter that just said no. A penalty that survives this many rounds is
// not the transient kind, and hammering it only extends it. Giving up is not
// silent: the banner is already gone by this point (the retry only fires once
// the countdown reaches zero), so what the user is left with is the stale rows
// still on screen, the toolbar's "Cached … ago", and the Refresh beside it.
const MAX_AUTO_RETRIES = 3;

const EMPTY: LibraryData = {
  tracks: [], playlists: [], allPlaylists: [], genresByTrack: new Map(), fingerprints: new Map(),
  artists: [], membership: new Map(),
};

export function useLibrary(settings: AppSettings): LibraryState {
  const [data, setData] = useState<LibraryData>(EMPTY);
  const [status, setStatus] = useState<LibraryState['status']>('loading');
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState({ resolved: 0, total: 0 });
  const [deepState, setDeepState] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [deepPhase, setDeepPhase] = useState<LibraryState['deepPhase']>(null);
  const [authExpired, setAuthExpired] = useState(false);

  // Re-runs the load effect: a fresh object is never Object.is-equal, so no
  // counter is needed. `force` rides along in the state rather than in a ref
  // because StrictMode's mount/unmount/remount replays the same value — a ref
  // cleared on first use would make refresh() a no-op in dev.
  const [reload, setReload] = useState({ force: false });
  const [snapshotAge, setSnapshotAge] = useState<number | null>(null);
  // Whether there is anything worth falling back to — set from the snapshot
  // before phase 1 runs, then re-set from phase 1's own rows.
  const hasDataRef = useRef(false);

  // A write must be skipped only when the hook is gone for good (logout /
  // account switch), not when a same-account effect re-run superseded it —
  // suppressing those would throw away a whole load's worth of fetching.
  const mountedRef = useRef(true);
  useEffect(() => {
    // Re-assigned on mount, not just cleared on unmount: StrictMode runs the
    // cleanup and then remounts, which would otherwise leave this false.
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const rateLimitedUntil = useRateLimit();
  // Only a load that actually threw RateLimitedError may be auto-resumed.
  // spotifyFetch *parks* on short penalties instead of throwing, so most
  // penalties come and go under a load that completes fine — restarting those
  // would cancel healthy work and put two loads on the wire at once.
  const sawRateLimitRef = useRef(false);
  const retriesRef = useRef(0);
  useEffect(() => {
    // The moment the penalty clears, re-run the load that it interrupted.
    // This is the "self-heal": no button, no reload.
    if (!sawRateLimitRef.current || rateLimitedUntil !== 0) return;
    sawRateLimitRef.current = false;
    if (retriesRef.current >= MAX_AUTO_RETRIES) return;
    retriesRef.current += 1;
    // Carries `force` through rather than resetting it: the run being resumed
    // may have been a user's Refresh, and dropping the flag would silently
    // resume into a pure cache read — the one outcome Refresh exists to avoid.
    setReload((r) => ({ ...r }));
  }, [rateLimitedUntil]);

  const refresh = useCallback(() => {
    // Deliberately does NOT clear the snapshot: if this refetch is itself
    // rate-limited, the snapshot is the only thing keeping rows on screen. A
    // successful refetch overwrites it anyway.
    // Re-arms the auto-resume budget too: pressing Refresh is fresh user
    // intent, so it should not inherit an exhausted count from earlier retries.
    retriesRef.current = 0;
    setReload({ force: true });
  }, []);

  // `!`-prefixed for the exclusion form so it can never collide with an
  // allowlist that happens to hold the same ids.
  const settingsKey = settings.targetPlaylistIds?.join(',') ?? `!${settings.excludedPlaylistIds?.join(',') ?? ''}`;

  useEffect(() => {
    // ponytail: a settings change right after a refresh re-runs this effect
    // with force still set, costing one extra saved-tracks + playlists fetch.
    // Cheap enough not to warrant tracking which dep changed.
    const force = reload.force;
    // `cancelled` means "this effect run was superseded" — it only suppresses
    // state updates. Snapshot writes are gated on mountedRef instead, so a
    // superseded run still keeps what it paid to fetch.
    let cancelled = false;
    // Hoisted out of the async IIFE so the catch below can also reach it —
    // a stale snapshot is the fallback when phase 1 itself is what got
    // rate-limited, before there's any freshly-fetched `data` to fall back on.
    let before: ReturnType<typeof readSnapshot> = null;
    // Whether phase 1 got past the point where snapshotAge was decided.
    let phase1Done = false;
    setStatus('loading');
    (async () => {
      before = readSnapshot();
      // Set from the snapshot itself, not from a successful fetch — the catch
      // below needs to know whether there is anything worth falling back to
      // even when THIS attempt is the one that gets rate-limited.
      hasDataRef.current = (before?.tracks.length ?? 0) > 0;
      const base = await loadTracksAndPlaylists(settings, () => !mountedRef.current, { force });
      if (cancelled) return;
      // A forced run refetched even though the snapshot was fresh, so these
      // rows came off the network — no age to report.
      setSnapshotAge(!force && isFresh(before) ? Date.now() - before!.savedAt : null);
      phase1Done = true;
      hasDataRef.current = base.tracks.length > 0;
      setData({ ...EMPTY, ...base });
      setStatus('enriching');

      let lastProgressAt = 0;
      const rest = await enrichLibrary(base, (resolved, total) => {
        if (cancelled) return;
        const now = Date.now();
        // Throttle to ~4/sec — genre resolution ticks per-artist and updating
        // React state on every tick janks the list during a fast run.
        if (now - lastProgressAt < 250 && resolved < total) return;
        lastProgressAt = now;
        setProgress({ resolved, total });
      }, (partial) => {
        if (cancelled) return;
        setData((d) => ({ ...d, ...partial }));
      }, {}, () => !mountedRef.current);
      if (cancelled) return;
      setData((d) => ({ ...d, ...rest }));
      setStatus('ready');
      retriesRef.current = 0; // a completed load re-arms the auto-resume budget
    })().catch((e) => {
      // Set even when this run was superseded: the penalty is app-wide, so the
      // run that replaced it is hitting the same wall.
      if (e instanceof RateLimitedError) sawRateLimitRef.current = true;
      if (cancelled) return;
      // Distinguish an expired session (AuthError) from network-level failures
      if (e instanceof AuthError) {
        setError(String(e));
        setStatus('error');
        setAuthExpired(true);
      } else if (e instanceof RateLimitedError && hasDataRef.current) {
        // The banner already explains this, and the countdown re-runs this
        // effect at zero. Keep the snapshot's rows on screen instead of
        // replacing a working app with an error page.
        setError(null);
        setStatus('ready');
        // What's on screen is the snapshot, and reporting null would claim it
        // came off the network in the one state where the user most needs to
        // be told how old it is. On the unforced path it is stale by
        // construction — a fresh one would have been served without fetching.
        // On the forced path it may still be within its TTL; the age is then
        // simply true rather than alarming, which is the right thing to show.
        if (!phase1Done && before) setSnapshotAge(Date.now() - before.savedAt);
        // Phase 1 itself is what got rate-limited (setData never ran this
        // pass) — fall back to the stale snapshot read at the top so there's
        // still something on screen. If phase 2 failed instead, `data` is
        // already populated from phase 1's real fetch and this is a no-op.
        setData((d) => (d.tracks.length > 0 || !before ? d : {
          ...EMPTY,
          tracks: before.tracks,
          allPlaylists: before.playlists,
          playlists: targetedPlaylists(before.playlists, settings),
        }));
      } else {
        setError(String(e));
        setStatus('error');
      }
    });
    return () => {
      cancelled = true;
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsKey, reload]);

  // Threshold-only changes recompute matches locally instead of refetching —
  // the sensitivity slider used to trigger a full reload via settingsKey.
  const matches = useMemo(() => {
    const m = new Map<string, SongMatch>();
    // Until enrichment lands, fingerprints are empty and every match would be
    // { best: null } — rows would say "no candidate playlists" while still
    // loading. No entry → MatchPicker renders its "…" placeholder instead.
    // Gated on fingerprints only *while still running*: a partial flush during
    // 'enriching' already has real fingerprints and should produce interim
    // matches, but a zero-target-playlist library never gets any fingerprints
    // at all — once 'ready', matches must still populate (as { best: null }).
    if (status !== 'ready' && data.fingerprints.size === 0) return m;
    // Inverted once per recompute (playlist→tracks to track→playlists) rather
    // than scanning every playlist's membership per song below.
    const inPlaylists = new Map<string, Set<string>>();
    for (const [playlistId, trackIds] of data.membership) {
      for (const trackId of trackIds) {
        let s = inPlaylists.get(trackId);
        if (!s) inPlaylists.set(trackId, s = new Set());
        s.add(playlistId);
      }
    }
    // Built once per recompute rather than inside the loop below — matchSong
    // used to rebuild this per track (O(tracks × playlists) on every threshold
    // change), and a per-track baseline would only ever see one song at a time.
    const songs = data.tracks.map((t) => ({
      genres: data.genresByTrack.get(t.id) ?? [],
      releaseYear: t.releaseYear,
      ...langSignals(t.artists, t.name, t.isrc),
    }));
    // The base rate a playlist's language must beat is the whole library, not
    // just the other target playlists — the Liked pool is what establishes that
    // latin/US is this user's *default* rather than a distinctive signal.
    // Without it a 40-track "lofi from Japan" playlist looks rare next to a
    // handful of target playlists and starts claiming genreless English songs
    // at 53%. signalBaseline re-weights each fingerprint by its scripted/
    // countried counts, so the Liked pool (built the same way as a playlist's
    // fingerprint, via buildFingerprint) contributes at its true size.
    const baseline = signalBaseline([...data.fingerprints.values(), buildFingerprint(songs)]);
    data.tracks.forEach((t, i) => {
      m.set(t.id, matchSong(
        songs[i],
        data.fingerprints,
        settings.threshold,
        inPlaylists.get(t.id),
        baseline,
      ));
    });
    return m;
  }, [data.tracks, data.fingerprints, data.genresByTrack, data.membership, settings.threshold, status]);

  const removeTrackLocally = useCallback((id: string) => {
    setData((d) => ({ ...d, tracks: d.tracks.filter((t) => t.id !== id) }));
    // Without this the next reload inside the TTL resurrects the song.
    updateSnapshotTracks((ts) => ts.filter((t) => t.id !== id));
  }, []);
  const restoreTrackLocally = useCallback((t: Track) => {
    setData((d) => ({ ...d, tracks: [...d.tracks, t] }));
    updateSnapshotTracks((ts) => [...ts.filter((x) => x.id !== t.id), t]);
  }, []);

  // One global deep pass so every fingerprint is built from the same data
  // depth — partial (per-playlist) deep resolution skewed recommendations
  // toward whichever playlists happened to be deep-resolved.
  // ponytail: re-runs enrichLibrary — inside the TTL that reuses the
  // snapshot's playlist items instead of re-fetching them, negligible next
  // to the minutes-long MB phase, and it guarantees the artist set matches
  // startup by construction.
  const deepResolveAll = useCallback(async () => {
    if (deepState === 'running') return;
    setDeepState('running');
    setDeepPhase(null);
    try {
      let lastProgressAt = 0;
      let lastPhaseAt = 0;
      const rest = await enrichLibrary(
        { tracks: data.tracks, playlists: data.playlists },
        (resolved, total) => {
          const now = Date.now();
          if (now - lastProgressAt < 250 && resolved < total) return; // same 4/sec throttle as the load effect
          lastProgressAt = now;
          setProgress({ resolved, total });
        },
        (partial) => setData((d) => ({ ...d, ...partial })),
        {
          deep: true,
          onPhase: (phase, artist) => {
            // 'mapping'/'fetching' fire once each — always show them. 'searching'
            // fires once per artist, faster than the UI needs to redraw.
            const now = Date.now();
            if (phase === 'searching' && now - lastPhaseAt < 250) return;
            lastPhaseAt = now;
            setDeepPhase({ phase, artist });
          },
        },
        // Minutes-long, and nothing aborts it on unmount — without this it is
        // the most likely writer to still be in flight when the next account
        // logs in, re-creating a snapshot full of the previous account's data.
        () => !mountedRef.current,
      );
      setData((d) => ({ ...d, ...rest }));
      setDeepState('done');
    } catch {
      setDeepState('error');
    } finally {
      setDeepPhase(null);
    }
  }, [data.tracks, data.playlists, deepState]);

  // Reads the resolver cache, which is updated synchronously before every
  // partial flush replaces genresByTrack — so keying on genresByTrack keeps
  // the counts live during a deep run. The linter cannot see that dependency
  // because it runs through module state rather than through the closure;
  // dropping it freezes the coverage numbers at their first value.
  const coverage = useMemo(
    () => genreCoverage(data.artists.map((a) => a.id)),
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [data.artists, data.genresByTrack],
  );

  return {
    ...data,
    status,
    error,
    authExpired,
    progress,
    matches,
    removeTrackLocally,
    restoreTrackLocally,
    deepResolveAll,
    deepState,
    deepPhase,
    coverage,
    refresh,
    snapshotAge,
  };
}


