import { findBroadPlaylists } from '../analyzer/broadPlaylists';
import type { LibraryState } from '../hooks/useLibrary';

export default function Analyzer({ lib }: { lib: LibraryState }) {
  if (lib.status === 'loading') return <p>Loading your playlists…</p>;

  const broad = findBroadPlaylists(lib.playlists, lib.fingerprints);

  return (
    <section>
      <h2>Too-broad playlists</h2>
      {broad.length === 0 ? (
        <p>No playlists look too broad — every one has a dominant genre.</p>
      ) : (
        <ul>
          {broad.map((p) => (
            <li key={p.playlistId}>
              <strong>{p.name}</strong> — top genre “{p.topGenre}” covers only{' '}
              {Math.round(p.topGenreShare * 100)}% of its songs
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
