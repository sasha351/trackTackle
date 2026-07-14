import { DEFAULT_THRESHOLD } from '../matching/engine';

export interface KondoSettings {
  targetPlaylistIds: string[] | null;
  threshold: number;
  sortOrder: 'oldest' | 'newest';
}

const KEY = 'kondo:settings:v1';

const DEFAULTS: KondoSettings = {
  targetPlaylistIds: null,
  threshold: DEFAULT_THRESHOLD,
  sortOrder: 'oldest',
};

export function loadSettings(): KondoSettings {
  const raw = localStorage.getItem(KEY);
  return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<KondoSettings>) } : { ...DEFAULTS };
}

export function saveSettings(s: KondoSettings): void {
  localStorage.setItem(KEY, JSON.stringify(s));
}
