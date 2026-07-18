import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import Analyzer from './Analyzer';
import { buildFingerprint } from '../matching/engine';
import type { LibraryState } from '../hooks/useLibrary';

const baseLib: LibraryState = {
  status: 'ready',
  error: null,
  tracks: [],
  playlists: [],
  genresByTrack: new Map(),
  fingerprints: new Map(),
  progress: { resolved: 0, total: 0 },
  matches: new Map(),
  removeTrackLocally: () => {},
  restoreTrackLocally: () => {},
};

it('shows a loading message while the library is loading', () => {
  render(<Analyzer lib={{ ...baseLib, status: 'loading' }} />);
  expect(screen.getByText(/loading your playlists/i)).toBeInTheDocument();
});

it('lists playlists whose top genre does not dominate', () => {
  const lib: LibraryState = {
    ...baseLib,
    playlists: [{ id: 'broad', name: 'Everything Bucket', trackCount: 5 }],
    fingerprints: new Map([
      ['broad', buildFingerprint([
        { genres: ['rock'], releaseYear: 1998 },
        { genres: ['pop'], releaseYear: 1999 },
        { genres: ['jazz'], releaseYear: 2000 },
        { genres: ['metal'], releaseYear: 2001 },
        { genres: ['folk'], releaseYear: 2002 },
      ])],
    ]),
  };
  render(<Analyzer lib={lib} />);
  expect(screen.getByText(/everything bucket/i)).toBeInTheDocument();
  expect(screen.getByText(/20%/)).toBeInTheDocument();
});

it('says nothing is broad when every playlist has a dominant genre', () => {
  const lib: LibraryState = {
    ...baseLib,
    playlists: [{ id: 'focused', name: 'Trip Hop Only', trackCount: 5 }],
    fingerprints: new Map([
      ['focused', buildFingerprint([
        { genres: ['trip hop'], releaseYear: 1998 },
        { genres: ['trip hop'], releaseYear: 1999 },
        { genres: ['trip hop'], releaseYear: 2000 },
        { genres: ['trip hop'], releaseYear: 2001 },
        { genres: ['trip hop'], releaseYear: 2002 },
      ])],
    ]),
  };
  render(<Analyzer lib={lib} />);
  expect(screen.getByText(/no playlists look too broad/i)).toBeInTheDocument();
});
