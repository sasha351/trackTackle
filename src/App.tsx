import { useEffect, useState } from 'react';
import { configureSpotify } from './api/spotify';
import { clearTokens, exchangeCode, loadTokens } from './auth/token';
import { CLIENT_ID, REDIRECT_URI } from './config';
import Login from './components/Login';
import Sorter from './components/Sorter';
import Analyzer from './components/Analyzer';
import Settings from './components/Settings';
import LegalPage from './components/LegalPage';
import { useLibrary } from './hooks/useLibrary';
import { loadSettings, saveSettings, type KondoSettings } from './storage/settings';

configureSpotify(CLIENT_ID);

type Tab = 'sorter' | 'analyzer' | 'settings';

// Mounted only once authed, so the library loads once and survives tab switches
// instead of Sorter/Analyzer each refetching on mount.
function Workspace({
  tab, settings, onSettingsChange, onAuthExpired,
}: { tab: Tab; settings: KondoSettings; onSettingsChange: (s: KondoSettings) => void; onAuthExpired: () => void }) {
  const lib = useLibrary(settings);
  useEffect(() => {
    if (lib.authExpired) onAuthExpired();
  }, [lib.authExpired, onAuthExpired]);
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
        />
      )}
    </>
  );
}

export default function App() {
  const [authed, setAuthed] = useState(() => loadTokens() !== null);
  const [tab, setTab] = useState<Tab>('sorter');
  const [authError, setAuthError] = useState<string | null>(null);
  const [showLegal, setShowLegal] = useState(false);
  const [settings, setSettings] = useState<KondoSettings>(loadSettings);
  const updateSettings = (s: KondoSettings) => {
    saveSettings(s);
    setSettings(s);
  };

  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('code');
    if (!code) return;
    // Consume the verifier: StrictMode double-invokes effects in dev, and an
    // auth code is single-use — the second pass must not re-exchange.
    const verifier = sessionStorage.getItem('kondo:verifier');
    if (!verifier) return;
    sessionStorage.removeItem('kondo:verifier');
    exchangeCode(code, verifier, CLIENT_ID, REDIRECT_URI)
      .then(() => setAuthed(true))
      .catch((e) => setAuthError(String(e)))
      .finally(() => window.history.replaceState(null, '', import.meta.env.BASE_URL));
  }, []);

  const logout = () => {
    clearTokens();
    setAuthed(false);
  };

  const [notice, setNotice] = useState<string | null>(null);

  const handleAuthExpired = () => {
    clearTokens();
    setAuthed(false);
    setNotice('Your Spotify session expired — log in again.');
  };

  return (
    <main>
      <header className="app-header">
        <h1>Kondo</h1>
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
      {showLegal && <LegalPage />}
      {!showLegal && !authed && <Login notice={notice || undefined} />}
      {!showLegal && authed && <Workspace tab={tab} settings={settings} onSettingsChange={updateSettings} onAuthExpired={handleAuthExpired} />}
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
