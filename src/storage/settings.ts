import { DEFAULT_THRESHOLD } from '../matching/engine';

export interface KondoSettings {
  targetPlaylistIds: string[] | null;
  threshold: number;
  sortOrder: 'oldest' | 'newest';
  /** Which list presentation the Sorter renders. loadSettings spreads DEFAULTS
   *  first, so a blob written before this field existed picks up 'table'
   *  without a key bump.
   *
   *  Optional on purpose: ~35 test call sites build a KondoSettings literal by
   *  hand, and a required field would fail `tsc -b` in all of them for a value
   *  every read site already treats as "anything but 'gallery' means table". */
  skin?: 'table' | 'gallery';
}

const KEY = 'kondo:settings:v1';

const DEFAULTS: KondoSettings = {
  targetPlaylistIds: null,
  threshold: DEFAULT_THRESHOLD,
  sortOrder: 'oldest',
  skin: 'table',
};

export function loadSettings(): KondoSettings {
  const raw = localStorage.getItem(KEY);
  return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<KondoSettings>) } : { ...DEFAULTS };
}

export function saveSettings(s: KondoSettings): void {
  localStorage.setItem(KEY, JSON.stringify(s));
}
