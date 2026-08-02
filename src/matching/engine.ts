import type { SongMatch } from '../types';

export interface Fingerprint {
  genreWeights: Map<string, number>;
  decadeWeights: Map<number, number>;
  scriptWeights: Map<string, number>;
  countryWeights: Map<string, number>;
  size: number;
  scripted: number;   // songs that carried a script signal
  countried: number;  // songs that carried an ISRC country
  genred: number;     // songs that carried ≥1 genre
}

export const DEFAULT_THRESHOLD = 0.3;
// Below this, a "best guess" is worse than no guess — suppress it entirely
// rather than dim-render noise, so the row falls back to the plain add-to-
// playlist menu (matchSong returns best: null, same as the no-candidates case).
export const MIN_GUESS = 0.2;

const GENRE_WEIGHT = 0.65;
const ERA_WEIGHT = 0.2;
const LANG_WEIGHT = 0.15;
// Kept low: a language-only claim should barely clear DEFAULT_THRESHOLD as a
// grey best-guess, never read as a confident match the way a real genre
// overlap does.
const LANG_ONLY_CAP = 0.35;
// A playlist this concentrated in one script/country that the song shares
// none of gets a heavy penalty rather than a hard veto — see explainScore.
const LANG_MISMATCH_SHARE = 0.7;
const LANG_MISMATCH_PENALTY = 0.25;
// ponytail: hint weight is a guess pending real tuning — a title/description
// match is weaker evidence than a resolved artist genre.
const HINT_WEIGHT_FRACTION = 0.25;

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
  artists: { name: string }[],
  title: string,
  isrc: string | null,
): { script: string | null; country: string | null } => {
  const artistText = artists.map((a) => a.name).join(' ');
  const artistScript = dominantScript(artistText);
  // Artist name is the primary anchor — stable across their catalog — but
  // Spotify routinely transliterates non-Latin artist names to Latin while
  // leaving the track title in its native script (K-pop, J-pop, Russian pop
  // artist pages are almost all Latin-lettered on Spotify). So only fall back
  // to the title when the artist name itself carries no non-Latin signal —
  // a translated/English title can't override a real artist-name script,
  // it can only fill in when the artist name is silent.
  const script = artistScript && artistScript !== 'latin'
    ? artistScript
    : dominantScript(`${artistText} ${title}`) ?? artistScript;
  return { script, country: isrc ? isrc.slice(0, 2).toUpperCase() : null };
};

interface GenredSong {
  genres: string[];
  releaseYear: number | null;
  script?: string | null;
  country?: string | null;
}

export function buildFingerprint(songs: GenredSong[], hints: string[] = []): Fingerprint {
  const genreCounts = new Map<string, number>();
  const decadeCounts = new Map<number, number>();
  const scriptCounts = new Map<string, number>();
  const countryCounts = new Map<string, number>();
  let scripted = 0;
  let countried = 0;
  let genred = 0;
  for (const s of songs) {
    const gset = new Set(s.genres.map((x) => x.toLowerCase()));
    if (gset.size > 0) genred += 1;
    for (const g of gset) {
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
  // Playlist title/description hints seed genreCounts (and genred, so they're
  // normalized the same way real genre data is) — a "Lo-fi Study" playlist
  // with no resolved artist genres still ranks. See HINT_WEIGHT_FRACTION.
  if (hints.length > 0 && songs.length > 0) {
    const hintWeight = songs.length * HINT_WEIGHT_FRACTION;
    for (const h of hints) genreCounts.set(h, (genreCounts.get(h) ?? 0) + hintWeight);
    genred += hintWeight;
  }
  // Normalized by genred (songs carrying ≥1 genre), like script/country below.
  // scoreSong is unaffected — cosine similarity is scale-invariant — but a raw
  // share read (the analyzer) would otherwise be deflated by sparse coverage.
  const genreWeights = new Map(
    [...genreCounts].map(([g, n]) => [g, genred > 0 ? n / genred : 0] as const),
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
    size: songs.length, scripted, countried, genred,
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
// A %-based claim needs enough samples before it means anything — a 1-song
// playlist is trivially "100% Cyrillic" by the same math as a 50-song one.
// Same floor as the analyzer's MIN_TRACKS.
const MIN_LANG_SAMPLES = 3;

const langOnlyClaim = (
  weights: Map<string, number>, n: number,
  baseCounts: Map<string, number>, baseN: number,
  key: string | null | undefined,
): number => {
  if (!key || n < MIN_LANG_SAMPLES) return 0;
  const share = weights.get(key) ?? 0;
  const restN = baseN - n;
  const restShare = restN > 0 ? Math.max(0, (baseCounts.get(key) ?? 0) - share * n) / restN : 0;
  // Overwhelmingly one script/country, not just "more than the library
  // average" — a moderately-skewed playlist no longer qualifies.
  return share >= Math.max(0.7, 3 * restShare) ? share : 0;
};

const magnitude = (weights: Map<string, number>): number =>
  Math.sqrt([...weights.values()].reduce((sum, w) => sum + w * w, 0));

export interface ScoreBreakdown {
  total: number;
  genre: number; // weighted genre contribution (already ×GENRE_WEIGHT, and any langPenalty)
  era: number;   // weighted era contribution (already ×ERA_WEIGHT, and any langPenalty)
  lang: number;  // weighted language contribution (already ×LANG_WEIGHT, or the lang-only claim)
  langPenalty: number; // 1 normally, LANG_MISMATCH_PENALTY when the playlist's dominant language shares nothing with the song
  overlap: string[]; // genres the song and playlist share
  songGenres: number;
  fpGenres: number;
}

const dominant = (weights: Map<string, number>): [string, number] | null => {
  let best: [string, number] | null = null;
  for (const entry of weights) if (!best || entry[1] > best[1]) best = entry;
  return best;
};

// A playlist that is overwhelmingly one script or one ISRC country, and a
// song that shares neither, gets suppressed hard rather than ranking on
// genre alone. Matching on *either* axis (see Molchat Doma in the tests —
// transliterated latin script, but the ISRC country still reads Russian)
// avoids the penalty, same as the additive langScore below.
const hasLangMismatch = (fp: Fingerprint, langScore: number): boolean => {
  const domScript = dominant(fp.scriptWeights);
  const domCountry = dominant(fp.countryWeights);
  const dominated = (domScript?.[1] ?? 0) >= LANG_MISMATCH_SHARE || (domCountry?.[1] ?? 0) >= LANG_MISMATCH_SHARE;
  return dominated && langScore === 0;
};

/** Single source of truth for scoring — scoreSong is just `.total`, so there is no parallel copy to drift. */
export function explainScore(song: GenredSong, fp: Fingerprint, baseline?: SignalBaseline): ScoreBreakdown {
  const fpGenres = fp.genreWeights.size;
  const empty = (lang: number): ScoreBreakdown =>
    ({ total: lang, genre: 0, era: 0, lang, langPenalty: 1, overlap: [], songGenres: 0, fpGenres });
  if (fp.size === 0) return empty(0);

  const genres = [...new Set(song.genres.map((g) => g.toLowerCase()))];
  const hasGenres = genres.length > 0;

  const dot = genres.reduce((sum, g) => sum + (fp.genreWeights.get(g) ?? 0), 0);
  const fpMagnitude = magnitude(fp.genreWeights);
  const genreScore = !hasGenres || fpMagnitude === 0 ? 0 : dot / (Math.sqrt(genres.length) * fpMagnitude);
  // Bleeds into neighbouring decades so a boundary year (a 1979 song against a
  // playlist full of 1980s) isn't punished to zero for missing a hard cliff.
  // Computed regardless of genre presence — a genreless song is still ranked
  // by era, same as a wrong-genre song already is; only genre itself goes to 0.
  const w = (d: number) => fp.decadeWeights.get(d) ?? 0;
  const eraScore = song.releaseYear == null ? 0 : (() => {
    const d = decadeOf(song.releaseYear!);
    return Math.min(1, w(d) + 0.5 * (w(d - 10) + w(d + 10)));
  })();
  // Language is normally an additive tiebreak: it separates same-genre
  // playlists in different languages but can never outvote genre on its own.
  // Raw shares — no sqrt inflation of minority scripts.
  const langScore = Math.max(
    song.script ? fp.scriptWeights.get(song.script) ?? 0 : 0,
    song.country ? fp.countryWeights.get(song.country) ?? 0 : 0,
  );
  const langPenalty = hasLangMismatch(fp, langScore) ? LANG_MISMATCH_PENALTY : 1;
  const genre = GENRE_WEIGHT * genreScore * langPenalty;
  const era = ERA_WEIGHT * eraScore * langPenalty;
  // With no genre signal at all, language becomes the strongest available
  // claim (see langOnlyClaim) instead of a mere tiebreak — but only when a
  // baseline exists to judge distinctiveness against.
  const lang = hasGenres || !baseline
    ? LANG_WEIGHT * langScore * langPenalty
    : LANG_ONLY_CAP * Math.max(
      langOnlyClaim(fp.scriptWeights, fp.scripted, baseline.scriptCounts, baseline.scripted, song.script),
      langOnlyClaim(fp.countryWeights, fp.countried, baseline.countryCounts, baseline.countried, song.country),
    );
  const overlap = genres.filter((g) => (fp.genreWeights.get(g) ?? 0) > 0);
  return { total: genre + era + lang, genre, era, lang, langPenalty, overlap, songGenres: genres.length, fpGenres };
}

export function scoreSong(song: GenredSong, fp: Fingerprint, baseline?: SignalBaseline): number {
  return explainScore(song, fp, baseline).total;
}

export function matchSong(
  song: GenredSong,
  fingerprints: Map<string, Fingerprint>,
  threshold: number,
  /** Playlists the song already belongs to — excluded from ranking, since
   *  suggesting a song's current playlist back to itself wastes a candidate
   *  slot on a choice that's already made (and often outranks real
   *  suggestions, since the song helped build that playlist's fingerprint). */
  alreadyIn?: Set<string>,
): SongMatch {
  const baseline = signalBaseline(fingerprints.values());
  const ranked = [...fingerprints]
    .filter(([playlistId]) => !alreadyIn?.has(playlistId))
    .map(([playlistId, fp]) => {
      const breakdown = explainScore(song, fp, baseline);
      return { playlistId, score: breakdown.total, breakdown };
    })
    .filter((r) => r.score >= MIN_GUESS) // below this a "best guess" is noise, not a candidate
    .sort((a, b) => b.score - a.score);
  const best = ranked[0] ?? null;
  return {
    best,
    alternates: ranked.slice(1, 4), // 4 total shown, incl. best
    belowThreshold: best === null || best.score < threshold,
  };
}
