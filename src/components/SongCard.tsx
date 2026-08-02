import { memo } from 'react';
import type { SongMatch, Track } from '../types';
import { BANANA_SRC, FRESHNESS_LABEL, freshnessOf, type FreshnessScale } from '../freshness';
import CoverArt from './CoverArt';
import MatchPicker from './MatchPicker';

interface Props {
  track: Track;
  match: SongMatch | undefined;
  playlistNames: Map<string, string>;
  /** Cover URL per playlist id — same map the panel's candidate tiles read. */
  playlistImages: Map<string, string | null>;
  /** playlist id → track ids it holds. Stable between renders, so memo holds. */
  membership: Map<string, Set<string>>;
  /** Library-wide added-at span; null for an empty library. */
  scale: FreshnessScale | null;
  onAdd: (track: Track, playlistIds: string[]) => void;
  onPlay: (uri: string) => void;
  isPlaying: boolean;
  pending?: boolean;
  loading?: boolean;
}

// The gallery skin's row: the same data and the same callbacks as SongRow, laid
// out as a tall card. Genres and the MB badge are deliberately absent — this
// skin exists to put fewer details in view, and the table still shows them.
function SongCard(
  { track, match, playlistNames, playlistImages, membership, scale,
    onAdd, onPlay, isPlaying, pending, loading }: Props,
) {
  const fresh = freshnessOf(track.addedAt, scale);
  const freshLabel = FRESHNESS_LABEL[fresh];

  // Handed to MatchPicker rather than rendered here. The request is that the
  // date, play, Add and ✕ all sit between the two cover arts; Add belongs to
  // the picker (only it knows which selections are addable), so the cluster
  // goes down to the picker instead of the picker's button coming up here.
  const midSlot = (
    <>
      {/* The banana IS the date control: it carries the ranking at a glance
          and the exact date rides underneath it, revealed on hover/focus.
          tabIndex so that reveal is reachable without a pointer; the text
          stays in the DOM at opacity 0, so screen readers always get it. */}
      <span className="card-date" tabIndex={0}>
        {/* alt/title, not just a picture: green, yellow and brown bananas
            are a colour-only signal on their own. */}
        <img
          className="banana"
          src={BANANA_SRC[fresh]}
          alt={freshLabel}
          title={`${freshLabel} · added ${track.addedAt.slice(0, 10)}`}
        />
        <span className="date-text">{track.addedAt.slice(0, 10)}</span>
      </span>
      <button
        className={'play-btn round' + (loading ? ' spin' : '')}
        aria-label={isPlaying ? 'pause' : 'play'}
        onClick={() => onPlay(track.uri)}
        disabled={pending}
      >
        {loading ? '' : (isPlaying ? '⏸' : '▶')}
      </button>
      <button className="remove-btn" title="Remove from Liked Songs" onClick={() => onAdd(track, [])}>
        ✕
      </button>
    </>
  );

  return (
    <li id={`track-${track.id}`} className={isPlaying ? 'song-card playing' : 'song-card'}>
      <div className="card-song">
        <a
          className="song-name"
          href={`https://open.spotify.com/track/${track.id}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          {track.name}
        </a>
        <CoverArt src={track.albumArt} name={track.name} className="cover-lg" />
        <span className="card-artists">{track.artists.map((a) => a.name).join(', ')}</span>
        <span className="card-year">{track.releaseYear ?? '—'}</span>
      </div>

      {/* While pending there is no picker to host the cluster, but the play
          button and ✕ must not vanish — so the card puts up the same two grid
          tracks itself, with a skeleton where the match will land. Also covers
          a missing match: MatchPicker returns a bare `<span>` when `match` is
          undefined, which would silently drop midSlot (date/play/✕) along with
          it. Not reachable today — useLibrary gives every `ready` track a
          match, and `pending` covers the rest — but reuse the same shell
          rather than let that become a trap. */}
      {(pending || !match) ? (
        <div className="match-panel">
          <div className="panel-mid">{midSlot}</div>
          <span className="match-skeleton" aria-hidden="true" />
        </div>
      ) : (
        <MatchPicker
          layout="panel"
          match={match}
          playlistNames={playlistNames}
          playlistImages={playlistImages}
          onAdd={(ids) => onAdd(track, ids)}
          alreadyIn={(pid) => membership.get(pid)?.has(track.id) ?? false}
          midSlot={midSlot}
        />
      )}
    </li>
  );
}

export default memo(SongCard);
