import type { Fingerprint } from '../matching/engine';
import type { Playlist } from '../types';

export interface GenreShare {
  genre: string;
  share: number; // fraction of the playlist's tracks tagged with this genre
}

export type PlaylistStatus = 'focused' | 'broad' | 'insufficient-data';

export interface PlaylistProfile {
  playlistId: string;
  name: string;
  trackCount: number;
  status: PlaylistStatus;
  genres: GenreShare[]; // all genres present, ranked by share descending
}

export interface BroadPlaylist {
  playlistId: string;
  name: string;
  topGenre: string | null;
  topGenreShare: number;
}

export const BROAD_THRESHOLD = 0.3;
export const MIN_TRACKS = 3; // fingerprints from fewer songs than this aren't enough signal to judge

const statusRank: Record<PlaylistStatus, number> = { broad: 0, focused: 1, 'insufficient-data': 2 };

/** Every playlist's genre makeup, ranked broad-first (the thing you came here to find). */
export function buildPlaylistProfiles(
  playlists: Playlist[],
  fingerprints: Map<string, Fingerprint>,
  threshold = BROAD_THRESHOLD,
): PlaylistProfile[] {
  return playlists
    .map((p): PlaylistProfile => {
      const fp = fingerprints.get(p.id);
      if (!fp || fp.size < MIN_TRACKS) {
        return { playlistId: p.id, name: p.name, trackCount: p.trackCount, status: 'insufficient-data', genres: [] };
      }
      const genres = [...fp.genreWeights]
        .map(([genre, share]) => ({ genre, share }))
        .sort((a, b) => b.share - a.share);
      // No readable genre on any track — can't judge breadth, don't call it "too broad".
      const status: PlaylistStatus =
        genres.length === 0 ? 'insufficient-data' : genres[0].share < threshold ? 'broad' : 'focused';
      return { playlistId: p.id, name: p.name, trackCount: p.trackCount, status, genres };
    })
    .sort((a, b) => statusRank[a.status] - statusRank[b.status] || a.name.localeCompare(b.name));
}

/** Playlists whose most common genre still covers less than `threshold` of their songs. */
export function findBroadPlaylists(
  playlists: Playlist[],
  fingerprints: Map<string, Fingerprint>,
  threshold = BROAD_THRESHOLD,
): BroadPlaylist[] {
  return buildPlaylistProfiles(playlists, fingerprints, threshold)
    .filter((p) => p.status === 'broad')
    .map((p) => ({
      playlistId: p.playlistId,
      name: p.name,
      topGenre: p.genres[0]?.genre ?? null,
      topGenreShare: p.genres[0]?.share ?? 0,
    }))
    .sort((a, b) => a.topGenreShare - b.topGenreShare);
}
