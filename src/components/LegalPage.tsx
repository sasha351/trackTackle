const CONTACT_EMAIL = 'alexshikhanovich@gmail.com';

export default function LegalPage() {
  return (
    <div className="legal-page">
      <h2>Privacy</h2>
      <p>
        Kondo has no backend, no analytics, and no tracking. The only third
        parties it ever contacts are <strong>Spotify</strong> (to read and
        modify your library) and <strong>MusicBrainz</strong> (to look up
        genre data). Nothing you do in this app is sent anywhere else.
      </p>
      <p>
        All data the app keeps — your Spotify auth tokens, genre lookup
        caches, and the local removal log — lives in your browser's{' '}
        <code>localStorage</code> and <code>sessionStorage</code>. It never
        leaves your device except as the direct Spotify and MusicBrainz API
        calls needed to run the app. Clearing your browser storage deletes it
        all.
      </p>
      <p>
        The app only modifies your Liked Songs or playlists when you
        explicitly choose to move or remove a track. Removing a song from
        Liked Songs permanently loses its original "added" date on Spotify's
        side — that's a Spotify API limitation, not something this app can
        avoid. To mitigate it, Kondo keeps a local removal log and offers an
        8-second undo after every move, so you can reverse a mistake before
        it's final.
      </p>
      <p>
        Questions about your data? Email{' '}
        <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
      </p>

      <h2>Terms</h2>
      <p>
        Kondo is provided as-is, with no warranty of any kind. It is an
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
