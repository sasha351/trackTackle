import { useEffect, useState } from 'react';
import { getMyPlaylists, getPlaylistTracks, getSavedTracks } from '../api/spotify';
import { prefetchSpotifyGenres, resolveArtistGenres } from '../genre/resolver';
import { buildFingerprint, matchSong, type Fingerprint } from '../matching/engine';
import type { KondoSettings } from '../storage/settings';
import type { Playlist, PlaylistTrack, SongMatch, Track } from '../types';

export interface LibraryData {
  tracks: Track[];
  playlists: Playlist[];
  genresByTrack: Map<string, string[]>;
  matches: Map<string, SongMatch>;
}

/** Phase 1: everything needed to render the song list. Seconds, not minutes. */
export async function loadTracksAndPlaylists(
  settings: KondoSettings,
): Promise<Pick<LibraryData, 'tracks' | 'playlists'>> {
  const [tracks, allPlaylists] = await Promise.all([getSavedTracks(), getMyPlaylists()]);
  const playlists = settings.targetPlaylistIds
    ? allPlaylists.filter((p) => settings.targetPlaylistIds!.includes(p.id))
    : allPlaylists;
  return { tracks, playlists };
}

/** Phase 2: genres and matches. Slow when uncached — runs behind the list. */
export async function enrichLibrary(
  { tracks, playlists }: Pick<LibraryData, 'tracks' | 'playlists'>,
  settings: KondoSettings,
  onProgress: (resolved: number, total: number) => void,
): Promise<Pick<LibraryData, 'genresByTrack' | 'matches'>> {
  const playlistTracks = new Map<string, PlaylistTrack[]>(
    await Promise.all(
      playlists.map(async (p) => [p.id, await getPlaylistTracks(p.id)] as const),
    ),
  );

  // Genre resolution is per unique artist — the cache and MB rate limit both
  // work in our favor this way.
  const artists = new Map<string, { id: string; name: string }>();
  for (const t of tracks) for (const a of t.artists) artists.set(a.id, a);
  for (const pts of playlistTracks.values()) {
    for (const pt of pts) for (const a of pt.artists) artists.set(a.id, a);
  }

  // One batched pass fills the cache for everything Spotify can answer; the
  // loop below then only pays the slow MusicBrainz price for the leftovers.
  await prefetchSpotifyGenres([...artists.values()]);

  const genresByArtist = new Map<string, string[]>();
  let resolved = 0;
  for (const a of artists.values()) {
    genresByArtist.set(a.id, (await resolveArtistGenres(a)).genres);
    resolved += 1;
    onProgress(resolved, artists.size);
  }

  const genresOf = (as: { id: string }[]) =>
    [...new Set(as.flatMap((a) => genresByArtist.get(a.id) ?? []))];

  const fingerprints = new Map<string, Fingerprint>(
    playlists.map((p) => [
      p.id,
      buildFingerprint(
        (playlistTracks.get(p.id) ?? []).map((pt) => ({
          genres: genresOf(pt.artists),
          releaseYear: pt.releaseYear,
        })),
      ),
    ]),
  );

  const genresByTrack = new Map(tracks.map((t) => [t.id, genresOf(t.artists)]));
  const matches = new Map(
    tracks.map((t) => [
      t.id,
      matchSong(
        { genres: genresByTrack.get(t.id) ?? [], releaseYear: t.releaseYear },
        fingerprints,
        settings.threshold,
      ),
    ]),
  );

  return { genresByTrack, matches };
}

export async function loadLibrary(
  settings: KondoSettings,
  onProgress: (resolved: number, total: number) => void,
): Promise<LibraryData> {
  const base = await loadTracksAndPlaylists(settings);
  return { ...base, ...(await enrichLibrary(base, settings, onProgress)) };
}

export interface LibraryState extends LibraryData {
  // 'enriching': songs are on screen and sortable, genres/matches still filling in.
  status: 'loading' | 'enriching' | 'ready' | 'error';
  error: string | null;
  progress: { resolved: number; total: number };
  removeTrackLocally(id: string): void;
  restoreTrackLocally(t: Track): void;
}

const EMPTY: LibraryData = {
  tracks: [], playlists: [], genresByTrack: new Map(), matches: new Map(),
};

export function useLibrary(settings: KondoSettings): LibraryState {
  const [data, setData] = useState<LibraryData>(EMPTY);
  const [status, setStatus] = useState<LibraryState['status']>('loading');
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState({ resolved: 0, total: 0 });

  const settingsKey = `${settings.threshold}|${settings.targetPlaylistIds?.join(',') ?? '*'}`;

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    (async () => {
      const base = await loadTracksAndPlaylists(settings);
      if (cancelled) return;
      setData({ ...EMPTY, ...base });
      setStatus('enriching');

      const rest = await enrichLibrary(base, settings, (resolved, total) => {
        if (!cancelled) setProgress({ resolved, total });
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

  return {
    ...data,
    status,
    error,
    progress,
    removeTrackLocally: (id) =>
      setData((d) => ({ ...d, tracks: d.tracks.filter((t) => t.id !== id) })),
    restoreTrackLocally: (t) =>
      setData((d) => ({ ...d, tracks: [...d.tracks, t] })),
  };
}
