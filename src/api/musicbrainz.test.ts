import { afterEach, expect, it, vi } from 'vitest';
import { lookupArtistGenres } from './musicbrainz';

afterEach(() => vi.restoreAllMocks());

const json = (body: object) => new Response(JSON.stringify(body), { status: 200 });
const notFound = () => new Response('', { status: 404 });
const artist = (name: string) => ({ id: `sp-${name}`, name });

it('resolves via the Spotify URL relation without touching name search', async () => {
  const spy = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(json({ relations: [{ artist: { id: 'mbid-bravo' } }] }))
    .mockResolvedValueOnce(json({ genres: [{ name: 'Rock', count: 7 }] }));
  // Transliterated Spotify name — name search would miss or mismatch this artist.
  const genres = await lookupArtistGenres(artist('Bravo'));
  expect(genres).toEqual(['rock']);
  expect(String(spy.mock.calls[0][0])).toContain('/ws/2/url?resource=');
  expect(String(spy.mock.calls[0][0])).toContain(encodeURIComponent('spotify.com/artist/sp-Bravo'));
  expect(String(spy.mock.calls[1][0])).toContain('/ws/2/artist/mbid-bravo?inc=genres');
});

it('falls back to name search when MB has no Spotify link, then fetches genres', async () => {
  const spy = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(notFound()) // url lookup: unknown resource
    .mockResolvedValueOnce(json({ artists: [{ id: 'mbid-1', score: 100 }] }))
    .mockResolvedValueOnce(json({
      genres: [
        { name: 'Downtempo', count: 5 },
        { name: 'trip hop', count: 9 },
        { name: 'zero votes', count: 0 },
      ],
    }));
  const genres = await lookupArtistGenres(artist('Portishead'));
  expect(genres).toEqual(['trip hop', 'downtempo']); // sorted by count, lowercased, count>0 only
  expect(String(spy.mock.calls[1][0])).toContain('/ws/2/artist?query=');
  expect(String(spy.mock.calls[2][0])).toContain('/ws/2/artist/mbid-1?inc=genres');
});

it('returns [] when the top search hit is not confident', async () => {
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(notFound())
    .mockResolvedValueOnce(json({ artists: [{ id: 'mbid-2', score: 60 }] }));
  expect(await lookupArtistGenres(artist('Some Obscure Name'))).toEqual([]);
});

it('retries a 503 after Retry-After, then succeeds', async () => {
  vi.useFakeTimers();
  const spy = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response('', { status: 503, headers: { 'Retry-After': '2' } }))
    .mockResolvedValueOnce(json({ relations: [{ artist: { id: 'mbid-3' } }] }))
    .mockResolvedValueOnce(json({ genres: [{ name: 'Jazz', count: 3 }] }));
  const genres = lookupArtistGenres(artist('Alice Coltrane'));
  await vi.runAllTimersAsync();
  await expect(genres).resolves.toEqual(['jazz']);
  expect(spy).toHaveBeenCalledTimes(3); // url lookup retried once, then genres
  vi.useRealTimers();
});

it('gives up on persistent 503 — url lookup exhausts, then search exhausts and throws', async () => {
  vi.useFakeTimers();
  const spy = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response('', { status: 503 }));
  const genres = lookupArtistGenres(artist('Anyone'));
  const assertion = expect(genres).rejects.toThrow('MusicBrainz 503');
  await vi.runAllTimersAsync();
  await assertion;
  expect(spy).toHaveBeenCalledTimes(6); // 3 attempts each for url lookup and search
  vi.useRealTimers();
});

it('spaces consecutive requests by at least 1.1s', async () => {
  vi.useFakeTimers();
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(json({})));
  const t0 = Date.now();
  let done1 = 0;
  let done2 = 0;
  lookupArtistGenres(artist('A')).then(() => { done1 = Date.now() - t0; });
  lookupArtistGenres(artist('B')).then(() => { done2 = Date.now() - t0; });
  await vi.runAllTimersAsync();
  expect(done2 - done1).toBeGreaterThanOrEqual(1100);
  vi.useRealTimers();
});
