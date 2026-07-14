import type { SongMatch } from '../types';

export interface Fingerprint {
  genreWeights: Map<string, number>;
  decadeWeights: Map<number, number>;
  size: number;
}

export const DEFAULT_THRESHOLD = 0.3;

const GENRE_WEIGHT = 0.85;
const ERA_WEIGHT = 0.15;

const decadeOf = (year: number) => Math.floor(year / 10) * 10;

interface GenredSong {
  genres: string[];
  releaseYear: number | null;
}

export function buildFingerprint(songs: GenredSong[]): Fingerprint {
  const genreCounts = new Map<string, number>();
  const decadeCounts = new Map<number, number>();
  for (const s of songs) {
    for (const g of new Set(s.genres.map((x) => x.toLowerCase()))) {
      genreCounts.set(g, (genreCounts.get(g) ?? 0) + 1);
    }
    if (s.releaseYear != null) {
      const d = decadeOf(s.releaseYear);
      decadeCounts.set(d, (decadeCounts.get(d) ?? 0) + 1);
    }
  }
  const genreWeights = new Map(
    [...genreCounts].map(([g, n]) => [g, n / songs.length] as const),
  );
  const decadeWeights = new Map(
    [...decadeCounts].map(([d, n]) => [d, n / songs.length] as const),
  );
  return { genreWeights, decadeWeights, size: songs.length };
}

export function scoreSong(song: GenredSong, fp: Fingerprint): number {
  const genres = [...new Set(song.genres.map((g) => g.toLowerCase()))];
  if (genres.length === 0 || fp.size === 0) return 0;
  const genreScore =
    genres.reduce((sum, g) => sum + (fp.genreWeights.get(g) ?? 0), 0) / genres.length;
  const eraScore =
    song.releaseYear != null ? fp.decadeWeights.get(decadeOf(song.releaseYear)) ?? 0 : 0;
  return Math.min(1, GENRE_WEIGHT * genreScore + ERA_WEIGHT * eraScore);
}

export function matchSong(
  song: GenredSong,
  fingerprints: Map<string, Fingerprint>,
  threshold: number,
): SongMatch {
  const ranked = [...fingerprints]
    .map(([playlistId, fp]) => ({ playlistId, score: scoreSong(song, fp) }))
    .sort((a, b) => b.score - a.score);
  const best = ranked[0] ?? null;
  return {
    best,
    alternates: ranked.slice(1, 3),
    belowThreshold: best === null || best.score < threshold,
  };
}
