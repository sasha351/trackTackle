import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { artistTopTags, genresFromLastFmTags, LastFmError, resetLastFmForTests } from './lastfm';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => resetLastFmForTests());
afterEach(() => vi.restoreAllMocks());

it('falls back from an unknown MBID to the name, and normalizes a single-object tag', async () => {
  const calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('mbid=')) return json({ error: 6, message: 'The artist you supplied could not be found' });
    return json({ toptags: { tag: { name: 'Bedroom Pop', count: 100 }, '@attr': { artist: 'Fai Laci' } } });
  });
  const r = await artistTopTags({ name: 'Fai Laci', mbid: 'm1' }, 'k');
  expect(r).toEqual({ by: 'name', matchedName: 'Fai Laci', tags: [{ name: 'bedroom pop', count: 100 }] });
  expect(calls).toHaveLength(2);
  expect(calls[1]).toContain('artist=Fai+Laci');
  expect(calls[1]).toContain('autocorrect=1');
});

it('returns null for not-found and for a known artist with no tags', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ error: 6, message: 'nope' }));
  expect(await artistTopTags({ name: 'X' }, 'k')).toBeNull();
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ toptags: { tag: [], '@attr': { artist: 'X' } } }));
  expect(await artistTopTags({ name: 'X' }, 'k')).toBeNull();
});

it('throws LastFmError for a real failure (bad key)', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ error: 10, message: 'Invalid API key' }, 403));
  await expect(artistTopTags({ name: 'X' }, 'bad')).rejects.toBeInstanceOf(LastFmError);
});

it('genresFromLastFmTags whitelists, drops weak tags, keeps the top 3', () => {
  const tags = [
    { name: 'seen live', count: 100 }, { name: 'indie pop', count: 90 }, { name: 'soul', count: 40 },
    { name: 'jazz', count: 30 }, { name: 'rnb', count: 20 }, { name: 'funk', count: 5 },
  ];
  const wl = new Set(['indie pop', 'soul', 'jazz', 'rnb', 'funk']);
  expect(genresFromLastFmTags(tags, wl)).toEqual(['indie pop', 'soul', 'jazz']);
  expect(genresFromLastFmTags([{ name: 'funk', count: 5 }], wl)).toEqual([]);
});
