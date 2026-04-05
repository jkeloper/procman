import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  api,
  type CfInstalled,
  type NamedTunnel,
  type RunningCloudflared,
  type Project,
} from '@/api/tauri';

interface Props {
  projects: Project[];
  /** Called after a tunnel is registered as a script, so sidebar updates. */
  onProjectsChanged: () => void;
}

export function CloudflareTunnelsCard({ projects, onProjectsChanged }: Props) {
  const [installed, setInstalled] = useState<CfInstalled | null>(null);
  const [named, setNamed] = useState<NamedTunnel[]>([]);
  const [running, setRunning] = useState<RunningCloudflared[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

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
    // For MVP: attach to the first project. A picker can come later.
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
    setBusy(`pid-${pid}`);
    try {
      await api.killCloudflaredPid(pid);
      await reload();
    } catch (e: any) {
      alert(`Kill failed: ${e?.message ?? e}`);
    } finally {
      setBusy(null);
    }
  }

  if (loading) return null;

  if (!installed?.installed) {
    return (
      <Card className="border-dashed">
        <CardContent className="py-3 text-xs text-muted-foreground">
          ☁︎ cloudflared not installed.{' '}
          <a
            href="https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            Install
          </a>{' '}
          to manage tunnels here.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between text-sm">
          <span>Cloudflare Tunnels</span>
          {installed.version && (
            <span className="text-xs font-normal text-muted-foreground">
              {installed.version}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Running */}
        <div>
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Running ({running.length})
          </div>
          {running.length === 0 ? (
            <p className="text-xs text-muted-foreground">No active cloudflared processes.</p>
          ) : (
            <ul className="divide-y rounded border">
              {running.map((r) => (
                <li key={r.pid} className="flex items-center gap-2 p-2 text-xs">
                  <Badge variant="default">pid {r.pid}</Badge>
                  <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
                    {r.tunnel_name
                      ? `tunnel: ${r.tunnel_name}`
                      : r.url
                      ? `quick: ${r.url}`
                      : r.command}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-xs text-red-600"
                    disabled={busy === `pid-${r.pid}`}
                    onClick={() => kill(r.pid)}
                  >
                    {busy === `pid-${r.pid}` ? 'Killing…' : 'Kill'}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Named tunnels */}
        <div>
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Named tunnels ({named.length})
          </div>
          {named.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              None. Run `cloudflared login` and create a tunnel.
            </p>
          ) : (
            <ul className="divide-y rounded border">
              {named.map((t) => {
                const isRunning = running.some(
                  (r) => r.tunnel_name === t.name || r.command.includes(t.name),
                );
                return (
                  <li key={t.id} className="flex items-center gap-2 p-2 text-xs">
                    <Badge variant={isRunning ? 'default' : 'secondary'}>{t.name}</Badge>
                    <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
                      {t.id.slice(0, 8)} · {t.connections} conn
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 px-2 text-xs"
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
                      {busy === t.id ? '…' : isRunning ? 'running' : 'Run'}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
