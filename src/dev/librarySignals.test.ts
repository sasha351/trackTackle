import { expect, it } from 'vitest';
import { measureLibrarySignals } from './librarySignals';
import type { CompactItem } from '../storage/librarySnapshot';
import type { Track } from '../types';

const track = (id: string, ...artistIds: string[]): Track => ({
  id, uri: `spotify:track:${id}`, name: id, artists: artistIds.map((a) => ({ id: a, name: `N-${a}` })),
  albumName: 'x', releaseYear: 2000, isrc: null, addedAt: '2020-01-01T00:00:00Z',
});
const item = (i: string, ...a: string[]): CompactItem => ({ a, y: 2000, s: 'Latn', c: null, i });

const genres: Record<string, string[]> = {
  t1: ['shoegaze'], t2: ['shoegaze', 'dream pop'], t3: ['shoegaze'], big: ['pop'], feat: ['grime'],
};

function run(untaggedTracks: Track[], items: Record<string, CompactItem[]>, extra: Track[] = []) {
  return measureLibrarySignals({
    tracks: [...untaggedTracks, ...extra],
    untaggedTracks,
    items,
    playlistName: (id) => `P-${id}`,
    lenderGenres: (id) => genres[id],
    artistName: (id) => `N-${id}`,
  }).join('\n');
}

it('A: suggests a playlist holding another song by the artist, not one already holding the song', () => {
  const out = run([track('s1', 'x'), track('s2', 'y')], {
    small: [item('o1', 'x'), item('o2', 't1')],
    // holds s2 itself — y is "already filed", nothing to suggest
    filed: [item('s2', 'y')],
  });
  expect(out).toContain('untagged tracks already in some playlist: 1 / 2');
  expect(out).toContain('untagged tracks that get ≥1 suggestion: 1 / 2');
  expect(out).toContain('N-x – s1 → P-small');
});

it('B: borrows genres ≥2 co-playlisted tagged artists agree on, weighted toward small playlists', () => {
  const big = Array.from({ length: 40 }, (_, k) => item(`b${k}`, 'big'));
  const out = run([track('s1', 'x')], {
    small: [item('o1', 'x'), item('o2', 't1'), item('o3', 't2'), item('o4', 't3')],
    catchall: [item('o5', 'x'), ...big],
  });
  expect(out).toContain('N-x → shoegaze');
  expect(out).not.toMatch(/N-x → .*pop,/); // the lone catch-all artist can't vote pop in alone
  expect(out).toMatch(/artists that would gain genres: 1 \/ 1/);
});

it('C: a tagged co-credit lends its genres; a neighbours-sourced lender would be filtered by the caller', () => {
  const out = run([track('s1', 'x')], { p: [item('o1', 'x', 'feat')] });
  expect(out).toContain('-- C. co-credited tagged artists');
  expect(out).toContain('N-x → grime');
});

it('says so when no playlist items are cached', () => {
  expect(run([track('s1', 'x')], {})).toContain('no cached playlist items');
});
