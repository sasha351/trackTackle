import { useState } from 'react';
import { runCapabilityProbe } from '../dev/probe';
import type { KondoSettings } from '../storage/settings';
import type { Playlist } from '../types';
import Spinner from './Spinner';

interface Props {
  settings: KondoSettings;
  onChange: (s: KondoSettings) => void;
  playlists: Playlist[] | null; // null = library phase 1 still loading
  error: string | null;
}

export default function Settings({ settings, onChange, playlists, error }: Props) {
  const [probeLines, setProbeLines] = useState<string[]>([]);
  const [probing, setProbing] = useState(false);
  const [query, setQuery] = useState('');

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
          <pre>{probeLines.join('\n')}</pre>
        </div>
      )}
    </section>
  );
}
