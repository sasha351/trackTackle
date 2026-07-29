import { useCallback, useEffect, useMemo, useState } from 'react';
import { getMyPlaylists, getPlaylistTracks, getSavedTracks } from '../api/spotify';
import { AuthError } from '../auth/token';
import { genreCoverage, resolveAllGenres } from '../genre/resolver';
import { buildFingerprint, langSignals, matchSong, type Fingerprint } from '../matching/engine';
import {
  compactPlaylists, isFresh, readSnapshot, updateSnapshotTracks,
  writeSnapshot, type CompactItem,
} from '../storage/librarySnapshot';
import type { KondoSettings } from '../storage/settings';
import type { Playlist, PlaylistTrack, SongMatch, Track } from '../types';

export interface LibraryData {
  tracks: Track[];
  playlists: Playlist[];      // filtered to sorting targets
  allPlaylists: Playlist[];   // unfiltered — Settings renders these
  genresByTrack: Map<string, string[]>;
  fingerprints: Map<string, Fingerprint>;
  artists: { id: string; name: string }[];
}

/** Phase 1: everything needed to render the song list. Free from cache inside
 *  the TTL, seconds otherwise. */
export async function loadTracksAndPlaylists(
  settings: KondoSettings,
): Promise<Pick<LibraryData, 'tracks' | 'playlists' | 'allPlaylists'>> {
  const snap = readSnapshot();
  let tracks: Track[];
  let allPlaylists: Playlist[];
  if (isFresh(snap)) {
    ({ tracks, playlists: allPlaylists } = snap!);
  } else {
    [tracks, allPlaylists] = await Promise.all([getSavedTracks(), getMyPlaylists()]);
    // Written only after both succeeded — a load interrupted partway must not
    // persist a half-built snapshot. Explicitly reset items/artistNames: an
    // expired snapshot's items expired too, and writeSnapshot merges patches —
    // without this it would carry the stale items forward and re-stamp them
    // fresh, pinning them for another TTL window even though nothing refetched.
    writeSnapshot({ tracks, playlists: allPlaylists, items: {}, artistNames: {} });
  }
  const playlists = settings.targetPlaylistIds
    ? allPlaylists.filter((p) => settings.targetPlaylistIds!.includes(p.id))
    : allPlaylists;
  return { tracks, playlists, allPlaylists };
}

const PARTIAL_FLUSH_ARTISTS = 100;
const PARTIAL_FLUSH_MS = 2000;

/** Phase 2: genres and matches. Slow when uncached — runs behind the list. */
export async function enrichLibrary(
  { tracks, playlists }: Pick<LibraryData, 'tracks' | 'playlists'>,
  onProgress: (resolved: number, total: number) => void,
  onPartial?: (partial: Pick<LibraryData, 'genresByTrack' | 'fingerprints'>) => void,
  opts: { deep?: boolean } = {},
): Promise<Pick<LibraryData, 'genresByTrack' | 'fingerprints' | 'artists'>> {
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
            console.warn(`kondo: skipping unreadable playlist “${p.name}”`, e);
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

  // Shared by the partial and final builds — a rebuild is just "run this over
  // whatever's resolved so far"; missing artists contribute [] either way.
  const buildFrom = (
    genresByArtist: Map<string, string[]>,
  ): Pick<LibraryData, 'genresByTrack' | 'fingerprints'> => {
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
        }))),
      ]),
    );

    const genresByTrack = new Map(
      tracks.map((t) => [t.id, genresOf(t.artists.map((a) => a.id))]),
    );

    return { genresByTrack, fingerprints };
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
  if (fetched.size > 0) writeSnapshot({ items, artistNames });
  return { ...buildFrom(genresByArtist), artists: [...artists.values()] };
}

export async function loadLibrary(
  settings: KondoSettings,
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
  coverage: { spotify: number; musicbrainz: number; none: number; unresolved: number };
}

const EMPTY: LibraryData = {
  tracks: [], playlists: [], allPlaylists: [], genresByTrack: new Map(), fingerprints: new Map(), artists: [],
};

export function useLibrary(settings: KondoSettings): LibraryState {
  const [data, setData] = useState<LibraryData>(EMPTY);
  const [status, setStatus] = useState<LibraryState['status']>('loading');
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState({ resolved: 0, total: 0 });
  const [deepState, setDeepState] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [authExpired, setAuthExpired] = useState(false);

  const settingsKey = settings.targetPlaylistIds?.join(',') ?? '*';

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    (async () => {
      const base = await loadTracksAndPlaylists(settings);
      if (cancelled) return;
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
      });
      if (cancelled) return;
      setData((d) => ({ ...d, ...rest }));
      setStatus('ready');
    })().catch((e) => {
      if (cancelled) return;
      // Distinguish an expired session (AuthError) from network-level failures
      if (e instanceof AuthError) {
        setError(String(e));
        setStatus('error');
        setAuthExpired(true);
      } else {
        setError(String(e));
        setStatus('error');
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsKey]);

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
    for (const t of data.tracks) {
      m.set(t.id, matchSong(
        {
          genres: data.genresByTrack.get(t.id) ?? [],
          releaseYear: t.releaseYear,
          ...langSignals(t.name, t.artists, t.isrc),
        },
        data.fingerprints,
        settings.threshold,
      ));
    }
    return m;
  }, [data.tracks, data.fingerprints, data.genresByTrack, settings.threshold, status]);

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
    try {
      let lastProgressAt = 0;
      const rest = await enrichLibrary(
        { tracks: data.tracks, playlists: data.playlists },
        (resolved, total) => {
          const now = Date.now();
          if (now - lastProgressAt < 250 && resolved < total) return; // same 4/sec throttle as the load effect
          lastProgressAt = now;
          setProgress({ resolved, total });
        },
        (partial) => setData((d) => ({ ...d, ...partial })),
        { deep: true },
      );
      setData((d) => ({ ...d, ...rest }));
      setDeepState('done');
    } catch {
      setDeepState('error');
    }
  }, [data.tracks, data.playlists, deepState]);

  // Reads the resolver cache, which is updated synchronously before every
  // partial flush replaces genresByTrack — so keying on genresByTrack keeps
  // the counts live during a deep run.
  const coverage = useMemo(
    () => genreCoverage(data.artists.map((a) => a.id)),
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
    coverage,
  };
}


