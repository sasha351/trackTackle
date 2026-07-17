import { useState } from 'react';
import type { SongMatch } from '../types';

interface Props {
  match: SongMatch | undefined;
  playlistNames: Map<string, string>;
  onAdd: (playlistIds: string[]) => void;
}

export default function MatchPicker({ match, playlistNames, onAdd }: Props) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string> | null>(null);

  if (!match) return <span>…</span>;
  if (!match.best) return <span className="no-match">no candidate playlists</span>;

  const candidates = [match.best, ...match.alternates];
  const chosen = selected ?? new Set([match.best.playlistId]);
  const nameOf = (id: string) => playlistNames.get(id) ?? id;
  const pct = (score: number) => Math.round(score * 100);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev ?? chosen);
      if (next.has(id)) {
        if (next.size > 1) next.delete(id); // at least one target must stay checked
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const addLabel = chosen.size > 1 ? `Add to ${chosen.size} playlists` : 'Add';

  return (
    <span className={match.belowThreshold ? 'match-picker match-picker-dim' : 'match-picker'}>
      <div className="match-pop-wrap">
        <button
          type="button"
          className="match-pill"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <span className="match-pill-label">
            {match.belowThreshold ? `best guess: ${nameOf(match.best.playlistId)}` : nameOf(match.best.playlistId)}
            {' · '}{pct(match.best.score)}%
          </span>
          <span aria-hidden="true">▾</span>
        </button>
        {open && (
          <div className="match-popover">
            {candidates.map((c) => (
              <label key={c.playlistId} className="match-candidate">
                <input
                  type="checkbox"
                  checked={chosen.has(c.playlistId)}
                  onChange={() => toggle(c.playlistId)}
                />
                <span className="cand-name">{nameOf(c.playlistId)}</span>
                <span className="cand-bar"><span style={{ width: `${pct(c.score)}%` }} /></span>
                <span className="cand-pct">{pct(c.score)}%</span>
              </label>
            ))}
          </div>
        )}
      </div>
      <button className="pill-green" onClick={() => onAdd([...chosen])}>
        {addLabel}
      </button>
    </span>
  );
}
