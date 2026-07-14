// DEV-only: answers "what does a fresh Spotify app still get in 2026?"
// Run it once after first login (button on the login/sorter screen in DEV builds)
// and read the lines it returns. If `GET /artists/{id}` is dead, the genre
// resolver (src/genre/resolver.ts) will rely on MusicBrainz — no code change
// needed. If a library endpoint is dead, fix its path in src/api/spotify.ts.
import { getArtistGenres, getSavedTracks, spotifyFetch } from '../api/spotify';

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

  await probe('GET /me/tracks (1 item)', async () => {
    const tracks = await getSavedTracks();
    return { count: tracks.length, first: tracks[0]?.name, isrc: tracks[0]?.isrc };
  });

  const tracks = await getSavedTracks().catch(() => []);
  const artistId = tracks[0]?.artists[0]?.id;
  if (artistId) {
    await probe(`GET /artists/${artistId} genres`, () => getArtistGenres(artistId));
    await probe('GET /artists?ids= (batch)', () =>
      spotifyFetch<{ artists: { genres?: string[] }[] }>(`/artists?ids=${artistId}`));
  }
  await probe('GET /me/playlists', () => spotifyFetch('/me/playlists?limit=1'));
  return lines;
}
