import { useState } from 'react';
import { buildAuthUrl, generateState, generateVerifier } from '../auth/pkce';
import { CLIENT_ID, REDIRECT_URI, SCOPES } from '../config';
import { runCapabilityProbe } from '../dev/probe';
import Spinner from './Spinner';

export default function Login() {
  const [probeLines, setProbeLines] = useState<string[]>([]);
  const [probing, setProbing] = useState(false);

  const login = async () => {
    const verifier = generateVerifier();
    const state = generateState();
    sessionStorage.setItem('tracktackle:verifier', verifier);
    sessionStorage.setItem('tracktackle:state', state);
    window.location.href = await buildAuthUrl({
      clientId: CLIENT_ID, redirectUri: REDIRECT_URI, scopes: SCOPES, verifier, state,
    });
  };

  return (
    <div>
      {/* The notice ("session expired", "you cancelled the login") is rendered
          by App, directly above this component — it used to be rendered here
          too, which announced it twice to a screen reader. */}
      <img className="login-logo" src="/icon-192.png" alt="" />
      <div className="login-explainer">
        <p>
          Track Tackle sorts your Liked Songs into playlists by genre. It runs
          entirely in your browser — no backend, no account of its own.
          Sorting works on any Spotify account; playing song previews while
          you sort needs Spotify Premium, but Premium isn't required to use
          the app.
        </p>
        <p>
          Spotify's next screen will ask to share your email address and
          account details. Those two permissions are required by Spotify's
          playback SDK, which is what plays the previews — Track Tackle never
          reads either, and has no server to send them to.
        </p>
        <p>Track Tackle is an independent tool and is not affiliated with Spotify.</p>
      </div>
      {/* Not "Log in with Spotify" on a green pill: Spotify's design guidelines
          govern the treatment of auth buttons that use their branding, and the
          cheapest way to stay clear of them is to use neither their word nor
          their colour. */}
      <button className="pill-accent" onClick={login}>Continue with Spotify</button>
      {import.meta.env.DEV && (
        <div>
          <button
            disabled={probing}
            onClick={() => {
              setProbing(true);
              runCapabilityProbe().then(setProbeLines).finally(() => setProbing(false));
            }}
          >
            {probing ? <Spinner label="Probing…" /> : 'Run API capability probe (needs prior login)'}
          </button>
          <pre>{probeLines.join('\n')}</pre>
        </div>
      )}
    </div>
  );
}
