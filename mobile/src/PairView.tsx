import { useState } from 'react';
import { savePair } from './pair';
import { QrScanner } from './QrScanner';
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
  const [scanning, setScanning] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  function cancel() {
    abortCtrl?.abort();
    setAbortCtrl(null);
    setBusy(false);
    setErr('Cancelled');
  }

  function handleQrScan(text: string) {
    setScanning(false);
    try {
      // QR format: "http(s)://host:port#token=xxx"
      const url = new URL(text);
      const hashParams = new URLSearchParams(url.hash.slice(1));
      const scannedToken = hashParams.get('token');
      if (!scannedToken) {
        setErr('QR code has no token. Generate a new QR from procman Remote Access.');
        return;
      }
      const isTunnel = url.hostname.includes('trycloudflare.com');
      if (isTunnel) {
        setMode('tunnel');
        setTunnelUrl(`${url.protocol}//${url.host}`);
      } else {
        setMode('lan');
        setHost(url.hostname);
        setPort(url.port || (url.protocol === 'https:' ? '443' : '80'));
      }
      setToken(scannedToken);
      setErr(null);
    } catch {
      setErr('Invalid QR code. Expected a procman pairing URL.');
    }
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
    <div className="page center-page" style={{ overflow: 'auto' }}>
      <div className="login-card">
        <div className="login-logo"><img src="/icon-192.png" alt="procman" style={{width:72,height:72,borderRadius:16}} /></div>
        <h1 className="login-title">procman</h1>
        <p className="login-sub">Companion app for procman on macOS</p>

        {/* What this app is — visible before pairing, for App Store reviewers and new users.
            TODO(post-launch): optional "demo mode" with stub data for zero-setup exploration. */}
        <div style={{
          background: 'rgba(255,255,255,0.04)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 12,
          padding: 14,
          marginBottom: 16,
          fontSize: 13,
          lineHeight: 1.5,
          color: 'var(--fg2)',
          textAlign: 'left',
        }}>
          <div style={{ color: 'var(--fg)', fontWeight: 600, marginBottom: 6 }}>
            How it works
          </div>
          <ol style={{ margin: 0, paddingLeft: 18 }}>
            <li>Install procman on your Mac (<a href="https://procman.kr" target="_blank" rel="noreferrer" style={{ color: 'var(--primary)' }}>procman.kr</a>)</li>
            <li>Open Dashboard &rarr; Remote Access &rarr; Start</li>
            <li>Scan the QR code or paste the token below</li>
          </ol>
          <button
            type="button"
            onClick={() => setShowHelp((v) => !v)}
            style={{
              marginTop: 8,
              background: 'transparent',
              border: 'none',
              color: 'var(--primary)',
              padding: 0,
              cursor: 'pointer',
              fontSize: 12,
            }}
          >
            {showHelp ? 'Hide details' : 'What does this app do?'}
          </button>
          {showHelp && (
            <div style={{ marginTop: 8, color: 'var(--fg3)', fontSize: 12 }}>
              procman mobile is a remote control for the procman desktop app on macOS. It lets you start, stop, and watch logs of your dev processes (servers, Docker, tunnels) from your phone. The app cannot function without a paired Mac running procman.
            </div>
          )}
        </div>

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

        <button
          type="button"
          onClick={() => setScanning(true)}
          style={{
            width: '100%',
            padding: '12px 0',
            marginBottom: 12,
            border: '1px solid rgba(255,255,255,0.15)',
            borderRadius: 10,
            background: 'rgba(255,255,255,0.05)',
            color: '#e4efe7',
            fontSize: 15,
            fontWeight: 600,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
          }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M3 7V5a2 2 0 012-2h2M17 3h2a2 2 0 012 2v2M21 17v2a2 2 0 01-2 2h-2M7 21H5a2 2 0 01-2-2v-2"/>
            <rect x="7" y="7" width="10" height="10" rx="1"/>
          </svg>
          Scan QR Code
        </button>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, color: 'var(--fg3)', fontSize: 12 }}>
          <span style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.08)' }} />
          or connect manually
          <span style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.08)' }} />
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
      {scanning && (
        <QrScanner
          onScan={handleQrScan}
          onClose={() => setScanning(false)}
        />
      )}
    </div>
  );
}
