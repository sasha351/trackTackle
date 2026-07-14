import { generateVerifier, challengeFromVerifier, buildAuthUrl } from './pkce';

it('generates a 64-char verifier from the RFC 7636 unreserved set', () => {
  const v = generateVerifier();
  expect(v).toHaveLength(64);
  expect(v).toMatch(/^[A-Za-z0-9\-._~]+$/);
  expect(generateVerifier()).not.toBe(generateVerifier());
});

it('computes the RFC 7636 appendix B challenge', async () => {
  // Known test vector from RFC 7636.
  const challenge = await challengeFromVerifier('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');
  expect(challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

it('builds the Spotify authorize URL', async () => {
  const url = new URL(
    await buildAuthUrl({
      clientId: 'abc123',
      redirectUri: 'http://127.0.0.1:5173/callback',
      scopes: ['user-library-read', 'streaming'],
      verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    }),
  );
  expect(url.origin + url.pathname).toBe('https://accounts.spotify.com/authorize');
  expect(url.searchParams.get('client_id')).toBe('abc123');
  expect(url.searchParams.get('response_type')).toBe('code');
  expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:5173/callback');
  expect(url.searchParams.get('scope')).toBe('user-library-read streaming');
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  expect(url.searchParams.get('code_challenge')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});
