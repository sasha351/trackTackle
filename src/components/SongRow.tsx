import type { ReactNode } from 'react';
import type { Track } from '../types';

interface Props {
  track: Track;
  genres: string[] | undefined;
  matchSlot: ReactNode;
}

export default function SongRow({ track, genres, matchSlot }: Props) {
  return (
    <li className="song-row">
      <span className="song-name">{track.name}</span>
      <span className="song-artists">{track.artists.map((a) => a.name).join(', ')}</span>
      <span className="song-genres">{genres ? genres.join(', ') || '—' : '…'}</span>
      <span className="song-added">{track.addedAt.slice(0, 10)}</span>
      {matchSlot}
    </li>
  );
}
