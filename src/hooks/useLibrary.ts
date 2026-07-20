import { useCallback, useEffect, useMemo, useState } from 'react';
import { getMyPlaylists, getPlaylistTracks, getSavedTracks } from '../api/spotify';
import { resolveAllGenres } from '../genre/resolver';
import { buildFingerprint, langSignals, matchSong, type Fingerprint } from '../matching/engine';
import type { KondoSettings } from '../storage/settings';
import type { Playlist, PlaylistTrack, SongMatch, Track } from '../types';

export interface LibraryData {
  tracks: Track[];
  playlists: Playlist[];      // filtered to sorting targets
  allPlaylists: Playlist[];   // unfiltered — Settings renders these
  genresByTrack: Map<string, string[]>;
  fingerprints: Map<string, Fingerprint>;
}

/** Phase 1: everything needed to render the song list. Seconds, not minutes. */
export async function loadTracksAndPlaylists(
  settings: KondoSettings,
): Promise<Pick<LibraryData, 'tracks' | 'playlists' | 'allPlaylists'>> {
  const [tracks, allPlaylists] = await Promise.all([getSavedTracks(), getMyPlaylists()]);
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
): Promise<Pick<LibraryData, 'genresByTrack' | 'fingerprints'>> {
  // Some playlists (Blends, algorithmic ones) 403 on their tracks endpoint
  // under dev-mode API restrictions — they can't be read or sorted into, so
  // drop them from the candidate set instead of failing the whole load.
  const playlistTracks = new Map<string, PlaylistTrack[]>(
    (await Promise.all(
      playlists.map((p) =>
        getPlaylistTracks(p.id).then(
          (ts) => [p.id, ts] as const,
          (e) => {
            console.warn(`kondo: skipping unreadable playlist “${p.name}”`, e);
            return null;
          },
        ),
      ),
    )).filter((e) => e !== null),
  );

  // Genre resolution is per unique artist — the cache and MB rate limit both
  // work in our favor this way.
  const artists = new Map<string, { id: string; name: string }>();
  for (const t of tracks) for (const a of t.artists) artists.set(a.id, a);
  for (const pts of playlistTracks.values()) {
    for (const pt of pts) for (const a of pt.artists) artists.set(a.id, a);
  }

  // Shared by the partial and final builds — a rebuild is just "run this over
  // whatever's resolved so far"; missing artists contribute [] either way.
  const buildFrom = (
    genresByArtist: Map<string, string[]>,
  ): Pick<LibraryData, 'genresByTrack' | 'fingerprints'> => {
    const genresOf = (as: { id: string }[]) =>
      [...new Set(as.flatMap((a) => genresByArtist.get(a.id) ?? []))];

    const fingerprints = new Map<string, Fingerprint>(
      [...playlistTracks].map(([id, pts]) => [
        id,
        buildFingerprint(
          pts.map((pt) => ({
            genres: genresOf(pt.artists),
            releaseYear: pt.releaseYear,
            ...langSignals(pt.name, pt.artists, pt.isrc),
          })),
        ),
      ]),
    );

    const genresByTrack = new Map(tracks.map((t) => [t.id, genresOf(t.artists)]));

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

  const genresByArtist = await resolveAllGenres([...artists.values()], wrappedProgress, sink);

  return buildFrom(genresByArtist);
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
  progress: { resolved: number; total: number };
  matches: Map<string, SongMatch>;
  removeTrackLocally(id: string): void;
  restoreTrackLocally(t: Track): void;
}

const EMPTY: LibraryData = {
  tracks: [], playlists: [], allPlaylists: [], genresByTrack: new Map(), fingerprints: new Map(),
};

export function useLibrary(settings: KondoSettings): LibraryState {
  const [data, setData] = useState<LibraryData>(EMPTY);
  const [status, setStatus] = useState<LibraryState['status']>('loading');
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState({ resolved: 0, total: 0 });

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
      setError(String(e));
      setStatus('error');
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

  const removeTrackLocally = useCallback(
    (id: string) => setData((d) => ({ ...d, tracks: d.tracks.filter((t) => t.id !== id) })),
    [],
  );
  const restoreTrackLocally = useCallback(
    (t: Track) => setData((d) => ({ ...d, tracks: [...d.tracks, t] })),
    [],
  );

  return {
    ...data,
    status,
    error,
    progress,
    matches,
    removeTrackLocally,
    restoreTrackLocally,
  };
}
