import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  addTracksToPlaylist, createPlaylist, removeSavedTracks, removeTracksFromPlaylist, saveTracks,
} from '../api/spotify';
import { getValidAccessToken } from '../auth/token';
import { CLIENT_ID } from '../config';
import type { LibraryState } from '../hooks/useLibrary';
import { suggestClusters } from '../matching/clusters';
import { activatePlayerElement, initPlayer, isPlaybackSupported, playUri } from '../player/spotifyPlayer';
import type { KondoSettings } from '../storage/settings';
import { logRemoval, removeFromLog } from '../storage/removalLog';
import type { Track } from '../types';
import { freshnessScale } from '../freshness';
import SongCard from './SongCard';
import SongRow from './SongRow';
import UndoToast from './UndoToast';
import Spinner from './Spinner';

interface UndoState {
  track: Track;
  playlistIds: string[];
  removedAt: string;
}

// ponytail: a constant, not a setting. 0.85 is a guess at what "obvious match"
// means until real libraries show what a strong score actually looks like —
// promote it to a slider only if it proves wrong, not before.
const QUICK_MATCH_MIN = 0.85;

// Four across is the sketch's shape, and four is also as many cards as fit the
// content width without shrinking below readable.
const QUICK_CARDS = 4;

// ponytail: worst case — every artist needs the 1.1s serial name search plus
// its share of the 50-per-request bulk phases. Real runs finish sooner.
function mbEstimate(n: number): string {
  const secs = n * 1.1 + Math.ceil(n / 50) * 2 * 1.1;
  return secs < 90 ? '~1 min' : `~${Math.round(secs / 60)} min`;
}

// Only the name-search fallback (phase 'searching') is genuinely per-artist;
// the two bulk phases fake per-item progress otherwise, so they get a plain
// label instead of pretending to track individual artists.
function DeepPhaseStatus(
  { deepPhase, progress, unresolvedCount }: {
    deepPhase: LibraryState['deepPhase'];
    progress: { resolved: number; total: number };
    unresolvedCount: number;
  },
) {
  if (!deepPhase) return <Spinner label={`Resolving ${progress.resolved}/${progress.total}…`} />;
  if (deepPhase.phase === 'joining') {
    return <Spinner label={`Checking Wikidata for ${unresolvedCount} artists…`} />;
  }
  if (deepPhase.phase === 'mapping') {
    return <Spinner label={`Looking up ${unresolvedCount} artists on MusicBrainz…`} />;
  }
  if (deepPhase.phase === 'searching') {
    return <span className="mb-searching-pulse">Searching {deepPhase.artist}…</span>;
  }
  return <Spinner label="Fetching genres for batch…" />;
}

function formatAge(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

type SortCol = 'title' | 'artist' | 'year' | 'added' | 'match';

// First click on a column that isn't already active starts here — a fresh
// year/match click means "best/newest first", a fresh name click means A→Z.
const DEFAULT_DIR: Record<SortCol, 'asc' | 'desc'> = {
  title: 'asc', artist: 'asc', year: 'desc', added: 'asc', match: 'desc',
};

export default function Sorter({ settings, lib }: { settings: KondoSettings; lib: LibraryState }) {
  const { removeTrackLocally, restoreTrackLocally } = lib;
  // Gallery view keeps the old/new toggle; table view sorts by clicking a
  // column heading instead, so the two skins get their own sort state.
  const [order, setOrder] = useState<'oldest' | 'newest'>(settings.sortOrder);
  const [sortCol, setSortCol] = useState<SortCol>('added');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>(settings.sortOrder === 'oldest' ? 'asc' : 'desc');
  const toggleSort = (col: SortCol) => {
    if (col === sortCol) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortCol(col); setSortDir(DEFAULT_DIR[col]); }
  };
  const [undo, setUndo] = useState<UndoState | null>(null);
  const [playingUri, setPlayingUri] = useState<string | null>(null);
  const [pendingUri, setPendingUri] = useState<string | null>(null);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [clusterNames, setClusterNames] = useState<Record<string, string>>({});
  const [creatingGenre, setCreatingGenre] = useState<string | null>(null);
  // ponytail: this expand is NOT decoration. `rest` below excludes every quick
  // match from the main table, so a cap without a way to expand would strand
  // the songs past the fourth where nothing on the page can reach them.
  const [showAllQuick, setShowAllQuick] = useState(false);
  const [showAllClusters, setShowAllClusters] = useState(false);

  const playlistNames = useMemo(
    () => new Map(lib.playlists.map((p) => [p.id, p.name])),
    [lib.playlists],
  );

  const playlistImages = useMemo(
    () => new Map(lib.playlists.map((p) => [p.id, p.image ?? null])),
    [lib.playlists],
  );

  // Computed once per library, not per card: the buckets are thirds of the
  // whole library's added-at span, so every card needs the same scale.
  const freshness = useMemo(
    () => freshnessScale(lib.tracks.map((t) => t.addedAt)),
    [lib.tracks],
  );

  const handleAdd = useCallback(async (track: Track, playlistIds: string[]) => {
    // Duplicate guard, before anything is optimistically mutated. Spotify
    // happily accepts the same track twice, and the second copy is invisible
    // here — the row is gone from Liked either way. An empty playlistIds (the
    // ✕ remove-only path) can never trip this.
    const dupes = playlistIds.filter((pid) => lib.membership.get(pid)?.has(track.id));
    if (dupes.length > 0) {
      setActionError(
        `"${track.name}" is already in ${dupes.map((pid) => playlistNames.get(pid) ?? pid).join(', ')}` +
        ' — nothing was changed.',
      );
      return;
    }

    const removedAt = new Date().toISOString();
    // Optimistic: row vanishes and undo toast shows immediately.
    removeTrackLocally(track.id);
    setUndo({ track, playlistIds, removedAt });
    setActionError(null);

    // Adds first: unsaving first would risk losing the song entirely if the
    // add then failed.
    try {
      await Promise.all(playlistIds.map((pid) => addTracksToPlaylist(pid, [track.uri])));
    } catch (e) {
      // Nothing landed — safe to put the row back.
      restoreTrackLocally(track);
      setUndo(null);
      setActionError(String(e));
      return;
    }

    try {
      await removeSavedTracks([track.uri]);
    } catch (e) {
      // The remove-only path (the ✕ button, empty playlistIds) added nothing,
      // so nothing happened at all and the plain rollback still applies.
      if (playlistIds.length === 0) {
        restoreTrackLocally(track);
        setUndo(null);
        setActionError(String(e));
        return;
      }
      // Otherwise the adds already landed. Rolling back here would invite a
      // retry that duplicates the song in the playlist, so keep the row gone
      // and lean on the undo toast — it un-adds *and* re-saves.
      setActionError(
        `Added to your playlist, but couldn't remove it from Liked Songs — ${String(e)}. ` +
        'Undo to put everything back.',
      );
      return; // no removal log: it was never actually removed from Liked
    }

    logRemoval({
      trackId: track.id,
      name: track.name,
      artists: track.artists.map((a) => a.name).join(', '),
      addedAt: track.addedAt,
      removedAt,
      playlistIds,
    });
  }, [removeTrackLocally, restoreTrackLocally, lib.membership, playlistNames]);

  // Creation must not unsave: the cluster's songs stay in Liked (they still
  // match the new playlist via the normal per-song flow afterwards), so a
  // failure here never needs the rollback/undo machinery handleAdd has.
  const handleCreateCluster = useCallback(async (genre: string, name: string, trackIds: string[]) => {
    setActionError(null);
    setCreatingGenre(genre);
    try {
      const ids = new Set(trackIds);
      const uris = lib.tracks.filter((t) => ids.has(t.id)).map((t) => t.uri);
      const playlist = await createPlaylist(name);
      await addTracksToPlaylist(playlist.id, uris);
      lib.refresh();
    } catch (e) {
      setActionError(String(e));
    } finally {
      setCreatingGenre(null);
    }
  }, [lib]);

  // Read via a ref instead of a `playingUri` dependency so handlePlay's
  // identity stays stable — otherwise every row's memoized SongRow would
  // re-render on every play/pause click.
  const playingUriRef = useRef(playingUri);
  useEffect(() => {
    playingUriRef.current = playingUri;
  }, [playingUri]);

  // Pre-warm the SDK so the first click doesn't have to wait for script load.
  // Skipped where the SDK cannot run: on a phone this would fetch and boot a
  // 100KB script that is guaranteed to fail.
  useEffect(() => {
    if (!isPlaybackSupported()) return;
    void initPlayer(() => getValidAccessToken(CLIENT_ID)).catch(() => {});
  }, []);

  const handlePlay = useCallback(async (uri: string) => {
    // First statement, before any await: the browser only counts this as a user
    // gesture while the handler runs synchronously. See activatePlayerElement.
    activatePlayerElement();
    try {
      if (playingUriRef.current === uri) {
        const player = await initPlayer(() => getValidAccessToken(CLIENT_ID));
        await player.pause();
        setPlayingUri(null);
      } else {
        setPendingUri(uri);
        try {
          await playUri(() => getValidAccessToken(CLIENT_ID), uri);
          setPlayingUri(uri);
        } finally {
          setPendingUri((p) => (p === uri ? null : p));
        }
      }
    } catch (e) {
      setPlayerError(String(e));
      setPendingUri(null);
    }
  }, []);

  if (lib.status === 'error') return <p role="alert">{lib.error}</p>;

  const compareByCol = (a: Track, b: Track): number => {
    const dir = sortDir === 'asc' ? 1 : -1;
    switch (sortCol) {
      case 'title': return dir * a.name.localeCompare(b.name);
      case 'artist': return dir * (a.artists[0]?.name ?? '').localeCompare(b.artists[0]?.name ?? '');
      case 'year': return dir * ((a.releaseYear ?? 0) - (b.releaseYear ?? 0));
      case 'match': return dir * (
        (lib.matches.get(a.id)?.best?.score ?? -1) - (lib.matches.get(b.id)?.best?.score ?? -1)
      );
      default: return dir * a.addedAt.localeCompare(b.addedAt);
    }
  };
  const sorted = settings.skin === 'gallery'
    ? [...lib.tracks].sort((a, b) =>
        order === 'oldest'
          ? a.addedAt.localeCompare(b.addedAt)
          : b.addedAt.localeCompare(a.addedAt),
      )
    : [...lib.tracks].sort(compareByCol);

  // Looked up rather than stored: `playingUri` is the only state playback has,
  // and a song sorted away mid-play is simply not found — the indicator
  // disappears instead of pointing at an id that has left the DOM.
  const playingTrack = playingUri ? lib.tracks.find((t) => t.uri === playingUri) : undefined;

  const handleUndo = async () => {
    if (!undo) return;
    try {
      await saveTracks([undo.track.uri]);
      for (const pid of undo.playlistIds) {
        await removeTracksFromPlaylist(pid, [undo.track.uri]);
      }
      removeFromLog(undo.track.id, undo.removedAt);
      restoreTrackLocally(undo.track);
      setUndo(null);
      setActionError(null);
    } catch (e) {
      setActionError(String(e));
    }
  };

  // A load that hit the rate limiter lands on 'ready' serving snapshot rows with
  // no fingerprints, so every song scores { best: null, belowThreshold: true } —
  // the exact shape of a real "scored it, nothing fits". Detected here rather
  // than trusted, because the difference is invisible in `matches` alone.
  const unscored = lib.status === 'ready'
    && lib.snapshotAge != null
    && lib.fingerprints.size === 0
    && lib.playlists.length > 0;

  // Suppressed while unscored: recommending new playlists off zero fingerprints
  // is a verdict the app never actually computed.
  const noFit = unscored ? [] : sorted.filter((t) => lib.matches.get(t.id)?.belowThreshold);
  const clusters = suggestClusters(
    noFit.map((t) => ({ trackId: t.id, genres: lib.genresByTrack.get(t.id) ?? [] })),
    5,
    lib.fingerprints,
  );

  // Songs the scorer is confident about, lifted to the top for a one-click add.
  // They are *moved*, not copied — the same song in two lists is a worse
  // problem than a strip the user can collapse. Suppressed while unscored for
  // the same reason as the cluster suggestions.
  let quick = unscored
    ? []
    : sorted.filter((t) => {
        const best = lib.matches.get(t.id)?.best;
        if (!best || best.score < QUICK_MATCH_MIN) return false;
        return !lib.membership.get(best.playlistId)?.has(t.id);
      });
  const quickIds = new Set(quick.map((t) => t.id));
  let rest = quick.length > 0 ? sorted.filter((t) => !quickIds.has(t.id)) : sorted;

  // Gallery mode with an empty main list is useless: if every song went to the
  // quick strip, collapse them into the gallery instead so there is something to
  // look at. In table mode the quick strip always wins over an empty list.
  if (settings.skin === 'gallery' && rest.length === 0 && quick.length > 0) {
    rest = quick;
    quick = [];
  }

  // One renderer for both lists and both skins, so every list inherits every
  // affordance (multi-select, browse-all, remove) instead of drifting.
  // `compact` wins over the skin: the Quick Add strip is a decision band above
  // the list, not a row style, so it stays table-shaped in the gallery too.
  const renderRow = (t: Track, compact = false) =>
    settings.skin === 'gallery' && !compact ? (
      <SongCard
        key={t.id}
        track={t}
        match={lib.matches.get(t.id)}
        playlistNames={playlistNames}
        playlistImages={playlistImages}
        membership={lib.membership}
        scale={freshness}
        onAdd={handleAdd}
        onPlay={handlePlay}
        isPlaying={playingUri === t.uri}
        loading={pendingUri === t.uri}
        pending={lib.status !== 'ready' && !lib.matches.has(t.id)}
      />
    ) : (
      <SongRow
        key={t.id}
        track={t}
        compact={compact}
        genres={lib.genresByTrack.get(t.id)}
        match={lib.matches.get(t.id)}
        playlistNames={playlistNames}
        membership={lib.membership}
        onAdd={handleAdd}
        onPlay={handlePlay}
        isPlaying={playingUri === t.uri}
        loading={pendingUri === t.uri}
        // ponytail: gated on matches too — a partial flush during 'enriching'
        // already produced a real match for this track, show it instead of a skeleton.
        pending={lib.status !== 'ready' && !lib.matches.has(t.id)}
      />
    );

  return (
    <section>
      <div className="sorter-toolbar">
        {lib.status !== 'loading' && (
          <p className="song-count">
            <span className="heart" aria-hidden="true">♥</span>
            {lib.tracks.length} liked songs
          </p>
        )}
        {/* One cluster, not two free-floating children: `space-between` would
            otherwise push the cache line and the sort chip to opposite ends of
            the toolbar, which is exactly what the sketch groups together. */}
        <div className="toolbar-controls">
          {lib.snapshotAge != null && (
            <p className="snapshot-age">
              Cached {formatAge(lib.snapshotAge)}
              <button onClick={lib.refresh}>Refresh</button>
            </p>
          )}
          {settings.skin === 'gallery' && (
            <button onClick={() => setOrder(order === 'oldest' ? 'newest' : 'oldest')}>
              {order === 'oldest' ? 'old → new' : 'new → old'}
            </button>
          )}
        </div>
      </div>
      {unscored && (
        <p className="status-line">
          These songs couldn't be scored against your playlists — showing cached songs only.
          Refresh once the rate limit clears.
        </p>
      )}
      {lib.status === 'ready' && (
        // The resolve button lives inside the coverage line, not under it: it
        // exists precisely because `coverage.unresolved > 0`, so they are one
        // thought. .status-line is already a wrapping flex row, so the button
        // just becomes another item on it.
        <p className="status-line">
          Genres: {lib.coverage.spotify} via Spotify · {lib.coverage.musicbrainz} via MusicBrainz
          {lib.coverage.wikipedia > 0 && <> · {lib.coverage.wikipedia} via Wikidata</>}
          {lib.coverage.none > 0 && <> · {lib.coverage.none} none found</>}
          {' · '}
          {lib.coverage.unresolved} unresolved
          {lib.coverage.unresolved > 0 && (
            <button
              disabled={lib.deepState === 'running'}
              onClick={() => void lib.deepResolveAll()}
            >
              {lib.deepState === 'running'
                ? (
                  <DeepPhaseStatus
                    deepPhase={lib.deepPhase}
                    progress={lib.progress}
                    unresolvedCount={lib.coverage.unresolved}
                  />
                )
                : `Resolve ${lib.coverage.unresolved} via Wikidata + MusicBrainz (${mbEstimate(lib.coverage.unresolved)} worst case)`}
            </button>
          )}
        </p>
      )}
      {!isPlaybackSupported() && (
        <p className="status-line">
          In-app previews need a desktop browser — tap a song title to open it in Spotify.
          Sorting works exactly the same here.
        </p>
      )}
      {playerError && (
        <p role="alert">
          {playerError}. Previews need Spotify Premium — but sorting still works without it, no
          Premium needed.
        </p>
      )}
      {actionError && <p role="alert">{actionError}</p>}
      {lib.deepState === 'error' && (
        <p role="alert">
          MusicBrainz resolution stopped part-way — everything already resolved is kept.
          Use the resolve button to retry the rest.
        </p>
      )}
      {lib.status === 'loading' && (
        <ul className="song-list">
          {Array.from({ length: 8 }).map((_, i) => (
            <li key={i} className="song-row skeleton">
              <span className="song-title">
                <div className="skeleton-line title" />
                <div className="skeleton-line genres" />
              </span>
              <span className="song-artists"><div className="skeleton-line artist" /></span>
              <span className="song-year"><div className="skeleton-line year" /></span>
              <span className="song-added"><div className="skeleton-line date" /></span>
              <span className="song-match"><div className="match-skeleton" /></span>
            </li>
          ))}
        </ul>
      )}
      {lib.status === 'enriching' && (
        <Spinner label={lib.progress.total > 0
          ? `Matching playlists… resolving genres ${lib.progress.resolved}/${lib.progress.total}`
          : 'Matching playlists… resolving genres…'} />
      )}
      {(quick.length > 0 || clusters.length > 0) && (
        <div className="suggestions-row">
          {quick.length > 0 && (
            // <details> rather than useState: the browser already owns show/hide,
            // and it stays open across the re-render an add causes.
            <details className="quick-matches" open>
              <summary>Quick Add · {quick.length}</summary>
              <ul className="song-list quick-list">
                {(showAllQuick ? quick : quick.slice(0, QUICK_CARDS)).map((t) => renderRow(t, true))}
              </ul>
              {quick.length > QUICK_CARDS && (
                <button className="strip-expand" onClick={() => setShowAllQuick((v) => !v)}>
                  {showAllQuick ? 'show fewer' : `show all ${quick.length}`}
                </button>
              )}
            </details>
          )}
          {clusters.length > 0 && (
            // Same disclosure as Quick Add above, so both strips open and close
            // the same way and the browser owns the state for both.
            <details className="cluster-suggestions" open>
              <summary>Playlist Suggestions · {clusters.length}</summary>
              <ul>
                {(showAllClusters ? clusters : clusters.slice(0, QUICK_CARDS)).map((c) => {
                  const name = clusterNames[c.genre] ?? c.genre;
                  return (
                    <li key={c.genre}>
                      <input
                        aria-label={`Name for the new "${c.genre}" playlist`}
                        value={name}
                        onChange={(e) =>
                          setClusterNames((m) => ({ ...m, [c.genre]: e.target.value }))}
                      />
                      <button
                        disabled={creatingGenre === c.genre}
                        onClick={() => void handleCreateCluster(c.genre, name, c.trackIds)}
                      >
                        {creatingGenre === c.genre
                          ? 'Creating…'
                          : `Create with ${c.trackIds.length} songs`}
                      </button>
                    </li>
                  );
                })}
              </ul>
              {/* Same reason as Quick Add's: suggestClusters is uncapped, and a
                  varied library can produce a long list the sketch has no room for. */}
              {clusters.length > QUICK_CARDS && (
                <button className="strip-expand" onClick={() => setShowAllClusters((v) => !v)}>
                  {showAllClusters ? 'show fewer' : `show all ${clusters.length}`}
                </button>
              )}
            </details>
          )}
        </div>
      )}
      {settings.skin !== 'gallery' && (
        <div className="song-cols">
          {([
            ['title', 'Song'], ['artist', 'Artist'], ['year', 'Yr'],
            ['added', 'Date added'], ['match', 'Match'],
          ] as [SortCol, string][]).map(([col, label]) => (
            <button
              key={col}
              type="button"
              className={col === sortCol ? 'col-sort active' : 'col-sort'}
              onClick={() => toggleSort(col)}
            >
              {label}{col === sortCol && (sortDir === 'asc' ? ' ↑' : ' ↓')}
            </button>
          ))}
        </div>
      )}
      <ul className={settings.skin === 'gallery' ? 'song-list gallery' : 'song-list'}>
        {rest.map((t) => renderRow(t))}
      </ul>
      {/* A plain anchor, like .to-top in App.tsx: the browser already scrolls to
          a fragment, and `scroll-behavior: smooth` makes it glide. A scroll
          handler here would buy nothing and cost a listener. */}
      {playingTrack && (
        <a
          className="now-playing"
          href={`#track-${playingTrack.id}`}
          aria-label={`Now playing ${playingTrack.name} — scroll to it`}
        >
          <span className="now-playing-icon" aria-hidden="true">▶</span>
          <span className="now-playing-name">{playingTrack.name}</span>
        </a>
      )}
      {undo && (
        <UndoToast
          message={`${undo.playlistIds.length > 0 ? 'Moved' : 'Removed'} "${undo.track.name}" — heads up: re-liking later resets its added date`}
          onUndo={() => void handleUndo()}
          onDismiss={() => setUndo(null)}
        />
      )}
    </section>
  );
}
