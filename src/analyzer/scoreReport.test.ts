import { expect, it } from 'vitest';
import { buildFingerprint, matchSong, DEFAULT_THRESHOLD } from '../matching/engine';
import { buildScoreReport } from './scoreReport';
import type { Track } from '../types';

const track = (id: string): Track => ({
  id, uri: `spotify:track:${id}`, name: id,
  artists: [], albumName: '', releaseYear: null, isrc: null, addedAt: '2024-01-01',
});

it('reports the score histogram, contribution stats, and zero-overlap share', () => {
  const fingerprints = new Map([
    ['tripHop', buildFingerprint([{ genres: ['trip hop'], releaseYear: 1994 }])],
    ['rock', buildFingerprint([{ genres: ['rock'], releaseYear: 1994 }])],
  ]);
  const tracks = [track('a'), track('b'), track('c')];
  const genresByTrack = new Map([
    ['a', ['trip hop']], // strong genre match
    // 'b' and 'c' never resolved a genre — no entry
  ]);
  const matches = new Map([
    ['a', matchSong({ genres: ['trip hop'], releaseYear: 1994 }, fingerprints, DEFAULT_THRESHOLD)],
    // 'b' has no genre but its era (1994) matches both fingerprints' decade →
    // ties on era alone, tripHop wins by insertion order → still a best match
    ['b', matchSong({ genres: [], releaseYear: 1994 }, fingerprints, DEFAULT_THRESHOLD)],
  ]);
  const playlistNames = new Map([['tripHop', 'Trip Hop Only'], ['rock', 'Rock Only']]);

  const lines = buildScoreReport(tracks, matches, fingerprints, genresByTrack, playlistNames);
  const text = lines.join('\n');

  expect(lines[0]).toMatch(/2 of 3 tracks have a best-match candidate/);
  expect(text).toContain('0.85-0.90'); // track a: genre (0.7) + era (0.15) both hit, no lang signal
  expect(text).toContain('Genre coverage: 1 of 3 tracks (33%) carry ≥1 genre');
  expect(text).toContain('Trip Hop Only: 1 distinct genres, 1 tracks');
  expect(text).toContain('Rock Only: 1 distinct genres, 1 tracks');
});

it('handles an empty library without dividing by zero', () => {
  const lines = buildScoreReport([], new Map(), new Map(), new Map(), new Map());
  expect(lines[0]).toBe('0 of 0 tracks have a best-match candidate');
  expect(lines.join('\n')).toContain('Genre coverage: 0 of 0 tracks (0%)');
});
