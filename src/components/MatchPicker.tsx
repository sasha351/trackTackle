import { useEffect, useRef, useState } from 'react';
import type { SongMatch } from '../types';

interface Props {
  match: SongMatch | undefined;
  playlistNames: Map<string, string>;
  onAdd: (playlistIds: string[]) => void;
  deepResolve?: () => Promise<void>;
  deepResolving?: boolean;
}

export default function MatchPicker({ match, playlistNames, onAdd, deepResolve, deepResolving }: Props) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [query, setQuery] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);

  // Collapse on outside-click or Escape. Clicking another row's pill lands
  // outside this wrap, so opening one picker closes any other — only one
  // popover is ever open, which is also what stops adjacent popovers colliding.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!match) return <span>…</span>;

  const best = match.best;
  const candidates = best ? [best, ...match.alternates] : [];
  const candidateIds = new Set(candidates.map((c) => c.playlistId));
  const chosen = selected ?? new Set(best ? [best.playlistId] : []);
  const nameOf = (id: string) => playlistNames.get(id) ?? id;
  const pct = (score: number) => Math.round(score * 100);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev ?? chosen);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Every playlist not already shown as a scored candidate, filtered by search.
  const q = query.trim().toLowerCase();
  const browse = [...playlistNames.entries()]
    .filter(([id]) => !candidateIds.has(id))
    .filter(([, name]) => !q || name.toLowerCase().includes(q))
    .sort((a, b) => a[1].localeCompare(b[1]));

  // Only keep IDs that still exist in the library (a reload/re-rank can strand
  // stale selections). The parent removes the track from Liked unconditionally,
  // so Add must never fire with an empty list — it's disabled instead.
  const effectiveChosen = [...chosen].filter((id) => playlistNames.has(id));
  const canAdd = effectiveChosen.length > 0;
  const addLabel = effectiveChosen.length > 1 ? `Add to ${effectiveChosen.length} playlists` : 'Add';

  const pillLabel = best
    ? (match.belowThreshold
        ? `best guess: ${nameOf(best.playlistId)} · ${pct(best.score)}%`
        : `${nameOf(best.playlistId)} · ${pct(best.score)}%`)
    : 'Add to a playlist';

  return (
    <span className={match.belowThreshold ? 'match-picker match-picker-dim' : 'match-picker'}>
      <div className="match-pop-wrap" ref={wrapRef}>
        <button
          type="button"
          className={best ? 'match-pill' : 'match-pill match-pill-empty'}
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <span className="match-pill-label">{pillLabel}</span>
          <span aria-hidden="true">{open ? '▴' : '▾'}</span>
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
            <div className="browse-section">
              {deepResolve && (
                <div style={{ marginBottom: 8 }}>
                  <button className="pill" onClick={() => void deepResolve()} disabled={!!deepResolving}>
                    {deepResolving ? 'Resolving…' : 'Deep-search genres'}
                  </button>
                </div>
              )}
              <input
                type="search"
                className="match-search"
                placeholder="Search all playlists"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search all playlists"
              />
              <div className="browse-list">
                {browse.length === 0 ? (
                  <p className="browse-empty">No playlists match “{query}”.</p>
                ) : (
                  browse.map(([id, name]) => (
                    <label key={id} className="browse-row">
                      <input
                        type="checkbox"
                        checked={chosen.has(id)}
                        onChange={() => toggle(id)}
                      />
                      <span className="cand-name">{name}</span>
                    </label>
                  ))
                )}
              </div>
            </div>
          </div>
        )}
      </div>
      <button className="pill-green" disabled={!canAdd} onClick={() => onAdd(effectiveChosen)}>
        {addLabel}
      </button>
    </span>
  );
}
