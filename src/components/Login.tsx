import { useState } from 'react';
import { buildAuthUrl, generateVerifier } from '../auth/pkce';
import { CLIENT_ID, REDIRECT_URI, SCOPES } from '../config';
import { runCapabilityProbe } from '../dev/probe';

export default function Login({ notice }: { notice?: string }) {
  const [probeLines, setProbeLines] = useState<string[]>([]);
  const [probing, setProbing] = useState(false);

  const login = async () => {
    const verifier = generateVerifier();
    sessionStorage.setItem('kondo:verifier', verifier);
    window.location.href = await buildAuthUrl({
      clientId: CLIENT_ID, redirectUri: REDIRECT_URI, scopes: SCOPES, verifier,
    });
  };

  return (
    <div>
      {notice && <div role="status" className="login-notice">{notice}</div>}
      <div className="login-explainer">
        <p>
          Kondo sorts your Liked Songs into playlists by genre. It runs
          entirely in your browser — no backend, no account of its own.
          Sorting works on any Spotify account; playing song previews while
          you sort needs Spotify Premium, but Premium isn't required to use
          the app.
        </p>
        <p>Kondo is an independent tool and is not affiliated with Spotify.</p>
      </div>
      <button className="pill-green" onClick={login}>Log in with Spotify</button>
      {import.meta.env.DEV && (
        <div>
          <button
            disabled={probing}
            onClick={() => {
              setProbing(true);
              runCapabilityProbe().then(setProbeLines).finally(() => setProbing(false));
            }}
          >
            {probing ? 'Probing…' : 'Run API capability probe (needs prior login)'}
          </button>
          <pre>{probeLines.join('\n')}</pre>
        </div>
      )}
    </div>
  );
}
