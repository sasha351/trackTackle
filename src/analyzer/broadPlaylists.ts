import type { Fingerprint } from '../matching/engine';
import type { Playlist } from '../types';

export interface BroadPlaylist {
  playlistId: string;
  name: string;
  topGenre: string | null;
  topGenreShare: number;
}

export const BROAD_THRESHOLD = 0.3;
const MIN_TRACKS = 3; // fingerprints from fewer songs than this aren't enough signal to judge

/** Playlists whose most common genre still covers less than `threshold` of their songs. */
export function findBroadPlaylists(
  playlists: Playlist[],
  fingerprints: Map<string, Fingerprint>,
  threshold = BROAD_THRESHOLD,
): BroadPlaylist[] {
  const out: BroadPlaylist[] = [];
  for (const p of playlists) {
    const fp = fingerprints.get(p.id);
    if (!fp || fp.size < MIN_TRACKS) continue;
    const [topGenre, topGenreShare] = [...fp.genreWeights].sort((a, b) => b[1] - a[1])[0] ?? [
      null,
      0,
    ];
    if (topGenreShare < threshold) out.push({ playlistId: p.id, name: p.name, topGenre, topGenreShare });
  }
  return out.sort((a, b) => a.topGenreShare - b.topGenreShare);
}
