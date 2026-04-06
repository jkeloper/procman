import { useState } from 'react';
import { savePair } from './pair';

interface Props {
  onPaired: () => void;
}

export function PairView({ onPaired }: Props) {
  // Default to current origin when served from procman, empty for native app
  const isEmbedded = window.location.port !== '' && window.location.hostname !== 'localhost';
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
    const url = `http://${host.trim()}:${p}`;

    try {
      const res = await fetch(`${url}/api/ping`, {
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
    <div style={{
      minHeight: '100%',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'center',
      padding: '24px 20px env(safe-area-inset-bottom, 20px)',
      boxSizing: 'border-box',
      gap: 20,
    }}>
      <div>
        <div style={{ fontSize: 48, textAlign: 'center', marginBottom: 8 }}>🐸</div>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700, textAlign: 'center', letterSpacing: -0.5 }}>
          procman
        </h1>
        <p style={{ margin: '8px 0 0', fontSize: 13, opacity: 0.5, textAlign: 'center' }}>
          Connect to your Mac's procman server
        </p>
      </div>

      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <Field label="Host / IP" value={host} onChange={setHost} placeholder="192.168.1.10" style={{ flex: 3 }} />
          <Field label="Port" value={port} onChange={setPort} placeholder="7777" style={{ flex: 1 }} />
        </div>
        <Field label="Token" value={token} onChange={setToken} placeholder="Paste from procman → Remote Access" />
        {err && <p style={{ color: '#ff8a8a', fontSize: 13, margin: 0, textAlign: 'center' }}>{err}</p>}
        <button
          type="submit"
          disabled={busy || !host.trim() || !token.trim()}
          style={{
            background: busy ? '#3a6b4f' : '#4a9d6b',
            border: 'none',
            color: '#fff',
            padding: '15px 16px',
            borderRadius: 12,
            fontSize: 16,
            fontWeight: 600,
            opacity: busy || !host.trim() || !token.trim() ? 0.5 : 1,
            marginTop: 4,
          }}
        >
          {busy ? 'Connecting…' : 'Log in'}
        </button>
      </form>
    </div>
  );
}

function Field({
  label, value, onChange, placeholder, style,
}: {
  label: string; value: string; onChange: (v: string) => void; placeholder: string; style?: React.CSSProperties;
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, opacity: 0.5, ...style }}>
      {label}
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        style={{
          background: 'rgba(255,255,255,0.06)',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 10,
          padding: '12px 12px',
          color: '#e4efe7',
          fontSize: 15,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        }}
      />
    </label>
  );
}
