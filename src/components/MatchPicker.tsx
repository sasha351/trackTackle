import { useEffect, useRef, useState } from 'react';
import CoverArt from './CoverArt';
import type { SongMatch } from '../types';

interface Props {
  match: SongMatch | undefined;
  playlistNames: Map<string, string>;
  onAdd: (playlistIds: string[]) => void;
  /** Playlists that already hold this track — shown, but not selectable. */
  alreadyIn?: (playlistId: string) => boolean;
  /** 'pill' (default): trigger button + floating popover, the table skin.
   *  'panel': the same body rendered inline inside a gallery card, with the
   *  scored candidates as cover-art tiles. Same state, same invariants — only
   *  the container differs. */
  layout?: 'pill' | 'panel';
  /** Cover URL per playlist id. Panel layout only; ids with no art fall back
   *  to CoverArt's text tile. */
  playlistImages?: Map<string, string | null>;
}

export default function MatchPicker(
  { match, playlistNames, onAdd, alreadyIn, layout = 'pill', playlistImages }: Props,
) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [query, setQuery] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);

  // Collapse on outside-click or Escape. Clicking another row's pill lands
  // outside this wrap, so opening one picker closes any other — only one
  // popover is ever open, which is also what stops adjacent popovers colliding.
  //
  // Pill only: the panel layout is inline content inside a card, not a floating
  // layer, so a click anywhere on the page must not fold it back up.
  useEffect(() => {
    if (!open || layout !== 'pill') return;
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
  }, [open, layout]);

  if (!match) return <span>…</span>;

  const best = match.best;
  const candidates = best ? [best, ...match.alternates] : [];
  const candidateIds = new Set(candidates.map((c) => c.playlistId));
  const chosen = selected ?? new Set(best ? [best.playlistId] : []);
  const nameOf = (id: string) => playlistNames.get(id) ?? id;
  const pct = (score: number) => Math.round(score * 100);
  const isDupe = (id: string) => alreadyIn?.(id) === true;

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
  // so Add must never fire with an empty list — it's disabled instead. Dropping
  // duplicates here is what disables Add when the top candidate is a playlist
  // the song is already in, instead of letting the click hit the parent's guard.
  const effectiveChosen = [...chosen].filter((id) => playlistNames.has(id) && !isDupe(id));
  const canAdd = effectiveChosen.length > 0;
  const addLabel = effectiveChosen.length > 1 ? `Add to ${effectiveChosen.length} playlists` : 'Add';

  const pillLabel = best
    ? (match.belowThreshold
        ? `best guess: ${nameOf(best.playlistId)} · ${pct(best.score)}%`
        : `${nameOf(best.playlistId)} · ${pct(best.score)}%`)
    : 'Add to a playlist';

  // Lifted out of the popover so both layouts render the identical element —
  // the search box and the every-other-playlist checkbox list are reused
  // verbatim, not reimplemented.
  const browseSection = (
    <div className="browse-section">
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
          <p className="browse-empty">No playlists match "{query}".</p>
        ) : (
          browse.map(([id, name]) => (
            <label
              key={id}
              className={isDupe(id) ? 'browse-row is-dupe' : 'browse-row'}
              title={isDupe(id) ? 'Already in this playlist' : undefined}
            >
              <input
                type="checkbox"
                checked={chosen.has(id) && !isDupe(id)}
                disabled={isDupe(id)}
                onChange={() => toggle(id)}
              />
              <span className="cand-name">{name}</span>
              {isDupe(id) && <span className="cand-pct">in ✓</span>}
            </label>
          ))
        )}
      </div>
    </div>
  );

  const addButton = (
    <button className="pill-green" disabled={!canAdd} onClick={() => onAdd(effectiveChosen)}>
      {addLabel}
    </button>
  );

  if (layout === 'panel') {
    return (
      <div className="match-panel">
        <div className="panel-head">
          {best ? (
            // The cover *is* the match's identity in this skin, so it is the
            // clickable thing — the name/percent shrinks to a caption below.
            <a
              className="cover-link"
              href={`https://open.spotify.com/playlist/${best.playlistId}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <CoverArt
                src={playlistImages?.get(best.playlistId) ?? null}
                name={nameOf(best.playlistId)}
                className="cover-md"
              />
              <span className="sr-only">{nameOf(best.playlistId)}</span>
            </a>
          ) : (
            <CoverArt src={null} name="" className="cover-md" />
          )}
          {addButton}
        </div>
        <p className={match.belowThreshold ? 'panel-caption panel-caption-dim' : 'panel-caption'}>
          {pillLabel}
        </p>
        {/* Same `open` state the popover uses — this is the card's "show more",
            just owned by the component that already tracks it. */}
        <button className="panel-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? 'hide' : 'show more'}
        </button>
        {open && (
          <div className="panel-body">
            <div className="cand-tiles">
              {candidates.map((c) => (
                <label
                  key={c.playlistId}
                  className={isDupe(c.playlistId) ? 'cand-tile is-dupe' : 'cand-tile'}
                  title={isDupe(c.playlistId) ? 'Already in this playlist' : undefined}
                >
                  <input
                    type="checkbox"
                    checked={chosen.has(c.playlistId) && !isDupe(c.playlistId)}
                    disabled={isDupe(c.playlistId)}
                    onChange={() => toggle(c.playlistId)}
                  />
                  <CoverArt
                    src={playlistImages?.get(c.playlistId) ?? null}
                    name={nameOf(c.playlistId)}
                    className="cover-sm"
                  />
                  <span className="cand-name">{nameOf(c.playlistId)}</span>
                  <span className="cand-pct">
                    {isDupe(c.playlistId) ? 'in ✓' : `${pct(c.score)}%`}
                  </span>
                </label>
              ))}
            </div>
            {browseSection}
          </div>
        )}
      </div>
    );
  }

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
          <span className="pill-caret">{open ? 'hide' : 'show'}</span>
        </button>
        {open && (
          <div className="match-popover">
            {candidates.map((c) => (
              <label
                key={c.playlistId}
                className={isDupe(c.playlistId) ? 'match-candidate is-dupe' : 'match-candidate'}
                title={isDupe(c.playlistId) ? 'Already in this playlist' : undefined}
              >
                <input
                  type="checkbox"
                  checked={chosen.has(c.playlistId) && !isDupe(c.playlistId)}
                  disabled={isDupe(c.playlistId)}
                  onChange={() => toggle(c.playlistId)}
                />
                <span className="cand-name">{nameOf(c.playlistId)}</span>
                <span className="cand-bar"><span style={{ width: `${pct(c.score)}%` }} /></span>
                <span className="cand-pct">{isDupe(c.playlistId) ? 'in ✓' : `${pct(c.score)}%`}</span>
                {import.meta.env.DEV && c.breakdown && (
                  <span className="cand-explain">
                    {c.breakdown.genre.toFixed(2)}g · {c.breakdown.era.toFixed(2)}e · {c.breakdown.lang.toFixed(2)}l
                    {c.breakdown.langPenalty < 1 && ` · ×${c.breakdown.langPenalty} lang`}
                    {c.breakdown.overlap.length > 0 && ` — shared: ${c.breakdown.overlap.join(', ')}`}
                  </span>
                )}
              </label>
            ))}
            {browseSection}
          </div>
        )}
      </div>
      {addButton}
    </span>
  );
}
