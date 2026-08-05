const UNRESERVED = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';

export function generateVerifier(length = 64): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => UNRESERVED[b % UNRESERVED.length]).join('');
}

export async function challengeFromVerifier(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** The OAuth `state` nonce. Same generator as the verifier — it is already a
 *  CSPRNG over the URL-unreserved set, which is all `state` needs to be.
 *
 *  Defence in depth, not the main line: PKCE already stops a foreign auth code
 *  from being exchanged, because it would have to match a verifier only this
 *  browser's sessionStorage holds. */
export const generateState = (): string => generateVerifier(32);

export async function buildAuthUrl(opts: {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  verifier: string;
  state: string;
}): Promise<string> {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    response_type: 'code',
    redirect_uri: opts.redirectUri,
    scope: opts.scopes.join(' '),
    state: opts.state,
    code_challenge_method: 'S256',
    code_challenge: await challengeFromVerifier(opts.verifier),
  });
  return `https://accounts.spotify.com/authorize?${params}`;
}
