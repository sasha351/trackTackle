import { memo } from 'react';
import type { SongMatch, Track } from '../types';
import { cachedSource } from '../genre/resolver';
import { isPlaybackSupported } from '../player/spotifyPlayer';
import MatchPicker from './MatchPicker';

interface Props {
  track: Track;
  genres: string[] | undefined;
  match: SongMatch | undefined;
  playlistNames: Map<string, string>;
  /** playlist id → track ids it holds. Stable between renders, so memo holds. */
  membership: Map<string, Set<string>>;
  onAdd: (track: Track, playlistIds: string[]) => void;
  onPlay: (uri: string) => void;
  isPlaying: boolean;
  pending?: boolean;
  loading?: boolean;
  /** Quick Add strip: render as a card, not a table row. Artists, year and
   *  date-added leave the DOM rather than being hidden, so screen readers
   *  don't read columns nobody can see. */
  compact?: boolean;
}

function SongRow(
  { track, genres, match, playlistNames, membership, onAdd, onPlay, isPlaying, pending, loading, compact }: Props,
) {
  // Cache is an in-memory map after first read — cheap to check per row, and
  // rows re-render as a deep resolve's partial flushes land, so this stays live.
  const hasMbGenre = track.artists.some((a) => cachedSource(a.id) === 'musicbrainz');
  return (
    <li className={`song-row${compact ? ' compact' : ''}${isPlaying ? ' playing' : ''}`}>
      <span className="song-title">
        <a
          className="song-name"
          href={`https://open.spotify.com/track/${track.id}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          {track.name}
        </a>
        <span className="song-genres">
          {genres ? genres.join(', ') || '—' : '…'}
          {hasMbGenre && <span className="mb-badge" title="Resolved via MusicBrainz">MB</span>}
        </span>
      </span>
      {!compact && (
        <span className="song-artists">{track.artists.map((a) => a.name).join(', ')}</span>
      )}
      {!compact && <span className="song-year">{track.releaseYear ?? '—'}</span>}
      {!compact && <span className="song-added">{track.addedAt.slice(0, 10)}</span>}
      <span className="song-match">
        {/* A button that provably cannot work is worse than no button. The
            track title's open.spotify.com link is the substitute — it hands
            off to the installed app. */}
        {isPlaybackSupported() && (
          <button
            className={"play-btn" + (loading ? ' spin' : '')}
            aria-label={isPlaying ? 'pause' : 'play'}
            onClick={() => onPlay(track.uri)}
            disabled={pending}
          >
            {loading ? '' : (isPlaying ? '⏸' : '▶')}
          </button>
        )}
        {pending ? (
           <span className="match-skeleton" aria-hidden="true" />
        ) : (
           <MatchPicker
             match={match}
             playlistNames={playlistNames}
             onAdd={(ids) => onAdd(track, ids)}
             alreadyIn={(pid) => membership.get(pid)?.has(track.id) ?? false}
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
