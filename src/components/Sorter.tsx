import { useState } from 'react';
import {
  addTracksToPlaylist, removeSavedTracks, removeTracksFromPlaylist, saveTracks,
} from '../api/spotify';
import { getValidAccessToken } from '../auth/token';
import { CLIENT_ID } from '../config';
import { useLibrary } from '../hooks/useLibrary';
import { suggestClusters } from '../matching/clusters';
import { initPlayer, playTrack } from '../player/spotifyPlayer';
import type { KondoSettings } from '../storage/settings';
import { logRemoval, removeFromLog } from '../storage/removalLog';
import type { Track } from '../types';
import MatchPicker from './MatchPicker';
import SongRow from './SongRow';
import UndoToast from './UndoToast';

interface UndoState {
  track: Track;
  playlistIds: string[];
  removedAt: string;
}

export default function Sorter({ settings }: { settings: KondoSettings }) {
  const lib = useLibrary(settings);
  const [order, setOrder] = useState<'oldest' | 'newest'>(settings.sortOrder);
  const [undo, setUndo] = useState<UndoState | null>(null);
  const [playingUri, setPlayingUri] = useState<string | null>(null);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  if (lib.status === 'error') return <p role="alert">{lib.error}</p>;

  const playlistNames = new Map(lib.playlists.map((p) => [p.id, p.name]));
  const sorted = [...lib.tracks].sort((a, b) =>
    order === 'oldest'
      ? a.addedAt.localeCompare(b.addedAt)
      : b.addedAt.localeCompare(a.addedAt),
  );

  const handleAdd = async (track: Track, playlistIds: string[]) => {
    try {
      for (const pid of playlistIds) await addTracksToPlaylist(pid, [track.uri]);
      await removeSavedTracks([track.id]);
      const removedAt = new Date().toISOString();
      logRemoval({
        trackId: track.id,
        name: track.name,
        artists: track.artists.map((a) => a.name).join(', '),
        addedAt: track.addedAt,
        removedAt,
        playlistIds,
      });
      lib.removeTrackLocally(track.id);
      setUndo({ track, playlistIds, removedAt });
      setActionError(null);
    } catch (e) {
      setActionError(String(e));
    }
  };

  const handlePlay = async (uri: string) => {
    try {
      const player = await initPlayer(() => getValidAccessToken(CLIENT_ID));
      if (playingUri === uri) {
        await player.pause();
        setPlayingUri(null);
      } else {
        await playTrack(player.deviceId, uri);
        setPlayingUri(uri);
      }
    } catch (e) {
      setPlayerError(String(e));
    }
  };

  const handleUndo = async () => {
    if (!undo) return;
    try {
      await saveTracks([undo.track.id]);
      for (const pid of undo.playlistIds) {
        await removeTracksFromPlaylist(pid, [undo.track.uri]);
      }
      removeFromLog(undo.track.id, undo.removedAt);
      lib.restoreTrackLocally(undo.track);
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
      {playerError && <p role="alert">{playerError}</p>}
      {actionError && <p role="alert">{actionError}</p>}
      {lib.status === 'loading' && <p>Loading your liked songs…</p>}
      {lib.status === 'enriching' && (
        <p>
          Matching playlists… resolving genres {lib.progress.resolved}/{lib.progress.total}
          {lib.progress.total > 0 && ' (first run is slow; results are cached)'}
        </p>
      )}
      <div className="song-cols" aria-hidden="true">
        <span>Song</span>
        <span>Artist</span>
        <span>Date added</span>
        <span>Match</span>
      </div>
      <ul className="song-list">
        {sorted.map((t) => (
          <SongRow
            key={t.id}
            track={t}
            genres={lib.genresByTrack.get(t.id)}
            matchSlot={
              <>
                <button
                  className="play-btn"
                  aria-label={playingUri === t.uri ? 'pause' : 'play'}
                  onClick={() => void handlePlay(t.uri)}
                >
                  {playingUri === t.uri ? '⏸' : '▶'}
                </button>
                <MatchPicker
                  match={lib.matches.get(t.id)}
                  playlistNames={playlistNames}
                  onAdd={(ids) => void handleAdd(t, ids)}
                />
              </>
            }
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
          message={`Moved “${undo.track.name}” — heads up: re-liking later resets its added date`}
          onUndo={() => void handleUndo()}
          onDismiss={() => setUndo(null)}
        />
      )}
    </section>
  );
}
