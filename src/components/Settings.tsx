import { useState } from 'react';
import { runCapabilityProbe } from '../dev/probe';
import { buildScoreReport } from '../analyzer/scoreReport';
import { BANANA_SRC, FRESHNESS_LABEL, type Freshness } from '../freshness';
import type { KondoSettings } from '../storage/settings';
import type { Playlist } from '../types';
import type { LibraryState } from '../hooks/useLibrary';
import Spinner from './Spinner';

interface Props {
  settings: KondoSettings;
  onChange: (s: KondoSettings) => void;
  playlists: Playlist[] | null; // null = library phase 1 still loading
  error: string | null;
  lib: LibraryState;
}

export default function Settings({ settings, onChange, playlists, error, lib }: Props) {
  const [probeLines, setProbeLines] = useState<string[]>([]);
  const [probing, setProbing] = useState(false);
  const [query, setQuery] = useState('');
  const [reportLines, setReportLines] = useState<string[]>([]);

  if (error) return <p role="alert">{error}</p>;
  if (!playlists) return <Spinner label="Loading playlists…" />;

  const isTarget = (id: string) =>
    settings.targetPlaylistIds === null || settings.targetPlaylistIds.includes(id);

  const toggle = (id: string) => {
    const current = settings.targetPlaylistIds ?? playlists.map((p) => p.id);
    const next = current.includes(id)
      ? current.filter((x) => x !== id)
      : [...current, id];
    onChange({ ...settings, targetPlaylistIds: next });
  };

  const visible = playlists.filter((p) => p.name.toLowerCase().includes(query.toLowerCase()));

  const selectAll = () => onChange({ ...settings, targetPlaylistIds: playlists.map((p) => p.id) });
  const selectNone = () => onChange({ ...settings, targetPlaylistIds: [] });

  return (
    <section className="settings">
      <h2>Match sensitivity</h2>
      <label>
        Songs scoring below {settings.threshold.toFixed(2)} are marked “no strong match” —
        changes apply instantly, no reload needed
        <input
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={settings.threshold}
          onChange={(e) => onChange({ ...settings, threshold: Number(e.target.value) })}
        />
      </label>

      <h2>Sorting destinations</h2>
      <p>Unchecked playlists are ignored by the sorter (road-trip mixes etc.).</p>

      <div className="settings-controls">
        <input
          type="search"
          className="match-search"
          placeholder="Filter playlists"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter playlists"
        />
        <button onClick={selectAll}>Select all</button>
        <button onClick={selectNone}>Select none</button>
      </div>

      <div className="dest-grid" role="list">
        {visible.map((p) => (
          <label key={p.id} role="listitem">
            <input type="checkbox" checked={isTarget(p.id)} onChange={() => toggle(p.id)} />
            {p.name} ({p.trackCount})
          </label>
        ))}
      </div>

      <h2>Ripeness</h2>
      <p>
        Every song carries a banana for how long it has been sitting in Liked. The three stages
        are thirds of your own library's span, oldest to newest — so they mean the same thing
        whatever your library looks like.
      </p>
      <ul className="ripeness-key">
        {(['unripe', 'stable', 'stale'] as Freshness[]).map((f) => (
          <li key={f}>
            {/* alt="" on purpose: the label beside it is the same words, and a
                screen reader reading them twice is worse than not at all. */}
            <img className="banana" src={BANANA_SRC[f]} alt="" />
            <span>{FRESHNESS_LABEL[f]}</span>
          </li>
        ))}
      </ul>

      {import.meta.env.DEV && (
        <div>
          <h2>Diagnostics</h2>
          <button
            disabled={probing}
            onClick={() => {
              setProbing(true);
              runCapabilityProbe().then(setProbeLines).finally(() => setProbing(false));
            }}
          >
            {probing ? <Spinner label="Probing…" /> : 'Run API capability probe'}
          </button>
          <button
            onClick={() => {
              const playlistNames = new Map((playlists ?? []).map((p) => [p.id, p.name]));
              setReportLines(buildScoreReport(lib.tracks, lib.matches, lib.fingerprints, lib.genresByTrack, playlistNames));
            }}
          >
            Score report
          </button>
          <pre>{probeLines.join('\n')}</pre>
          <pre>{reportLines.join('\n')}</pre>
        </div>
      )}
    </section>
  );
}
