export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
}

const KEY = 'kondo:tokens';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';

export function saveTokens(t: TokenSet): void {
  localStorage.setItem(KEY, JSON.stringify(t));
}

export function loadTokens(): TokenSet | null {
  const raw = localStorage.getItem(KEY);
  return raw ? (JSON.parse(raw) as TokenSet) : null;
}

export function clearTokens(): void {
  localStorage.removeItem(KEY);
}

export function expireAccessToken(): void {
  const t = loadTokens();
  if (t) saveTokens({ ...t, expiresAt: 0 });
}

async function tokenRequest(body: URLSearchParams): Promise<TokenSet> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`token request failed: ${res.status}`);
  const json = await res.json();
  const t: TokenSet = {
    accessToken: json.access_token,
    // Spotify may omit a new refresh token on refresh; keep the old one.
    refreshToken: json.refresh_token ?? loadTokens()?.refreshToken ?? '',
    expiresAt: Date.now() + json.expires_in * 1000,
  };
  saveTokens(t);
  return t;
}

export async function exchangeCode(
  code: string, verifier: string, clientId: string, redirectUri: string,
): Promise<TokenSet> {
  return tokenRequest(new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
  }));
}

// Spotify rotates the refresh token on every use, so two concurrent refreshes
// race: the second one submits a token the first already consumed and gets
// rejected. One in-flight refresh, shared by every concurrent caller, avoids that.
let refreshing: Promise<TokenSet> | null = null;

export async function getValidAccessToken(clientId: string): Promise<string> {
  const t = loadTokens();
  if (!t) throw new Error('not authenticated');
  if (Date.now() < t.expiresAt - 60_000) return t.accessToken;
  if (!refreshing) {
    refreshing = tokenRequest(new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: t.refreshToken,
      client_id: clientId,
    })).finally(() => {
      refreshing = null;
    });
  }
  return (await refreshing).accessToken;
}
