import { useState } from 'react';
import { buildAuthUrl, generateVerifier } from '../auth/pkce';
import { CLIENT_ID, REDIRECT_URI, SCOPES } from '../config';
import { runCapabilityProbe } from '../dev/probe';

export default function Login() {
  const [probeLines, setProbeLines] = useState<string[]>([]);

  const login = async () => {
    const verifier = generateVerifier();
    sessionStorage.setItem('kondo:verifier', verifier);
    window.location.href = await buildAuthUrl({
      clientId: CLIENT_ID, redirectUri: REDIRECT_URI, scopes: SCOPES, verifier,
    });
  };

  return (
    <div>
      <p>Sort your Liked Songs into playlists. Everything stays in this browser.</p>
      <button className="pill-green" onClick={login}>Log in with Spotify</button>
      {import.meta.env.DEV && (
        <div>
          <button onClick={() => runCapabilityProbe().then(setProbeLines)}>
            Run API capability probe (needs prior login)
          </button>
          <pre>{probeLines.join('\n')}</pre>
        </div>
      )}
    </div>
  );
}
