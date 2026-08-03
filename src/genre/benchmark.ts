// Pure scoring for the MusicBrainz-vs-Wikipedia genre-provider benchmark (see
// docs/superpowers/specs/2026-08-03-wikipedia-genre-resolver-design.md,
// "Benchmark design"). No I/O here on purpose: `benchmark.test.ts` drives this
// offline over `WIKITEXT_FIXTURES`, and `benchmark.live.test.ts` drives it
// over real provider calls -- both reduce to the same shapes below so the
// scoring logic is exercised (and trusted) by the suite that always runs.

/** ~25 broad, "you'd see this on a genre picker" buckets. `specificity` below
 *  is the metric that actually encodes this whole exercise's motivating
 *  complaint: MusicBrainz's `arid:` search *does* return genre tags -- via
 *  `tagsToGenres` in src/api/musicbrainz.ts -- they are just filtered down to
 *  broad ones by its canonical `/genre/all` whitelist. A provider that always
 *  answers "rock" is not "wrong" by precision/recall if the ground truth
 *  itself says "rock" -- specificity is the metric that would catch a
 *  provider laundering every niche artist into one of these buckets even when
 *  it's technically not incorrect. */
export const COARSE_GENRES: ReadonlySet<string> = new Set([
  'rock', 'pop', 'electronic', 'hip hop', 'rap', 'jazz', 'metal', 'folk',
  'country', 'r&b', 'soul', 'punk', 'classical', 'blues', 'reggae', 'dance',
  'indie', 'alternative', 'experimental', 'ambient', 'house', 'techno',
  'funk', 'disco', 'world',
]);

const normalizeLabel = (label: string): string => label.trim().toLowerCase();

const normSet = (labels: string[]): Set<string> =>
  new Set(labels.map(normalizeLabel).filter(Boolean));

/** Per-artist input to the scorers. `actual` distinguishes the two failure
 *  modes both provider modules document (musicbrainz.ts, wikipedia.ts):
 *  `undefined` = the artist is *absent* from the provider's result map, a
 *  transient failure (a chunk/search/fetch errored) that is retryable and
 *  must not be scored as a confident answer. `[]` = the provider durably
 *  answered "this artist has no genres" -- a real, if disappointing, result.
 *  A non-empty array is a real resolution. Conflating absent with `[]`
 *  anywhere in this module would silently reward or punish a provider for
 *  network flakiness that has nothing to do with genre-resolution quality. */
export interface ArtistResult {
  name: string;
  actual: string[] | undefined;
  expected: string[];
}

/** Share of *answered* artists (`actual !== undefined`) that resolved to >= 1
 *  genre.
 *
 *  Absent artists are excluded from BOTH numerator and denominator: a
 *  transient failure is a "the provider never actually weighed in" signal,
 *  not evidence it has no genre for that artist, so folding it into the
 *  denominator would make retryable network flakiness look identical to a
 *  real coverage gap. A confirmed empty answer (`[]`) DOES count in the
 *  denominator, as a miss -- that's a real, durable "no genre" and coverage
 *  should reflect it. This is the "coverage ... should treat them distinctly"
 *  requirement: absent is excluded, `[]` is counted-but-missed.
 *
 *  Degenerate case: if nothing was answered at all, returns 0 rather than
 *  NaN -- a run that failed to answer anyone has zero coverage to report, not
 *  an undefined one; unlike precision/recall (see below), "how much of the
 *  library got an answer" is always a well-formed question even at zero. */
export function coverage(results: Array<string[] | undefined>): number {
  const answered = results.filter((r): r is string[] => r !== undefined);
  if (answered.length === 0) return 0;
  return answered.filter((genres) => genres.length > 0).length / answered.length;
}

/** Set-based precision of `actual` against `expected`, both normalized to
 *  lowercase before comparing (case/whitespace must never affect scoring).
 *
 *  Returns `undefined`, not `0`, when `actual` is empty. Precision asks "of
 *  what we predicted, how much was right" -- an empty prediction makes no
 *  claims at all, so scoring it `0` would penalize "answered nothing" exactly
 *  as harshly as "answered confidently wrong", and scoring it `1` (the
 *  vacuous-truth reading) would reward a provider that never guesses.
 *  `undefined` keeps both readings out of the aggregate average instead of
 *  silently picking one. Callers that need a single number (e.g. a report
 *  table) decide how to render `undefined` explicitly (`formatTable` below
 *  renders it as "n/a"), rather than that decision being baked in here. */
export function precision(actual: string[], expected: string[]): number | undefined {
  const a = normSet(actual);
  if (a.size === 0) return undefined;
  const e = normSet(expected);
  let hits = 0;
  for (const label of a) if (e.has(label)) hits += 1;
  return hits / a.size;
}

/** Set-based recall of `actual` against `expected`.
 *
 *  Returns `undefined` when `expected` is empty: with no ground truth for
 *  this artist, "did we find everything" is not a meaningful question, so it
 *  must not silently resolve to a perfect 1 (nothing to miss) or a confusing
 *  0. Unlike `precision`, an empty `actual` against a non-empty `expected` IS
 *  a meaningful, well-defined 0 here (we found none of what exists) -- that
 *  asymmetry with `precision` is intentional, not an oversight. */
export function recall(actual: string[], expected: string[]): number | undefined {
  const e = normSet(expected);
  if (e.size === 0) return undefined;
  const a = normSet(actual);
  let hits = 0;
  for (const label of e) if (a.has(label)) hits += 1;
  return hits / e.size;
}

/** Harmonic mean of precision and recall. `undefined` propagates from either
 *  input (see their doc comments) rather than being coerced to 0 -- an f1
 *  computed from a coerced 0 would look like a real (bad) score instead of
 *  "not applicable for this artist". */
export function f1(actual: string[], expected: string[]): number | undefined {
  const p = precision(actual, expected);
  const r = recall(actual, expected);
  if (p === undefined || r === undefined) return undefined;
  if (p + r === 0) return 0;
  return (2 * p * r) / (p + r);
}

/** Share of `actual`'s (normalized) labels that are NOT in `COARSE_GENRES` --
 *  i.e. how "specific" a provider's vocabulary is. `undefined` when `actual`
 *  has no labels at all: with nothing returned there is no vocabulary to
 *  judge the specificity of, and `0` would misleadingly read as "answered,
 *  but only with broad genres". */
export function specificity(actual: string[]): number | undefined {
  const labels = actual.map(normalizeLabel).filter(Boolean);
  if (labels.length === 0) return undefined;
  const specific = labels.filter((l) => !COARSE_GENRES.has(l)).length;
  return specific / labels.length;
}

export interface ProviderScore {
  provider: string;
  /** Total artists in the run, including absent ones. */
  artists: number;
  /** Artists with `actual !== undefined` -- the provider gave *some* answer
   *  (possibly a confirmed empty one). */
  answered: number;
  /** Artists absent from the provider's result (transient failures). */
  absent: number;
  coverage: number;
  /** Macro-average (mean of each answered artist's own precision) rather than
   *  micro/pooled, because pooling every artist's predicted labels into one
   *  set before comparing would let one artist with many predictions swamp
   *  the score for the other 49 -- macro-averaging weights every artist
   *  equally, which matches "does this provider work for a wide range of
   *  artists" better than "does this provider produce a lot of correct
   *  labels in aggregate". Artists whose per-artist precision is `undefined`
   *  (see `precision` above) are excluded from the mean rather than
   *  defaulting to 0. */
  precision: number | undefined;
  recall: number | undefined;
  f1: number | undefined;
  /** Pooled (not macro-averaged) across every returned label from every
   *  answered artist -- unlike precision/recall this is a property of the
   *  provider's *vocabulary*, not of any one artist's answer, so pooling
   *  every label into one set before scoring is the right aggregation here. */
  specificity: number | undefined;
  /** Total genre labels returned across all answered artists (pooled count),
   *  reported for context alongside specificity -- specificity alone can't
   *  distinguish "1 specific label total" from "200 specific labels total". */
  labels: number;
}

/** Aggregates an array of per-artist results into one report row. See each
 *  scorer's own doc comment for how `undefined` and absent-vs-empty are
 *  handled; this function only combines them, it doesn't introduce new
 *  judgment calls. */
export function scoreProvider(provider: string, perArtist: ArtistResult[]): ProviderScore {
  const absent = perArtist.filter((r) => r.actual === undefined).length;
  const answered = perArtist.length - absent;

  const precisions: number[] = [];
  const recalls: number[] = [];
  const f1s: number[] = [];
  const allLabels: string[] = [];
  for (const r of perArtist) {
    if (r.actual === undefined) continue; // no answer to score -- excluded, not defaulted to 0
    allLabels.push(...r.actual);
    const p = precision(r.actual, r.expected);
    if (p !== undefined) precisions.push(p);
    const rec = recall(r.actual, r.expected);
    if (rec !== undefined) recalls.push(rec);
    const f = f1(r.actual, r.expected);
    if (f !== undefined) f1s.push(f);
  }

  const mean = (xs: number[]): number | undefined =>
    xs.length === 0 ? undefined : xs.reduce((sum, x) => sum + x, 0) / xs.length;

  return {
    provider,
    artists: perArtist.length,
    answered,
    absent,
    coverage: coverage(perArtist.map((r) => r.actual)),
    precision: mean(precisions),
    recall: mean(recalls),
    f1: mean(f1s),
    specificity: specificity(allLabels),
    labels: allLabels.length,
  };
}

const pct = (n: number | undefined): string => (n === undefined ? 'n/a' : `${(n * 100).toFixed(1)}%`);

/** Renders scored rows as a markdown table -- meant to be pasted verbatim
 *  into the report (Task 6). */
export function formatTable(rows: ProviderScore[]): string {
  const header = '| provider | artists | answered | absent | coverage | precision | recall | f1 | specificity | labels |';
  const sep = '|---|---|---|---|---|---|---|---|---|---|';
  const body = rows.map((r) =>
    `| ${r.provider} | ${r.artists} | ${r.answered} | ${r.absent} | ${pct(r.coverage)} | `
    + `${pct(r.precision)} | ${pct(r.recall)} | ${pct(r.f1)} | ${pct(r.specificity)} | ${r.labels} |`,
  );
  return [header, sep, ...body].join('\n');
}
