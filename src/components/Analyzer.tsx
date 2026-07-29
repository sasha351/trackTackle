import { useState } from 'react';
import { MIN_TRACKS, buildPlaylistProfiles, type GenreShare, type PlaylistProfile } from '../analyzer/broadPlaylists';
import type { LibraryState } from '../hooks/useLibrary';
import Spinner from './Spinner';

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
  if (status === 'too-few-tracks') return <span className="pill pill-dashed status-badge">too few tracks</span>;
  return <span className="pill pill-dashed status-badge">no genre data</span>;
}

function PlaylistCard({ profile }: { profile: PlaylistProfile }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? profile.genres : profile.genres.slice(0, VISIBLE_GENRES);
  const hidden = profile.genres.length - shown.length;

  return (
    <article className="playlist-card">
      <header className="playlist-card-header">
        <h3>{profile.name}</h3>
        <StatusPill status={profile.status} />
      </header>
      <p className="playlist-card-count">
        {profile.trackCount} tracks
        {(profile.status === 'focused' || profile.status === 'broad') &&
          <> · {pct(profile.genreCoverage)}% have genres</>}
      </p>
      {profile.genres.length === 0 ? (
        <p className="playlist-card-empty">
          {profile.status === 'too-few-tracks'
            ? `Needs at least ${MIN_TRACKS} tracks to judge.`
            : 'No genre data for these tracks yet — try Resolve via MusicBrainz.'}
        </p>
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

// Ordered so the actionable group leads. 'broad' is the only one open by
// default — with a lot of playlists this page was one long undifferentiated wall.
const GROUPS: { status: PlaylistProfile['status']; label: string; open: boolean }[] = [
  { status: 'broad', label: 'Too broad', open: true },
  { status: 'focused', label: 'Just right', open: false },
  { status: 'too-few-tracks', label: 'Too few tracks to judge', open: false },
  { status: 'no-genre-data', label: 'No genre data', open: false },
];

export default function Analyzer({ lib }: { lib: LibraryState }) {
  if (lib.status === 'loading') return <Spinner label="Loading your playlists…" />;

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
        {/* These stats are computed off the same library the Sorter mutates —
            after filing a batch of songs they're stale until a refetch. */}
        <button onClick={lib.refresh} disabled={lib.status !== 'ready'}>Refresh</button>
      </p>
      {GROUPS.map(({ status, label, open }) => {
        const group = profiles.filter((p) => p.status === status);
        if (group.length === 0) return null;
        return (
          <details key={status} className="analyzer-group" open={open}>
            <summary>{label} · {group.length}</summary>
            <div className="analyzer-grid">
              {group.map((p) => <PlaylistCard key={p.playlistId} profile={p} />)}
            </div>
          </details>
        );
      })}
    </section>
  );
}
