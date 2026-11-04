import { useState } from 'react';
import { runCapabilityProbe } from '../dev/probe';
import { runGenreGapDiagnostic } from '../dev/genreGaps';
import { lookupGenresBulk as wikiLookupGenresBulk, resetWikipediaForTests } from '../api/wikipedia';
import { buildScoreReport } from '../analyzer/scoreReport';
import { BANANA_SRC, FRESHNESS_LABEL, type Freshness } from '../freshness';
import type { AppSettings } from '../storage/settings';
import type { Playlist } from '../types';
import type { LibraryState } from '../hooks/useLibrary';
import Spinner from './Spinner';

interface Props {
  settings: AppSettings;
  onChange: (s: AppSettings) => void;
  playlists: Playlist[] | null; // null = library phase 1 still loading
  error: string | null;
  lib: LibraryState;
}

export default function Settings({ settings, onChange, playlists, error, lib }: Props) {
  const [probeLines, setProbeLines] = useState<string[]>([]);
  const [probing, setProbing] = useState(false);
  const [joinLines, setJoinLines] = useState<string[]>([]);
  const [joining, setJoining] = useState(false);
  const [query, setQuery] = useState('');
  const [reportLines, setReportLines] = useState<string[]>([]);
  const [gapLines, setGapLines] = useState<string[]>([]);
  const [gapStatus, setGapStatus] = useState<string | null>(null);

  if (error) return <p role="alert">{error}</p>;
  if (!playlists) return <Spinner label="Loading playlists…" />;

  // Unchecking stores the *exclusion*, never the selection: a selection list
  // is frozen against today's roster, so every playlist created later would
  // come back unchecked. See AppSettings.excludedPlaylistIds.
  const excluded = settings.excludedPlaylistIds
    ?? (settings.targetPlaylistIds
      // The legacy allowlist, on the one render before Workspace migrates it.
      ? playlists.filter((p) => !settings.targetPlaylistIds!.includes(p.id)).map((p) => p.id)
      : []);

  const isTarget = (id: string) => !excluded.includes(id);

  const toggle = (id: string) => onChange({
    ...settings,
    targetPlaylistIds: null,
    excludedPlaylistIds: excluded.includes(id)
      ? excluded.filter((x) => x !== id)
      : [...excluded, id],
  });

  const visible = playlists.filter((p) => p.name.toLowerCase().includes(query.toLowerCase()));

  const selectAll = () => onChange({ ...settings, targetPlaylistIds: null, excludedPlaylistIds: [] });
  // "None" means the playlists that exist right now — one created later is
  // targeted again, same as any other newcomer.
  const selectNone = () =>
    onChange({ ...settings, targetPlaylistIds: null, excludedPlaylistIds: playlists.map((p) => p.id) });

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
          <button
            disabled={joining}
            onClick={() => {
              setJoining(true);
              const artists = lib.artists;
              resetWikipediaForTests(); // force a fresh join, not a cached title from an earlier run
              const missed = new Set<string>();
              const start = Date.now();
              wikiLookupGenresBulk(artists, undefined, undefined, {
                nameSearch: false,
                infobox: false,
                onPhase: (phase, name) => {
                  if (phase === 'searching' && name) missed.add(name);
                },
              }).then(() => {
                const hits = artists.length - missed.size;
                setJoinLines([
                  `${hits} / ${artists.length} artists resolved via the Wikidata P1902 join `
                  + `(${((hits / artists.length) * 100).toFixed(1)}%), ${Date.now() - start}ms`,
                ]);
              }).finally(() => setJoining(false));
            }}
          >
            {joining ? <Spinner label="Joining…" /> : 'Wikidata join-hit rate (real library)'}
          </button>
          <button
            disabled={gapStatus !== null}
            onClick={() => {
              setGapStatus('Starting…');
              setGapLines([]);
              runGenreGapDiagnostic(lib.tracks, lib.genresByTrack, setGapStatus)
                .then(setGapLines, (e: Error) => setGapLines([`FAILED: ${e.message}`]))
                .finally(() => setGapStatus(null));
            }}
          >
            {gapStatus !== null ? <Spinner label={gapStatus} /> : 'Genre gaps: why untagged + library / ISRC / ListenBrainz hit rates'}
          </button>
          <pre>{probeLines.join('\n')}</pre>
          <pre>{joinLines.join('\n')}</pre>
          <pre>{reportLines.join('\n')}</pre>
          <pre>{gapLines.join('\n')}</pre>
        </div>
      )}
    </section>
  );
}
