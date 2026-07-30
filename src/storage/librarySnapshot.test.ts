import { afterEach, expect, it, vi } from 'vitest';
import {
  clearSnapshot, compactPlaylists, isFresh, readSnapshot, resetSnapshotForTests,
  SNAPSHOT_TTL_MS, updateSnapshotTracks, writeSnapshot,
} from './librarySnapshot';
import { buildFingerprint, langSignals } from '../matching/engine';
import type { PlaylistTrack, Track } from '../types';

afterEach(() => {
  localStorage.clear();
  resetSnapshotForTests();
  vi.restoreAllMocks();
});

const track: Track = {
  id: 't1', uri: 'spotify:track:t1', name: 'Glory Box',
  artists: [{ id: 'a1', name: 'Portishead' }],
  albumName: 'Dummy', releaseYear: 1994, isrc: 'GBAAA9400001', addedAt: '2024-01-01T00:00:00Z',
};

const playlistTracks: PlaylistTrack[] = [
  { id: 'pt1', name: 'Angel', artists: [{ id: 'a2', name: 'Massive Attack' }], releaseYear: 1998, isrc: 'GBAAA9800001' },
  { id: 'pt2', name: 'Teardrop', artists: [{ id: 'a2', name: 'Massive Attack' }], releaseYear: 1998, isrc: null },
];

it('round-trips a snapshot through localStorage', () => {
  writeSnapshot({ tracks: [track], playlists: [{ id: 'p1', name: 'Trip', trackCount: 2 }] });
  const got = readSnapshot();
  expect(got?.tracks).toEqual([track]);
  expect(got?.playlists[0].name).toBe('Trip');
  expect(got?.items).toEqual({});
});

it('merges patches instead of replacing the whole snapshot', () => {
  writeSnapshot({ tracks: [track] });
  writeSnapshot({ playlists: [{ id: 'p1', name: 'Trip', trackCount: 2 }] });
  expect(readSnapshot()?.tracks).toEqual([track]); // survived the second write
});

// The whole point of CompactItem: it must carry exactly the signal
// buildFingerprint reads, so a cached rebuild is indistinguishable from a
// fetched one. If this drifts, matching silently degrades on warm loads.
it('rebuilds an identical fingerprint from compact items', () => {
  const { items } = compactPlaylists(new Map([['p1', playlistTracks]]));
  const genres = new Map([['a2', ['trip hop']]]);

  const fromRaw = buildFingerprint(playlistTracks.map((pt) => ({
    genres: genres.get(pt.artists[0].id) ?? [],
    releaseYear: pt.releaseYear,
    ...langSignals(pt.name, pt.artists, pt.isrc),
  })));
  const fromCache = buildFingerprint(items.p1.map((it) => ({
    genres: [...new Set(it.a.flatMap((id) => genres.get(id) ?? []))],
    releaseYear: it.y, script: it.s, country: it.c,
  })));

  expect(fromCache).toEqual(fromRaw);
});

// Track ids are the one thing here buildFingerprint never reads — they exist
// solely so the duplicate guard can answer from cache instead of refetching.
it('keeps track ids so the duplicate guard can work from cache', () => {
  const { items } = compactPlaylists(new Map([['p1', playlistTracks]]));
  expect(items.p1.map((it) => it.i)).toEqual(['pt1', 'pt2']);
});

it('collects deduped artist names so a deep MusicBrainz run still has them', () => {
  const { artistNames } = compactPlaylists(new Map([['p1', playlistTracks]]));
  expect(artistNames).toEqual({ a2: 'Massive Attack' });
});

it('treats a snapshot older than the TTL as stale', () => {
  writeSnapshot({ tracks: [track] });
  const snap = readSnapshot()!;
  expect(isFresh(snap)).toBe(true);
  expect(isFresh(snap, Date.now() + SNAPSHOT_TTL_MS + 1)).toBe(false);
  expect(isFresh(null)).toBe(false);
});

it('writes through a track removal without resetting the freshness clock', () => {
  writeSnapshot({ tracks: [track] });
  const savedAt = readSnapshot()!.savedAt;
  updateSnapshotTracks((ts) => ts.filter((t) => t.id !== 't1'));
  expect(readSnapshot()?.tracks).toEqual([]);
  // A mutation is not a refresh — bumping savedAt here would let steady
  // sorting postpone a real refetch forever.
  expect(readSnapshot()?.savedAt).toBe(savedAt);
});

it('drops the bulky items on a quota error rather than losing the whole snapshot', () => {
  const real = localStorage.setItem.bind(localStorage);
  let calls = 0;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation((k: string, v: string) => {
    calls += 1;
    if (calls === 1) throw new DOMException('full', 'QuotaExceededError');
    real(k, v);
  });

  const { items, artistNames } = compactPlaylists(new Map([['p1', playlistTracks]]));
  expect(() => writeSnapshot({ tracks: [track], items, artistNames })).not.toThrow();
  expect(readSnapshot()?.tracks).toEqual([track]); // the useful half survived
  expect(readSnapshot()?.items).toEqual({});
});

it('disables itself when even the trimmed snapshot will not fit', () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('full', 'QuotaExceededError');
  });
  expect(() => writeSnapshot({ tracks: [track] })).not.toThrow();
  expect(readSnapshot()).toBeNull();
});

it('does not renew the freshness clock when only the trimmed snapshot fits', () => {
  writeSnapshot({ tracks: [track] });
  const firstSavedAt = readSnapshot()!.savedAt;

  // A later load, an hour on.
  vi.spyOn(Date, 'now').mockReturnValue(firstSavedAt + 3_600_000);

  const real = localStorage.setItem.bind(localStorage);
  let calls = 0;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation((k: string, v: string) => {
    calls += 1;
    if (calls === 1) throw new DOMException('full', 'QuotaExceededError');
    real(k, v);
  });

  const { items, artistNames } = compactPlaylists(new Map([['p1', playlistTracks]]));
  writeSnapshot({ tracks: [track], items, artistNames });

  // The write dropped the items it was asked to store, so it has not earned a
  // fresh stamp. Bumping savedAt here re-pins tracks/playlists for another TTL
  // on *every* load of a library this size — they would never age out at all.
  expect(readSnapshot()!.savedAt).toBe(firstSavedAt);
  expect(readSnapshot()!.items).toEqual({});
});

it('clearSnapshot removes it', () => {
  writeSnapshot({ tracks: [track] });
  clearSnapshot();
  expect(readSnapshot()).toBeNull();
});

it('reports a non-quota write failure as itself and keeps snapshotting enabled', () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const real = localStorage.setItem.bind(localStorage);
  let failNext = true;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation((k: string, v: string) => {
    if (failNext) {
      failNext = false;
      throw new TypeError('Converting circular structure to JSON');
    }
    real(k, v);
  });

  expect(() => writeSnapshot({ tracks: [track] })).not.toThrow();
  // Reported as what it is, not as a full disk.
  expect(error).toHaveBeenCalled();
  expect(warn).not.toHaveBeenCalled();

  // Not disabled: the very next write must still land.
  writeSnapshot({ playlists: [{ id: 'p1', name: 'Trip', trackCount: 2 }] });
  expect(readSnapshot()?.playlists[0].name).toBe('Trip');
});
