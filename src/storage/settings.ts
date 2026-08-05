import { DEFAULT_THRESHOLD } from '../matching/engine';

export interface AppSettings {
  /** Legacy allowlist. Migrated to `excludedPlaylistIds` by Workspace as soon
   *  as the playlist roster loads, then left null forever. Only still read so
   *  a stored blob written before the migration filters correctly on the one
   *  render before it runs. */
  targetPlaylistIds: string[] | null;
  /** Playlists the sorter must ignore. Stored as the complement of the
   *  selection on purpose: an allowlist froze the roster at the moment the
   *  user first unchecked something, so every playlist created afterwards was
   *  silently invisible in the Sorter and the Analyzer. Optional — absent
   *  means nothing is excluded, which is also what a fresh install wants. */
  excludedPlaylistIds?: string[];
  threshold: number;
  sortOrder: 'oldest' | 'newest';
  /** Which list presentation the Sorter renders. loadSettings spreads DEFAULTS
   *  first, so a blob written before this field existed picks up 'table'
   *  without a key bump.
   *
   *  Optional on purpose: ~35 test call sites build an AppSettings literal by
   *  hand, and a required field would fail `tsc -b` in all of them for a value
   *  every read site already treats as "anything but 'gallery' means table". */
  skin?: 'table' | 'gallery';
}

const KEY = 'tracktackle:settings:v1';

const DEFAULTS: AppSettings = {
  targetPlaylistIds: null,
  threshold: DEFAULT_THRESHOLD,
  sortOrder: 'oldest',
  skin: 'table',
};

export function loadSettings(): AppSettings {
  const raw = localStorage.getItem(KEY);
  return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<AppSettings>) } : { ...DEFAULTS };
}

export function saveSettings(s: AppSettings): void {
  localStorage.setItem(KEY, JSON.stringify(s));
}

/** The playlists the sorter may file into. New playlists are targeted by
 *  default — that's the whole reason the exclusion list, not a selection list,
 *  is what gets stored. */
export function targetedPlaylists<T extends { id: string }>(ps: T[], s: AppSettings): T[] {
  const legacy = s.targetPlaylistIds;
  if (legacy) return ps.filter((p) => legacy.includes(p.id));
  const excluded = s.excludedPlaylistIds;
  return excluded?.length ? ps.filter((p) => !excluded.includes(p.id)) : ps;
}
