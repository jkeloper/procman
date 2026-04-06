import { useState } from 'react';
import { savePair } from './pair';

interface Props {
  onPaired: () => void;
}

export function PairView({ onPaired }: Props) {
  const [token, setToken] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!token.trim()) {
      setErr('Token required');
      return;
    }
    setBusy(true);
    setErr(null);

    // Derive host+port from current page URL (the PWA is served by procman)
    const host = window.location.hostname;
    const port = parseInt(window.location.port || '80', 10);

    // Verify token works
    try {
      const res = await fetch(`http://${host}:${port}/api/ping`, {
        headers: { Authorization: `Bearer ${token.trim()}` },
      });
      if (!res.ok) {
        setErr(res.status === 401 ? 'Invalid token' : `Server error: ${res.status}`);
        setBusy(false);
        return;
      }
    } catch (e: any) {
      setErr(`Can't reach server: ${e?.message ?? e}`);
      setBusy(false);
      return;
    }

    savePair({ host, port, token: token.trim() });
    onPaired();
  }

  return (
    <div
      style={{
        minHeight: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        padding: '24px 20px env(safe-area-inset-bottom, 20px)',
        boxSizing: 'border-box',
        gap: 20,
      }}
    >
      <div>
        <div style={{ fontSize: 40, textAlign: 'center', marginBottom: 8 }}>🐸</div>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, textAlign: 'center' }}>
          procman remote
        </h1>
        <p style={{ margin: '8px 0 0', fontSize: 13, opacity: 0.6, textAlign: 'center' }}>
          Enter the token shown in procman → Dashboard → Remote Access
        </p>
      </div>

      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <input
          type="text"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Paste token here"
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          style={{
            background: 'rgba(255,255,255,0.05)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 10,
            padding: '14px 14px',
            color: '#e4efe7',
            fontSize: 15,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            textAlign: 'center',
            letterSpacing: 1,
          }}
        />
        {err && (
          <p style={{ color: '#ff8a8a', fontSize: 13, margin: 0, textAlign: 'center' }}>
            {err}
          </p>
        )}
        <button
          type="submit"
          disabled={busy || !token.trim()}
          style={{
            background: busy ? '#3a6b4f' : '#65C18C',
            border: 'none',
            color: '#0d1a12',
            padding: '14px 16px',
            borderRadius: 10,
            fontSize: 16,
            fontWeight: 600,
            opacity: busy || !token.trim() ? 0.6 : 1,
          }}
        >
          {busy ? 'Verifying…' : 'Connect'}
        </button>
      </form>
    </div>
  );
}
