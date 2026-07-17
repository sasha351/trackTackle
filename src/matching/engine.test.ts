import { expect, it } from 'vitest';
import { buildFingerprint, scoreSong, matchSong, DEFAULT_THRESHOLD } from './engine';

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

it('matchSong ranks playlists, returns two alternates, and flags below-threshold', () => {
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
