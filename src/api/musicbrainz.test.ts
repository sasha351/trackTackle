import { afterEach, expect, it, vi } from 'vitest';
import { lookupArtistGenres } from './musicbrainz';

afterEach(() => vi.restoreAllMocks());

const json = (body: object) => new Response(JSON.stringify(body), { status: 200 });

it('searches then fetches genres for a confident match', async () => {
  const spy = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(json({ artists: [{ id: 'mbid-1', score: 100 }] }))
    .mockResolvedValueOnce(json({
      genres: [
        { name: 'Downtempo', count: 5 },
        { name: 'trip hop', count: 9 },
        { name: 'zero votes', count: 0 },
      ],
    }));
  const genres = await lookupArtistGenres('Portishead');
  expect(genres).toEqual(['trip hop', 'downtempo']); // sorted by count, lowercased, count>0 only
  expect(String(spy.mock.calls[0][0])).toContain('/ws/2/artist?query=');
  expect(String(spy.mock.calls[1][0])).toContain('/ws/2/artist/mbid-1?inc=genres');
});

it('returns [] when the top hit is not confident', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
    json({ artists: [{ id: 'mbid-2', score: 60 }] }),
  );
  expect(await lookupArtistGenres('Some Obscure Name')).toEqual([]);
});

it('spaces consecutive requests by at least 1.1s', async () => {
  vi.useFakeTimers();
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(json({ artists: [] })));
  const t0 = Date.now();
  let done1 = 0;
  let done2 = 0;
  lookupArtistGenres('A').then(() => { done1 = Date.now() - t0; });
  lookupArtistGenres('B').then(() => { done2 = Date.now() - t0; });
  await vi.runAllTimersAsync();
  expect(done2 - done1).toBeGreaterThanOrEqual(1100);
  vi.useRealTimers();
});
