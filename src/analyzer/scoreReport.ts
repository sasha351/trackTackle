import type { Fingerprint } from '../matching/engine';
import type { MatchResult, SongMatch, Track } from '../types';

const BUCKET = 0.05;

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

const median = (xs: number[]) => {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const pct = (n: number, total: number) => (total > 0 ? Math.round((n / total) * 100) : 0);

/**
 * DEV diagnostic: where best-match scores actually land over the real library,
 * and what's driving them (genre/era/lang). Read-only — informs whether the
 * scoring weights or genre granularity need to change; changes nothing itself.
 */
export function buildScoreReport(
  tracks: Track[],
  matches: Map<string, SongMatch>,
  fingerprints: Map<string, Fingerprint>,
  genresByTrack: Map<string, string[]>,
  playlistNames: Map<string, string>,
): string[] {
  const lines: string[] = [];
  const scored = tracks
    .map((t) => matches.get(t.id)?.best)
    .filter((b): b is MatchResult & { breakdown: NonNullable<MatchResult['breakdown']> } =>
      b != null && b.breakdown != null);

  lines.push(`${scored.length} of ${tracks.length} tracks have a best-match candidate`);

  const buckets = new Map<number, number>();
  for (const b of scored) {
    const bucket = Math.min(0.95, Math.floor(b.score / BUCKET) * BUCKET);
    const key = Number(bucket.toFixed(2));
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  lines.push('', 'Best-match score histogram (0.05 buckets):');
  for (let b = 0; b < 1; b += BUCKET) {
    const bucket = Number(b.toFixed(2));
    const count = buckets.get(bucket) ?? 0;
    if (count > 0) {
      lines.push(`  ${bucket.toFixed(2)}-${(bucket + BUCKET).toFixed(2)}: ${'#'.repeat(Math.min(count, 50))} (${count})`);
    }
  }

  const genres = scored.map((b) => b.breakdown.genre);
  const eras = scored.map((b) => b.breakdown.era);
  const langs = scored.map((b) => b.breakdown.lang);
  lines.push(
    '',
    `Genre contribution — mean ${mean(genres).toFixed(3)}, median ${median(genres).toFixed(3)}`,
    `Era contribution   — mean ${mean(eras).toFixed(3)}, median ${median(eras).toFixed(3)}`,
    `Lang contribution  — mean ${mean(langs).toFixed(3)}, median ${median(langs).toFixed(3)}`,
  );

  const zeroOverlap = scored.filter((b) => b.breakdown.overlap.length === 0).length;
  lines.push(
    '',
    `${zeroOverlap} of ${scored.length} best matches (${pct(zeroOverlap, scored.length)}%) share zero genres — scoring on era/lang alone`,
  );

  const genreCounts = tracks.map((t) => genresByTrack.get(t.id)?.length ?? 0);
  const withGenre = genreCounts.filter((n) => n > 0).length;
  lines.push(
    '',
    `Genre coverage: ${withGenre} of ${tracks.length} tracks (${pct(withGenre, tracks.length)}%) carry ≥1 genre`,
    `Mean genres per song: ${mean(genreCounts).toFixed(2)}`,
  );

  lines.push('', 'Distinct genres per playlist:');
  for (const [playlistId, fp] of fingerprints) {
    lines.push(`  ${playlistNames.get(playlistId) ?? playlistId}: ${fp.genreWeights.size} distinct genres, ${fp.size} tracks`);
  }

  return lines;
}
