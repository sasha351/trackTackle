// DEV-only: answers "what does a fresh Spotify app still get in 2026?"
// Run it once after first login (button on the login/sorter screen in DEV builds)
// and read the lines it returns. If `GET /artists/{id}` is dead, the genre
// resolver (src/genre/resolver.ts) will rely on MusicBrainz — no code change
// needed. If a library endpoint is dead, fix its path in src/api/spotify.ts.
import { getArtistGenres, spotifyFetch } from '../api/spotify';

export async function runCapabilityProbe(): Promise<string[]> {
  const lines: string[] = [];
  const probe = async (label: string, fn: () => Promise<unknown>) => {
    try {
      const result = await fn();
      lines.push(`OK   ${label}: ${JSON.stringify(result)?.slice(0, 120)}`);
    } catch (e) {
      lines.push(`FAIL ${label}: ${(e as Error).message}`);
    }
  };

  type SavedTrackLike = {
    name?: string;
    artists?: { id: string; name: string }[];
    external_ids?: { isrc?: string };
  };
  type SavedPage = {
    items?: { track?: SavedTrackLike | null; item?: SavedTrackLike | null }[];
    total?: number;
  };
  let firstTrack = null as SavedTrackLike | null;
  await probe('GET /me/tracks?limit=1', async () => {
    const page = await spotifyFetch<SavedPage>('/me/tracks?limit=1');
    firstTrack = page.items?.[0]?.item ?? page.items?.[0]?.track ?? null;
    return { total: page.total, first: firstTrack?.name, isrc: firstTrack?.external_ids?.isrc };
  });

  const artistId = firstTrack?.artists?.[0]?.id;
  if (artistId) {
    await probe(`GET /artists/${artistId} genres`, () => getArtistGenres(artistId));
    await probe('GET /artists?ids= (batch)', () =>
      spotifyFetch<{ artists: { genres?: string[] }[] }>(`/artists?ids=${artistId}`));
  }
  await probe('GET /me/playlists', () => spotifyFetch('/me/playlists?limit=1'));

  // Feb 2026 migration moved playlist reads to /playlists/{id}/items — probe
  // the exact call the app makes against the first real playlist we can see.
  const pls = await spotifyFetch<{ items: ({ id: string; name: string } | null)[] }>(
    '/me/playlists?limit=5',
  ).catch(() => null);
  const pl = pls?.items.find((p) => p != null);
  if (pl) {
    const fields = encodeURIComponent('items(item(artists(id,name),album(release_date))),next');
    await probe(`GET /playlists/${pl.id}/items + fields (app's exact call)`, () =>
      spotifyFetch(`/playlists/${pl.id}/items?limit=1&fields=${fields}`));
    await probe(`GET /playlists/${pl.id}/items bare`, () =>
      spotifyFetch(`/playlists/${pl.id}/items?limit=1`));
    await probe(`GET /playlists/${pl.id}/tracks (pre-2026 route, expected FAIL)`, () =>
      spotifyFetch(`/playlists/${pl.id}/tracks?limit=1`));
  }
  return lines;
}
