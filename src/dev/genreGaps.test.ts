import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Track } from '../types';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

const track = (id: string, artistId: string, isrc: string | null): Track => ({
  id, uri: `spotify:track:${id}`, name: id, artists: [{ id: artistId, name: `Name-${artistId}` }],
  albumName: 'x', releaseYear: 2000, isrc, addedAt: '2020-01-01T00:00:00Z',
});

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
});
afterEach(() => vi.restoreAllMocks());

// Three untagged artists, one per bucket the diagnostic exists to tell apart:
//   a1 — Wikidata gives an MBID, MB has no tags, ListenBrainz neighbours do
//   a2 — MB /url gives an MBID, MB tags are all non-genre (whitelist drop)
//   a3 — no MBID anywhere, but its ISRC's album is tagged in MB
function routeFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = decodeURIComponent(String(input));
    if (url.startsWith('https://query.wikidata.org')) {
      return json({ results: { bindings: [{ spotifyId: { value: 'a1' }, mbid: { value: 'm1' } }] } });
    }
    if (url.includes('labs.api.listenbrainz.org')) {
      return json([{ artist_mbid: 'n1', name: 'N1', score: 9 }, { artist_mbid: 'n2', name: 'N2', score: 8 }]);
    }
    if (url.includes('/genre/all')) return new Response('shoegaze\ncity pop', { status: 200 });
    if (url.includes('/url?')) {
      // a2 and a3 both miss Wikidata, so they share one 2-resource chunk.
      return json({ urls: [{ resource: 'https://open.spotify.com/artist/a2', relations: [{ artist: { id: 'm2' } }] }] });
    }
    if (url.includes('/recording?')) {
      return json({ recordings: [{
        id: 'r3', isrcs: ['ISRC3'], 'artist-credit': [{ artist: { id: 'm3' } }],
        releases: [{ 'release-group': { id: 'rg3' } }],
      }] });
    }
    if (url.includes('/release-group?')) return json({ 'release-groups': [{ id: 'rg3', tags: [{ name: 'City Pop', count: 2 }] }] });
    if (url.includes('arid:')) {
      return json({ artists: [
        { id: 'm1', tags: [] },
        { id: 'm2', tags: [{ name: 'seen live', count: 4 }] },
        { id: 'n1', tags: [{ name: 'Shoegaze', count: 3 }] },
        { id: 'n2', tags: [{ name: 'Shoegaze', count: 1 }] },
      ].filter((a) => url.includes(a.id)) });
    }
    throw new Error(`unrouted ${url}`);
  });
}

it('buckets untagged artists by cause and measures both candidate fixes', async () => {
  routeFetch();
  const { runGenreGapDiagnostic } = await import('./genreGaps');
  const tracks = [track('t1', 'a1', 'ISRC1'), track('t2', 'a2', null), track('t3', 'a3', 'ISRC3'), track('t4', 'a4', null)];
  const genresByTrack = new Map([['t4', ['rock']]]);

  vi.useFakeTimers();
  const p = runGenreGapDiagnostic(tracks, genresByTrack);
  await vi.runAllTimersAsync();
  const out = (await p).join('\n');
  vi.useRealTimers();

  expect(out).toContain('tracks with no genres: 3 / 4');
  expect(out).toContain('missing 3');
  expect(out).toMatch(/no MBID anywhere: +1 \/ 3/);
  expect(out).toMatch(/MBID, MB has no tags: +1 \/ 3/);
  expect(out).toMatch(/MBID, tags all non-genre: +1 \/ 3/);
  expect(out).toContain('dropped: Name-a2 → seen live');
  // option 3: a3 rescued via its album, and its MBID recovered from the credit
  expect(out).toContain('Name-a3 → city pop');
  expect(out).toContain('MBIDs recovered from recording credits (no-MBID artists): 1 / 1');
  // option 2: a1 and a2 both have MBIDs and get the same two shoegaze neighbours
  expect(out).toContain('would gain genres (≥2 of top 10 agree): 2 / 2');
  expect(out).toContain('Name-a1 → shoegaze   (like: N1, N2)');
});
