import { memo } from 'react';
import type { SongMatch, Track } from '../types';
import { FRESHNESS_LABEL, freshnessOf, type Freshness, type FreshnessScale } from '../freshness';
import CoverArt from './CoverArt';
import MatchPicker from './MatchPicker';
import bananaUnripe from '../assets/banana-unripe.png';
import bananaStable from '../assets/banana-stable.png';
import bananaStale from '../assets/banana-stale.png';

// Three drawn bananas rather than one emoji re-tinted by CSS filters: the
// ripeness stages differ by their brown spotting, which no hue-rotate on a
// clean yellow emoji can fake. Imported (not /public) so Vite hashes them.
const BANANA: Record<Freshness, string> = {
  unripe: bananaUnripe,
  stable: bananaStable,
  stale: bananaStale,
};

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

      <div className="card-mid">
        {/* The banana IS the date control: it carries the ranking at a glance
            and the exact date rides underneath it, revealed on hover/focus.
            tabIndex so that reveal is reachable without a pointer; the text
            stays in the DOM at opacity 0, so screen readers always get it. */}
        <span className="card-date" tabIndex={0}>
          {/* alt/title, not just a picture: green, yellow and brown bananas
              are a colour-only signal on their own. */}
          <img
            className="banana"
            src={BANANA[fresh]}
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
      </div>

      <div className="card-match">
        {pending ? (
          <span className="match-skeleton" aria-hidden="true" />
        ) : (
          <MatchPicker
            layout="panel"
            match={match}
            playlistNames={playlistNames}
            playlistImages={playlistImages}
            onAdd={(ids) => onAdd(track, ids)}
            alreadyIn={(pid) => membership.get(pid)?.has(track.id) ?? false}
          />
        )}
        <button className="remove-btn" title="Remove from Liked Songs" onClick={() => onAdd(track, [])}>
          ✕
        </button>
      </div>
    </li>
  );
}

export default memo(SongCard);
