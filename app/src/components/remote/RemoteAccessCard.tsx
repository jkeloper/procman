import { useCallback, useEffect, useState } from 'react';
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
  const [showToken, setShowToken] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
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

  function copy(text: string, label: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(null), 1500);
    });
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
            >
              local only
            </button>
            <button
              className="rounded bg-primary px-2 py-0.5 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              onClick={() => toggle(true, 'lan')}
              disabled={busy}
            >
              start (LAN)
            </button>
          </div>
        )}
      </div>

      {err && <p className="mb-2 text-[11px] text-red-500">{err}</p>}

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
              <button
                onClick={() => copy(url!, 'url')}
                className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                {copied === 'url' ? '✓' : 'copy'}
              </button>
            </div>
            {/* Token */}
            <div className="flex items-center gap-2">
              <span className="w-12 text-muted-foreground">Token</span>
              <span className="min-w-0 flex-1 truncate font-mono">
                {showToken ? status.token : '•'.repeat(20)}
              </span>
              <button
                onClick={() => setShowToken(!showToken)}
                className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                {showToken ? 'hide' : 'show'}
              </button>
              <button
                onClick={() => copy(status.token, 'token')}
                className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                {copied === 'token' ? '✓' : 'copy'}
              </button>
            </div>
            {/* Mode */}
            <div className="flex items-center gap-2">
              <span className="w-12 text-muted-foreground">Mode</span>
              <span className="font-mono">{status.mode}</span>
            </div>
          </div>

          <div className="flex items-center gap-2 border-t border-border/40 pt-2">
            <button
              className="rounded border border-border/60 px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              onClick={rotate}
              disabled={busy}
            >
              rotate token
            </button>
            <span className="text-[10px] text-muted-foreground/50">
              Phone: open {url} → paste token → connect
            </span>
          </div>

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
