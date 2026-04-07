import { useState } from 'react';
import { savePair } from './pair';
import './mobile.css';

interface Props {
  onPaired: () => void;
}

export function PairView({ onPaired }: Props) {
  const isEmbedded =
    window.location.port !== '' && window.location.hostname !== 'localhost';
  const [host, setHost] = useState(isEmbedded ? window.location.hostname : '');
  const [port, setPort] = useState(isEmbedded ? window.location.port : '7777');
  const [token, setToken] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!host.trim() || !port.trim() || !token.trim()) {
      setErr('All fields required');
      return;
    }
    setBusy(true);
    setErr(null);
    const p = parseInt(port, 10);
    try {
      const res = await fetch(`http://${host.trim()}:${p}/api/ping`, {
        headers: { Authorization: `Bearer ${token.trim()}` },
      });
      if (!res.ok) {
        setErr(res.status === 401 ? 'Invalid token' : `Error: ${res.status}`);
        setBusy(false);
        return;
      }
    } catch (e: any) {
      setErr(`Can't reach server: ${e?.message ?? e}`);
      setBusy(false);
      return;
    }
    savePair({ host: host.trim(), port: p, token: token.trim() });
    onPaired();
  }

  return (
    <div className="page center-page">
      <div className="login-card">
        <div className="login-logo">🐸</div>
        <h1 className="login-title">procman</h1>
        <p className="login-sub">Connect to your Mac</p>

        <form onSubmit={submit} className="login-form">
          <div style={{ display: 'flex', gap: 8, width: '100%' }}>
            <label className="field" style={{ flex: 1, minWidth: 0 }}>
              <span>Host / IP</span>
              <input
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="192.168.1.10"
                autoCapitalize="off"
                autoCorrect="off"
              />
            </label>
            <label className="field" style={{ flex: 0, width: 72, minWidth: 72 }}>
              <span>Port</span>
              <input
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder="7777"
                inputMode="numeric"
                style={{ width: '100%' }}
              />
            </label>
          </div>
          <label className="field">
            <span>Token</span>
            <input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Paste from Remote Access"
              autoCapitalize="off"
              autoCorrect="off"
            />
          </label>
          {err && <p className="error">{err}</p>}
          <button
            type="submit"
            className="btn-primary"
            disabled={busy || !host.trim() || !token.trim()}
          >
            {busy ? 'Connecting…' : 'Log in'}
          </button>
        </form>
      </div>
    </div>
  );
}
