/**
 * Library-derived genre context: how *informative* each genre is (IDF) and
 * which genres are *adjacent* to it. Built from the user's own artist→genre
 * map, never from a hand-written table — same reasoning as the script
 * buckets in engine.ts: a curated "shoegaze ~ dream pop" list would encode
 * one listener's taxonomy and silently fail for every genre it forgot, while
 * co-occurrence adapts to whatever sources (Spotify, MusicBrainz, Wikidata)
 * actually tagged this library.
 *
 * Two problems this exists to fix, both visible as "random playlists acting
 * as dumping grounds":
 * 1. Generic tags ("pop", "rock", "electronic") count as much as specific
 *    ones. A song tagged only "pop" scores ~0.85 genre against any playlist
 *    whose fingerprint happens to be pop-heavy, whatever else that playlist
 *    is about. IDF shrinks a tag by how common it is across the library.
 * 2. Exact-string matching gives "shoegaze" zero credit in a "dream pop"
 *    playlist. Adjacency gives it partial credit — kept well below a direct
 *    match so it ranks as an alternate / best guess, not a confident sort.
 */

export interface GenreContext {
  idf: Map<string, number>;
  /** IDF for a genre no artist carries (e.g. a playlist-title hint) — treated as maximally rare. */
  defaultIdf: number;
  /** genre → adjacent genres with a similarity in (0, 1], strongest first. */
  neighbors: Map<string, Array<readonly [string, number]>>;
  /** Fingerprint → IDF-weighted magnitude. Fingerprints are rebuilt (new
   *  objects) whenever genres change, so identity is a safe cache key. */
  magCache: WeakMap<object, number>;
}

// An edge seen on a single artist is one source's tagging habit, not a
// relationship — require it on at least two distinct artists.
const MIN_COOCCUR = 2;
// Cosine over artist incidence: |A∩B| / sqrt(|A|·|B|). Normalizing by both
// sides is what stops "pop" — which co-occurs with almost everything — from
// becoming adjacent to almost everything. Below this the link is noise.
const MIN_SIM = 0.2;
// ponytail: fixed similarity for a head-word link ("uk drill" → "drill",
// "dream pop" → "pop"). A guess, not tuned — it exists so sparse libraries
// (MusicBrainz often returns 1–3 tags per artist) still get *some* adjacency
// where co-occurrence has too few samples. Co-occurrence wins when stronger.
const HEAD_SIM = 0.4;
const MAX_NEIGHBORS = 8;
// Pair counting is quadratic per artist; no real artist carries this many,
// but a pathological tag dump shouldn't stall the build.
const MAX_GENRES_PER_ARTIST = 20;

const idfOf = (n: number, df: number) => Math.log((1 + n) / (1 + df)) + 1;

export function buildGenreContext(genresByArtist: Iterable<string[]>): GenreContext {
  const df = new Map<string, number>();
  const pairs = new Map<string, Map<string, number>>();
  const bump = (a: string, b: string) => {
    let row = pairs.get(a);
    if (!row) pairs.set(a, row = new Map());
    row.set(b, (row.get(b) ?? 0) + 1);
  };
  let n = 0;
  for (const raw of genresByArtist) {
    const gs = [...new Set(raw.map((g) => g.toLowerCase()))].slice(0, MAX_GENRES_PER_ARTIST);
    if (gs.length === 0) continue;
    n += 1;
    for (const g of gs) df.set(g, (df.get(g) ?? 0) + 1);
    for (let i = 0; i < gs.length; i++) {
      for (let j = i + 1; j < gs.length; j++) {
        bump(gs[i], gs[j]);
        bump(gs[j], gs[i]);
      }
    }
  }

  const idf = new Map([...df].map(([g, d]) => [g, idfOf(n, d)] as const));

  const sims = new Map<string, Map<string, number>>();
  const link = (a: string, b: string, s: number) => {
    let row = sims.get(a);
    if (!row) sims.set(a, row = new Map());
    if (s > (row.get(b) ?? 0)) row.set(b, s);
  };
  for (const [a, row] of pairs) {
    for (const [b, co] of row) {
      if (co < MIN_COOCCUR) continue;
      const s = co / Math.sqrt(df.get(a)! * df.get(b)!);
      if (s >= MIN_SIM) link(a, b, s);
    }
  }
  // Head-word links: the longest proper word-suffix of a genre that is itself
  // a genre in this library. Symmetric, so a "pop" song also gets partial
  // credit in a "dream pop" playlist — IDF keeps that from being a hotspot,
  // since the generic side is the cheap one.
  for (const g of df.keys()) {
    const words = g.split(' ');
    for (let i = 1; i < words.length; i++) {
      const head = words.slice(i).join(' ');
      if (df.has(head)) {
        link(g, head, HEAD_SIM);
        link(head, g, HEAD_SIM);
        break;
      }
    }
  }

  const neighbors = new Map(
    [...sims].map(([g, row]) => [
      g,
      [...row].sort((x, y) => y[1] - x[1]).slice(0, MAX_NEIGHBORS),
    ] as const),
  );
  return { idf, defaultIdf: idfOf(n, 0), neighbors, magCache: new WeakMap() };
}
