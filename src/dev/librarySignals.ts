// DEV-only, network-free: measures "option 1" — what the user's own library
// already says about artists no free database knows. Run as part of the
// genre-gap diagnostic, before any of these becomes a real source.
//
//   A. Artist already in playlist P — another song by this artist sits in P,
//      so P is a direct suggestion. No genres involved.
//   B. Playlist neighbours — tagged artists sharing playlists with the
//      untagged one lend genres (same ≥2-agree vote as ListenBrainz). Each
//      shared playlist adds 1/|its artists| to a co-artist's weight, so a
//      500-artist catch-all playlist barely registers next to a 12-artist one.
//   C. Co-credits — a tagged artist credited on the same track (in a playlist
//      or in Liked) lends its genres.
//
// Lenders are cached genres from every source except `neighbours`: those are
// already borrowed, and borrowing from a borrow compounds its error.
//
// ponytail: reads playlist items from the library snapshot, so it only sees
// playlists whose items are cached (the target set, plus earlier targets).

import { genresFromNeighbours } from '../api/listenbrainz';
import type { CompactItem } from '../storage/librarySnapshot';
import type { Track } from '../types';

const NEIGHBOURS = 10;
const EXAMPLES = 8;

export interface LibrarySignalInput {
  /** Every Liked track (co-credits are looked up across all of them). */
  tracks: Track[];
  untaggedTracks: Track[];
  items: Record<string, CompactItem[]>;
  playlistName: (id: string) => string;
  /** Genres an artist can lend; undefined/[] = it has none to lend. */
  lenderGenres: (artistId: string) => string[] | undefined;
  artistName: (id: string) => string;
}

const pct = (n: number, d: number) => (d === 0 ? '—' : `${((n / d) * 100).toFixed(1)}%`);
const frac = (n: number, d: number) => `${n} / ${d} (${pct(n, d)})`;

export function measureLibrarySignals(input: LibrarySignalInput): string[] {
  const { tracks, untaggedTracks, items, playlistName, lenderGenres, artistName } = input;
  const lines: string[] = [];
  const untaggedArtists = new Set(untaggedTracks.flatMap((t) => t.artists.map((a) => a.id)));

  // playlist → its unique artists, and artist → the playlists holding it.
  const artistsOf = new Map<string, Set<string>>();
  const playlistsOf = new Map<string, Set<string>>();
  // playlist → track ids, and (playlist, artist) → the track ids carrying it.
  const trackIdsOf = new Map<string, Set<string>>();
  const tracksOfArtistIn = new Map<string, Set<string>>();
  let withIds = 0;
  for (const [pid, its] of Object.entries(items)) {
    const as = new Set<string>();
    const ids = new Set<string>();
    if (its.some((it) => it.i)) withIds += 1;
    for (const it of its) {
      if (it.i) ids.add(it.i);
      for (const a of it.a) {
        as.add(a);
        let ps = playlistsOf.get(a);
        if (!ps) playlistsOf.set(a, ps = new Set());
        ps.add(pid);
        const key = `${pid}|${a}`;
        let ts = tracksOfArtistIn.get(key);
        if (!ts) tracksOfArtistIn.set(key, ts = new Set());
        if (it.i) ts.add(it.i);
      }
    }
    artistsOf.set(pid, as);
    trackIdsOf.set(pid, ids);
  }

  const playlistCount = Object.keys(items).length;
  lines.push('', '== Option 1: your own library (no network)');
  lines.push(`playlists with cached items: ${playlistCount} (${withIds} carry track ids)`);
  if (playlistCount === 0) {
    lines.push('  no cached playlist items — load the Sorter once, then re-run.');
    return lines;
  }
  const inAnyPlaylist = [...untaggedArtists].filter((a) => playlistsOf.has(a)).length;
  lines.push(`untagged artists in ≥1 playlist: ${frac(inAnyPlaylist, untaggedArtists.size)}`);

  // -- A. artist already in playlist P ----------------------------------------
  // P qualifies for track t when it holds another track by one of t's artists
  // and does not already hold t. Without track ids, "another track" can't be
  // told apart from t itself, so such playlists only count when t is absent.
  const suggestionsFor = new Map<string, Set<string>>();
  let alreadyFiled = 0;
  for (const t of untaggedTracks) {
    if ([...trackIdsOf.values()].some((ids) => ids.has(t.id))) alreadyFiled += 1;
    const ps = new Set<string>();
    for (const a of t.artists) {
      for (const pid of playlistsOf.get(a.id) ?? []) {
        if (trackIdsOf.get(pid)!.has(t.id)) continue;
        const others = tracksOfArtistIn.get(`${pid}|${a.id}`)!;
        if (others.size === 0 || [...others].some((id) => id !== t.id)) ps.add(pid);
      }
    }
    if (ps.size > 0) suggestionsFor.set(t.id, ps);
  }
  const counts = [...suggestionsFor.values()].map((s) => s.size);
  const receivers = new Map<string, number>();
  for (const ps of suggestionsFor.values()) for (const p of ps) receivers.set(p, (receivers.get(p) ?? 0) + 1);

  lines.push('', '-- A. artist already in playlist P (direct suggestion, no genres)');
  lines.push(`untagged tracks already in some playlist: ${frac(alreadyFiled, untaggedTracks.length)}`);
  lines.push(`untagged tracks that get ≥1 suggestion: ${frac(suggestionsFor.size, untaggedTracks.length)}`);
  lines.push(`  exactly 1 candidate: ${counts.filter((c) => c === 1).length},`
    + ` 2–3: ${counts.filter((c) => c >= 2 && c <= 3).length}, 4+: ${counts.filter((c) => c >= 4).length}`);
  // A playlist collecting most of these is a catch-all, not evidence.
  const topReceivers = [...receivers].sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (topReceivers.length > 0) {
    lines.push(`  most-suggested: ${topReceivers
      .map(([p, n]) => `${playlistName(p)} ×${n} (${artistsOf.get(p)!.size} artists)`).join(', ')}`);
  }
  for (const t of untaggedTracks.filter((x) => suggestionsFor.has(x.id)).slice(0, EXAMPLES)) {
    const ps = [...suggestionsFor.get(t.id)!];
    lines.push(`  ${t.artists.map((a) => a.name).join(', ')} – ${t.name} → ${ps.slice(0, 3).map(playlistName).join(', ')}`
      + (ps.length > 3 ? ` +${ps.length - 3}` : ''));
  }

  // -- B. playlist neighbours ---------------------------------------------------
  const viaNeighbours = new Map<string, { genres: string[]; like: string[] }>();
  for (const x of untaggedArtists) {
    const weight = new Map<string, number>();
    for (const pid of playlistsOf.get(x) ?? []) {
      const as = artistsOf.get(pid)!;
      for (const y of as) {
        if (y === x || !(lenderGenres(y)?.length)) continue;
        weight.set(y, (weight.get(y) ?? 0) + 1 / as.size);
      }
    }
    const ns = [...weight].sort((a, b) => b[1] - a[1]).map(([mbid, score]) => ({ mbid, score, name: artistName(mbid) }));
    const genres = genresFromNeighbours(ns, lenderGenres, { topN: NEIGHBOURS }).slice(0, 3);
    if (genres.length > 0) viaNeighbours.set(x, { genres, like: ns.slice(0, 3).map((n) => n.name) });
  }

  // -- C. co-credits -------------------------------------------------------------
  const viaCoCredit = new Map<string, Set<string>>();
  const credits = [
    ...tracks.map((t) => t.artists.map((a) => a.id)),
    ...Object.values(items).flatMap((its) => its.map((it) => it.a)),
  ];
  for (const as of credits) {
    if (as.length < 2) continue;
    for (const x of as) {
      if (!untaggedArtists.has(x)) continue;
      for (const y of as) {
        if (y === x) continue;
        const g = lenderGenres(y);
        if (!g?.length) continue;
        let set = viaCoCredit.get(x);
        if (!set) viaCoCredit.set(x, set = new Set());
        g.forEach((v) => set.add(v));
      }
    }
  }

  const tracksGaining = (gainers: Set<string>) =>
    untaggedTracks.filter((t) => t.artists.some((a) => gainers.has(a.id)));
  const bTracks = tracksGaining(new Set(viaNeighbours.keys()));
  const cTracks = tracksGaining(new Set(viaCoCredit.keys()));

  lines.push('', `-- B. playlist neighbours (≥2 of top ${NEIGHBOURS} co-playlisted artists agree)`);
  lines.push(`artists that would gain genres: ${frac(viaNeighbours.size, untaggedArtists.size)}`
    + ` → tracks: ${frac(bTracks.length, untaggedTracks.length)}`);
  for (const [x, { genres, like }] of [...viaNeighbours].slice(0, EXAMPLES)) {
    lines.push(`  ${artistName(x)} → ${genres.join(', ')}   (like: ${like.join(', ')})`);
  }

  lines.push('', '-- C. co-credited tagged artists');
  lines.push(`artists that would gain genres: ${frac(viaCoCredit.size, untaggedArtists.size)}`
    + ` → tracks: ${frac(cTracks.length, untaggedTracks.length)}`);
  for (const [x, g] of [...viaCoCredit].slice(0, EXAMPLES)) {
    lines.push(`  ${artistName(x)} → ${[...g].slice(0, 5).join(', ')}`);
  }

  const any = new Set([...suggestionsFor.keys(), ...bTracks.map((t) => t.id), ...cTracks.map((t) => t.id)]);
  const genreAny = new Set([...bTracks, ...cTracks].map((t) => t.id));
  lines.push('', `option 1 total: ${frac(any.size, untaggedTracks.length)} untagged tracks reached`
    + ` (A ${suggestionsFor.size}, B ${bTracks.length}, C ${cTracks.length}; genres via B∪C: ${genreAny.size})`);
  return lines;
}
