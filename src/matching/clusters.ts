import type { Fingerprint } from './engine';

export interface ClusterSuggestion {
  genre: string;
  trackIds: string[];
}

// A genre is "covered" if any existing playlist already carries it at this
// share of its genre-carrying songs. Deliberately below the analyzer's
// BROAD_THRESHOLD (0.3): a playlist too broad to have a real top genre can
// still legitimately own the genres it does carry.
const COVERED_SHARE = 0.2;
// Fingerprints from fewer genre-carrying songs than this aren't enough signal
// to judge coverage by — a 2-track playlist gives every genre it touches a
// 0.5 share and would veto everything. Same floor as the analyzer's MIN_TRACKS.
const MIN_GENRED = 3;

function coveredGenres(fingerprints: Map<string, Fingerprint>): Set<string> {
  const covered = new Set<string>();
  for (const fp of fingerprints.values()) {
    if (fp.genred < MIN_GENRED) continue;
    for (const [genre, weight] of fp.genreWeights) {
      if (weight >= COVERED_SHARE) covered.add(genre);
    }
  }
  return covered;
}

export function suggestClusters(
  songs: { trackId: string; genres: string[] }[],
  minSize = 5,
  fingerprints?: Map<string, Fingerprint>,
): ClusterSuggestion[] {
  const covered = fingerprints ? coveredGenres(fingerprints) : null;
  const remaining = new Map(songs.map((s) => [s.trackId, s] as const));
  const out: ClusterSuggestion[] = [];
  for (;;) {
    const byGenre = new Map<string, string[]>();
    for (const s of remaining.values()) {
      for (const g of new Set(s.genres.map((x) => x.toLowerCase()))) {
        byGenre.set(g, [...(byGenre.get(g) ?? []), s.trackId]);
      }
    }
    // Skipping a covered genre doesn't consume its tracks — they stay in
    // `remaining` so the next iteration can surface a narrower uncovered
    // genre off the same songs (e.g. hyperpop after pop is skipped).
    const candidates = [...byGenre.entries()]
      .filter(([g]) => !covered?.has(g))
      .sort((a, b) => b[1].length - a[1].length);
    const biggest = candidates[0];
    if (!biggest || biggest[1].length < minSize) return out;
    out.push({ genre: biggest[0], trackIds: biggest[1] });
    for (const id of biggest[1]) remaining.delete(id);
  }
}
