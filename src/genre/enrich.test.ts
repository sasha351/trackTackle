import { beforeEach, expect, it, vi } from 'vitest';
import * as lb from '../api/listenbrainz';
import * as mb from '../api/musicbrainz';
import * as lfm from '../api/lastfm';
import { enrichEmptyArtists } from './enrich';

vi.mock('../api/musicbrainz', () => ({
  lookupIsrcs: vi.fn(), releaseGroupGenres: vi.fn(), artistTagSummaries: vi.fn(), genreWhitelist: vi.fn(),
}));
vi.mock('../api/lastfm', async () => {
  const actual = await vi.importActual<typeof import('../api/lastfm')>('../api/lastfm');
  return { ...actual, artistTopTags: vi.fn() };
});
vi.mock('../api/listenbrainz', async () => {
  const actual = await vi.importActual<typeof import('../api/listenbrainz')>('../api/listenbrainz');
  return { ...actual, similarArtists: vi.fn() };
});

const rec = (over: Partial<mb.IsrcRecording> = {}): mb.IsrcRecording => ({
  recordingId: 'r', genres: [], releaseGroupIds: [], artistMbids: [], ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(mb.lookupIsrcs).mockResolvedValue({ byIsrc: new Map(), failed: new Set(), unattributed: 0 });
  vi.mocked(mb.releaseGroupGenres).mockResolvedValue({ byId: new Map(), failed: new Set() });
  vi.mocked(mb.artistTagSummaries).mockResolvedValue(new Map());
  vi.mocked(lb.similarArtists).mockResolvedValue([]);
  vi.mocked(mb.genreWhitelist).mockResolvedValue(new Set(['hip hop', 'jazz', 'indie pop']));
  vi.mocked(lfm.artistTopTags).mockResolvedValue(null);
});

it('takes album tags by ISRC, and recovers an MBID from a solo credit for the neighbour phase', async () => {
  vi.mocked(mb.lookupIsrcs).mockResolvedValue({
    byIsrc: new Map([['ISRC1', [rec({ releaseGroupIds: ['rg1'], artistMbids: ['m1'] })]]]),
    failed: new Set(), unattributed: 0,
  });
  vi.mocked(mb.releaseGroupGenres).mockResolvedValue({ byId: new Map([['rg1', ['punk', 'rock']]]), failed: new Set() });

  const out = await enrichEmptyArtists(['a1'], new Map([['a1', [{ isrc: 'isrc1', solo: true }]]]), new Map());
  expect(out.found.get('a1')).toEqual({ genres: ['punk', 'rock'], source: 'recordings' });
  expect(lb.similarArtists).not.toHaveBeenCalled(); // already rescued
});

it("ignores a recording whose credits don't include the artist's known MBID", async () => {
  vi.mocked(mb.lookupIsrcs).mockResolvedValue({
    byIsrc: new Map([['ISRC1', [rec({ genres: ['polka'], artistMbids: ['someone-else'] })]]]),
    failed: new Set(), unattributed: 0,
  });
  const out = await enrichEmptyArtists(['a1'], new Map([['a1', [{ isrc: 'ISRC1', solo: true }]]]), new Map([['a1', 'm1']]));
  expect(out.found.get('a1')?.source).not.toBe('recordings');
});

it('borrows neighbour genres for an artist with an MBID and no recording tags', async () => {
  vi.mocked(lb.similarArtists).mockResolvedValue([
    { mbid: 'n1', name: 'N1', score: 2 }, { mbid: 'n2', name: 'N2', score: 1 },
  ]);
  vi.mocked(mb.artistTagSummaries).mockResolvedValue(new Map([
    ['n1', { rawTags: [], genres: ['soul', 'funk'] }],
    ['n2', { rawTags: [], genres: ['soul'] }],
  ]));
  const out = await enrichEmptyArtists(['a1'], new Map(), new Map([['a1', 'm1']]));
  expect(lb.similarArtists).toHaveBeenCalledWith('m1');
  expect(out.found.get('a1')).toEqual({ genres: ['soul'], source: 'neighbours' });
});

it('reports request failures so the caller does not cache a durable none', async () => {
  vi.mocked(mb.lookupIsrcs).mockResolvedValue({ byIsrc: new Map(), failed: new Set(['ISRC1']), unattributed: 0 });
  vi.mocked(lb.similarArtists).mockRejectedValue(new Error('CORS'));
  const out = await enrichEmptyArtists(
    ['a1', 'a2', 'a3'],
    new Map([['a1', [{ isrc: 'ISRC1', solo: true }]]]),
    new Map([['a2', 'm2']]),
  );
  expect([...out.failed].sort()).toEqual(['a1', 'a2']);
  expect(out.found.size).toBe(0); // a3: no ISRC, no MBID — answered "nothing", durably
});

it('asks Last.fm last, by MBID and name, normalizing hyphenated tags', async () => {
  vi.mocked(lfm.artistTopTags).mockImplementation(async ({ name }) => (name === 'WHO SHOT SCOTT'
    ? { by: 'name', matchedName: name, tags: [{ name: 'rap', count: 100 }, { name: 'hip-hop', count: 100 }, { name: 'iraqi', count: 8 }] }
    : null));
  const out = await enrichEmptyArtists(
    ['a1', 'a2'], new Map(), new Map([['a2', 'm2']]), undefined,
    { names: new Map([['a1', 'WHO SHOT SCOTT'], ['a2', 'Nobody']]), lastFmKey: 'k' },
  );
  expect(out.found.get('a1')).toEqual({ genres: ['hip hop'], source: 'lastfm' });
  expect(lfm.artistTopTags).toHaveBeenCalledWith({ name: 'Nobody', mbid: 'm2' }, 'k');
  expect(out.failed.size).toBe(0); // a2: Last.fm answered "nothing" — durable
});

it('skips Last.fm without a key', async () => {
  await enrichEmptyArtists(['a1'], new Map(), new Map(), undefined, { names: new Map([['a1', 'X']]) });
  expect(lfm.artistTopTags).not.toHaveBeenCalled();
});

it('leaves Last.fm artists retryable when the genre whitelist is unavailable', async () => {
  vi.mocked(mb.genreWhitelist).mockResolvedValue(new Set());
  const out = await enrichEmptyArtists(['a1'], new Map(), new Map(), undefined, { names: new Map([['a1', 'X']]), lastFmKey: 'k' });
  expect(lfm.artistTopTags).not.toHaveBeenCalled();
  expect([...out.failed]).toEqual(['a1']);
});

it('stops at the first fatal Last.fm error and marks the rest retryable', async () => {
  vi.mocked(lfm.artistTopTags).mockRejectedValue(new lfm.LastFmError(10, 'Invalid API key'));
  const names = new Map([['a1', 'A'], ['a2', 'B'], ['a3', 'C']]);
  const out = await enrichEmptyArtists(['a1', 'a2', 'a3'], new Map(), new Map(), undefined, { names, lastFmKey: 'bad' });
  expect(lfm.artistTopTags).toHaveBeenCalledTimes(1);
  expect([...out.failed].sort()).toEqual(['a1', 'a2', 'a3']);
});

it('keeps going past a non-fatal Last.fm error', async () => {
  vi.mocked(lfm.artistTopTags)
    .mockRejectedValueOnce(new lfm.LastFmError(8, 'Operation failed'))
    .mockResolvedValueOnce({ by: 'name', matchedName: 'B', tags: [{ name: 'jazz', count: 100 }] });
  const names = new Map([['a1', 'A'], ['a2', 'B']]);
  const out = await enrichEmptyArtists(['a1', 'a2'], new Map(), new Map(), undefined, { names, lastFmKey: 'k' });
  expect([...out.failed]).toEqual(['a1']);
  expect(out.found.get('a2')).toEqual({ genres: ['jazz'], source: 'lastfm' });
});
