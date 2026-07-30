import { afterEach, expect, it } from 'vitest';
import { loadSettings, saveSettings } from './settings';
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

it('gives a settings blob written before the skin existed the default', () => {
  localStorage.setItem('kondo:settings:v1', JSON.stringify({ threshold: 0.4 }));
  expect(loadSettings().skin).toBe('table');
});
