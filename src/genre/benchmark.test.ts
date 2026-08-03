import { expect, it } from 'vitest';
import {
  COARSE_GENRES,
  coverage,
  f1,
  formatTable,
  precision,
  recall,
  scoreProvider,
  specificity,
  type ArtistResult,
} from './benchmark';
import { parseInfoboxGenres } from '../api/wikipedia';
import { WIKITEXT_FIXTURES } from './fixtures/wikitext';

// -- COARSE_GENRES -------------------------------------------------------

it('COARSE_GENRES is a lowercase, ~25-item bucket list', () => {
  expect(COARSE_GENRES.size).toBeGreaterThanOrEqual(20);
  expect(COARSE_GENRES.size).toBeLessThanOrEqual(30);
  for (const g of COARSE_GENRES) expect(g).toBe(g.toLowerCase());
  expect(COARSE_GENRES.has('rock')).toBe(true);
  expect(COARSE_GENRES.has('hip hop')).toBe(true);
  // A real subgenre must NOT be in here, or `specificity` is meaningless.
  expect(COARSE_GENRES.has('shoegaze')).toBe(false);
});

// -- coverage --------------------------------------------------------------

it('coverage: counts only answered artists resolved to >= 1 genre', () => {
  expect(coverage([['rock'], [], undefined])).toBeCloseTo(1 / 2); // absent excluded from denominator
  expect(coverage([['rock'], ['pop']])).toBe(1);
  expect(coverage([[], []])).toBe(0);
});

it('coverage: absent (undefined) is excluded from the denominator, unlike a confirmed []', () => {
  // Same numerator (one resolved artist) but different denominators because
  // the second case has an extra confirmed-empty artist counted as a miss.
  expect(coverage([['rock'], undefined])).toBe(1);
  expect(coverage([['rock'], []])).toBeCloseTo(1 / 2);
});

it('coverage: degenerate case -- nothing answered at all returns 0, not NaN', () => {
  expect(coverage([undefined, undefined])).toBe(0);
  expect(coverage([])).toBe(0);
});

// -- precision / recall / f1 -------------------------------------------------

it('precision: undefined (not 0) when actual is empty -- an empty prediction makes no claims', () => {
  expect(precision([], ['rock'])).toBeUndefined();
  expect(precision([], [])).toBeUndefined();
});

it('precision: set-based over normalized lowercase labels', () => {
  expect(precision(['Rock', 'POP'], ['rock', 'jazz'])).toBeCloseTo(1 / 2);
  expect(precision(['rock'], ['rock'])).toBe(1);
  expect(precision(['rock'], ['jazz'])).toBe(0);
});

it('precision: duplicate labels in actual do not inflate or deflate the score (set-based)', () => {
  expect(precision(['rock', 'rock', 'rock'], ['rock'])).toBe(1);
});

it('recall: undefined (not 0 or 1) when expected is empty -- no ground truth to recall against', () => {
  expect(recall(['rock'], [])).toBeUndefined();
  expect(recall([], [])).toBeUndefined();
});

it('recall: empty actual against non-empty expected is a well-defined 0 (unlike precision\'s undefined)', () => {
  expect(recall([], ['rock'])).toBe(0);
});

it('recall: set-based over normalized lowercase labels', () => {
  expect(recall(['rock'], ['Rock', 'Pop'])).toBeCloseTo(1 / 2);
  expect(recall(['rock', 'pop'], ['rock', 'pop'])).toBe(1);
});

it('f1: undefined when either precision or recall is undefined', () => {
  expect(f1([], ['rock'])).toBeUndefined(); // precision undefined
  expect(f1(['rock'], [])).toBeUndefined(); // recall undefined
});

it('f1: harmonic mean of precision and recall, 0 when both are 0', () => {
  expect(f1(['rock'], ['rock'])).toBe(1);
  expect(f1(['rock'], ['jazz'])).toBe(0);
  expect(f1(['rock', 'jazz'], ['jazz', 'pop'])).toBeCloseTo(1 / 2); // p=1/2, r=1/2
});

// -- specificity -------------------------------------------------------------

it('specificity: share of labels NOT in COARSE_GENRES', () => {
  expect(specificity(['rock', 'shoegaze'])).toBeCloseTo(1 / 2);
  expect(specificity(['rock', 'pop'])).toBe(0);
  expect(specificity(['shoegaze', 'vaporwave'])).toBe(1);
});

it('specificity: undefined for an empty label set, not 0 -- nothing to judge the granularity of', () => {
  expect(specificity([])).toBeUndefined();
});

it('specificity: normalizes case before checking bucket membership', () => {
  expect(specificity(['Rock', 'HIP HOP'])).toBe(0);
});

// -- scoreProvider / formatTable ---------------------------------------------

it('scoreProvider: aggregates coverage/precision/recall/f1/specificity and absent-vs-empty counts', () => {
  const perArtist: ArtistResult[] = [
    { name: 'A', actual: ['rock', 'shoegaze'], expected: ['rock'] },
    { name: 'B', actual: [], expected: ['pop'] }, // confirmed empty: a real miss
    { name: 'C', actual: undefined, expected: ['jazz'] }, // absent: transient failure
  ];
  const row = scoreProvider('test-provider', perArtist);

  expect(row.provider).toBe('test-provider');
  expect(row.artists).toBe(3);
  expect(row.answered).toBe(2);
  expect(row.absent).toBe(1);
  expect(row.coverage).toBeCloseTo(1 / 2); // 1 of 2 *answered* artists resolved
  expect(row.precision).toBeCloseTo(1 / 2); // only A contributes (B's actual is empty -> undefined, excluded)
  expect(row.recall).toBeCloseTo(1 / 2); // mean of A's recall (1) and B's recall (0); C excluded (absent)
  expect(row.specificity).toBeCloseTo(1 / 2); // pooled over A's two labels only
  expect(row.labels).toBe(2);
});

it('scoreProvider: an all-absent run has zero coverage and every metric undefined', () => {
  const row = scoreProvider('nobody-answered', [
    { name: 'A', actual: undefined, expected: ['rock'] },
  ]);
  expect(row.coverage).toBe(0);
  expect(row.precision).toBeUndefined();
  expect(row.recall).toBeUndefined();
  expect(row.f1).toBeUndefined();
  expect(row.specificity).toBeUndefined();
});

it('formatTable: renders a markdown table with a header, separator, and one row per input', () => {
  const table = formatTable([scoreProvider('p1', [{ name: 'A', actual: ['rock'], expected: ['rock'] }])]);
  const lines = table.split('\n');
  expect(lines[0]).toMatch(/^\| provider \|/);
  expect(lines[1]).toMatch(/^\|---/);
  expect(lines[2]).toContain('p1');
  expect(lines[2]).toContain('100.0%');
});

it('formatTable: renders undefined metrics as "n/a" rather than blank or 0', () => {
  const table = formatTable([scoreProvider('empty', [{ name: 'A', actual: undefined, expected: ['rock'] }])]);
  expect(table).toContain('n/a');
});

// -- Offline parse benchmark --------------------------------------------------
//
// This measures `parseInfoboxGenres`'s accuracy against hand-authored wikitext
// that reproduces real infobox *shapes* (see fixtures/wikitext.ts's own header
// comment) -- it is a regression guard on the PARSER, not a measurement of
// end-to-end coverage over real Wikipedia articles. Real articles vary in ways
// this fixture set can't anticipate (template redirects, locale-specific field
// names, unusual editor style); only `benchmark.live.test.ts`, run on a
// machine with network egress, measures that. Do not present these numbers as
// a proxy for real-world coverage in the report.
it('offline parse benchmark: parseInfoboxGenres over WIKITEXT_FIXTURES clears a regression floor', () => {
  const perArtist: ArtistResult[] = WIKITEXT_FIXTURES.map((fx) => ({
    name: fx.artist,
    actual: parseInfoboxGenres(fx.wikitext), // pure parse, never returns undefined -- no "absent" case offline
    expected: fx.expected,
  }));
  const row = scoreProvider('wikipedia-parser (offline, authored fixtures)', perArtist);

  // eslint-disable-next-line no-console -- deliberate: a run should show the numbers
  console.info(`\n${formatTable([row])}\n`);

  // Floors below, each measured then given a small margin so this guards
  // against a real regression instead of re-asserting today's exact numbers
  // (a tautology). As authored, parseInfoboxGenres gets every fixture with a
  // non-empty `expected` exactly right (coverage 0.75, precision/recall/f1
  // all 1.0, specificity 0.72) -- see this test's own console.info output for
  // the numbers as actually measured on a given run.
  expect(row.coverage).toBeGreaterThanOrEqual(0.65);
  expect(row.precision).toBeDefined();
  expect(row.precision!).toBeGreaterThanOrEqual(0.9);
  expect(row.recall).toBeDefined();
  expect(row.recall!).toBeGreaterThanOrEqual(0.9);
  expect(row.f1).toBeDefined();
  expect(row.f1!).toBeGreaterThanOrEqual(0.9);
  expect(row.specificity).toBeDefined();
  expect(row.specificity!).toBeGreaterThanOrEqual(0.6);
});
