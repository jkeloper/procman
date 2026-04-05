import { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api } from '@/api/tauri';

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
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [audit, setAudit] = useState<
    Array<{ ts_ms: number; action: string; target: string; ok: boolean; detail: string | null }>
  >([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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

  // Regenerate QR whenever status/ip changes
  useEffect(() => {
    if (!status?.running) {
      setQrDataUrl(null);
      return;
    }
    const host = status.mode === 'lan' ? ip : '127.0.0.1';
    const payload = JSON.stringify({
      host,
      port: status.port,
      token: status.token,
      v: 1,
    });
    QRCode.toDataURL(payload, { width: 220, margin: 1, color: { dark: '#1F6B3F', light: '#FFFFFF' } })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(null));
  }, [status, ip]);

  async function toggle(enable: boolean, mode: Mode = 'lan') {
    setBusy(true);
    setErr(null);
    try {
      if (enable) {
        await api.startServer(7777, mode);
      } else {
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
    if (!window.confirm('Rotate token? All paired devices will need to re-scan.')) return;
    setBusy(true);
    try {
      await api.rotateToken();
      await reload();
    } finally {
      setBusy(false);
    }
  }

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
          <button
            className="rounded px-1.5 py-0.5 text-[11px] text-red-500/80 transition-colors hover:bg-red-500/10 hover:text-red-500 disabled:opacity-50"
            onClick={() => toggle(false)}
            disabled={busy}
          >
            stop
          </button>
        ) : (
          <div className="flex gap-1">
            <button
              className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
              onClick={() => toggle(true, 'loopback')}
              disabled={busy}
              title="Bind to 127.0.0.1 only (same machine only)"
            >
              start (local only)
            </button>
            <button
              className="rounded bg-primary px-2 py-0.5 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              onClick={() => toggle(true, 'lan')}
              disabled={busy}
              title="Bind to LAN (phones on same Wi-Fi can connect)"
            >
              start (LAN)
            </button>
          </div>
        )}
      </div>

      {err && <p className="mb-2 text-[11px] text-red-500">{err}</p>}

      {!status?.running ? (
        <div className="rounded-lg border border-dashed border-border/60 bg-card/50 p-3 text-[11px] text-muted-foreground">
          Start the server to pair a mobile device.
          <br />
          <span className="text-muted-foreground/70">
            ⚠ Only expose LAN on trusted networks — this API can start/stop your processes.
          </span>
        </div>
      ) : (
        <div className="space-y-3 rounded-lg border border-border/60 bg-card p-3">
          <div className="flex items-start gap-4">
            {qrDataUrl && (
              <img
                src={qrDataUrl}
                alt="Pairing QR"
                className="h-32 w-32 shrink-0 rounded border border-border/40"
              />
            )}
            <div className="min-w-0 flex-1 space-y-1.5 text-[11px]">
              <div className="flex gap-2">
                <span className="w-10 text-muted-foreground">URL</span>
                <span className="font-mono">
                  http://{status.mode === 'lan' ? ip : '127.0.0.1'}:{status.port}
                </span>
              </div>
              <div className="flex gap-2">
                <span className="w-10 text-muted-foreground">mode</span>
                <span className="font-mono">{status.mode}</span>
              </div>
              <div className="flex gap-2">
                <span className="w-10 text-muted-foreground">token</span>
                <div className="flex min-w-0 flex-1 items-center gap-1">
                  <span className="truncate font-mono">
                    {showToken ? status.token : '•'.repeat(20)}
                  </span>
                  <button
                    onClick={() => setShowToken(!showToken)}
                    className="shrink-0 px-1 text-muted-foreground hover:text-foreground"
                  >
                    {showToken ? 'hide' : 'show'}
                  </button>
                </div>
              </div>
              <div className="pt-1">
                <button
                  className="rounded border border-border/60 px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  onClick={rotate}
                  disabled={busy}
                >
                  rotate token
                </button>
              </div>
            </div>
          </div>

          {audit.length > 0 && (
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Recent activity
              </div>
              <ul className="max-h-36 space-y-0.5 overflow-y-auto font-mono text-[10px]">
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
                    {a.detail && (
                      <span className="shrink-0 text-muted-foreground/70">{a.detail}</span>
                    )}
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
