import { useState } from 'react';
import type { SongMatch } from '../types';

interface Props {
  match: SongMatch | undefined;
  playlistNames: Map<string, string>;
  onAdd: (playlistIds: string[]) => void;
}

export default function MatchPicker({ match, playlistNames, onAdd }: Props) {
  const [selected, setSelected] = useState<string | null>(null);
  const [extra, setExtra] = useState<string[]>([]);

  if (!match) return <span>…</span>;
  if (!match.best) return <span className="no-match">no candidate playlists</span>;

  const options = [match.best, ...match.alternates];
  const current = selected ?? match.best.playlistId;
  const nameOf = (id: string) => playlistNames.get(id) ?? id;

  const toggleExtra = (id: string) =>
    setExtra((xs) => (xs.includes(id) ? xs.filter((x) => x !== id) : [...xs, id]));

  return (
    <span className={match.belowThreshold ? 'match-picker no-match' : 'match-picker'}>
      {match.belowThreshold && <span className="badge">no strong match</span>}
      <select value={current} onChange={(e) => setSelected(e.target.value)}>
        {options.map((o) => (
          <option key={o.playlistId} value={o.playlistId}>
            {nameOf(o.playlistId)} ({Math.round(o.score * 100)}%)
          </option>
        ))}
      </select>
      <button onClick={() => onAdd([...new Set([current, ...extra])])}>Add</button>
      <details>
        <summary>multiple</summary>
        {options.map((o) => (
          <label key={o.playlistId}>
            <input
              type="checkbox"
              checked={o.playlistId === current || extra.includes(o.playlistId)}
              disabled={o.playlistId === current}
              onChange={() => toggleExtra(o.playlistId)}
            />
            {nameOf(o.playlistId)}
          </label>
        ))}
      </details>
    </span>
  );
}
