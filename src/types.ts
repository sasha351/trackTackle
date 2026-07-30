import type { ScoreBreakdown } from './matching/engine';

export interface Track {
  id: string; uri: string; name: string;
  artists: { id: string; name: string }[];
  albumName: string; releaseYear: number | null;
  isrc: string | null; addedAt: string; // ISO date from Spotify
  /** ~300px album cover. Optional: a snapshot written before this field
   *  existed simply has none, and the gallery falls back to a text tile. */
  albumArt?: string | null;
}
export interface Playlist {
  id: string; name: string; description?: string | null; trackCount: number;
  /** ~300px playlist cover — see Track.albumArt on why it is optional. */
  image?: string | null;
}
export interface PlaylistTrack {
  id: string;
  name: string;
  artists: { id: string; name: string }[];
  releaseYear: number | null;
  isrc: string | null;
}
export interface GenreInfo { genres: string[]; source: 'spotify' | 'musicbrainz' | 'none' | 'unresolved' }
export interface MatchResult { playlistId: string; score: number; breakdown?: ScoreBreakdown }
export interface SongMatch { best: MatchResult | null; alternates: MatchResult[]; belowThreshold: boolean }
