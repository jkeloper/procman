import { lazy, Suspense, useState } from 'react';
import {
  parsePairingUrl,
  savePair,
  validatePairInfo,
  type ConnectionMode,
  type PairInfo,
} from './pair';
import { isNativeIOS } from './platform';
import { isTerminalTransportError, transportRequest } from './transport';
import './mobile.css';

// Lazy boundary: the QR scanner (and its heavy html5-qrcode dependency) is a
// one-time pairing affordance, so it's code-split out of the initial bundle and
// fetched only when the user opens the scanner.
const QrScanner = lazy(() => import('./QrScanner'));

interface Props {
  onPaired: () => void;
}

export function PairView({ onPaired }: Props) {
  const nativeIOS = isNativeIOS();
  const isEmbedded =
    window.location.port !== '' && window.location.hostname !== 'localhost';

  const [mode, setMode] = useState<ConnectionMode>(nativeIOS ? 'lan' : 'tunnel');
  const [host, setHost] = useState(isEmbedded ? window.location.hostname : '');
  const [port, setPort] = useState(isEmbedded ? window.location.port : '7777');
  const [tunnelUrl, setTunnelUrl] = useState('');
  const [token, setToken] = useState('');
  const [certFingerprint, setCertFingerprint] = useState<string | null>(null);
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
      const pair = parsePairingUrl(text);
      if (pair.connectionMode === 'tunnel') {
        setMode('tunnel');
        setTunnelUrl(`https://${pair.host}`);
      } else {
        setMode('lan');
        setHost(pair.host);
        setPort(String(pair.port));
      }
      setToken(pair.token);
      setCertFingerprint(pair.certFingerprintSha256);
      setErr(null);
    } catch (error: unknown) {
      setErr(error instanceof Error ? error.message : 'Invalid procman pairing QR code.');
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!token.trim()) {
      setErr('Token required');
      return;
    }

    let candidate: PairInfo;

    try {
      if (mode === 'tunnel') {
        let value = tunnelUrl.trim();
        if (!value) throw new Error('Tunnel URL required');
        if (!value.includes('://')) value = `https://${value}`;
        const parsed = new URL(value);
        if (parsed.username || parsed.password || (parsed.pathname !== '/' && parsed.pathname !== '')) {
          throw new Error('Enter the Tunnel origin only, without credentials or a path.');
        }
        candidate = validatePairInfo({
          connectionMode: 'tunnel',
          host: parsed.hostname,
          port: parsed.port ? Number.parseInt(parsed.port, 10) : 443,
          scheme: parsed.protocol === 'https:' ? 'https' : 'http',
          token,
          certFingerprintSha256: null,
        });
      } else {
        candidate = validatePairInfo({
          connectionMode: 'lan',
          host,
          port: Number.parseInt(port, 10),
          scheme: 'https',
          token,
          certFingerprintSha256: certFingerprint,
        });
      }
    } catch (error: unknown) {
      setErr(error instanceof Error ? error.message : 'Invalid connection settings.');
      return;
    }

    setBusy(true);
    setErr(null);
    const ctrl = new AbortController();
    setAbortCtrl(ctrl);

    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, 10_000);

    try {
      const res = await transportRequest(candidate, '/api/ping', {
        headers: { Authorization: `Bearer ${candidate.token}` },
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const msg =
          res.status === 401 ? 'Invalid token. Check Remote Access in procman.' :
          res.status === 403 ? 'Forbidden — token might be expired. Rotate and retry.' :
          res.status === 404 ? 'Server found but API not available. Check procman version.' :
          `Server error (${res.status}). Try again later.`;
        setErr(msg);
        return;
      }
    } catch (e: unknown) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        if (timedOut) {
          setErr('Connection timed out (10s). Check the address and try again.');
        }
        return;
      }
      const message = e instanceof Error ? e.message : String(e);
      const msg = isTerminalTransportError(e)
        ? message
        : message.includes('timed out')
        ? message
        : message.includes('Failed to fetch') || message.includes('NetworkError')
        ? `Can't reach ${mode === 'tunnel' ? 'tunnel' : 'server'}. Check:\n• ${mode === 'lan' ? 'Same Wi-Fi network?' : 'Tunnel still running?'}\n• IP address correct?\n• procman server started?`
        : `Connection failed: ${message}`;
      setErr(msg);
      return;
    } finally {
      window.clearTimeout(timeout);
      setBusy(false);
      setAbortCtrl(null);
    }

    savePair(candidate);
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
            disabled={!nativeIOS}
            title={!nativeIOS ? 'LAN pinning requires the procman iOS app' : undefined}
            style={{
              flex: 1,
              padding: '10px 0',
              border: 'none',
              fontSize: 13,
              fontWeight: 600,
              cursor: nativeIOS ? 'pointer' : 'not-allowed',
              opacity: nativeIOS ? 1 : 0.45,
              background: mode === 'lan' ? 'var(--primary)' : 'transparent',
              color: mode === 'lan' ? '#fff' : 'var(--fg2)',
            }}
          >
            LAN
          </button>
          <button
            type="button"
            onClick={() => { setMode('tunnel'); setCertFingerprint(null); setErr(null); }}
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

        {!nativeIOS && (
          <div
            role="note"
            style={{
              margin: '-6px 0 14px',
              color: 'var(--fg3)',
              fontSize: 12,
              lineHeight: 1.45,
              textAlign: 'left',
            }}
          >
            Browser/PWA access is Tunnel-only. Start a Cloudflare Tunnel in
            procman on your Mac, then scan its QR code or enter its HTTPS URL.
            Direct LAN access with certificate pinning is available in the iOS app.
          </div>
        )}

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
            <>
              <div style={{ display: 'flex', gap: 8, width: '100%', boxSizing: 'border-box' }}>
                <label className="field" style={{ flex: 'none', width: 88 }}>
                  <span>Scheme</span>
                  <input
                    value="HTTPS"
                    readOnly
                    style={{
                      width: '100%',
                      height: 44,
                      borderRadius: 10,
                      border: '1px solid rgba(255,255,255,0.12)',
                      background: '#101a14',
                      color: 'var(--fg)',
                      padding: '0 10px',
                    }}
                  />
                </label>
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
              <label className="field">
                <span>SHA-256 certificate fingerprint</span>
                <input
                  value={certFingerprint ?? ''}
                  onChange={(e) => setCertFingerprint(e.target.value)}
                  placeholder="AA:BB:… (scan QR recommended)"
                  autoCapitalize="characters"
                  autoCorrect="off"
                  spellCheck={false}
                />
              </label>
              <p style={{
                margin: '0 0 4px',
                color: 'var(--fg3)',
                fontSize: 11,
                lineHeight: 1.4,
              }}>
                The iOS app pins this fingerprint for both API and live-stream traffic.
              </p>
            </>
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
        <Suspense fallback={null}>
          <QrScanner
            onScan={handleQrScan}
            onClose={() => setScanning(false)}
          />
        </Suspense>
      )}
    </div>
  );
}
