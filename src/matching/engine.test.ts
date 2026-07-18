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
  expect(scoreSong(song(['trip hop'], 1995), fp)).toBeCloseTo(0.85 * 1 + 0.15 * 1);
  expect(scoreSong(song(['death metal'], 2020), fp)).toBe(0);
  expect(scoreSong(song([], 1995), fp)).toBe(0); // no genres → no claim
});

it('era is a secondary signal only', () => {
  const fp = buildFingerprint([song(['trip hop'], 1994)]);
  const rightGenreWrongEra = scoreSong(song(['trip hop'], 2020), fp);
  const wrongGenreRightEra = scoreSong(song(['polka'], 1995), fp);
  expect(rightGenreWrongEra).toBeCloseTo(0.85);
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
  expect(hit.alternates).toHaveLength(2);
  expect(hit.belowThreshold).toBe(false);

  const miss = matchSong(song(['reggaeton'], 2019), fingerprints, DEFAULT_THRESHOLD);
  expect(miss.belowThreshold).toBe(true);
  expect(miss.best).not.toBeNull(); // still shows a greyed-out best guess

  const none = matchSong(song(['anything']), new Map(), DEFAULT_THRESHOLD);
  expect(none.best).toBeNull();
  expect(none.belowThreshold).toBe(true);
});

it('language mismatch is floor-penalized; script or country alone rescues', () => {
  const ru = buildFingerprint([{ genres: ['rap'], releaseYear: 2020, script: 'cyrillic', country: 'RU' }]);
  const en = buildFingerprint([{ genres: ['rap'], releaseYear: 2020, script: 'latin', country: 'US' }]);
  const ruSong = { genres: ['rap'], releaseYear: 2021, script: 'cyrillic', country: 'RU' };
  expect(scoreSong(ruSong, ru)).toBeCloseTo(1);
  expect(scoreSong(ruSong, en)).toBeCloseTo(0.3);               // perfect genre, wrong language → floor
  expect(scoreSong({ ...ruSong, script: 'latin' }, ru)).toBeCloseTo(1); // Molchat Doma: country rescues
  expect(scoreSong({ genres: ['rap'], releaseYear: 2021 }, en)).toBeCloseTo(1); // no signals → legacy
  expect(dominantScript('Каспийский Груз feat. Rigos')).toBe('cyrillic'); // mixed text → argmax
  expect(dominantScript('Фраер Mikhail Krug')).toBe('cyrillic'); // transliterated artist must not outvote Cyrillic title
  expect(dominantScript('Angel Massive Attack')).toBe('latin');
  expect(dominantScript('123 - !')).toBe(null);
});

it('genreless song falls back to language signals instead of scoring 0', () => {
  const ru = buildFingerprint([{ genres: ['rap'], releaseYear: 2020, script: 'cyrillic', country: 'RU' }]);
  const en = buildFingerprint([{ genres: ['rap'], releaseYear: 2020, script: 'latin', country: 'US' }]);
  const genreless = { genres: [], releaseYear: 2021, script: 'cyrillic', country: 'RU' };
  expect(scoreSong(genreless, ru)).toBeGreaterThan(DEFAULT_THRESHOLD);
  expect(scoreSong(genreless, en)).toBeLessThan(scoreSong(genreless, ru));
  expect(scoreSong({ genres: [], releaseYear: 1995 }, en)).toBe(0); // no genres, no signals → still no claim
});

it('matchSong caps alternates at 4 even with many candidate playlists', () => {
  const fingerprints = new Map([
    ['pTrip', buildFingerprint([song(['trip hop'], 1994)])],
    ['pRock', buildFingerprint([song(['rock'], 1994)])],
    ['pJazz', buildFingerprint([song(['jazz'], 1960)])],
    ['pFunk', buildFingerprint([song(['funk'], 1975)])],
    ['pPunk', buildFingerprint([song(['punk'], 1980)])],
    ['pPop', buildFingerprint([song(['pop'], 2005)])],
  ]);
  const hit = matchSong(song(['trip hop'], 1995), fingerprints, DEFAULT_THRESHOLD);
  expect(hit.best?.playlistId).toBe('pTrip');
  expect(hit.alternates).toHaveLength(4);
  expect(hit.alternates.some((a) => a.playlistId === 'pTrip')).toBe(false);
});
