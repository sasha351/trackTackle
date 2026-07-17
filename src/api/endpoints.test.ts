import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  configureSpotify, getSavedTracks, getMyPlaylists, getPlaylistTracks,
  addTracksToPlaylist, removeSavedTracks,
} from './spotify';
import { saveTokens } from '../auth/token';

beforeEach(() => {
  configureSpotify('cid');
  saveTokens({ accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 3600_000 });
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

const page = (items: unknown[]) =>
  new Response(JSON.stringify({ items, next: null }), { status: 200 });

it('maps saved tracks to the Track shape', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(page([{
    added_at: '2024-03-01T00:00:00Z',
    track: {
      id: 't1', uri: 'spotify:track:t1', name: 'Song',
      artists: [{ id: 'a1', name: 'Artist' }],
      album: { name: 'Album', release_date: '1998-05-01' },
      external_ids: { isrc: 'USUM71703861' },
    },
  }]));
  const tracks = await getSavedTracks();
  expect(tracks).toEqual([{
    id: 't1', uri: 'spotify:track:t1', name: 'Song',
    artists: [{ id: 'a1', name: 'Artist' }],
    albumName: 'Album', releaseYear: 1998,
    isrc: 'USUM71703861', addedAt: '2024-03-01T00:00:00Z',
  }]);
});

it('keeps playlists I own or collaborate on, drops ones I merely follow', async () => {
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'me1' }), { status: 200 }))
    .mockResolvedValueOnce(page([
      // post-Feb-2026 shape: count lives under `items`
      { id: 'p1', name: 'Mine', owner: { id: 'me1' }, items: { total: 10 } },
      { id: 'p2', name: 'Road trip (shared)', owner: { id: 'other' }, collaborative: true, items: { total: 5 } },
      { id: 'p3', name: 'Just following', owner: { id: 'other' }, items: { total: 2 } },
      // pre-migration shape still tolerated
      { id: 'p4', name: 'Old shape', owner: { id: 'me1' }, tracks: { total: 7 } },
    ]));
  expect(await getMyPlaylists()).toEqual([
    { id: 'p1', name: 'Mine', trackCount: 10 },
    { id: 'p2', name: 'Road trip (shared)', trackCount: 5 },
    { id: 'p4', name: 'Old shape', trackCount: 7 },
  ]);
});

it('skips null entries but keeps owned playlists missing the count field', async () => {
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'me1' }), { status: 200 }))
    .mockResolvedValueOnce(page([
      null,
      { id: 'p2', name: 'No count field', owner: { id: 'me1' } },
      { id: 'p3', name: 'Fine', owner: { id: 'me1' }, items: { total: 3 } },
    ]));
  expect(await getMyPlaylists()).toEqual([
    { id: 'p2', name: 'No count field', trackCount: 0 },
    { id: 'p3', name: 'Fine', trackCount: 3 },
  ]);
});

it('maps playlist items (post-Feb-2026 shape) and skips null items', async () => {
  const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(page([
    { item: { artists: [{ id: 'a1', name: 'A' }], album: { release_date: '2011' } } },
    { item: null },
  ]));
  expect(await getPlaylistTracks('p1')).toEqual([
    { artists: [{ id: 'a1', name: 'A' }], releaseYear: 2011 },
  ]);
  const url = String(spy.mock.calls[0][0]);
  expect(url).toContain('/playlists/p1/items?');
  expect(decodeURIComponent(url)).toContain('items(item(');
});

it('POSTs uris to /items when adding to a playlist and DELETEs /me/library uris when unliking', async () => {
  // mockImplementation (not mockResolvedValue) so each call gets a fresh Response —
  // a single shared Response instance can't have its body read twice.
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('', { status: 200 }));
  await addTracksToPlaylist('p1', ['spotify:track:t1']);
  await removeSavedTracks(['spotify:track:t1']);
  expect(spy.mock.calls[0][0]).toBe('https://api.spotify.com/v1/playlists/p1/items');
  expect(spy.mock.calls[0][1]!.method).toBe('POST');
  expect(JSON.parse(spy.mock.calls[0][1]!.body as string)).toEqual({ uris: ['spotify:track:t1'] });
  expect(spy.mock.calls[1][0]).toBe(
    `https://api.spotify.com/v1/me/library?uris=${encodeURIComponent('spotify:track:t1')}`,
  );
  expect(spy.mock.calls[1][1]!.method).toBe('DELETE');
});
