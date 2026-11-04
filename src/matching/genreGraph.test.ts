import { buildFingerprint, explainScore, matchSong } from './engine';
import { buildGenreContext } from './genreGraph';

const songs = (n: number, genres: string[], releaseYear: number | null = 2010) =>
  Array.from({ length: n }, () => ({ genres, releaseYear }));

// A small library: pop is everywhere, shoegaze/dream pop travel together.
const LIBRARY: string[][] = [
  ['pop', 'dance pop'], ['pop'], ['pop', 'electropop'], ['pop', 'dance pop'], ['pop'],
  ['pop', 'synthwave'], ['pop'], ['pop', 'dance pop'],
  ['shoegaze', 'dream pop'], ['shoegaze', 'dream pop', 'noise pop'], ['dream pop'],
  ['synthwave'], ['uk drill'], ['drill'],
];

it('IDF ranks a library-common genre below a rare one', () => {
  const ctx = buildGenreContext(LIBRARY);
  expect(ctx.idf.get('pop')!).toBeLessThan(ctx.idf.get('shoegaze')!);
  expect(ctx.defaultIdf).toBeGreaterThan(ctx.idf.get('shoegaze')!);
});

it('links genres that co-occur on ≥2 artists, and not on one', () => {
  const ctx = buildGenreContext(LIBRARY);
  const nb = new Map(ctx.neighbors.get('shoegaze'));
  expect(nb.get('dream pop')).toBeGreaterThan(0.5);
  // noise pop co-occurs with shoegaze on exactly one artist — no edge from that.
  // (It still shares the head word "pop", which links it to pop, not shoegaze.)
  expect(nb.has('noise pop')).toBe(false);
});

it('normalizes co-occurrence so a ubiquitous genre is not adjacent to everything by count alone', () => {
  const ctx = buildGenreContext(LIBRARY);
  // pop co-occurs with dance pop 3×, but pop is on 8 artists: 3/sqrt(8·3) ≈ 0.61
  // versus a raw count that would rank it like a real sibling.
  const popToDance = new Map(ctx.neighbors.get('pop')).get('dance pop')!;
  const shoeToDream = new Map(ctx.neighbors.get('shoegaze')).get('dream pop')!;
  expect(popToDance).toBeLessThan(shoeToDream);
});

it('links a genre to its head word ("uk drill" → "drill") even with no co-occurrence', () => {
  const ctx = buildGenreContext(LIBRARY);
  expect(new Map(ctx.neighbors.get('uk drill')).get('drill')).toBeGreaterThan(0);
  expect(new Map(ctx.neighbors.get('drill')).get('uk drill')).toBeGreaterThan(0);
});

it('with IDF, sharing only a common genre counts for less than sharing only a rare one', () => {
  const ctx = buildGenreContext(LIBRARY);
  const mixed = buildFingerprint([...songs(5, ['pop']), ...songs(5, ['synthwave'])]);
  const viaPop = explainScore({ genres: ['pop'], releaseYear: null }, mixed, ctx).genre;
  const viaRare = explainScore({ genres: ['synthwave'], releaseYear: null }, mixed, ctx).genre;
  expect(viaPop).toBeLessThan(viaRare);
  // Without a context they tie — that tie is the hotspot.
  expect(explainScore({ genres: ['pop'], releaseYear: null }, mixed).genre)
    .toBeCloseTo(explainScore({ genres: ['synthwave'], releaseYear: null }, mixed).genre);
});

it('adjacency surfaces a neighbouring-genre playlist as a below-threshold guess, under a direct match', () => {
  const ctx = buildGenreContext(LIBRARY);
  const fps = new Map([
    ['dreampop', buildFingerprint(songs(20, ['dream pop']))],
    ['shoegaze', buildFingerprint(songs(20, ['shoegaze']))],
  ]);
  const song = { genres: ['shoegaze'], releaseYear: 2010 };

  const plain = matchSong(song, new Map([['dreampop', fps.get('dreampop')!]]), 0.7);
  expect(plain.best).toBeNull(); // exact-string matching: zero credit

  const adj = matchSong(song, new Map([['dreampop', fps.get('dreampop')!]]), 0.7, undefined, ctx);
  expect(adj.best?.playlistId).toBe('dreampop');
  expect(adj.belowThreshold).toBe(true);
  expect(adj.best?.breakdown?.adjacent).toEqual(['dream pop']);

  const both = matchSong(song, fps, 0.7, undefined, ctx);
  expect(both.best?.playlistId).toBe('shoegaze');
  expect(both.alternates[0]?.playlistId).toBe('dreampop');
});

it('a weak adjacency does not un-gate era into an era-only best guess', () => {
  const ctx = buildGenreContext(LIBRARY);
  // "pop" ↔ "electropop" is a head-word link only; against a pure electropop
  // playlist that sits under ADJ_ONLY_FLOOR, so no genre → no era → no candidate.
  const fp = buildFingerprint(songs(20, ['electropop'], 2010));
  const b = explainScore({ genres: ['pop'], releaseYear: 2010 }, fp, ctx);
  expect(b.genre).toBe(0);
  expect(b.era).toBe(0);
});

it('shrinks a tiny playlist\'s score so it cannot out-rank an equally pure large one', () => {
  const ctx = buildGenreContext(LIBRARY);
  const fps = new Map([
    ['tiny', buildFingerprint(songs(1, ['synthwave']))],
    ['big', buildFingerprint(songs(20, ['synthwave']))],
  ]);
  const song = { genres: ['synthwave'], releaseYear: 2010 };
  const m = matchSong(song, fps, 0.7, undefined, ctx);
  expect(m.best?.playlistId).toBe('big');
  expect(m.alternates[0].score).toBeLessThan(m.best!.score);
  // Legacy scoring ties them.
  const legacy = matchSong(song, fps, 0.7);
  expect(legacy.best!.score).toBeCloseTo(legacy.alternates[0].score);
});

it('a perfect direct match against a sizeable playlist still clears the default threshold', () => {
  const ctx = buildGenreContext(LIBRARY);
  const fp = buildFingerprint(songs(20, ['shoegaze', 'dream pop']));
  const m = matchSong({ genres: ['shoegaze', 'dream pop'], releaseYear: 2010 }, new Map([['p', fp]]), 0.7,
    undefined, ctx);
  expect(m.belowThreshold).toBe(false);
});
