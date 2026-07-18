import type { SongMatch } from '../types';

export interface Fingerprint {
  genreWeights: Map<string, number>;
  decadeWeights: Map<number, number>;
  scriptWeights: Map<string, number>;
  countryWeights: Map<string, number>;
  size: number;
}

export const DEFAULT_THRESHOLD = 0.3;

const GENRE_WEIGHT = 0.85;
const ERA_WEIGHT = 0.15;
const LANG_FLOOR = 0.3;
const NO_GENRE_CAP = 0.6;

const decadeOf = (year: number) => Math.floor(year / 10) * 10;

// Script buckets, not a language list — stays language-agnostic.
const SCRIPTS: Record<string, RegExp> = {
  cyrillic: /\p{Script=Cyrillic}/gu,
  greek: /\p{Script=Greek}/gu,
  hebrew: /\p{Script=Hebrew}/gu,
  arabic: /\p{Script=Arabic}/gu,
  han: /\p{Script=Han}/gu,
  kana: /[\p{Script=Hiragana}\p{Script=Katakana}]/gu,
  hangul: /\p{Script=Hangul}/gu,
  thai: /\p{Script=Thai}/gu,
  devanagari: /\p{Script=Devanagari}/gu,
};

export function dominantScript(text: string): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const [name, re] of Object.entries(SCRIPTS)) {
    const count = text.match(re)?.length ?? 0;
    if (count > bestCount) {
      best = name;
      bestCount = count;
    }
  }
  // Latin only wins by default: Spotify transliterates non-Latin artist names
  // ("Mikhail Krug"), so any non-Latin chars are the stronger signal even when
  // outnumbered — "Фраер Mikhail Krug" is cyrillic, not latin.
  return best ?? (/\p{Script=Latin}/u.test(text) ? 'latin' : null);
}

export const langSignals = (
  name: string,
  artists: { name: string }[],
  isrc: string | null,
): { script: string | null; country: string | null } => ({
  script: dominantScript(`${name} ${artists.map((a) => a.name).join(' ')}`),
  country: isrc ? isrc.slice(0, 2).toUpperCase() : null,
});

interface GenredSong {
  genres: string[];
  releaseYear: number | null;
  script?: string | null;
  country?: string | null;
}

export function buildFingerprint(songs: GenredSong[]): Fingerprint {
  const genreCounts = new Map<string, number>();
  const decadeCounts = new Map<number, number>();
  const scriptCounts = new Map<string, number>();
  const countryCounts = new Map<string, number>();
  let scripted = 0;
  let countried = 0;
  for (const s of songs) {
    for (const g of new Set(s.genres.map((x) => x.toLowerCase()))) {
      genreCounts.set(g, (genreCounts.get(g) ?? 0) + 1);
    }
    if (s.releaseYear != null) {
      const d = decadeOf(s.releaseYear);
      decadeCounts.set(d, (decadeCounts.get(d) ?? 0) + 1);
    }
    if (s.script) {
      scriptCounts.set(s.script, (scriptCounts.get(s.script) ?? 0) + 1);
      scripted += 1;
    }
    if (s.country) {
      countryCounts.set(s.country, (countryCounts.get(s.country) ?? 0) + 1);
      countried += 1;
    }
  }
  const genreWeights = new Map(
    [...genreCounts].map(([g, n]) => [g, n / songs.length] as const),
  );
  const decadeWeights = new Map(
    [...decadeCounts].map(([d, n]) => [d, n / songs.length] as const),
  );
  // ponytail: normalized by songs *with* the signal, not songs.length — sparse
  // ISRC coverage would otherwise deflate langSim even for a pure playlist.
  const scriptWeights = new Map(
    [...scriptCounts].map(([s, n]) => [s, n / scripted] as const),
  );
  const countryWeights = new Map(
    [...countryCounts].map(([c, n]) => [c, n / countried] as const),
  );
  return { genreWeights, decadeWeights, scriptWeights, countryWeights, size: songs.length };
}

const magnitude = (weights: Map<string, number>): number =>
  Math.sqrt([...weights.values()].reduce((sum, w) => sum + w * w, 0));

export function scoreSong(song: GenredSong, fp: Fingerprint): number {
  const genres = [...new Set(song.genres.map((g) => g.toLowerCase()))];
  if (fp.size === 0) return 0;
  const dot = genres.reduce((sum, g) => sum + (fp.genreWeights.get(g) ?? 0), 0);
  const fpMagnitude = magnitude(fp.genreWeights);
  const genreScore =
    genres.length === 0 || fpMagnitude === 0 ? 0 : dot / (Math.sqrt(genres.length) * fpMagnitude);
  const eraScore =
    song.releaseYear != null ? fp.decadeWeights.get(decadeOf(song.releaseYear)) ?? 0 : 0;
  if (genres.length === 0) {
    // No genre data: language stands in for genre — but only *distinctive*
    // signals count. Latin script is the majority default (Spotify
    // transliterates non-Latin names), so it would claim every latin-heavy
    // playlist at ~99%. No distinctive signal → no claim.
    const evidence: number[] = [];
    if (song.script && song.script !== 'latin' && fp.scriptWeights.size) {
      evidence.push(Math.sqrt(fp.scriptWeights.get(song.script) ?? 0));
    }
    if (song.country && fp.countryWeights.size) {
      evidence.push(Math.sqrt(fp.countryWeights.get(song.country) ?? 0));
    }
    if (evidence.length === 0) return 0;
    // ponytail: flat cap — language alone is a hint, never 99% proof. Country
    // shares latin's base-rate problem (US-heavy libraries); upgrade to an
    // IDF-style rarity weight if it still over-claims.
    return NO_GENRE_CAP * Math.min(1, GENRE_WEIGHT * Math.max(...evidence) + ERA_WEIGHT * eraScore);
  }
  const sims: number[] = [];
  if (song.script && fp.scriptWeights.size) sims.push(Math.sqrt(fp.scriptWeights.get(song.script) ?? 0));
  if (song.country && fp.countryWeights.size) sims.push(Math.sqrt(fp.countryWeights.get(song.country) ?? 0));
  const langSim = sims.length ? Math.max(...sims) : 1;
  return Math.min(1, GENRE_WEIGHT * genreScore + ERA_WEIGHT * eraScore)
    * (LANG_FLOOR + (1 - LANG_FLOOR) * langSim);
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
    alternates: ranked.slice(1, 5),
    belowThreshold: best === null || best.score < threshold,
  };
}
