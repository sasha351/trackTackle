import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import Analyzer from './Analyzer';
import { buildFingerprint } from '../matching/engine';
import type { LibraryState } from '../hooks/useLibrary';

const baseLib: LibraryState = {
  status: 'ready',
  error: null,
  tracks: [],
  playlists: [],
  allPlaylists: [],
  genresByTrack: new Map(),
  fingerprints: new Map(),
  artists: [],
  progress: { resolved: 0, total: 0 },
  matches: new Map(),
  removeTrackLocally: () => {},
  restoreTrackLocally: () => {},
  deepResolveAll: async () => {},
  deepState: 'idle',  deepPhase: null,
  refresh: () => {},
  snapshotAge: null,
  coverage: { spotify: 0, musicbrainz: 0, none: 0, unresolved: 0 },
};

it('shows a loading message while the library is loading', () => {
  render(<Analyzer lib={{ ...baseLib, status: 'loading' }} />);
  expect(screen.getByText(/loading your playlists/i)).toBeInTheDocument();
});

it('shows an animated spinner while the library is loading', () => {
  render(<Analyzer lib={{ ...baseLib, status: 'loading' }} />);
  expect(document.querySelector('.spinner')).toBeInTheDocument();
});

it('says there is nothing to analyze when there are no playlists', () => {
  render(<Analyzer lib={baseLib} />);
  expect(screen.getByText(/no playlists to analyze yet/i)).toBeInTheDocument();
});

it('shows the full genre breakdown and flags a broad playlist', () => {
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
  expect(screen.getByText('Everything Bucket')).toBeInTheDocument();
  expect(screen.getByText('too broad')).toBeInTheDocument(); // the status pill (exact match — summary line also mentions "broad")
  expect(screen.getByText('rock')).toBeInTheDocument();
  expect(screen.getAllByText('20%')).toHaveLength(5); // every genre here is a 1/5 share
  expect(document.querySelector('.analyzer-summary')).toHaveTextContent(
    '1 playlist analyzed · 1 looks too broad',
  );
  expect(screen.getByText(/100% have genres/)).toBeInTheDocument();
});

it('marks a dominant-genre playlist as focused', () => {
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
  expect(screen.getByText(/^focused$/i)).toBeInTheDocument();
  expect(screen.queryByText(/look too broad/i)).not.toBeInTheDocument();
});

it('flags a too-small playlist as unjudgeable instead of guessing', () => {
  const lib: LibraryState = {
    ...baseLib,
    playlists: [{ id: 'tiny', name: 'New Playlist', trackCount: 1 }],
    fingerprints: new Map([
      ['tiny', buildFingerprint([{ genres: ['pop'], releaseYear: 2020 }])],
    ]),
  };
  render(<Analyzer lib={lib} />);
  expect(screen.getByText(/too few tracks/i)).toBeInTheDocument();
  expect(screen.getByText(/needs at least 3 tracks to judge/i)).toBeInTheDocument();
});

it('flags a track-rich playlist with no readable genres as no-genre-data, distinct from too-few-tracks', () => {
  const lib: LibraryState = {
    ...baseLib,
    playlists: [{ id: 'genreless', name: 'No Genres Yet', trackCount: 4 }],
    fingerprints: new Map([
      ['genreless', buildFingerprint([
        { genres: [], releaseYear: 2020 },
        { genres: [], releaseYear: 2021 },
        { genres: [], releaseYear: 2022 },
        { genres: [], releaseYear: 2023 },
      ])],
    ]),
  };
  render(<Analyzer lib={lib} />);
  expect(screen.getByText(/^no genre data$/i)).toBeInTheDocument(); // the status pill
  expect(screen.getByText(/try resolve via musicbrainz/i)).toBeInTheDocument();
  expect(screen.queryByText(/too few tracks/i)).not.toBeInTheDocument();
});

it('collapses long genre lists behind a "show more" toggle', async () => {
  const genres = Array.from({ length: 9 }, (_, i) => ({ genres: [`genre${i}`], releaseYear: 2000 }));
  const lib: LibraryState = {
    ...baseLib,
    playlists: [{ id: 'many', name: 'Kitchen Sink', trackCount: 9 }],
    fingerprints: new Map([['many', buildFingerprint(genres)]]),
  };
  render(<Analyzer lib={lib} />);
  expect(screen.queryByText('genre8')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: /show 3 more/i }));
  expect(screen.getByText('genre8')).toBeInTheDocument();
});
