import { useEffect, useState } from 'react';
import { configureSpotify } from './api/spotify';
import { clearTokens, exchangeCode, loadTokens } from './auth/token';
import { CLIENT_ID, REDIRECT_URI } from './config';
import Login from './components/Login';
import Sorter from './components/Sorter';
import Settings from './components/Settings';
import { loadSettings, saveSettings, type KondoSettings } from './storage/settings';

configureSpotify(CLIENT_ID);

type Tab = 'sorter' | 'analyzer' | 'settings';

export default function App() {
  const [authed, setAuthed] = useState(() => loadTokens() !== null);
  const [tab, setTab] = useState<Tab>('sorter');
  const [authError, setAuthError] = useState<string | null>(null);
  const [settings, setSettings] = useState<KondoSettings>(loadSettings);
  const updateSettings = (s: KondoSettings) => {
    saveSettings(s);
    setSettings(s);
  };
  // `updateSettings` is wired to the Settings tab in Task 15.
  void updateSettings;

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
      <header>
        <h1>spotifyKondo</h1>
        {authed && (
          <nav>
            <button onClick={() => setTab('sorter')}>Sorter</button>
            <button onClick={() => setTab('analyzer')}>Analyzer</button>
            <button onClick={() => setTab('settings')}>Settings</button>
            <button onClick={logout}>Log out</button>
          </nav>
        )}
      </header>
      {authError && <p role="alert">{authError}</p>}
      {!authed && <Login />}
      {authed && tab === 'sorter' && <Sorter settings={settings} />}
      {authed && tab === 'analyzer' && <p>Analyzer — coming soon (separate plan).</p>}
      {authed && tab === 'settings' && <Settings />}
    </main>
  );
}
