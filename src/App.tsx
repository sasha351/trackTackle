import { useEffect, useState } from 'react';
import { configureSpotify } from './api/spotify';
import { clearTokens, exchangeCode, loadTokens } from './auth/token';
import { CLIENT_ID, REDIRECT_URI } from './config';
import Login from './components/Login';
import Sorter from './components/Sorter';
import Settings from './components/Settings';
import LegalPage from './components/LegalPage';
import { loadSettings, saveSettings, type KondoSettings } from './storage/settings';

configureSpotify(CLIENT_ID);

type Tab = 'sorter' | 'analyzer' | 'settings';

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
      {showLegal && <LegalPage />}
      {!showLegal && !authed && <Login />}
      {!showLegal && authed && tab === 'sorter' && <Sorter settings={settings} />}
      {!showLegal && authed && tab === 'analyzer' && <p>Analyzer — coming soon (separate plan).</p>}
      {!showLegal && authed && tab === 'settings' && <Settings settings={settings} onChange={updateSettings} />}
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
