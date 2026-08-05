import { useEffect, useState } from 'react';
import { configureSpotify } from './api/spotify';
import { clearTokens, exchangeCode, loadTokens } from './auth/token';
import { CLIENT_ID, REDIRECT_URI } from './config';
import Login from './components/Login';
import Sorter from './components/Sorter';
import Analyzer from './components/Analyzer';
import Settings from './components/Settings';
import LegalPage from './components/LegalPage';
import RateLimitBanner from './components/RateLimitBanner';
import { useLibrary } from './hooks/useLibrary';
import { loadSettings, saveSettings, type AppSettings } from './storage/settings';
import { clearSnapshot } from './storage/librarySnapshot';

configureSpotify(CLIENT_ID);

type Tab = 'sorter' | 'analyzer' | 'settings';

// Mounted only once authed, so the library loads once and survives tab switches
// instead of Sorter/Analyzer each refetching on mount.
function Workspace({
  tab, settings, onSettingsChange, onAuthExpired,
}: { tab: Tab; settings: AppSettings; onSettingsChange: (s: AppSettings) => void; onAuthExpired: () => void }) {
  const lib = useLibrary(settings);
  useEffect(() => {
    if (lib.authExpired) onAuthExpired();
  }, [lib.authExpired, onAuthExpired]);
  // One-time rewrite of the legacy allowlist into its complement, done here
  // because this is the first point the real roster exists. Runs once: it
  // nulls the field it keys on. Costs one extra reload (settingsKey changes)
  // on the first load after upgrading, once per browser.
  useEffect(() => {
    const legacy = settings.targetPlaylistIds;
    if (!legacy || lib.allPlaylists.length === 0) return;
    onSettingsChange({
      ...settings,
      targetPlaylistIds: null,
      excludedPlaylistIds: lib.allPlaylists.filter((p) => !legacy.includes(p.id)).map((p) => p.id),
    });
  }, [settings, lib.allPlaylists, onSettingsChange]);
  return (
    <>
      {tab === 'sorter' && <Sorter settings={settings} lib={lib} />}
      {tab === 'analyzer' && <Analyzer lib={lib} />}
      {tab === 'settings' && (
        <Settings
          settings={settings}
          onChange={onSettingsChange}
          playlists={lib.status === 'loading' ? null : lib.allPlaylists}
          error={lib.status === 'error' && lib.allPlaylists.length === 0 ? lib.error : null}
          lib={lib}
        />
      )}
    </>
  );
}

export default function App() {
  const [authed, setAuthed] = useState(() => loadTokens() !== null);
  const [tab, setTab] = useState<Tab>('sorter');
  const [authError, setAuthError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showLegal, setShowLegal] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(loadSettings);
  const updateSettings = (s: AppSettings) => {
    saveSettings(s);
    setSettings(s);
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const authorizeError = params.get('error');
    if (!code && !authorizeError) return;

    // Consume both stashed values up front, synchronously and unconditionally.
    // StrictMode double-invokes effects in dev and an auth code is single-use,
    // so the second pass must find nothing left to exchange — and a cancelled
    // or rejected authorize must not leave them behind for a later attempt to
    // pick up.
    const verifier = sessionStorage.getItem('tracktackle:verifier');
    const expectedState = sessionStorage.getItem('tracktackle:state');
    sessionStorage.removeItem('tracktackle:verifier');
    sessionStorage.removeItem('tracktackle:state');
    const clearUrl = () => window.history.replaceState(null, '', import.meta.env.BASE_URL);

    // Spotify sends the user back with ?error= when they hit Cancel on the
    // consent screen. Without this branch they land on the login page with no
    // explanation and no idea whether something broke.
    if (authorizeError) {
      setNotice(authorizeError === 'access_denied'
        ? 'You cancelled the Spotify login, so nothing was connected. Press the button to try again.'
        : `Spotify refused the login (${authorizeError}).`);
      clearUrl();
      return;
    }
    if (!verifier) return; // StrictMode's second pass, or a stray ?code=

    // state is defence in depth — PKCE already blocks a foreign code, which
    // could not match this browser's verifier. Bail rather than exchange.
    if (params.get('state') !== expectedState) {
      setAuthError('Login could not be verified (state mismatch). Please try again.');
      clearUrl();
      return;
    }
    exchangeCode(code!, verifier, CLIENT_ID, REDIRECT_URI)
      .then(() => setAuthed(true))
      .catch((e) => setAuthError(String(e)))
      .finally(clearUrl);
  }, []);

  const logout = () => {
    clearTokens();
    clearSnapshot(); // the cached library belongs to the account that just left
    setAuthed(false);
  };

  const handleAuthExpired = () => {
    clearTokens();
    clearSnapshot();
    setAuthed(false);
    setNotice('Your Spotify session expired — log in again.');
  };

  return (
    <main>
      <header className="app-header" id="top">
        {/* The mark lives inside the h1 so the `flex: 1 0 100%` full-row rule
            below still applies to both together. alt="" because the heading
            already says the name — a second copy would just be noise to a
            screen reader. */}
        {/* icon-192, not favicon.png: the favicon is cropped tight to the
            artwork so it survives a 16px tab, which would make this 40px mark
            look zoomed next to the login screen's. Same source as that one. */}
        <h1><img className="app-logo" src="/icon-192.png" alt="" />Track Tackle</h1>
        {authed && !showLegal && (
          <nav>
            <button aria-pressed={tab === 'sorter'} onClick={() => setTab('sorter')}>Sorter</button>
            <button aria-pressed={tab === 'analyzer'} onClick={() => setTab('analyzer')}>Analyzer</button>
            <button aria-pressed={tab === 'settings'} onClick={() => setTab('settings')}>Settings</button>
            <button onClick={logout}>Log out</button>
          </nav>
        )}
      </header>
      {authError && <p role="alert">{authError}</p>}
      {notice && <p role="status">{notice}</p>}
      {authed && <RateLimitBanner />}
      {showLegal && <LegalPage />}
      {!showLegal && !authed && <Login />}
      {!showLegal && authed && <Workspace tab={tab} settings={settings} onSettingsChange={updateSettings} onAuthExpired={handleAuthExpired} />}
      {/* A plain anchor, not a scroll handler: the browser already does this,
          and `scroll-behavior: smooth` in index.css makes it glide. Always
          visible rather than appearing past some scroll depth — that would
          cost a scroll listener to save nothing. */}
      {/* Viewport-fixed rather than in the header flow, because the request is
          explicitly that it stay put while scrolling. Same pattern as .to-top
          below; `.app-header h1 { flex: 1 0 100% }` puts the nav on its own
          row, below the fixed toggle, so it never slides underneath it. */}
      {authed && !showLegal && (
        <button
          className="skin-toggle"
          aria-pressed={settings.skin === 'gallery'}
          onClick={() => updateSettings({
            ...settings,
            skin: settings.skin === 'gallery' ? 'table' : 'gallery',
          })}
        >
          {settings.skin === 'gallery' ? 'Table view' : 'Gallery view'}
        </button>
      )}
      {authed && !showLegal && (
        <a className="to-top" href="#top" aria-label="Back to top">↑</a>
      )}
      <footer className="app-footer">
        <button aria-pressed={showLegal} onClick={() => setShowLegal((v) => !v)}>
          {showLegal ? 'Back' : 'Privacy & Terms'}
        </button>
        <p className="footer-attribution">
          Music data and playback provided by Spotify. Not affiliated with Spotify AB.
        </p>
      </footer>
    </main>
  );
}
