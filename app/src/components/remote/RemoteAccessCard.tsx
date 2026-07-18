import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { api } from '@/api/tauri';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/Toast';
import { useConfirm } from '@/components/ConfirmDialog';
import { useSettings } from '@/hooks/useSettings';
import { useVisibleInterval } from '@/hooks/useVisibleInterval';

type PairingMode = 'loopback' | 'lan' | 'tunnel' | null;

// Pure helper so the LAN/Tunnel credential boundary can be tested without
// relying on QR canvas rendering.
export function buildPairingUrl({
  url,
  token,
  certFingerprint,
  mode,
}: {
  url: string;
  token: string;
  certFingerprint: string | null;
  mode: PairingMode;
}) {
  const payload = new URL(url);
  const params = new URLSearchParams({ token });
  if (certFingerprint) params.set('fp', certFingerprint);
  if (mode === 'lan' || mode === 'tunnel') params.set('mode', mode);
  payload.hash = params.toString();
  return payload.toString();
}

// QR code that encodes the procman pairing payload as a URL with the
// token and optional TLS fingerprint in the fragment (so neither is sent server-side).
// Capacitor iOS pins that fingerprint for LAN REST/WS; browser PWA uses Tunnel only.
function PairingQR({
  url,
  token,
  certFingerprint,
  mode,
}: {
  url: string;
  token: string;
  certFingerprint: string | null;
  mode: PairingMode;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!canvasRef.current) return;
    const payload = buildPairingUrl({ url, token, certFingerprint, mode });
    QRCode.toCanvas(canvasRef.current, payload, {
      width: 180,
      margin: 1,
      color: {
        dark: '#0f1c14',
        light: '#ffffff',
      },
      errorCorrectionLevel: 'M',
    }).catch(() => {});
  }, [url, token, certFingerprint, mode]);
  return (
    <div className="flex flex-col items-center gap-2">
      <canvas
        ref={canvasRef}
        className="rounded-lg ring-1 ring-foreground/10"
        style={{ width: 180, height: 180 }}
      />
      <p className="text-center text-[11px] text-muted-foreground">
        {mode === 'lan'
          ? 'Open the procman iOS app → Scan QR (in-app scanner only)'
          : mode === 'tunnel'
            ? 'Open with your phone camera or the browser PWA'
            : 'Local-only endpoint · use Cloudflare Tunnel for mobile access'}
      </p>
    </div>
  );
}

// Special script_id used to key the tunnel that exposes procman's
// own remote-control HTTP server (not a user script).
const REMOTE_SERVER_TUNNEL_ID = '__procman_remote_server__';

// ---- Tunnel sub-section ---- //
function TunnelSection({
  serverPort,
  serverMode,
  token,
}: {
  serverPort: number | null;
  serverMode: Mode | null;
  token: string;
}) {
  const [tunnel, setTunnel] = useState<
    { running: boolean; url: string | null; pid: number | null } | null
  >({ running: false, url: null, pid: null });
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const reload = useCallback(async () => {
    try {
      const all = await api.tunnelStatus();
      const ours = all.find((t) => t.script_id === REMOTE_SERVER_TUNNEL_ID);
      if (ours) {
        setTunnel({ running: true, url: ours.url, pid: ours.pid });
      } else {
        setTunnel({ running: false, url: null, pid: null });
      }
    } catch {}
  }, []);

  useVisibleInterval(reload, 3000);

  async function start() {
    setBusy(true);
    try {
      const result = await api.startTunnel(
        serverPort ?? 7777,
        REMOTE_SERVER_TUNNEL_ID,
      );
      setTunnel({ running: true, url: result.url, pid: result.pid });
    } catch (e: any) {
      toast.error(`Tunnel failed: ${e?.message ?? e}`, {
        label: 'Retry',
        onClick: () => void start(),
      });
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    setBusy(true);
    try {
      await api.stopTunnel(REMOTE_SERVER_TUNNEL_ID);
      setTunnel({ running: false, url: null, pid: null });
    } finally {
      setBusy(false);
    }
  }

  function copy(text: string) {
    toast.copy(text, 'Tunnel URL copied');
  }

  if (!tunnel) return null;

  return (
    <div className="mt-3 space-y-2 border-t border-border/40 pt-3">
      <div className="flex items-baseline justify-between">
        <div className="flex items-baseline gap-2">
          <span className="text-[11px] font-semibold">Internet Access</span>
          <span className="font-mono text-[10px] text-muted-foreground">
            {tunnel.running ? 'connected' : 'off'}
          </span>
        </div>
        {tunnel.running ? (
          <Button variant="ghost" size="sm" className="h-6 px-2 text-destructive"
            onClick={stop}
            disabled={busy}
          >
            Stop
          </Button>
        ) : (
          <Button size="sm"
            onClick={start}
            disabled={busy || !serverPort || serverMode !== 'loopback'}
            title={serverMode === 'lan' ? 'Stop LAN, then start Local only before exposing a Tunnel' : undefined}
          >
            {busy ? 'Connecting...' : 'Expose via Cloudflare'}
          </Button>
        )}
      </div>

      {tunnel.running && tunnel.url && serverMode === 'loopback' && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-[11px]">
            <span className="min-w-0 flex-1 truncate font-mono text-primary">{tunnel.url}</span>
            <Button variant="ghost" size="sm" className="h-6 px-2"
              onClick={() => copy(tunnel.url!)}
            >
              Copy
            </Button>
          </div>
          <PairingQR
            url={tunnel.url}
            token={token}
            certFingerprint={null}
            mode="tunnel"
          />
        </div>
      )}

      {tunnel.running && serverMode !== 'loopback' && (
        <p className="text-[10px] text-amber-700 dark:text-amber-300">
          This Tunnel no longer has a compatible loopback HTTP origin. Stop it,
          restart Remote Access as Local only, and expose it again.
        </p>
      )}

      {!tunnel.running && (
        <p className="text-[10px] text-muted-foreground/70">
          {serverMode === 'lan'
            ? 'Tunnel uses the loopback HTTP origin. Stop LAN, start Local only, then expose it here.'
            : 'Browser PWA access requires this HTTPS Cloudflare Tunnel; direct LAN pairing is available only in the pinned iOS app. Requires cloudflared.'}
        </p>
      )}
    </div>
  );
}

type Mode = 'loopback' | 'lan';

interface Status {
  running: boolean;
  port: number | null;
  mode: Mode | null;
  tls: boolean;
  cert_fingerprint_sha256: string | null;
  token: string;
}

export function RemoteAccessCard() {
  const [status, setStatus] = useState<Status | null>(null);
  const [ip, setIp] = useState<string>('127.0.0.1');
  const [showToken, setShowToken] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [audit, setAudit] = useState<
    Array<{ ts_ms: number; action: string; target: string; ok: boolean; detail: string | null }>
  >([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { settings } = useSettings();
  const confirm = useConfirm();
  const lanOptIn = settings?.lan_mode_opt_in ?? false;

  const reload = useCallback(async () => {
    try {
      const [s, i] = await Promise.all([
        api.serverStatus(),
        api.localIp().catch(() => '127.0.0.1'),
      ]);
      setStatus(s);
      setIp(i);
      if (s.running) {
        const a = await api.getAuditLog().catch(() => []);
        setAudit(a.slice(-20).reverse());
      }
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    }
  }, []);

  useVisibleInterval(reload, 3000);

  async function toggle(enable: boolean, mode: Mode = 'lan') {
    setBusy(true);
    setErr(null);
    try {
      if (enable) {
        await api.startServer(7777, mode);
      } else {
        // A cloudflared child can outlive its HTTP origin. Stop the special
        // tunnel first so a later loopback restart cannot silently reactivate
        // an old public URL.
        await api.stopTunnel(REMOTE_SERVER_TUNNEL_ID);
        await api.stopServer();
      }
      await reload();
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  async function rotate() {
    const ok = await confirm({
      title: 'Rotate token?',
      description: 'You will need to re-enter the new token on your phone.',
      confirmLabel: 'Rotate',
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.rotateToken();
      await reload();
    } finally {
      setBusy(false);
    }
  }

  const toast2 = useToast();
  function copy(text: string, label: string) {
    const name = label === 'url' ? 'URL' : label === 'cert' ? 'Certificate fingerprint' : 'Token';
    toast2.copy(text, `${name} copied`);
    setCopied(label);
    setTimeout(() => setCopied(null), 1500);
  }

  const scheme = status?.tls ? 'https' : 'http';
  const url = status?.running
    ? `${scheme}://${status.mode === 'lan' ? ip : '127.0.0.1'}:${status.port}`
    : null;
  const fingerprintShort = status?.cert_fingerprint_sha256
    ? `${status.cert_fingerprint_sha256.slice(0, 23)}...${status.cert_fingerprint_sha256.slice(-11)}`
    : null;

  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between">
        <div className="flex items-baseline gap-2">
          <h2 className="text-[13px] font-semibold">Remote Access</h2>
          <span className="font-mono text-[11px] text-muted-foreground">
            {status?.running ? 'serving' : 'off'}
          </span>
        </div>
        {status?.running ? (
          <Button variant="ghost" size="sm" className="h-6 px-2 text-destructive"
            onClick={() => toggle(false)}
            disabled={busy}
          >
            Stop
          </Button>
        ) : (
          <div className="flex gap-1">
            <Button variant="ghost" size="sm" className="h-6 px-2"
              onClick={() => toggle(true, 'loopback')}
              disabled={busy}
            >
              Local only
            </Button>
            <Button
              size="sm"
              onClick={() => toggle(true, 'lan')}
              disabled={busy || !lanOptIn}
              title={!lanOptIn ? 'Enable LAN mode in Settings first' : undefined}
            >
              Start LAN
            </Button>
          </div>
        )}
      </div>

      {err && <p className="mb-2 text-[11px] text-red-500">{err}</p>}

      {!status?.running && !lanOptIn && (
        <div className="mb-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
          <span className="font-semibold">LAN mode disabled.</span> Opt-in from Settings
          for pinned Capacitor iOS access. Browser PWA clients always require a
          Cloudflare Tunnel.
        </div>
      )}
      {!status?.running && lanOptIn && (
        <div className="mb-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-1.5 text-[10px] text-amber-700 dark:text-amber-300">
          Direct LAN pairing is for the Capacitor iOS app only. Native REST and
          WebSocket pin this self-signed certificate&apos;s SHA-256 leaf fingerprint
          and fail closed on mismatch. Browser PWA clients must use Cloudflare
          Tunnel; a replaced certificate requires scanning a new QR.
        </div>
      )}

      {!status?.running ? (
        <div className="rounded-lg border border-dashed border-border/60 bg-card/50 p-3 text-[11px] text-muted-foreground">
          <div>
            Start the server to control procman from your phone.
            <br />
            <span className="text-muted-foreground/70">
              iOS LAN → scan in app. Browser PWA → start Cloudflare Tunnel.
            </span>
          </div>
          <TunnelSection serverPort={null} serverMode={null} token="" />
        </div>
      ) : (
        <div className="space-y-3 rounded-lg border border-border/60 bg-card p-3">
          <div className="space-y-1.5 text-[11px]">
            {/* URL */}
            <div className="flex items-center gap-2">
              <span className="w-12 text-muted-foreground">URL</span>
              <span className="font-mono">{url}</span>
              <Button variant="ghost" size="sm" className="h-6 px-2"
                onClick={() => copy(url!, 'url')}
              >
                {copied === 'url' ? '✓' : 'Copy'}
              </Button>
            </div>
            {/* Token */}
            <div className="flex items-center gap-2">
              <span className="w-12 text-muted-foreground">Token</span>
              <span className="min-w-0 flex-1 truncate font-mono">
                {showToken ? status.token : '•'.repeat(20)}
              </span>
              <Button variant="ghost" size="sm" className="h-6 px-2"
                onClick={() => setShowToken(!showToken)}
              >
                {showToken ? 'Hide' : 'Show'}
              </Button>
              <Button variant="ghost" size="sm" className="h-6 px-2"
                onClick={() => copy(status.token, 'token')}
              >
                {copied === 'token' ? '✓' : 'Copy'}
              </Button>
            </div>
            {/* Mode */}
            <div className="flex items-center gap-2">
              <span className="w-12 text-muted-foreground">Mode</span>
              <span className="font-mono">{status.mode}</span>
              {status.mode === 'lan' && (
                <span className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                  {status.tls ? 'TLS' : 'HTTP fallback'}
                </span>
              )}
            </div>
            {status.tls && status.cert_fingerprint_sha256 && (
              <div className="flex items-center gap-2">
                <span className="w-12 text-muted-foreground">Cert</span>
                <span
                  className="min-w-0 flex-1 truncate font-mono"
                  title={status.cert_fingerprint_sha256}
                >
                  {fingerprintShort}
                </span>
                <Button variant="ghost" size="sm" className="h-6 px-2"
                  onClick={() => copy(status.cert_fingerprint_sha256!, 'cert')}
                >
                  {copied === 'cert' ? '✓' : 'Copy'}
                </Button>
              </div>
            )}
          </div>

          {url && status.token && status.mode === 'lan' && (
            <div className="border-t border-border/40 pt-3">
              <PairingQR
                url={url}
                token={status.token}
                certFingerprint={status.cert_fingerprint_sha256}
                mode={status.mode}
              />
              {status.mode === 'lan' && (
                <p className="mt-2 text-center text-[10px] text-muted-foreground/70">
                  iOS app only · pinned certificate · re-pair after certificate changes
                </p>
              )}
            </div>
          )}

          <div className="flex items-center gap-2 border-t border-border/40 pt-2">
            <Button variant="outline" size="sm" className="h-6 px-2"
              onClick={rotate}
              disabled={busy}
            >
              Rotate token
            </Button>
            <span className="text-[10px] text-muted-foreground/50">
              {status.mode === 'lan'
                ? 'Or scan QR ↑ in the procman iOS app'
                : 'Use Cloudflare Tunnel for mobile access'}
            </span>
          </div>

          <TunnelSection
            serverPort={status.port}
            serverMode={status.mode}
            token={status.token}
          />

          {audit.length > 0 && (
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Activity
              </div>
              <ul className="max-h-28 space-y-0.5 overflow-y-auto font-mono text-[10px]">
                {audit.map((a, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="shrink-0 text-muted-foreground/60">
                      {new Date(a.ts_ms).toLocaleTimeString()}
                    </span>
                    <span
                      className={`shrink-0 uppercase ${
                        a.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'
                      }`}
                    >
                      {a.action}
                    </span>
                    <span className="truncate text-muted-foreground">{a.target}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
