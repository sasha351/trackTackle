import { useState } from 'react';
import {
  addTracksToPlaylist, removeSavedTracks, removeTracksFromPlaylist, saveTracks,
} from '../api/spotify';
import { useLibrary } from '../hooks/useLibrary';
import { suggestClusters } from '../matching/clusters';
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

  if (lib.status === 'error') return <p role="alert">{lib.error}</p>;

  const playlistNames = new Map(lib.playlists.map((p) => [p.id, p.name]));
  const sorted = [...lib.tracks].sort((a, b) =>
    order === 'oldest'
      ? a.addedAt.localeCompare(b.addedAt)
      : b.addedAt.localeCompare(a.addedAt),
  );

  const handleAdd = async (track: Track, playlistIds: string[]) => {
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
  };

  const handleUndo = async () => {
    if (!undo) return;
    await saveTracks([undo.track.id]);
    for (const pid of undo.playlistIds) {
      await removeTracksFromPlaylist(pid, [undo.track.uri]);
    }
    removeFromLog(undo.track.id, undo.removedAt);
    lib.restoreTrackLocally(undo.track);
    setUndo(null);
  };

  const noFit = sorted.filter((t) => lib.matches.get(t.id)?.belowThreshold);
  const clusters = suggestClusters(
    noFit.map((t) => ({ trackId: t.id, genres: lib.genresByTrack.get(t.id) ?? [] })),
  );

  return (
    <section>
      <p>{lib.tracks.length} songs remaining in Liked</p>
      {lib.status === 'loading' && (
        <p>
          Loading library… resolving genres {lib.progress.resolved}/{lib.progress.total}
          {lib.progress.total > 0 && ' (first run is slow; results are cached)'}
        </p>
      )}
      <button onClick={() => setOrder(order === 'oldest' ? 'newest' : 'oldest')}>
        {order === 'oldest' ? 'oldest → newest' : 'newest → oldest'}
      </button>
      <ul className="song-list">
        {sorted.map((t) => (
          <SongRow
            key={t.id}
            track={t}
            genres={lib.genresByTrack.get(t.id)}
            matchSlot={
              <MatchPicker
                match={lib.matches.get(t.id)}
                playlistNames={playlistNames}
                onAdd={(ids) => void handleAdd(t, ids)}
              />
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
