import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  addTracksToPlaylist, removeSavedTracks, removeTracksFromPlaylist, saveTracks,
} from '../api/spotify';
import { getValidAccessToken } from '../auth/token';
import { CLIENT_ID } from '../config';
import type { LibraryState } from '../hooks/useLibrary';
import { suggestClusters } from '../matching/clusters';
import { activatePlayerElement, initPlayer, playUri } from '../player/spotifyPlayer';
import type { KondoSettings } from '../storage/settings';
import { logRemoval, removeFromLog } from '../storage/removalLog';
import type { Track } from '../types';
import SongRow from './SongRow';
import UndoToast from './UndoToast';
import Spinner from './Spinner';

interface UndoState {
  track: Track;
  playlistIds: string[];
  removedAt: string;
}

// ponytail: worst case — every artist needs the 1.1s serial name search plus
// its share of the 50-per-request bulk phases. Real runs finish sooner.
function mbEstimate(n: number): string {
  const secs = n * 1.1 + Math.ceil(n / 50) * 2 * 1.1;
  return secs < 90 ? '~1 min' : `~${Math.round(secs / 60)} min`;
}

export default function Sorter({ settings, lib }: { settings: KondoSettings; lib: LibraryState }) {
  const { removeTrackLocally, restoreTrackLocally } = lib;
  const [order, setOrder] = useState<'oldest' | 'newest'>(settings.sortOrder);
  const [undo, setUndo] = useState<UndoState | null>(null);
  const [playingUri, setPlayingUri] = useState<string | null>(null);
  const [pendingUri, setPendingUri] = useState<string | null>(null);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const playlistNames = useMemo(
    () => new Map(lib.playlists.map((p) => [p.id, p.name])),
    [lib.playlists],
  );

  const handleAdd = useCallback(async (track: Track, playlistIds: string[]) => {
    const removedAt = new Date().toISOString();
    // Optimistic: row vanishes and undo toast shows immediately.
    removeTrackLocally(track.id);
    setUndo({ track, playlistIds, removedAt });
    setActionError(null);

    // Adds first: unsaving first would risk losing the song entirely if the
    // add then failed.
    try {
      await Promise.all(playlistIds.map((pid) => addTracksToPlaylist(pid, [track.uri])));
    } catch (e) {
      // Nothing landed — safe to put the row back.
      restoreTrackLocally(track);
      setUndo(null);
      setActionError(String(e));
      return;
    }

    try {
      await removeSavedTracks([track.uri]);
    } catch (e) {
      // The remove-only path (the ✕ button, empty playlistIds) added nothing,
      // so nothing happened at all and the plain rollback still applies.
      if (playlistIds.length === 0) {
        restoreTrackLocally(track);
        setUndo(null);
        setActionError(String(e));
        return;
      }
      // Otherwise the adds already landed. Rolling back here would invite a
      // retry that duplicates the song in the playlist, so keep the row gone
      // and lean on the undo toast — it un-adds *and* re-saves.
      setActionError(
        `Added to your playlist, but couldn't remove it from Liked Songs — ${String(e)}. ` +
        'Undo to put everything back.',
      );
      return; // no removal log: it was never actually removed from Liked
    }

    logRemoval({
      trackId: track.id,
      name: track.name,
      artists: track.artists.map((a) => a.name).join(', '),
      addedAt: track.addedAt,
      removedAt,
      playlistIds,
    });
  }, [removeTrackLocally, restoreTrackLocally]);

  // Read via a ref instead of a `playingUri` dependency so handlePlay's
  // identity stays stable — otherwise every row's memoized SongRow would
  // re-render on every play/pause click.
  const playingUriRef = useRef(playingUri);
  useEffect(() => {
    playingUriRef.current = playingUri;
  }, [playingUri]);

  // Pre-warm the SDK so the first click doesn't have to wait for script load
  useEffect(() => {
    void initPlayer(() => getValidAccessToken(CLIENT_ID)).catch(() => {});
  }, []);

  const handlePlay = useCallback(async (uri: string) => {
    // First statement, before any await: the browser only counts this as a user
    // gesture while the handler runs synchronously. See activatePlayerElement.
    activatePlayerElement();
    try {
      if (playingUriRef.current === uri) {
        const player = await initPlayer(() => getValidAccessToken(CLIENT_ID));
        await player.pause();
        setPlayingUri(null);
      } else {
        setPendingUri(uri);
        try {
          await playUri(() => getValidAccessToken(CLIENT_ID), uri);
          setPlayingUri(uri);
        } finally {
          setPendingUri((p) => (p === uri ? null : p));
        }
      }
    } catch (e) {
      setPlayerError(String(e));
      setPendingUri(null);
    }
  }, []);

  if (lib.status === 'error') return <p role="alert">{lib.error}</p>;

  const sorted = [...lib.tracks].sort((a, b) =>
    order === 'oldest'
      ? a.addedAt.localeCompare(b.addedAt)
      : b.addedAt.localeCompare(a.addedAt),
  );

  const handleUndo = async () => {
    if (!undo) return;
    try {
      await saveTracks([undo.track.uri]);
      for (const pid of undo.playlistIds) {
        await removeTracksFromPlaylist(pid, [undo.track.uri]);
      }
      removeFromLog(undo.track.id, undo.removedAt);
      restoreTrackLocally(undo.track);
      setUndo(null);
      setActionError(null);
    } catch (e) {
      setActionError(String(e));
    }
  };

  const noFit = sorted.filter((t) => lib.matches.get(t.id)?.belowThreshold);
  const clusters = suggestClusters(
    noFit.map((t) => ({ trackId: t.id, genres: lib.genresByTrack.get(t.id) ?? [] })),
  );

  return (
    <section>
      <div className="sorter-toolbar">
        {lib.status !== 'loading' && (
          <p className="song-count">
            <span className="heart" aria-hidden="true">♥</span>
            {lib.tracks.length} liked songs
          </p>
        )}
        <button onClick={() => setOrder(order === 'oldest' ? 'newest' : 'oldest')}>
          {order === 'oldest' ? 'old → new' : 'new → old'}
        </button>
      </div>
      {lib.status === 'ready' && (
        <p className="status-line">
          Genres: {lib.coverage.spotify} via Spotify · {lib.coverage.musicbrainz} via MusicBrainz
          {lib.coverage.none > 0 && <> · {lib.coverage.none} none found</>}
          {' · '}
          {lib.coverage.unresolved} unresolved
        </p>
      )}
      {lib.status === 'ready' && lib.coverage.unresolved > 0 && (
        <button
          disabled={lib.deepState === 'running'}
          onClick={() => void lib.deepResolveAll()}
        >
          {lib.deepState === 'running'
            ? <Spinner label={`Resolving via MusicBrainz ${lib.progress.resolved}/${lib.progress.total}…`} />
            : `Resolve ${lib.coverage.unresolved} via MusicBrainz (${mbEstimate(lib.coverage.unresolved)} worst case)`}
        </button>
      )}
      {playerError && (
        <p role="alert">
          {playerError}. Previews need Spotify Premium — but sorting still works without it, no
          Premium needed.
        </p>
      )}
      {actionError && <p role="alert">{actionError}</p>}
      {lib.deepState === 'error' && (
        <p role="alert">
          MusicBrainz resolution stopped part-way — everything already resolved is kept.
          Use the resolve button to retry the rest.
        </p>
      )}
      {lib.status === 'loading' && (
        <ul className="song-list">
          {Array.from({ length: 8 }).map((_, i) => (
            <li key={i} className="song-row skeleton">
              <span className="song-title">
                <div className="skeleton-line title" />
                <div className="skeleton-line genres" />
              </span>
              <span className="song-artists"><div className="skeleton-line artist" /></span>
              <span className="song-year"><div className="skeleton-line year" /></span>
              <span className="song-added"><div className="skeleton-line date" /></span>
              <span className="song-match"><div className="match-skeleton" /></span>
            </li>
          ))}
        </ul>
      )}
      {lib.status === 'enriching' && (
        <Spinner label={lib.progress.total > 0
          ? `Matching playlists… resolving genres ${lib.progress.resolved}/${lib.progress.total}`
          : 'Matching playlists… resolving genres…'} />
      )}
      <div className="song-cols" aria-hidden="true">
        <span>Song</span>
        <span>Artist</span>
        <span>Year</span>
        <span>Date added</span>
        <span>Match</span>
      </div>
      <ul className="song-list">
        {sorted.map((t) => (
          <SongRow
            key={t.id}
            track={t}
            genres={lib.genresByTrack.get(t.id)}
            match={lib.matches.get(t.id)}
            playlistNames={playlistNames}
            onAdd={handleAdd}
            onPlay={handlePlay}
            isPlaying={playingUri === t.uri}
            loading={pendingUri === t.uri}
            // ponytail: gated on matches too — a partial flush during 'enriching'
            // already produced a real match for this track, show it instead of a skeleton.
            pending={lib.status !== 'ready' && !lib.matches.has(t.id)}
          />
        ))}
      </ul>
      {clusters.length > 0 && (
        <footer>
          <h2>New playlist ideas (songs with no strong match)</h2>
          <ul>
            {clusters.map((c) => (
              <li key={c.genre}>
                {c.trackIds.length} unsorted “{c.genre}” songs — maybe a new playlist?
              </li>
            ))}
          </ul>
        </footer>
      )}
      {undo && (
        <UndoToast
          message={`${undo.playlistIds.length > 0 ? 'Moved' : 'Removed'} “${undo.track.name}” — heads up: re-liking later resets its added date`}
          onUndo={() => void handleUndo()}
          onDismiss={() => setUndo(null)}
        />
      )}
    </section>
  );
}
