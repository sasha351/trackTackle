import { expect, it } from 'vitest';
import { suggestClusters } from './clusters';
import { buildFingerprint } from './engine';

function fp(genres: string[]) {
  return buildFingerprint(genres.map((g) => ({ genres: [g], releaseYear: null })));
}

it('greedily clusters no-fit songs by their most common shared genre', () => {
  const songs = [
    { trackId: 't1', genres: ['downtempo', 'chill'] },
    { trackId: 't2', genres: ['downtempo'] },
    { trackId: 't3', genres: ['downtempo', 'idm'] },
    { trackId: 't4', genres: ['idm'] },
    { trackId: 't5', genres: [] },
  ];
  const clusters = suggestClusters(songs, 3);
  expect(clusters).toEqual([{ genre: 'downtempo', trackIds: ['t1', 't2', 't3'] }]);
  // t4's idm group only has size 1 after downtempo claimed t3 → below minSize.
});

it('returns [] when nothing reaches minSize', () => {
  expect(suggestClusters([{ trackId: 't1', genres: ['x'] }], 5)).toEqual([]);
});

it('skips a genre already covered by an existing playlist, falling through to a narrower one', () => {
  const songs = [
    { trackId: 't1', genres: ['pop', 'hyperpop'] },
    { trackId: 't2', genres: ['pop', 'hyperpop'] },
    { trackId: 't3', genres: ['pop', 'hyperpop'] },
    { trackId: 't4', genres: ['pop'] },
    { trackId: 't5', genres: ['pop'] },
  ];
  // 4/4 pop = 80% coverage on an existing "pop" playlist.
  const fingerprints = new Map([['existing-pop', fp(['pop', 'pop', 'pop', 'pop'])]]);
  const clusters = suggestClusters(songs, 3, fingerprints);
  expect(clusters).toEqual([{ genre: 'hyperpop', trackIds: ['t1', 't2', 't3'] }]);
});

it('does not let a 2-track playlist veto a genre it barely touches', () => {
  const songs = [
    { trackId: 't1', genres: ['pop'] },
    { trackId: 't2', genres: ['pop'] },
    { trackId: 't3', genres: ['pop'] },
  ];
  const fingerprints = new Map([['tiny', fp(['pop', 'jazz'])]]);
  const clusters = suggestClusters(songs, 3, fingerprints);
  expect(clusters).toEqual([{ genre: 'pop', trackIds: ['t1', 't2', 't3'] }]);
});

it('reproduces today\'s biggest-bucket behavior when no fingerprints are given', () => {
  const songs = [
    { trackId: 't1', genres: ['pop'] },
    { trackId: 't2', genres: ['pop'] },
    { trackId: 't3', genres: ['pop'] },
  ];
  expect(suggestClusters(songs, 3)).toEqual([{ genre: 'pop', trackIds: ['t1', 't2', 't3'] }]);
});
