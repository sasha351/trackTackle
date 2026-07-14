import { afterEach, expect, it } from 'vitest';
import { getRemovalLog, logRemoval, removeFromLog } from './removalLog';

afterEach(() => localStorage.clear());

const entry = {
  trackId: 't1', name: 'Glory Box', artists: 'Portishead',
  addedAt: '2024-01-01T00:00:00Z', removedAt: '2026-07-14T00:00:00Z', playlistIds: ['p1'],
};

it('appends and reads entries', () => {
  logRemoval(entry);
  logRemoval({ ...entry, trackId: 't2' });
  expect(getRemovalLog()).toHaveLength(2);
  expect(getRemovalLog()[0]).toEqual(entry);
});

it('removes an entry on undo', () => {
  logRemoval(entry);
  removeFromLog('t1', entry.removedAt);
  expect(getRemovalLog()).toEqual([]);
});
