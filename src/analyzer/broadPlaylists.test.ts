import { expect, it } from 'vitest';
import { buildFingerprint } from '../matching/engine';
import { findBroadPlaylists } from './broadPlaylists';

const playlists = [
  { id: 'focused', name: 'Trip Hop Only', trackCount: 5 },
  { id: 'broad', name: 'Everything Bucket', trackCount: 5 },
  { id: 'tiny', name: 'New Playlist', trackCount: 2 },
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
