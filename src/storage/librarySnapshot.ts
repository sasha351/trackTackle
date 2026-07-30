import { langSignals } from '../matching/engine';
import type { Playlist, PlaylistTrack, Track } from '../types';

const KEY = 'kondo:library:v1';

/** Serve the cached library for this long before refetching. Long enough that
 *  a session's worth of reloads costs nothing; short enough that edits made in
 *  the Spotify app show up the same day. */
export const SNAPSHOT_TTL_MS = 6 * 60 * 60 * 1000;

/** Exactly what buildFingerprint consumes, and nothing else. A playlist item's
 *  track name and ISRC exist only as langSignals input, so we store the derived
 *  script/country instead — lossless for the sole consumer, several times
 *  smaller. Genres come from artist ids via kondo:genres:v3. Saved tracks are
 *  NOT compacted: those get rendered, so they keep every field. */
export interface CompactItem {
  a: string[];      // artist ids
  y: number | null; // release year
  s: string | null; // dominant script
  c: string | null; // ISRC country
  // Track id — the one field here that buildFingerprint does NOT consume. It
  // exists so the duplicate guard can answer "is this song already in that
  // playlist?" without refetching. Optional on purpose: a snapshot written
  // before this field existed simply has none, and the guard goes quiet until
  // the TTL rolls. Bumping the key instead would force every user into a full
  // playlist refetch just to enable a warning.
  i?: string;
}

export interface LibrarySnapshot {
  savedAt: number;
  tracks: Track[];
  playlists: Playlist[];
  artistNames: Record<string, string>;
  items: Record<string, CompactItem[]>;
}

const EMPTY: LibrarySnapshot = {
  savedAt: 0, tracks: [], playlists: [], artistNames: {}, items: {},
};

// Set once localStorage proves it cannot hold even a trimmed snapshot. Trying
// again on every load would just burn a serialize-and-throw per phase.
let disabled = false;

export function resetSnapshotForTests(): void {
  disabled = false;
}

export function compactPlaylists(
  byPlaylist: Map<string, PlaylistTrack[]>,
): { items: Record<string, CompactItem[]>; artistNames: Record<string, string> } {
  const items: Record<string, CompactItem[]> = {};
  // Artists repeat heavily across playlists — deduping them here instead of
  // inlining names per item is most of this cache's size win.
  const artistNames: Record<string, string> = {};
  for (const [playlistId, pts] of byPlaylist) {
    items[playlistId] = pts.map((pt) => {
      for (const a of pt.artists) artistNames[a.id] = a.name;
      const { script, country } = langSignals(pt.artists, pt.name, pt.isrc);
      return { a: pt.artists.map((a) => a.id), y: pt.releaseYear, s: script, c: country, i: pt.id };
    });
  }
  return { items, artistNames };
}

export function readSnapshot(): LibrarySnapshot | null {
  const raw = localStorage.getItem(KEY);
  if (!raw) return null;
  try {
    return { ...EMPTY, ...(JSON.parse(raw) as Partial<LibrarySnapshot>) };
  } catch {
    // Corrupt or half-written — a bad cache must never wedge the app.
    localStorage.removeItem(KEY);
    return null;
  }
}

export function isFresh(s: LibrarySnapshot | null, now = Date.now()): boolean {
  return s != null && now - s.savedAt < SNAPSHOT_TTL_MS;
}

/** Storage-full, across browsers. Checked by name rather than
 *  `instanceof DOMException`: Firefox raises NS_ERROR_DOM_QUOTA_REACHED, and
 *  some environments throw a plain Error carrying the standard name. */
function isQuotaError(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name;
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED';
}

function persist(s: LibrarySnapshot): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch (e) {
    // Anything that isn't a full disk gets reported as itself and left alone.
    // The trim-and-disable ladder below only makes sense for a size problem: a
    // serialization bug would throw again on the trimmed payload, and killing
    // snapshotting for the whole session over one bad write is a far worse
    // outcome than one lost write.
    if (!isQuotaError(e)) {
      console.error('kondo: library snapshot write failed', e);
      return;
    }
    try {
      // `items` and `artistNames` are the bulk. Dropping them still leaves the
      // song list loading for free; only fingerprints have to be refetched.
      //
      // savedAt is deliberately NOT advanced: this write stored less than it
      // was asked to, so it has not earned a fresh stamp. On a library big
      // enough to hit quota this branch runs on every single load, and bumping
      // savedAt each time would pin tracks/playlists inside the TTL forever —
      // the snapshot would only ever refresh via a manual Refresh click.
      // `?? 0` (no prior snapshot) means "serve it as a fallback, never as
      // fresh", which is exactly right for data we could not fully store.
      const savedAt = readSnapshot()?.savedAt ?? 0;
      localStorage.setItem(
        KEY,
        JSON.stringify({ ...s, items: {}, artistNames: {}, savedAt }),
      );
    } catch {
      disabled = true;
      localStorage.removeItem(KEY);
      console.warn('kondo: library snapshot disabled — localStorage is full');
    }
  }
}

/** Merge a patch into the stored snapshot and stamp it fresh. Called once per
 *  load phase, after that phase's fetch succeeded, so an interrupted load never
 *  persists a half-built snapshot. */
export function writeSnapshot(patch: Partial<LibrarySnapshot>): void {
  if (disabled) return;
  persist({ ...EMPTY, ...(readSnapshot() ?? {}), ...patch, savedAt: Date.now() });
}

/** Write-through for local mutations. Without this, a reload inside the TTL
 *  resurrects every song you just sorted — the one way this cache can be
 *  actively wrong rather than merely stale. */
export function updateSnapshotTracks(fn: (tracks: Track[]) => Track[]): void {
  if (disabled) return;
  const s = readSnapshot();
  if (!s) return;
  persist({ ...s, tracks: fn(s.tracks) }); // savedAt kept: a mutation is not a refresh
}

export function clearSnapshot(): void {
  localStorage.removeItem(KEY);
}
