import { useCallback, useEffect, useState } from 'react';
import {
  api,
  type CfInstalled,
  type NamedTunnel,
  type RunningCloudflared,
  type Project,
} from '@/api/tauri';
import { useConfirm } from '@/components/ConfirmDialog';

interface Props {
  projects: Project[];
  onProjectsChanged: () => void;
}

export function CloudflareTunnelsCard({ projects, onProjectsChanged }: Props) {
  const [installed, setInstalled] = useState<CfInstalled | null>(null);
  const [named, setNamed] = useState<NamedTunnel[]>([]);
  const [running, setRunning] = useState<RunningCloudflared[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const confirm = useConfirm();

  const reload = useCallback(async () => {
    try {
      const inst = await api.cloudflaredInstalled();
      setInstalled(inst);
      if (!inst.installed) {
        setLoading(false);
        return;
      }
      const [n, r] = await Promise.all([
        api.listCfTunnels().catch(() => []),
        api.detectRunningCloudflared().catch(() => []),
      ]);
      setNamed(n);
      setRunning(r);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
    const id = setInterval(reload, 4000);
    return () => clearInterval(id);
  }, [reload]);

  async function registerAndRun(tunnel: NamedTunnel) {
    if (projects.length === 0) {
      alert('Create a project first, then come back here.');
      return;
    }
    const proj = projects[0];
    setBusy(tunnel.id);
    try {
      const script = await api.createScript(
        proj.id,
        `cf: ${tunnel.name}`,
        `cloudflared tunnel run ${tunnel.name}`,
        null,
        false,
      );
      onProjectsChanged();
      await api.spawnProcess(proj.id, script.id);
      await reload();
    } catch (e: any) {
      alert(`Failed: ${e?.message ?? e}`);
    } finally {
      setBusy(null);
    }
  }

  async function kill(pid: number) {
    const ok = await confirm({
      title: `Kill cloudflared (pid ${pid})?`,
      description: 'This will terminate the tunnel process.\nThis action cannot be undone.',
      confirmLabel: 'Kill',
      destructive: true,
    });
    if (!ok) return;
    setBusy(`pid-${pid}`);
    try {
      await api.killCloudflaredPid(pid);
      await reload();
    } catch (e: any) {
      await confirm({ title: 'Kill failed', description: e?.message ?? String(e), confirmLabel: 'OK', destructive: true });
    } finally {
      setBusy(null);
    }
  }

  if (loading) return null;

  if (!installed?.installed) {
    return (
      <section>
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-[13px] font-semibold">Cloudflare Tunnels</h2>
        </div>
        <div className="rounded-lg border border-dashed border-border/60 bg-card/50 p-3 text-[11px] text-muted-foreground">
          <span className="mr-1">☁︎</span>
          cloudflared not installed.{' '}
          <a
            href="https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
            target="_blank"
            rel="noreferrer"
            className="text-primary underline-offset-2 hover:underline"
          >
            Install
          </a>{' '}
          to manage tunnels here.
        </div>
      </section>
    );
  }

  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between">
        <div className="flex items-baseline gap-2">
          <h2 className="text-[13px] font-semibold">Cloudflare Tunnels</h2>
          <span className="font-mono text-[11px] text-muted-foreground">
            {running.length} running · {named.length} configured
          </span>
        </div>
        {installed.version && (
          <span className="font-mono text-[10px] text-muted-foreground/60">
            {installed.version}
          </span>
        )}
      </div>

      <div className="space-y-2">
        {/* Running */}
        {running.length > 0 && (
          <div className="overflow-hidden rounded-lg border border-border/60 bg-card">
            <div className="border-b border-border/40 bg-muted/30 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Running
            </div>
            <ul className="divide-y divide-border/40">
              {running.map((r) => (
                <li key={r.pid} className="flex items-center gap-2 px-3 py-2 text-[12px]">
                  <span className="status-dot bg-emerald-500" style={{ marginRight: 0 }} />
                  <span className="font-mono text-[10px] text-muted-foreground">pid {r.pid}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
                    {r.tunnel_name
                      ? r.tunnel_name
                      : r.url
                      ? `quick: ${r.url}`
                      : r.command}
                  </span>
                  <button
                    className="rounded bg-red-800/80 px-3 py-1 text-[11px] font-medium text-red-100 transition-colors hover:bg-red-700 disabled:opacity-50"
                    disabled={busy === `pid-${r.pid}`}
                    onClick={() => kill(r.pid)}
                  >
                    {busy === `pid-${r.pid}` ? 'killing…' : 'Kill'}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Named tunnels */}
        {named.length > 0 ? (
          <div className="overflow-hidden rounded-lg border border-border/60 bg-card">
            <div className="border-b border-border/40 bg-muted/30 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Configured
            </div>
            <ul className="divide-y divide-border/40">
              {named.map((t) => {
                const isRunning = running.some(
                  (r) => r.tunnel_name === t.name || r.command.includes(t.name),
                );
                return (
                  <li key={t.id} className="flex items-center gap-2 px-3 py-2 text-[12px]">
                    <span
                      className={`status-dot ${isRunning ? 'bg-emerald-500' : 'bg-border'}`}
                      style={{ marginRight: 0 }}
                    />
                    <span className="font-medium">{t.name}</span>
                    <span className="flex-1 truncate font-mono text-[10px] text-muted-foreground">
                      {t.id.slice(0, 8)} · {t.connections} conn
                    </span>
                    <button
                      className="rounded border border-border/60 px-2 py-0.5 text-[11px] text-foreground transition-colors hover:bg-accent disabled:opacity-50"
                      disabled={busy === t.id || isRunning || projects.length === 0}
                      onClick={() => registerAndRun(t)}
                      title={
                        projects.length === 0
                          ? 'Create a project first'
                          : isRunning
                          ? 'Already running'
                          : `Register as script under "${projects[0]?.name}" and start`
                      }
                    >
                      {busy === t.id ? '…' : isRunning ? 'running' : 'run'}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : running.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/60 bg-card/50 p-3 text-center text-[11px] text-muted-foreground">
            No configured tunnels. Run{' '}
            <code className="rounded bg-muted/50 px-1 py-0.5">cloudflared login</code> to get
            started.
          </div>
        ) : null}
      </div>
    </section>
  );
}
