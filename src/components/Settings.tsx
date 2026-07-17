import { useEffect, useState } from 'react';
import { getMyPlaylists } from '../api/spotify';
import { runCapabilityProbe } from '../dev/probe';
import type { KondoSettings } from '../storage/settings';
import type { Playlist } from '../types';

interface Props {
  settings: KondoSettings;
  onChange: (s: KondoSettings) => void;
}

export default function Settings({ settings, onChange }: Props) {
  const [playlists, setPlaylists] = useState<Playlist[] | null>(null);
  const [probeLines, setProbeLines] = useState<string[]>([]);

  useEffect(() => {
    void getMyPlaylists().then(setPlaylists);
  }, []);

  if (!playlists) return <p>Loading playlists…</p>;

  const isTarget = (id: string) =>
    settings.targetPlaylistIds === null || settings.targetPlaylistIds.includes(id);

  const toggle = (id: string) => {
    const current = settings.targetPlaylistIds ?? playlists.map((p) => p.id);
    const next = current.includes(id)
      ? current.filter((x) => x !== id)
      : [...current, id];
    onChange({ ...settings, targetPlaylistIds: next });
  };

  return (
    <section className="settings">
      <h2>Sorting destinations</h2>
      <p>Unchecked playlists are ignored by the sorter (road-trip mixes etc.).</p>
      <ul>
        {playlists.map((p) => (
          <li key={p.id}>
            <label>
              <input type="checkbox" checked={isTarget(p.id)} onChange={() => toggle(p.id)} />
              {p.name} ({p.trackCount})
            </label>
          </li>
        ))}
      </ul>
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
      {import.meta.env.DEV && (
        <div>
          <h2>Diagnostics</h2>
          <button onClick={() => runCapabilityProbe().then(setProbeLines)}>
            Run API capability probe
          </button>
          <pre>{probeLines.join('\n')}</pre>
        </div>
      )}
    </section>
  );
}
