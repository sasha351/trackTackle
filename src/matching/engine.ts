import type { SongMatch } from '../types';

export interface Fingerprint {
  genreWeights: Map<string, number>;
  decadeWeights: Map<number, number>;
  scriptWeights: Map<string, number>;
  countryWeights: Map<string, number>;
  size: number;
  scripted: number;   // songs that carried a script signal
  countried: number;  // songs that carried an ISRC country
}

export const DEFAULT_THRESHOLD = 0.3;

const GENRE_WEIGHT = 0.7;
const ERA_WEIGHT = 0.15;
const LANG_WEIGHT = 0.15;
const LANG_ONLY_CAP = 0.5;

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
  return {
    genreWeights, decadeWeights, scriptWeights, countryWeights,
    size: songs.length, scripted, countried,
  };
}

/** Library-wide signal counts — the base rate a playlist must beat to claim a genreless song. */
export interface SignalBaseline {
  scriptCounts: Map<string, number>;
  scripted: number;
  countryCounts: Map<string, number>;
  countried: number;
}

export function signalBaseline(fingerprints: Iterable<Fingerprint>): SignalBaseline {
  const scriptCounts = new Map<string, number>();
  const countryCounts = new Map<string, number>();
  let scripted = 0;
  let countried = 0;
  for (const fp of fingerprints) {
    for (const [s, w] of fp.scriptWeights) scriptCounts.set(s, (scriptCounts.get(s) ?? 0) + w * fp.scripted);
    for (const [c, w] of fp.countryWeights) countryCounts.set(c, (countryCounts.get(c) ?? 0) + w * fp.countried);
    scripted += fp.scripted;
    countried += fp.countried;
  }
  return { scriptCounts, scripted, countryCounts, countried };
}

// A playlist claims a genreless song only when the song's script/country is
// *distinctive* there: the playlist is mostly that signal AND at least twice
// as concentrated in it as the rest of the library (leave-one-out). Nothing
// language-specific — in a mostly-English library Cyrillic/Hebrew/ES-country
// pass and latin/US fail; in a mostly-Russian library the roles flip.
const langOnlyClaim = (
  weights: Map<string, number>, n: number,
  baseCounts: Map<string, number>, baseN: number,
  key: string | null | undefined,
): number => {
  if (!key) return 0;
  const share = weights.get(key) ?? 0;
  const restN = baseN - n;
  const restShare = restN > 0 ? Math.max(0, (baseCounts.get(key) ?? 0) - share * n) / restN : 0;
  return share >= Math.max(0.5, 2 * restShare) ? share : 0;
};

const magnitude = (weights: Map<string, number>): number =>
  Math.sqrt([...weights.values()].reduce((sum, w) => sum + w * w, 0));

export function scoreSong(song: GenredSong, fp: Fingerprint, baseline?: SignalBaseline): number {
  if (fp.size === 0) return 0;
  const genres = [...new Set(song.genres.map((g) => g.toLowerCase()))];
  if (genres.length === 0) {
    // No genre data → no claim, unless the song's language is distinctive and
    // this playlist is where it concentrates (see langOnlyClaim).
    if (!baseline) return 0;
    return LANG_ONLY_CAP * Math.max(
      langOnlyClaim(fp.scriptWeights, fp.scripted, baseline.scriptCounts, baseline.scripted, song.script),
      langOnlyClaim(fp.countryWeights, fp.countried, baseline.countryCounts, baseline.countried, song.country),
    );
  }
  const dot = genres.reduce((sum, g) => sum + (fp.genreWeights.get(g) ?? 0), 0);
  const fpMagnitude = magnitude(fp.genreWeights);
  const genreScore = fpMagnitude === 0 ? 0 : dot / (Math.sqrt(genres.length) * fpMagnitude);
  const eraScore =
    song.releaseYear != null ? fp.decadeWeights.get(decadeOf(song.releaseYear)) ?? 0 : 0;
  // Language is an additive tiebreak: it separates same-genre playlists in
  // different languages but can never outvote genre. Raw shares — no sqrt
  // inflation of minority scripts.
  const langScore = Math.max(
    song.script ? fp.scriptWeights.get(song.script) ?? 0 : 0,
    song.country ? fp.countryWeights.get(song.country) ?? 0 : 0,
  );
  return GENRE_WEIGHT * genreScore + ERA_WEIGHT * eraScore + LANG_WEIGHT * langScore;
}

export function matchSong(
  song: GenredSong,
  fingerprints: Map<string, Fingerprint>,
  threshold: number,
): SongMatch {
  const baseline = signalBaseline(fingerprints.values());
  const ranked = [...fingerprints]
    .map(([playlistId, fp]) => ({ playlistId, score: scoreSong(song, fp, baseline) }))
    .filter((r) => r.score > 0) // a 0% "best guess" is noise, not a candidate
    .sort((a, b) => b.score - a.score);
  const best = ranked[0] ?? null;
  return {
    best,
    alternates: ranked.slice(1, 5),
    belowThreshold: best === null || best.score < threshold,
  };
}
