import { afterEach, expect, it } from 'vitest';
import { loadSettings, saveSettings } from './settings';
import { DEFAULT_THRESHOLD } from '../matching/engine';

afterEach(() => localStorage.clear());

it('returns defaults when nothing is stored', () => {
  expect(loadSettings()).toEqual({
    targetPlaylistIds: null, threshold: DEFAULT_THRESHOLD, sortOrder: 'oldest',
  });
});

it('round-trips saved settings', () => {
  saveSettings({ targetPlaylistIds: ['p1'], threshold: 0.5, sortOrder: 'newest' });
  expect(loadSettings()).toEqual({ targetPlaylistIds: ['p1'], threshold: 0.5, sortOrder: 'newest' });
});
