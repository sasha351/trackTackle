import { memo } from 'react';
import type { SongMatch, Track } from '../types';
import MatchPicker from './MatchPicker';

interface Props {
  track: Track;
  genres: string[] | undefined;
  match: SongMatch | undefined;
  playlistNames: Map<string, string>;
  onAdd: (track: Track, playlistIds: string[]) => void;
  onPlay: (uri: string) => void;
  isPlaying: boolean;
  pending?: boolean;
  loading?: boolean;
}

function SongRow({ track, genres, match, playlistNames, onAdd, onPlay, isPlaying, pending, loading }: Props) {
  return (
    <li className="song-row">
      <span className="song-title">
        <a
          className="song-name"
          href={`https://open.spotify.com/track/${track.id}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          {track.name}
        </a>
        <span className="song-genres">{genres ? genres.join(', ') || '—' : '…'}</span>
      </span>
      <span className="song-artists">{track.artists.map((a) => a.name).join(', ')}</span>
      <span className="song-year">{track.releaseYear ?? '—'}</span>
      <span className="song-added">{track.addedAt.slice(0, 10)}</span>
      <span className="song-match">
        <button
          className={"play-btn" + (loading ? ' spin' : '')}
          aria-label={isPlaying ? 'pause' : 'play'}
          onClick={() => onPlay(track.uri)}
          disabled={pending}
        >
          {loading ? '' : (isPlaying ? '⏸' : '▶')}
        </button>
        {pending ? (
           <span className="match-skeleton" aria-hidden="true" />
        ) : (
           <MatchPicker
             match={match}
             playlistNames={playlistNames}
             onAdd={(ids) => onAdd(track, ids)}
           />
        )}
        <button className="remove-btn" title="Remove from Liked Songs" onClick={() => onAdd(track, [])}>
          ✕
        </button>
      </span>
    </li>
  );
}

export default memo(SongRow);
