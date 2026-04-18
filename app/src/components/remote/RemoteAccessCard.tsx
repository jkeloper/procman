import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { api } from '@/api/tauri';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/Toast';
import { useSettings } from '@/hooks/useSettings';

// QR code that encodes the procman pairing payload as a URL with the
// token in the fragment (so it never gets logged or sent server-side).
// Mobile picks the URL up, parses #token=, and auto-pairs.
function PairingQR({ url, token }: { url: string; token: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!canvasRef.current) return;
    const payload = `${url}#token=${encodeURIComponent(token)}`;
    QRCode.toCanvas(canvasRef.current, payload, {
      width: 180,
      margin: 1,
      color: {
        dark: '#0f1c14',
        light: '#ffffff',
      },
      errorCorrectionLevel: 'M',
    }).catch(() => {});
  }, [url, token]);
  return (
    <div className="flex flex-col items-center gap-2">
      <canvas
        ref={canvasRef}
        className="rounded-lg ring-1 ring-foreground/10"
        style={{ width: 180, height: 180 }}
      />
      <p className="text-center text-[11px] text-muted-foreground">
        Scan with your phone camera to pair instantly
      </p>
    </div>
  );
}

// Special script_id used to key the tunnel that exposes procman's
// own remote-control HTTP server (not a user script).
const REMOTE_SERVER_TUNNEL_ID = '__procman_remote_server__';

// ---- Tunnel sub-section ---- //
function TunnelSection({ serverPort }: { serverPort: number | null }) {
  const [tunnel, setTunnel] = useState<
    { running: boolean; url: string | null; pid: number | null } | null
  >({ running: false, url: null, pid: null });
  const [busy, setBusy] = useState(false);

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

  useEffect(() => {
    reload();
    const id = setInterval(reload, 3000);
    return () => clearInterval(id);
  }, [reload]);

  async function start() {
    setBusy(true);
    try {
      const result = await api.startTunnel(
        serverPort ?? 7777,
        REMOTE_SERVER_TUNNEL_ID,
      );
      setTunnel({ running: true, url: result.url, pid: result.pid });
    } catch (e: any) {
      alert(`Tunnel failed: ${e?.message ?? e}`);
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

  const toast = useToast();
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
            disabled={busy || !serverPort}
          >
            {busy ? 'Connecting...' : 'Expose via Cloudflare'}
          </Button>
        )}
      </div>

      {tunnel.running && tunnel.url && (
        <div className="flex items-center gap-2 text-[11px]">
          <span className="min-w-0 flex-1 truncate font-mono text-primary">{tunnel.url}</span>
          <Button variant="ghost" size="sm" className="h-6 px-2"
            onClick={() => copy(tunnel.url!)}
          >
            Copy
          </Button>
        </div>
      )}

      {!tunnel.running && (
        <p className="text-[10px] text-muted-foreground/70">
          Creates a Cloudflare quick tunnel so you can access procman from anywhere.
          Requires cloudflared installed.
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

  useEffect(() => {
    reload();
    const id = setInterval(reload, 3000);
    return () => clearInterval(id);
  }, [reload]);

  async function toggle(enable: boolean, mode: Mode = 'lan') {
    setBusy(true);
    setErr(null);
    try {
      if (enable) await api.startServer(7777, mode);
      else await api.stopServer();
      await reload();
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  async function rotate() {
    if (!window.confirm('Rotate token? You will need to re-enter on your phone.')) return;
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
    toast2.copy(text, `${label === 'url' ? 'URL' : 'Token'} copied`);
    setCopied(label);
    setTimeout(() => setCopied(null), 1500);
  }

  const url = status?.running
    ? `http://${status.mode === 'lan' ? ip : '127.0.0.1'}:${status.port}`
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
          to expose procman on your local network. Cloudflare Tunnel is recommended for
          anything beyond a trusted Wi-Fi.
        </div>
      )}
      {!status?.running && lanOptIn && (
        <div className="mb-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-1.5 text-[10px] text-amber-700 dark:text-amber-300">
          Warning: certificate pinning is not yet implemented. Keep LAN sessions on
          your own Wi-Fi only.
        </div>
      )}

      {!status?.running ? (
        <div className="rounded-lg border border-dashed border-border/60 bg-card/50 p-3 text-[11px] text-muted-foreground">
          Start the server to control procman from your phone.
          <br />
          <span className="text-muted-foreground/70">
            Phone → open the URL → enter token → done.
          </span>
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
            </div>
          </div>

          {url && status.token && (
            <div className="border-t border-border/40 pt-3">
              <PairingQR url={url} token={status.token} />
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
              Or scan QR ↑ on your phone
            </span>
          </div>

          <TunnelSection serverPort={status.port} />

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
