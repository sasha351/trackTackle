import { expect, it } from 'vitest';
import { buildFingerprint } from '../matching/engine';
import { buildPlaylistProfiles, findBroadPlaylists } from './broadPlaylists';

const playlists = [
  { id: 'focused', name: 'Trip Hop Only', trackCount: 5 },
  { id: 'broad', name: 'Everything Bucket', trackCount: 5 },
  { id: 'tiny', name: 'New Playlist', trackCount: 2 },
  { id: 'genreless', name: 'No Genres', trackCount: 4 },
];

const fingerprints = new Map([
  ['focused', buildFingerprint([
    { genres: ['trip hop'], releaseYear: 1998 },
    { genres: ['trip hop'], releaseYear: 1999 },
    { genres: ['trip hop'], releaseYear: 2000 },
    { genres: ['trip hop', 'downtempo'], releaseYear: 2001 },
    { genres: ['trip hop'], releaseYear: 2002 },
  ])],
  ['broad', buildFingerprint([
    { genres: ['rock'], releaseYear: 1998 },
    { genres: ['pop'], releaseYear: 1999 },
    { genres: ['jazz'], releaseYear: 2000 },
    { genres: ['metal'], releaseYear: 2001 },
    { genres: ['folk'], releaseYear: 2002 },
  ])],
  // too few tracks to judge, even though its one genre isn't dominant enough alone
  ['tiny', buildFingerprint([
    { genres: ['pop'], releaseYear: 2020 },
    { genres: ['rock'], releaseYear: 2021 },
  ])],
  // plenty of tracks, but none carried a readable genre — can't be judged broad
  ['genreless', buildFingerprint([
    { genres: [], releaseYear: 2020 },
    { genres: [], releaseYear: 2021 },
    { genres: [], releaseYear: 2022 },
    { genres: [], releaseYear: 2023 },
  ])],
]);

it('flags playlists whose top genre does not dominate', () => {
  const broad = findBroadPlaylists(playlists, fingerprints);
  expect(broad).toHaveLength(1);
  expect(broad[0]).toMatchObject({ playlistId: 'broad', topGenre: 'rock', topGenreShare: 0.2 });
});

it('skips playlists with too few tracks to judge', () => {
  const broad = findBroadPlaylists(playlists, fingerprints);
  expect(broad.some((p) => p.playlistId === 'tiny')).toBe(false);
});

it('skips playlists with no fingerprint (unreadable/empty)', () => {
  const broad = findBroadPlaylists(
    [{ id: 'ghost', name: 'Ghost', trackCount: 0 }],
    new Map(),
  );
  expect(broad).toEqual([]);
});

it('profiles every playlist, sorted broad-first then focused then unjudgeable', () => {
  const profiles = buildPlaylistProfiles(playlists, fingerprints);
  expect(profiles.map((p) => p.playlistId)).toEqual(['broad', 'focused', 'tiny', 'genreless']);
});

it('ranks a focused playlist\'s full genre breakdown by share', () => {
  const profiles = buildPlaylistProfiles(playlists, fingerprints);
  const focused = profiles.find((p) => p.playlistId === 'focused')!;
  expect(focused.status).toBe('focused');
  expect(focused.genres).toEqual([
    { genre: 'trip hop', share: 1 },
    { genre: 'downtempo', share: 0.2 },
  ]);
  expect(focused.genreCoverage).toBe(1); // all 5 tracks carried a genre
});

it('does not flag a track-rich playlist as broad when no genres are readable', () => {
  const profiles = buildPlaylistProfiles(playlists, fingerprints);
  const genreless = profiles.find((p) => p.playlistId === 'genreless')!;
  expect(genreless.status).toBe('no-genre-data');
  expect(genreless.genres).toEqual([]);
  expect(genreless.genreCoverage).toBe(0);
  expect(findBroadPlaylists(playlists, fingerprints).some((p) => p.playlistId === 'genreless')).toBe(false);
});

it('marks a too-small playlist as too-few-tracks with no genre breakdown', () => {
  const profiles = buildPlaylistProfiles(playlists, fingerprints);
  const tiny = profiles.find((p) => p.playlistId === 'tiny')!;
  expect(tiny.status).toBe('too-few-tracks');
  expect(tiny.genres).toEqual([]);
  expect(tiny.genreCoverage).toBe(0);
});

it('reads a sparsely-genred playlist\'s share off genred tracks, not total tracks', () => {
  // 10 tracks, only 4 carry a genre, 3 of those tagged jazz — the true
  // concentration among readable tracks is 75%, not 30% of all 10.
  const sparse = new Map([
    ['sparse', buildFingerprint([
      { genres: ['jazz'], releaseYear: 2000 },
      { genres: ['jazz'], releaseYear: 2001 },
      { genres: ['jazz'], releaseYear: 2002 },
      { genres: ['blues'], releaseYear: 2003 },
      { genres: [], releaseYear: 2004 },
      { genres: [], releaseYear: 2005 },
      { genres: [], releaseYear: 2006 },
      { genres: [], releaseYear: 2007 },
      { genres: [], releaseYear: 2008 },
      { genres: [], releaseYear: 2009 },
    ])],
  ]);
  const profiles = buildPlaylistProfiles(
    [{ id: 'sparse', name: 'Sparse Genres', trackCount: 10 }],
    sparse,
  );
  const profile = profiles[0]!;
  expect(profile.genres[0]).toEqual({ genre: 'jazz', share: 0.75 });
  expect(profile.status).toBe('focused'); // 75% clears the 30% threshold — not 'broad'
  expect(profile.genreCoverage).toBeCloseTo(0.4); // 4 of 10 tracks carried a genre
});
