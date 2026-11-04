// ListenBrainz "similar artists": collaborative filtering over real listening
// sessions — the closest free analogue to how Spotify derives its genres. An
// artist no tagger has touched can still borrow genres from the tagged artists
// people listen to alongside it.
//
// ponytail: this is the *labs* API — no stability promise, no documented rate
// limit, and the response shape below is parsed defensively rather than
// trusted (a real-library diagnostic run confirmed the flat-array shape). Used
// by deep runs (src/genre/enrich.ts) and the DEV genre-gap diagnostic. If it
// ever moves or dies, enrich.ts reports the artists as failed — they stay
// re-checkable, nothing durable is cached from a dead endpoint.

const LB_LABS = 'https://labs.api.listenbrainz.org';

// The dataset ListenBrainz's own artist pages use: 7500 days of listens,
// 300 s session gap, top 100 neighbours. A wrong name is a 400, which the
// diagnostic prints verbatim rather than guessing at.
export const SIMILAR_ARTISTS_ALGORITHM =
  'session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30';

export interface SimilarArtist { mbid: string; name: string; score: number }

export class ListenBrainzError extends Error {
  readonly status: number;
  constructor(status: number, body: string) {
    super(`ListenBrainz ${status}: ${body.slice(0, 160)}`);
    this.status = status;
  }
}

// Collect every object carrying an `artist_mbid` wherever it sits — a flat
// array, or wrapped in a { type: 'dataset', data: [...] } envelope as some
// labs endpoints do.
function collect(node: unknown, out: SimilarArtist[]): void {
  if (Array.isArray(node)) {
    for (const n of node) collect(n, out);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const o = node as Record<string, unknown>;
  if (typeof o.artist_mbid === 'string') {
    out.push({
      mbid: o.artist_mbid,
      name: typeof o.name === 'string' ? o.name : '',
      score: typeof o.score === 'number' ? o.score : 0,
    });
    return;
  }
  for (const v of Object.values(o)) collect(v, out);
}

/** Neighbours of one artist, highest score first, the artist itself excluded. */
export async function similarArtists(mbid: string): Promise<SimilarArtist[]> {
  const url = `${LB_LABS}/similar-artists/json?artist_mbids=${encodeURIComponent(mbid)}`
    + `&algorithm=${SIMILAR_ARTISTS_ALGORITHM}`;
  const res = await fetch(url);
  if (!res.ok) throw new ListenBrainzError(res.status, await res.text().catch(() => ''));
  const found: SimilarArtist[] = [];
  collect(await res.json(), found);
  const seen = new Set<string>([mbid]);
  const unique = found.filter((a) => {
    if (seen.has(a.mbid)) return false;
    seen.add(a.mbid);
    return true;
  });
  return unique.sort((a, b) => b.score - a.score);
}

/** Genres an artist borrows from its tagged neighbours. A genre needs at
 *  least `minVotes` neighbours behind it, so one mis-tagged neighbour can't
 *  label an artist on its own; votes are score-weighted, top 5 kept. */
export function genresFromNeighbours(
  neighbours: SimilarArtist[],
  genresOf: (mbid: string) => string[] | undefined,
  { topN = 10, minVotes = 2 } = {},
): string[] {
  const weight = new Map<string, number>();
  const votes = new Map<string, number>();
  for (const n of neighbours.slice(0, topN)) {
    for (const g of genresOf(n.mbid) ?? []) {
      weight.set(g, (weight.get(g) ?? 0) + (n.score || 1));
      votes.set(g, (votes.get(g) ?? 0) + 1);
    }
  }
  return [...weight]
    .filter(([g]) => (votes.get(g) ?? 0) >= minVotes)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([g]) => g);
}
