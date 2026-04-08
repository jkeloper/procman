import { useState } from 'react';
import { savePair } from './pair';
import './mobile.css';

interface Props {
  onPaired: () => void;
}

type Mode = 'lan' | 'tunnel';

export function PairView({ onPaired }: Props) {
  const isEmbedded =
    window.location.port !== '' && window.location.hostname !== 'localhost';

  const [mode, setMode] = useState<Mode>('lan');
  const [host, setHost] = useState(isEmbedded ? window.location.hostname : '');
  const [port, setPort] = useState(isEmbedded ? window.location.port : '7777');
  const [tunnelUrl, setTunnelUrl] = useState('');
  const [token, setToken] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [abortCtrl, setAbortCtrl] = useState<AbortController | null>(null);

  function cancel() {
    abortCtrl?.abort();
    setAbortCtrl(null);
    setBusy(false);
    setErr('Cancelled');
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!token.trim()) {
      setErr('Token required');
      return;
    }

    let baseUrl: string;
    let pairHost: string;
    let pairPort: number;

    if (mode === 'tunnel') {
      let url = tunnelUrl.trim();
      if (!url) {
        setErr('Tunnel URL required');
        return;
      }
      // Normalize: remove trailing slash, ensure https://
      url = url.replace(/\/+$/, '');
      if (!url.startsWith('http')) url = 'https://' + url;
      baseUrl = url;
      // For tunnel, store the full URL as host with port 443
      const parsed = new URL(url);
      pairHost = parsed.hostname;
      pairPort = parsed.port ? parseInt(parsed.port, 10) : (parsed.protocol === 'https:' ? 443 : 80);
    } else {
      if (!host.trim() || !port.trim()) {
        setErr('Host and port required');
        return;
      }
      pairHost = host.trim();
      pairPort = parseInt(port, 10);
      baseUrl = `http://${pairHost}:${pairPort}`;
    }

    setBusy(true);
    setErr(null);
    const ctrl = new AbortController();
    setAbortCtrl(ctrl);

    try {
      const res = await Promise.race([
        fetch(`${baseUrl}/api/ping`, {
          headers: { Authorization: `Bearer ${token.trim()}` },
          signal: ctrl.signal,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Connection timed out (10s). Check the address and try again.')), 10000),
        ),
      ]);
      if (!res.ok) {
        const msg =
          res.status === 401 ? 'Invalid token. Check Remote Access in procman.' :
          res.status === 403 ? 'Forbidden — token might be expired. Rotate and retry.' :
          res.status === 404 ? 'Server found but API not available. Check procman version.' :
          `Server error (${res.status}). Try again later.`;
        setErr(msg);
        setBusy(false);
        setAbortCtrl(null);
        return;
      }
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        setBusy(false);
        setAbortCtrl(null);
        return;
      }
      const msg = e?.message?.includes('timed out')
        ? e.message
        : e?.message?.includes('Failed to fetch') || e?.message?.includes('NetworkError')
        ? `Can't reach ${mode === 'tunnel' ? 'tunnel' : 'server'}. Check:\n• ${mode === 'lan' ? 'Same Wi-Fi network?' : 'Tunnel still running?'}\n• IP address correct?\n• procman server started?`
        : `Connection failed: ${e?.message ?? e}`;
      setErr(msg);
      setBusy(false);
      setAbortCtrl(null);
      return;
    }
    setAbortCtrl(null);

    savePair({ host: pairHost, port: pairPort, token: token.trim() });
    onPaired();
  }

  return (
    <div className="page center-page">
      <div className="login-card">
        <div className="login-logo"><img src="/icon-192.png" alt="procman" style={{width:72,height:72,borderRadius:16}} /></div>
        <h1 className="login-title">procman</h1>
        <p className="login-sub">Connect to your Mac</p>

        {/* Mode toggle */}
        <div style={{
          display: 'flex',
          gap: 0,
          borderRadius: 10,
          overflow: 'hidden',
          border: '1px solid rgba(255,255,255,0.1)',
          marginBottom: 16,
        }}>
          <button
            type="button"
            onClick={() => { setMode('lan'); setErr(null); }}
            style={{
              flex: 1,
              padding: '10px 0',
              border: 'none',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              background: mode === 'lan' ? 'var(--primary)' : 'transparent',
              color: mode === 'lan' ? '#fff' : 'var(--fg2)',
            }}
          >
            LAN
          </button>
          <button
            type="button"
            onClick={() => { setMode('tunnel'); setErr(null); }}
            style={{
              flex: 1,
              padding: '10px 0',
              border: 'none',
              borderLeft: '1px solid rgba(255,255,255,0.1)',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              background: mode === 'tunnel' ? 'var(--primary)' : 'transparent',
              color: mode === 'tunnel' ? '#fff' : 'var(--fg2)',
            }}
          >
            Tunnel
          </button>
        </div>

        <form onSubmit={submit} className="login-form">
          {mode === 'lan' ? (
            <div style={{ display: 'flex', gap: 8, width: '100%', boxSizing: 'border-box' }}>
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
              <label className="field" style={{ flex: 'none', width: 70 }}>
                <span>Port</span>
                <input
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                  placeholder="7777"
                  inputMode="numeric"
                />
              </label>
            </div>
          ) : (
            <label className="field">
              <span>Cloudflare Tunnel URL</span>
              <input
                value={tunnelUrl}
                onChange={(e) => setTunnelUrl(e.target.value)}
                placeholder="https://xxx-xxx.trycloudflare.com"
                autoCapitalize="off"
                autoCorrect="off"
              />
            </label>
          )}

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
          {err && <p className="error" style={{ whiteSpace: 'pre-line' }}>{err}</p>}
          {busy ? (
            <button
              type="button"
              className="btn-primary"
              onClick={cancel}
              style={{ background: 'transparent', border: '1px solid rgba(255,255,255,0.15)', color: 'var(--fg)' }}
            >
              Cancel
            </button>
          ) : (
            <button
              type="submit"
              className="btn-primary"
              disabled={!token.trim()}
            >
              Log in
            </button>
          )}
        </form>
      </div>
    </div>
  );
}
