import { expect, it } from 'vitest';
import { buildFingerprint, scoreSong, explainScore, matchSong, dominantScript, langSignals, DEFAULT_THRESHOLD } from './engine';

const song = (genres: string[], releaseYear: number | null = null) => ({ genres, releaseYear });

it('builds normalized genre and decade weights', () => {
  const fp = buildFingerprint([
    song(['trip hop', 'downtempo'], 1994),
    song(['trip hop'], 1998),
    song([], 2011),
  ]);
  expect(fp.size).toBe(3);
  // Normalized by genred (2), not size (3) — matches script/country below.
  expect(fp.genreWeights.get('trip hop')).toBeCloseTo(2 / 2);
  expect(fp.genreWeights.get('downtempo')).toBeCloseTo(1 / 2);
  expect(fp.decadeWeights.get(1990)).toBeCloseTo(2 / 3);
  expect(fp.decadeWeights.get(2010)).toBeCloseTo(1 / 3);
  expect(fp.genred).toBe(2); // 2 of 3 songs carried a genre
});

it('title/description hints seed the fingerprint so a genreless playlist still ranks', () => {
  const fp = buildFingerprint([song([], 1994), song([], 1998)], ['lo-fi']);
  expect(fp.genred).toBeGreaterThan(0); // hints count as genred evidence
  expect(fp.genreWeights.get('lo-fi')).toBeCloseTo(1); // the only genre signal, so it's 100% of it
  const candidate = scoreSong(song(['lo-fi'], 1996), fp);
  expect(candidate).toBeGreaterThan(0);

  const noHints = buildFingerprint([song([], 1994), song([], 1998)]);
  expect(noHints.genred).toBe(0);
  expect(explainScore(song(['lo-fi'], 1996), noHints).genre).toBe(0); // without the hint, no genre signal to match
});

it('leaves scoreSong unchanged by the genred-vs-size normalization (cosine is scale-invariant)', () => {
  const fp = buildFingerprint([
    song(['trip hop', 'downtempo'], 1994),
    song(['trip hop'], 1998),
    song([], 2011),
  ]);
  const candidate = song(['trip hop'], 1995);
  const scoreWithGenredDenominator = scoreSong(candidate, fp);

  // Reconstruct the same fingerprint using the old songs.length denominator —
  // every weight scales by the same constant (genred / size), which cannot
  // change cosine similarity, only the raw share an analyzer would read.
  const oldStyleWeights = new Map(
    [...fp.genreWeights].map(([g, w]) => [g, w * fp.genred / fp.size] as const),
  );
  const oldStyleFp = { ...fp, genreWeights: oldStyleWeights };
  expect(scoreSong(candidate, oldStyleFp)).toBeCloseTo(scoreWithGenredDenominator);
});

it('explainScore.total equals the weighted sum of its own parts, and agrees with scoreSong', () => {
  const cases: {
    fp: ReturnType<typeof buildFingerprint>;
    candidate: { genres: string[]; releaseYear: number | null; script?: string; country?: string };
  }[] = [
    { fp: buildFingerprint([song(['trip hop'], 1994), song(['trip hop'], 1998)]), candidate: song(['trip hop'], 1995) },
    { fp: buildFingerprint([song(['trip hop'], 1994)]), candidate: song(['polka'], 1995) },
    {
      fp: buildFingerprint([
        { genres: ['pop'], releaseYear: 2010, script: 'cyrillic', country: 'RU' },
      ]),
      candidate: { genres: [], releaseYear: 2010, script: 'cyrillic', country: 'RU' },
    },
  ];
  for (const { fp, candidate } of cases) {
    const breakdown = explainScore(candidate, fp);
    expect(breakdown.total).toBeCloseTo(breakdown.genre + breakdown.era + breakdown.lang);
    expect(breakdown.total).toBeCloseTo(scoreSong(candidate, fp));
  }
});

it('explainScore reports the genres a song and playlist share', () => {
  const fp = buildFingerprint([song(['trip hop', 'downtempo'], 1994), song(['trip hop'], 1998)]);
  const breakdown = explainScore(song(['trip hop', 'jungle'], 1995), fp);
  expect(breakdown.overlap).toEqual(['trip hop']);
  expect(breakdown.songGenres).toBe(2);
  expect(breakdown.fpGenres).toBe(2); // trip hop, downtempo
});

it('scores a perfectly matching song near 1 and an unrelated song at 0', () => {
  const fp = buildFingerprint([song(['trip hop'], 1994), song(['trip hop'], 1998)]);
  expect(scoreSong(song(['trip hop'], 1995), fp)).toBeCloseTo(0.7 * 1 + 0.15 * 1);
  expect(scoreSong(song(['death metal'], 2020), fp)).toBe(0);
  // no genres → no genre claim, but era still applies (decade 1990 matches)
  expect(scoreSong(song([], 1995), fp)).toBeCloseTo(0.2);
  expect(scoreSong(song([], 2020), fp)).toBe(0); // no genres, no era overlap either
});

it('era is a secondary signal only', () => {
  const fp = buildFingerprint([song(['trip hop'], 1994)]);
  const rightGenreWrongEra = scoreSong(song(['trip hop'], 2020), fp);
  const wrongGenreRightEra = scoreSong(song(['polka'], 1995), fp);
  expect(rightGenreWrongEra).toBeCloseTo(0.65);
  expect(wrongGenreRightEra).toBeCloseTo(0.2);
  expect(rightGenreWrongEra).toBeGreaterThan(wrongGenreRightEra);
});

it('era bleeds into neighbouring decades instead of a hard cliff', () => {
  const fp = buildFingerprint([song(['polka'], 1994), song(['polka'], 1996)]); // decade 1990
  const boundary = scoreSong(song(['polka'], 1989), fp); // decade 1980, one year off the cliff
  const farAway = scoreSong(song(['polka'], 1965), fp); // decade 1960, no bleed reaches it
  expect(boundary).toBeGreaterThan(0);
  expect(boundary).toBeCloseTo(0.65 + 0.2 * 0.5); // full genre match, half-strength era bleed
  expect(farAway).toBeCloseTo(0.65); // genre only, no era contribution at all
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
  expect(scoreSong(ruSong, ru)).toBeCloseTo(1);      // genre, era, language all agree
  expect(scoreSong(ruSong, en)).toBeCloseTo(0.2125); // en is 100% latin/US, ru shares neither → heavy penalty even though genre matched
  // Same-script wrong-genre playlist must not beat cross-script right-genre one
  // (the "Soviet rock → chanson 47%" screenshot bug).
  expect(scoreSong(ruSong, chanson)).toBeCloseTo(0.15);
  expect(scoreSong({ ...ruSong, script: 'latin' }, ru)).toBeCloseTo(1); // Molchat Doma: country rescues
  expect(dominantScript('Каспийский Груз feat. Rigos')).toBe('cyrillic'); // mixed text → argmax
  expect(dominantScript('Фраер Mikhail Krug')).toBe('cyrillic'); // transliterated artist must not outvote Cyrillic title
  expect(dominantScript('Angel Massive Attack')).toBe('latin');
  expect(dominantScript('123 - !')).toBe(null);
});

it('langSignals anchors script on the artist name, not the (unreliable) song title', () => {
  // A Cyrillic-scripted artist keeps their script regardless of what the
  // track title looks like — langSignals doesn't even take a title anymore.
  expect(langSignals([{ name: 'Молчат Дома' }], null).script).toBe('cyrillic');
  expect(langSignals([{ name: 'Massive Attack' }], null).script).toBe('latin');
  expect(langSignals([{ name: '123' }], null).script).toBe(null); // no letters, no anchor
  expect(langSignals([{ name: 'Angel' }], 'RUA2K2100047').country).toBe('RU');
});

it('language mismatch penalty is symmetric and only fires against a genuinely dominant playlist', () => {
  const ru = buildFingerprint([{ genres: ['rap'], releaseYear: 2020, script: 'cyrillic', country: 'RU' }]);
  const en = buildFingerprint([{ genres: ['rap'], releaseYear: 2020, script: 'latin', country: 'US' }]);
  const mixed = buildFingerprint([
    { genres: ['rap'], releaseYear: 2020, script: 'cyrillic', country: 'RU' },
    { genres: ['rap'], releaseYear: 2020, script: 'latin', country: 'US' },
  ]); // no script/country clears 70% — neither direction should be penalised
  const ruSong = { genres: ['rap'], releaseYear: 2020, script: 'cyrillic', country: 'RU' };
  const enSong = { genres: ['rap'], releaseYear: 2020, script: 'latin', country: 'US' };

  const ruOnEn = explainScore(ruSong, en);
  const enOnRu = explainScore(enSong, ru);
  expect(ruOnEn.langPenalty).toBe(0.25); // mismatch — penalised
  expect(enOnRu.langPenalty).toBe(0.25); // flip is symmetric
  expect(ruOnEn.total).toBeCloseTo(enOnRu.total);

  const matchUntouched = explainScore(ruSong, ru);
  expect(matchUntouched.langPenalty).toBe(1); // agreement — untouched

  expect(explainScore(ruSong, mixed).langPenalty).toBe(1); // no dominant language to mismatch against
});

// releaseYear omitted throughout — these tests isolate the language-only
// claim, and era is now scored independently (see the era-credit test below).
const fpOf = (script: string, country: string, n = 4) =>
  buildFingerprint(Array.from({ length: n }, () => (
    { genres: ['pop'], releaseYear: null, script, country }
  )));

it('genreless foreign-language song suggests exactly the same-language playlists', () => {
  const fingerprints = new Map([
    ['chanson', fpOf('cyrillic', 'RU')],
    ['hardbass', fpOf('cyrillic', 'RU')],
    ['droopy', fpOf('latin', 'US')],
    ['redline', fpOf('latin', 'US')],
    ['camsonme', fpOf('latin', 'US')],
  ]);
  const ruSong = { genres: [], releaseYear: null, script: 'cyrillic', country: 'RU' };
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
  const enSong = { genres: [], releaseYear: null, script: 'latin', country: 'US' };
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
  const enSong = { genres: [], releaseYear: null, script: 'latin', country: 'US' };
  const m = matchSong(enSong, fingerprints, DEFAULT_THRESHOLD);
  expect([m.best!, ...m.alternates].map((c) => c.playlistId)).toEqual(['english']);
  const ruSong = { genres: [], releaseYear: null, script: 'cyrillic', country: 'RU' };
  expect(matchSong(ruSong, fingerprints, DEFAULT_THRESHOLD).best).toBeNull(); // cyrillic is the default here
});

it('a playlist below the sample floor cannot claim a genreless song by coincidence', () => {
  const tiny = fpOf('cyrillic', 'RU', 2); // below MIN_LANG_SAMPLES
  const enoughSamples = fpOf('cyrillic', 'RU', 3); // at the floor
  const ruSong = { genres: [], releaseYear: null, script: 'cyrillic', country: 'RU' };
  const fingerprintsTiny = new Map([['tiny', tiny], ['other', fpOf('latin', 'US', 10)]]);
  const fingerprintsEnough = new Map([['enough', enoughSamples], ['other', fpOf('latin', 'US', 10)]]);
  expect(matchSong(ruSong, fingerprintsTiny, DEFAULT_THRESHOLD).best).toBeNull();
  expect(matchSong(ruSong, fingerprintsEnough, DEFAULT_THRESHOLD).best?.playlistId).toBe('enough');
});

it('a moderately (not overwhelmingly) skewed playlist cannot claim a genreless song', () => {
  // 60% cyrillic, plenty of samples to clear the floor — but not the 70%
  // concentration bar, so this must read as "not distinctively Russian".
  const moderate = buildFingerprint([
    { genres: [], releaseYear: null, script: 'cyrillic', country: 'RU' },
    { genres: [], releaseYear: null, script: 'cyrillic', country: 'RU' },
    { genres: [], releaseYear: null, script: 'cyrillic', country: 'RU' },
    { genres: [], releaseYear: null, script: 'latin', country: 'US' },
    { genres: [], releaseYear: null, script: 'latin', country: 'US' },
  ]);
  const ruSong = { genres: [], releaseYear: null, script: 'cyrillic', country: 'RU' };
  expect(matchSong(ruSong, new Map([['moderate', moderate]]), DEFAULT_THRESHOLD).best).toBeNull();
});

it('genreless song still claims era credit when a baseline is present but language does not match', () => {
  const fp = fpOf('latin', 'US', 3); // no distinctive language signal
  const withEra = buildFingerprint(Array.from({ length: 3 }, () => song(['pop'], 1994)));
  const fingerprints = new Map([['withEra', withEra], ['other', fp]]);
  const genrelessSong = { genres: [], releaseYear: 1995, script: null, country: null };
  const m = matchSong(genrelessSong, fingerprints, DEFAULT_THRESHOLD);
  expect(m.best?.playlistId).toBe('withEra'); // era alone (0.2) beats the language-only playlist's 0
  expect(m.best!.score).toBeCloseTo(0.2);
});

it('scoreSong without a baseline still credits era, but not the boosted language-only claim', () => {
  const ru = fpOf('cyrillic', 'RU', 3);
  // No baseline passed → falls back to the plain (unboosted) language tiebreak.
  const total = scoreSong({ genres: [], releaseYear: null, script: 'cyrillic', country: 'RU' }, ru);
  expect(total).toBeCloseTo(0.15 * 1); // LANG_WEIGHT * full share, no boost, no era
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
