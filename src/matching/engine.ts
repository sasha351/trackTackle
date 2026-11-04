import type { SongMatch } from '../types';
import type { GenreContext } from './genreGraph';

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

export const DEFAULT_THRESHOLD = 0.7;
// Below this, a "best guess" is worse than no guess — suppress it entirely
// rather than dim-render noise, so the row falls back to the plain add-to-
// playlist menu (matchSong returns best: null, same as the no-candidates case).
export const MIN_GUESS = 0.2;

const GENRE_WEIGHT = 0.65;
const ERA_WEIGHT = 0.2;
const LANG_WEIGHT = 0.15;
// A playlist this concentrated in one script/country that the song shares
// none of gets a heavy penalty rather than a hard veto — see explainScore.
const LANG_MISMATCH_SHARE = 0.7;
const LANG_MISMATCH_PENALTY = 0.25;
// ponytail: hint weight is a guess pending real tuning — a title/description
// match is weaker evidence than a resolved artist genre.
const HINT_WEIGHT_FRACTION = 0.25;
// An adjacent genre counts at most half a direct one (before its similarity
// is applied), so adjacency alone lands a song in best-guess range, never
// above a playlist that actually carries the song's own genres.
const ADJ_WEIGHT = 0.5;
// Bayesian-style shrinkage on the genre score: a fingerprint built from k
// genre-carrying songs is trusted k/(k+PRIOR_SONGS). A 1-song playlist is a
// perfect cosine match for every song sharing that one song's tags — that is
// what turns tiny playlists into dumping grounds. 1 song → ×0.33, 5 → ×0.71,
// 20 → ×0.91, 50 → ×0.96.
// ponytail: 2 is a guess pending a real library run (see scoreReport's
// hotspot section); raise it if tiny playlists still top that list.
const PRIOR_SONGS = 2;
// An adjacency-only match (no shared genre at all) below this cosine is
// dropped to 0. Without the floor, any faint link makes `genre > 0`, which
// un-gates era (+0.2) and re-creates the flood of identical era-driven best
// guesses that the era gate exists to stop. A strong neighbour (sim ≈ 0.6
// against a playlist built on it) clears this; a head-word link alone
// (HEAD_SIM) against a playlist with none of the song's own genres does not.
const ADJ_ONLY_FLOOR = 0.2;

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

const magnitude = (weights: Map<string, number>): number =>
  Math.sqrt([...weights.values()].reduce((sum, w) => sum + w * w, 0));

/** Legacy exact-string cosine — what scoring is without a GenreContext. */
function plainGenreScore(genres: string[], fp: Fingerprint): number {
  const dot = genres.reduce((sum, g) => sum + (fp.genreWeights.get(g) ?? 0), 0);
  const fpMagnitude = magnitude(fp.genreWeights);
  return genres.length === 0 || fpMagnitude === 0 ? 0 : dot / (Math.sqrt(genres.length) * fpMagnitude);
}

/** Cosine between an IDF-weighted, adjacency-expanded song vector and the
 *  IDF-weighted fingerprint, shrunk by fingerprint size. A true cosine (the
 *  expanded song vector's own magnitude in the denominator), so adjacency
 *  slightly dilutes a direct match rather than ever pushing a score past 1 —
 *  an asymmetric "own genres only" norm let broad playlists that carry many
 *  neighbours climb back up as hotspots. */
function contextGenreScore(
  genres: string[], fp: Fingerprint, ctx: GenreContext,
): { score: number; adjacent: string[] } {
  if (genres.length === 0 || fp.genred === 0) return { score: 0, adjacent: [] };
  const idf = (g: string) => ctx.idf.get(g) ?? ctx.defaultIdf;

  const own = new Set(genres);
  const vec = new Map<string, number>(genres.map((g) => [g, idf(g)]));
  for (const g of genres) {
    for (const [nb, sim] of ctx.neighbors.get(g) ?? []) {
      if (own.has(nb)) continue;
      const v = ADJ_WEIGHT * sim * idf(nb);
      if (v > (vec.get(nb) ?? 0)) vec.set(nb, v);
    }
  }

  let fpMag = ctx.magCache.get(fp);
  if (fpMag === undefined) {
    fpMag = Math.sqrt([...fp.genreWeights].reduce((sum, [g, w]) => sum + (w * idf(g)) ** 2, 0));
    ctx.magCache.set(fp, fpMag);
  }
  if (fpMag === 0) return { score: 0, adjacent: [] };

  let dot = 0;
  let songMag = 0;
  const adjacent: string[] = [];
  for (const [g, v] of vec) {
    songMag += v * v;
    const w = fp.genreWeights.get(g) ?? 0;
    if (w === 0) continue;
    dot += v * w * idf(g);
    if (!own.has(g)) adjacent.push(g);
  }
  const cosine = dot / (Math.sqrt(songMag) * fpMag);
  const directHit = genres.some((g) => (fp.genreWeights.get(g) ?? 0) > 0);
  if (!directHit && cosine < ADJ_ONLY_FLOOR) return { score: 0, adjacent: [] };
  return { score: cosine * (fp.genred / (fp.genred + PRIOR_SONGS)), adjacent };
}

export interface ScoreBreakdown {
  total: number;
  genre: number; // weighted genre contribution (already ×GENRE_WEIGHT, and any langPenalty)
  era: number;   // weighted era contribution (already ×ERA_WEIGHT, and any langPenalty)
  lang: number;  // weighted language contribution (already ×LANG_WEIGHT)
  langPenalty: number; // 1 normally, LANG_MISMATCH_PENALTY when the playlist's dominant language shares nothing with the song
  overlap: string[]; // genres the song and playlist share
  adjacent?: string[]; // genres the playlist carries that are only *adjacent* to the song's (GenreContext)
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
export function explainScore(
  song: GenredSong, fp: Fingerprint, ctx?: GenreContext,
): ScoreBreakdown {
  const fpGenres = fp.genreWeights.size;
  const genres = [...new Set(song.genres.map((g) => g.toLowerCase()))];
  // A song with no genres — whether still `unresolved` or a durable `none`
  // after both resolver passes — is never recommended anywhere. Era and
  // language are modifiers on genre evidence, never evidence on their own:
  // the old language-only claim (a mostly-Cyrillic playlist claiming any
  // genreless Cyrillic song) put songs in playlists on script alone, which
  // is a guess the user can't tell apart from a real match.
  if (fp.size === 0 || genres.length === 0) {
    return { total: 0, genre: 0, era: 0, lang: 0, langPenalty: 1, overlap: [], songGenres: genres.length, fpGenres };
  }

  const { score: genreScore, adjacent } = ctx
    ? contextGenreScore(genres, fp, ctx)
    : { score: plainGenreScore(genres, fp), adjacent: [] as string[] };
  // Bleeds into neighbouring decades so a boundary year (a 1979 song against a
  // playlist full of 1980s) isn't punished to zero for missing a hard cliff.
  // era is a modifier on evidence, never evidence itself: alone it equals
  // exactly MIN_GUESS (both are 0.2), which would flood the list with
  // identical 20% "best guesses" for whichever playlist holds the most songs
  // from that decade. See the `genre > 0` gate on `era` below.
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
  // Gated on a real genre match — see the comment above eraScore.
  const era = genre > 0 ? ERA_WEIGHT * eraScore * langPenalty : 0;
  const lang = LANG_WEIGHT * langScore * langPenalty;
  const overlap = genres.filter((g) => (fp.genreWeights.get(g) ?? 0) > 0);
  return {
    total: genre + era + lang, genre, era, lang, langPenalty, overlap, adjacent,
    songGenres: genres.length, fpGenres,
  };
}

export function scoreSong(song: GenredSong, fp: Fingerprint, ctx?: GenreContext): number {
  return explainScore(song, fp, ctx).total;
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
  // Library-wide IDF + genre adjacency (genreGraph.ts). Optional so callers
  // and tests without a whole library keep the plain exact-match cosine.
  ctx?: GenreContext,
): SongMatch {
  const ranked = [...fingerprints]
    .filter(([playlistId]) => !alreadyIn?.has(playlistId))
    .map(([playlistId, fp]) => {
      const breakdown = explainScore(song, fp, ctx);
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
