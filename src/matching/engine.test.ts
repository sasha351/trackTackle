import { expect, it } from 'vitest';
import { buildFingerprint, scoreSong, matchSong, dominantScript, DEFAULT_THRESHOLD } from './engine';

const song = (genres: string[], releaseYear: number | null = null) => ({ genres, releaseYear });

it('builds normalized genre and decade weights', () => {
  const fp = buildFingerprint([
    song(['trip hop', 'downtempo'], 1994),
    song(['trip hop'], 1998),
    song([], 2011),
  ]);
  expect(fp.size).toBe(3);
  expect(fp.genreWeights.get('trip hop')).toBeCloseTo(2 / 3);
  expect(fp.genreWeights.get('downtempo')).toBeCloseTo(1 / 3);
  expect(fp.decadeWeights.get(1990)).toBeCloseTo(2 / 3);
  expect(fp.decadeWeights.get(2010)).toBeCloseTo(1 / 3);
});

it('scores a perfectly matching song near 1 and an unrelated song at 0', () => {
  const fp = buildFingerprint([song(['trip hop'], 1994), song(['trip hop'], 1998)]);
  expect(scoreSong(song(['trip hop'], 1995), fp)).toBeCloseTo(0.7 * 1 + 0.15 * 1);
  expect(scoreSong(song(['death metal'], 2020), fp)).toBe(0);
  expect(scoreSong(song([], 1995), fp)).toBe(0); // no genres → no claim
});

it('era is a secondary signal only', () => {
  const fp = buildFingerprint([song(['trip hop'], 1994)]);
  const rightGenreWrongEra = scoreSong(song(['trip hop'], 2020), fp);
  const wrongGenreRightEra = scoreSong(song(['polka'], 1995), fp);
  expect(rightGenreWrongEra).toBeCloseTo(0.7);
  expect(wrongGenreRightEra).toBeCloseTo(0.15);
  expect(rightGenreWrongEra).toBeGreaterThan(wrongGenreRightEra);
});

it('scores a song with many tags, only some relevant, above threshold (cosine vs. mean-of-weights)', () => {
  // Real Spotify artists carry several genre tags at once; a plain mean punishes
  // that dilution hard. Cosine similarity only normalizes by sqrt(count).
  const playlistSongs = [
    ['a', 'b', 'c'], ['a', 'b', 'd'], ['a', 'b', 'c'], ['a', 'c', 'd'], ['a', 'b', 'c'],
    ['b', 'c', 'd'], ['a', 'b', 'c'], ['a', 'b', 'd'], ['a', 'c', 'd'], ['a', 'b', 'c'],
  ].map((genres) => song(genres));
  const fp = buildFingerprint(playlistSongs);

  const relevantButDiluted = song(['a', 'b', 'c', 'x1', 'x2', 'x3', 'x4', 'x5']);
  expect(scoreSong(relevantButDiluted, fp)).toBeGreaterThan(DEFAULT_THRESHOLD);

  const unrelated = song(['x1', 'x2', 'x3']);
  expect(scoreSong(unrelated, fp)).toBeLessThan(DEFAULT_THRESHOLD);
});

it('matchSong ranks playlists and flags below-threshold', () => {
  const fingerprints = new Map([
    ['pTrip', buildFingerprint([song(['trip hop'], 1994)])],
    ['pRock', buildFingerprint([song(['rock'], 1994)])],
    ['pJazz', buildFingerprint([song(['jazz'], 1960)])],
  ]);
  const hit = matchSong(song(['trip hop'], 1995), fingerprints, DEFAULT_THRESHOLD);
  expect(hit.best?.playlistId).toBe('pTrip');
  expect(hit.alternates).toHaveLength(1); // pRock via era overlap; zero-score pJazz dropped
  expect(hit.belowThreshold).toBe(false);

  const miss = matchSong(song(['reggaeton'], 1994), fingerprints, DEFAULT_THRESHOLD);
  expect(miss.belowThreshold).toBe(true);
  expect(miss.best).not.toBeNull(); // era overlap → still shows a greyed-out best guess

  const zero = matchSong(song(['reggaeton'], 2019), fingerprints, DEFAULT_THRESHOLD);
  expect(zero.best).toBeNull(); // nothing scored above 0 → no guess at all
  expect(zero.alternates).toHaveLength(0);

  const none = matchSong(song(['anything']), new Map(), DEFAULT_THRESHOLD);
  expect(none.best).toBeNull();
  expect(none.belowThreshold).toBe(true);
});

it('language is a tiebreak between same-genre playlists, never a genre substitute', () => {
  const ru = buildFingerprint([{ genres: ['rap'], releaseYear: 2020, script: 'cyrillic', country: 'RU' }]);
  const en = buildFingerprint([{ genres: ['rap'], releaseYear: 2020, script: 'latin', country: 'US' }]);
  const chanson = buildFingerprint([{ genres: ['chanson'], releaseYear: 2000, script: 'cyrillic', country: 'RU' }]);
  const ruSong = { genres: ['rap'], releaseYear: 2021, script: 'cyrillic', country: 'RU' };
  expect(scoreSong(ruSong, ru)).toBeCloseTo(1);    // genre, era, language all agree
  expect(scoreSong(ruSong, en)).toBeCloseTo(0.85); // wrong language dents, genre still dominates
  // Same-script wrong-genre playlist must not beat cross-script right-genre one
  // (the "Soviet rock → chanson 47%" screenshot bug).
  expect(scoreSong(ruSong, chanson)).toBeCloseTo(0.15);
  expect(scoreSong({ ...ruSong, script: 'latin' }, ru)).toBeCloseTo(1); // Molchat Doma: country rescues
  expect(dominantScript('Каспийский Груз feat. Rigos')).toBe('cyrillic'); // mixed text → argmax
  expect(dominantScript('Фраер Mikhail Krug')).toBe('cyrillic'); // transliterated artist must not outvote Cyrillic title
  expect(dominantScript('Angel Massive Attack')).toBe('latin');
  expect(dominantScript('123 - !')).toBe(null);
});

const fpOf = (script: string, country: string, n = 4) =>
  buildFingerprint(Array.from({ length: n }, () => (
    { genres: ['pop'], releaseYear: 2010, script, country }
  )));

it('genreless foreign-language song suggests exactly the same-language playlists', () => {
  const fingerprints = new Map([
    ['chanson', fpOf('cyrillic', 'RU')],
    ['hardbass', fpOf('cyrillic', 'RU')],
    ['droopy', fpOf('latin', 'US')],
    ['redline', fpOf('latin', 'US')],
    ['camsonme', fpOf('latin', 'US')],
  ]);
  const ruSong = { genres: [], releaseYear: 2021, script: 'cyrillic', country: 'RU' };
  const m = matchSong(ruSong, fingerprints, DEFAULT_THRESHOLD);
  const suggested = [m.best!, ...m.alternates].map((c) => c.playlistId).sort();
  expect(suggested).toEqual(['chanson', 'hardbass']); // both Russian playlists, no latin noise
  expect(m.best!.score).toBeLessThanOrEqual(0.5); // language is a hint, never near-certainty
});

it('genreless majority-language song claims nothing (latin/US base rate)', () => {
  const fingerprints = new Map([
    ['chanson', fpOf('cyrillic', 'RU')],
    ['droopy', fpOf('latin', 'US')],
    ['redline', fpOf('latin', 'US')],
    ['camsonme', fpOf('latin', 'US')],
  ]);
  const enSong = { genres: [], releaseYear: 2021, script: 'latin', country: 'US' };
  const m = matchSong(enSong, fingerprints, DEFAULT_THRESHOLD);
  expect(m.best).toBeNull(); // renders "no candidate playlists", not a fake best guess
});

it('language-agnostic: in a mostly-Russian library, latin is the distinctive signal', () => {
  const fingerprints = new Map([
    ['ru1', fpOf('cyrillic', 'RU')],
    ['ru2', fpOf('cyrillic', 'RU')],
    ['ru3', fpOf('cyrillic', 'RU')],
    ['english', fpOf('latin', 'US')],
  ]);
  const enSong = { genres: [], releaseYear: 2021, script: 'latin', country: 'US' };
  const m = matchSong(enSong, fingerprints, DEFAULT_THRESHOLD);
  expect([m.best!, ...m.alternates].map((c) => c.playlistId)).toEqual(['english']);
  const ruSong = { genres: [], releaseYear: 2021, script: 'cyrillic', country: 'RU' };
  expect(matchSong(ruSong, fingerprints, DEFAULT_THRESHOLD).best).toBeNull(); // cyrillic is the default here
});

it('scoreSong without a baseline gives genreless songs no claim', () => {
  const ru = fpOf('cyrillic', 'RU');
  expect(scoreSong({ genres: [], releaseYear: 2021, script: 'cyrillic', country: 'RU' }, ru)).toBe(0);
});

it('matchSong caps alternates at 4 even with many candidate playlists', () => {
  const fingerprints = new Map([
    ['pTrip', buildFingerprint([song(['trip hop'], 1994)])],
    ['pRock', buildFingerprint([song(['rock'], 1994)])],
    ['pJazz', buildFingerprint([song(['jazz'], 1993)])],
    ['pFunk', buildFingerprint([song(['funk'], 1995)])],
    ['pPunk', buildFingerprint([song(['punk'], 1996)])],
    ['pPop', buildFingerprint([song(['pop'], 1997)])],
  ]);
  const hit = matchSong(song(['trip hop'], 1995), fingerprints, DEFAULT_THRESHOLD);
  expect(hit.best?.playlistId).toBe('pTrip');
  expect(hit.alternates).toHaveLength(4);
  expect(hit.alternates.some((a) => a.playlistId === 'pTrip')).toBe(false);
});
