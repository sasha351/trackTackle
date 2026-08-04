import { afterEach, expect, it } from 'vitest';
import { loadSettings, saveSettings, targetedPlaylists } from './settings';
import { DEFAULT_THRESHOLD } from '../matching/engine';

afterEach(() => localStorage.clear());

it('returns defaults when nothing is stored', () => {
  expect(loadSettings()).toEqual({
    targetPlaylistIds: null, threshold: DEFAULT_THRESHOLD, sortOrder: 'oldest', skin: 'table',
  });
});

it('round-trips saved settings', () => {
  saveSettings({ targetPlaylistIds: ['p1'], threshold: 0.5, sortOrder: 'newest', skin: 'gallery' });
  expect(loadSettings()).toEqual({
    targetPlaylistIds: ['p1'], threshold: 0.5, sortOrder: 'newest', skin: 'gallery',
  });
});

it('defaults the skin to the table and round-trips a change', () => {
  expect(loadSettings().skin).toBe('table');
  saveSettings({ ...loadSettings(), skin: 'gallery' });
  expect(loadSettings().skin).toBe('gallery');
});

it('targets a playlist created after the user last edited the selection', () => {
  const base = { targetPlaylistIds: null, threshold: 0.3, sortOrder: 'oldest' as const };
  const ps = [{ id: 'old' }, { id: 'unwanted' }, { id: 'brand-new' }];
  // The user unchecked one playlist back when only old/unwanted existed.
  expect(targetedPlaylists(ps, { ...base, excludedPlaylistIds: ['unwanted'] }))
    .toEqual([{ id: 'old' }, { id: 'brand-new' }]);
  // The legacy allowlist is the bug this replaced: it drops the newcomer.
  expect(targetedPlaylists(ps, { ...base, targetPlaylistIds: ['old'] })).toEqual([{ id: 'old' }]);
  expect(targetedPlaylists(ps, base)).toEqual(ps);
});

it('gives a settings blob written before the skin existed the default', () => {
  localStorage.setItem('kondo:settings:v1', JSON.stringify({ threshold: 0.4 }));
  expect(loadSettings().skin).toBe('table');
});
