import { useEffect, useState } from 'react';
import { currentPosition, type PlaybackState } from '../player/spotifyPlayer';
import type { Track } from '../types';

interface Props {
  track: Track;
  /** null until the SDK's first state event for this track arrives. */
  playback: PlaybackState | null;
  paused: boolean;
  onToggle: () => void;
  onSeek: (positionMs: number) => void;
}

const SKIP_MS = 10_000;

function fmt(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export default function NowPlaying({ track, playback, paused, onToggle, onSeek }: Props) {
  // Re-render tick while playing. ponytail: 500ms is a visible-enough step for
  // a seconds readout; a rAF loop would buy smoothness nobody reads.
  const [now, setNow] = useState(() => performance.now());
  const live = playback && playback.uri === track.uri ? playback : null;
  useEffect(() => {
    if (!live || live.paused) return;
    const id = window.setInterval(() => setNow(performance.now()), 500);
    return () => window.clearInterval(id);
  }, [live]);

  // While the thumb is held, the slider shows the drag value and nothing is
  // sent — committing on every `change` would fire a seek per pixel dragged.
  const [scrub, setScrub] = useState<number | null>(null);

  const duration = live?.durationMs ?? 0;
  const position = scrub ?? (live ? currentPosition(live, Math.max(now, live.at)) : 0);

  const commit = () => {
    if (scrub === null) return;
    onSeek(scrub);
    setScrub(null);
  };
  const skip = (delta: number) => {
    if (!live) return;
    onSeek(Math.max(0, Math.min(duration, currentPosition(live, performance.now()) + delta)));
  };

  return (
    <div className="now-playing" role="region" aria-label="Player">
      {/* A plain anchor, like .to-top in App.tsx: the browser already scrolls to
          a fragment, and `scroll-behavior: smooth` makes it glide. */}
      <a
        className="now-playing-link"
        href={`#track-${track.id}`}
        aria-label={`Now playing ${track.name} — scroll to it`}
      >
        <span className="now-playing-name">{track.name}</span>
      </a>
      <div className="now-playing-controls">
        <button type="button" className="np-btn" aria-label="back 10 seconds"
          disabled={!live} onClick={() => skip(-SKIP_MS)}>«10</button>
        <button type="button" className="np-btn np-toggle" aria-label={paused ? 'resume' : 'pause playback'}
          onClick={onToggle}>{paused ? '▶' : '⏸'}</button>
        <button type="button" className="np-btn" aria-label="forward 10 seconds"
          disabled={!live} onClick={() => skip(SKIP_MS)}>10»</button>
      </div>
      <div className="now-playing-scrub">
        <span className="np-time">{fmt(position)}</span>
        <input
          type="range"
          aria-label="seek"
          min={0}
          max={duration}
          step={1000}
          value={Math.min(position, duration)}
          disabled={!live}
          onChange={(e) => setScrub(Number(e.target.value))}
          // pointerup covers mouse and touch drags; keyup covers arrow keys;
          // blur catches a drag that ends outside the element.
          onPointerUp={commit}
          onKeyUp={commit}
          onBlur={commit}
        />
        <span className="np-time">{fmt(duration)}</span>
      </div>
    </div>
  );
}
