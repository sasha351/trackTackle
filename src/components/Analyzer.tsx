import { useState } from 'react';
import { MIN_TRACKS, buildPlaylistProfiles, type GenreShare, type PlaylistProfile } from '../analyzer/broadPlaylists';
import type { LibraryState } from '../hooks/useLibrary';

const VISIBLE_GENRES = 6;
const pct = (share: number) => Math.round(share * 100);

function GenreBar({ genre, share }: GenreShare) {
  return (
    <div className="genre-row">
      <span className="genre-name">{genre}</span>
      <span className="cand-bar"><span style={{ width: `${pct(share)}%` }} /></span>
      <span className="cand-pct">{pct(share)}%</span>
    </div>
  );
}

function StatusPill({ status }: { status: PlaylistProfile['status'] }) {
  if (status === 'focused') return <span className="pill pill-green status-badge">focused</span>;
  if (status === 'broad') return <span className="pill pill-dashed status-badge">too broad</span>;
  return <span className="pill pill-dashed status-badge">too few tracks</span>;
}

function PlaylistCard({ profile, onDeepResolve, status }: {
  profile: PlaylistProfile;
  onDeepResolve: (id: string) => void;
  status?: 'resolving' | 'done' | 'error';
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? profile.genres : profile.genres.slice(0, VISIBLE_GENRES);
  const hidden = profile.genres.length - shown.length;

  return (
    <article className="playlist-card">
      <header className="playlist-card-header">
        <h3>{profile.name}</h3>
        <StatusPill status={profile.status} />
      </header>
      <p className="playlist-card-count">{profile.trackCount} tracks</p>
      <button
        type="button"
        className="genre-toggle"
        disabled={status === 'resolving'}
        onClick={() => onDeepResolve(profile.playlistId)}
      >
        {status === 'resolving' ? 'Resolving…' : status === 'done' ? 'Deep-search genres ✓' : 'Deep-search genres'}
      </button>
      {profile.genres.length === 0 ? (
        <p className="playlist-card-empty">Needs at least {MIN_TRACKS} readable tracks to judge.</p>
      ) : (
        <>
          {shown.map((g) => <GenreBar key={g.genre} {...g} />)}
          {(hidden > 0 || expanded) && (
            <button type="button" className="genre-toggle" onClick={() => setExpanded(!expanded)}>
              {expanded ? 'Show less' : `Show ${hidden} more`}
            </button>
          )}
        </>
      )}
    </article>
  );
}

export default function Analyzer({ lib }: { lib: LibraryState }) {
  if (lib.status === 'loading') return <p>Loading your playlists…</p>;

  const profiles = buildPlaylistProfiles(lib.playlists, lib.fingerprints);
  const broadCount = profiles.filter((p) => p.status === 'broad').length;

  if (profiles.length === 0) return <p>No playlists to analyze yet.</p>;

  return (
    <section className="analyzer">
      <p className="analyzer-summary">
        {profiles.length} playlist{profiles.length === 1 ? '' : 's'} analyzed
        {broadCount > 0 && (
          <> · <strong>{broadCount}</strong> {broadCount === 1 ? 'looks' : 'look'} too broad</>
        )}
      </p>
      <p className="analyzer-hint">Matches for a playlist look off? Run a deeper genre search for it — slower, but more thorough.</p>
      <div className="analyzer-grid">
        {profiles.map((p) => (
          <PlaylistCard
            key={p.playlistId}
            profile={p}
            onDeepResolve={lib.deepResolvePlaylist}
            status={lib.deepStatus[p.playlistId]}
          />
        ))}
      </div>
    </section>
  );
}
