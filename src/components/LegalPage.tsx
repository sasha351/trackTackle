const CONTACT_EMAIL = 'alexshikhanovich@gmail.com';

export default function LegalPage() {
  return (
    <div className="legal-page">
      <h2>Privacy</h2>
      <p>
        Track Tackle has no backend, no analytics, and no tracking. It contacts
        exactly five third parties, and nothing you do in this app is sent
        anywhere else:
      </p>
      <ul>
        <li><strong>Spotify</strong> — to read and modify your library.</li>
        <li>
          <strong>MusicBrainz</strong> (<code>musicbrainz.org</code>) — to look
          up genre data for artists Spotify has no genres for.
        </li>
        <li>
          <strong>Wikidata</strong> (<code>query.wikidata.org</code>) and{' '}
          <strong>English Wikipedia</strong> (<code>en.wikipedia.org</code>) —
          the same job, as a last resort. These two are only contacted during a
          "deep" genre run, which you start yourself.
        </li>
        <li>
          <strong>ListenBrainz</strong> (<code>labs.api.listenbrainz.org</code>) —
          also during a deep run only, to find similar artists for an artist no
          other source has genres for.
        </li>
      </ul>
      <p>
        In every case the only thing sent is an artist name or id, or a
        track's ISRC (the public industry code printed on every release). None
        of these services is told who you are.
      </p>
      <p>
        All data the app keeps — your Spotify auth tokens, genre lookup
        caches, and the local removal log — lives in your browser's{' '}
        <code>localStorage</code> and <code>sessionStorage</code>. It never
        leaves your device except as the direct API calls to the five services
        above. Clearing your browser storage deletes it all.
      </p>
      <p>
        Spotify's consent screen asks for two permissions that look alarming for
        a sorting app: <strong>view your email address</strong> and{' '}
        <strong>read your private information</strong>. Both are required by
        Spotify's Web Playback SDK, which is what plays previews while you sort.
        Track Tackle never reads either one, and has no server it could send
        them to.
      </p>
      <p>
        The app only modifies your Liked Songs or playlists when you
        explicitly choose to move or remove a track. Removing a song from
        Liked Songs permanently loses its original "added" date on Spotify's
        side — that's a Spotify API limitation, not something this app can
        avoid. To mitigate it, Track Tackle keeps a local removal log and offers an
        8-second undo after every move, so you can reverse a mistake before
        it's final.
      </p>
      <p>
        Questions about your data? Email{' '}
        <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
      </p>

      <h2>Terms</h2>
      <p>
        Track Tackle is provided as-is, with no warranty of any kind. It is an
        independent, unofficial tool and is <strong>not affiliated with
        Spotify</strong>, and it is not endorsed, sponsored, or certified by
        Spotify AB in any way. "Spotify" and related marks are trademarks of
        Spotify AB.
      </p>
      <p>
        You are responsible for reviewing changes before you confirm them.
        Because the app acts on your real Spotify library, moves and removals
        it makes are real changes to your account, limited only by the undo
        window described above.
      </p>
    </div>
  );
}
