import { afterEach, expect, it, vi } from 'vitest';
import { genresFromNeighbours, ListenBrainzError, similarArtists } from './listenbrainz';

afterEach(() => vi.restoreAllMocks());

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

it('parses a flat neighbour list, drops the queried artist and duplicates, sorts by score', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(json([
    { artist_mbid: 'b', name: 'B', score: 10 },
    { artist_mbid: 'self', name: 'Self', score: 99 },
    { artist_mbid: 'c', name: 'C', score: 50 },
    { artist_mbid: 'b', name: 'B again', score: 5 },
  ]));
  const out = await similarArtists('self');
  expect(out.map((a) => a.mbid)).toEqual(['c', 'b']);
});

it('finds neighbours inside a labs dataset envelope', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(json([
    { type: 'markup', data: '<p>hi</p>' },
    { type: 'dataset', data: [{ artist_mbid: 'x', name: 'X', score: 3 }] },
  ]));
  expect((await similarArtists('self')).map((a) => a.name)).toEqual(['X']);
});

it('surfaces a non-OK response as ListenBrainzError with its status', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('bad algorithm', { status: 400 }));
  await expect(similarArtists('self')).rejects.toBeInstanceOf(ListenBrainzError);
});

it('borrows only genres that at least two neighbours agree on', () => {
  const ns = [
    { mbid: 'a', name: 'A', score: 3 },
    { mbid: 'b', name: 'B', score: 2 },
    { mbid: 'c', name: 'C', score: 1 },
  ];
  const tags: Record<string, string[]> = { a: ['shoegaze', 'polka'], b: ['shoegaze', 'dream pop'], c: ['dream pop'] };
  expect(genresFromNeighbours(ns, (m) => tags[m])).toEqual(['shoegaze', 'dream pop']);
});
