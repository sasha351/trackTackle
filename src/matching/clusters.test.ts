import { expect, it } from 'vitest';
import { suggestClusters } from './clusters';

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
