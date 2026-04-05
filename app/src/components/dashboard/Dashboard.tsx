import { useCallback, useEffect, useState } from 'react';
import { api, type PortInfo, type Project } from '@/api/tauri';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { GroupsPanel } from '@/components/group/GroupsPanel';
import { CloudflareTunnelsCard } from './CloudflareTunnelsCard';

interface Props {
  projects: Project[];
  onSelectProject?: (id: string | null) => void;
}

export function Dashboard({ projects, onSelectProject }: Props) {
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [killing, setKilling] = useState<number | null>(null);

  const reload = useCallback(async () => {
    try {
      const list = await api.listPorts();
      setPorts(list);
      setErr(null);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // Poll every 2s
  useEffect(() => {
    reload();
    const id = setInterval(reload, 2000);
    return () => clearInterval(id);
  }, [reload]);

  async function handleKill(port: number) {
    if (!window.confirm(`Kill process on port :${port}?`)) return;
    setKilling(port);
    try {
      await api.killPort(port);
      await reload();
    } catch (e: any) {
      alert(`Kill failed: ${e?.message ?? e}`);
    } finally {
      setKilling(null);
    }
  }

  async function handlePortClick(p: PortInfo) {
    // Resolve pid → procman-managed script_id (if any)
    try {
      const scriptId = await api.resolvePidToScript(p.pid);
      if (scriptId) {
        // Jump to owning project + scroll user intent toward logs.
        const proj = projects.find((pr) =>
          pr.scripts.some((s) => s.id === scriptId),
        );
        if (proj && onSelectProject) {
          onSelectProject(proj.id);
          // Dispatch a custom event so LogViewer can switch to that tab.
          window.dispatchEvent(new CustomEvent('procman:focus-log', { detail: { scriptId } }));
          return;
        }
      }
      // External process — show a small info alert
      alert(
        `External process\nPID ${p.pid} (${p.process_name})\nPort :${p.port}\n\nprocman has no log stream for this process (not managed by procman).`,
      );
    } catch (e: any) {
      console.error('resolve pid', e);
    }
  }

  // Map port → which project/script expects it
  const expectedPortMap = new Map<number, { project: string; script: string }>();
  for (const p of projects) {
    for (const s of p.scripts) {
      if (s.expected_port != null) {
        expectedPortMap.set(s.expected_port, { project: p.name, script: s.name });
      }
    }
  }

  // Categorize
  const matched = ports.filter((p) => expectedPortMap.has(p.port));
  const others = ports.filter((p) => !expectedPortMap.has(p.port));

  const totalScripts = projects.reduce((n, p) => n + p.scripts.length, 0);

  return (
    <ScrollArea className="h-full">
      <div className="space-y-4 p-4">
        <div className="grid grid-cols-3 gap-3">
          <StatCard label="Projects" value={projects.length} />
          <StatCard label="Scripts" value={totalScripts} />
          <StatCard
            label="Listening ports"
            value={ports.length}
            sub={err ? 'error' : loading ? 'loading…' : undefined}
          />
        </div>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center justify-between text-sm">
              <span>Matched ports ({matched.length})</span>
              <span className="text-xs font-normal text-muted-foreground">
                ports from your registered scripts
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {matched.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                None of your scripts' expected ports are currently listening.
              </p>
            ) : (
              <PortTable
                rows={matched}
                expectedMap={expectedPortMap}
                killing={killing}
                onKill={handleKill}
                onClickRow={handlePortClick}
              />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">
              Other listening ports ({others.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {others.length === 0 ? (
              <p className="text-sm text-muted-foreground">No other ports.</p>
            ) : (
              <PortTable
                rows={others}
                expectedMap={expectedPortMap}
                killing={killing}
                onKill={handleKill}
                onClickRow={handlePortClick}
              />
            )}
          </CardContent>
        </Card>

        <GroupsPanel projects={projects} />

        <CloudflareTunnelsCard projects={projects} onProjectsChanged={() => reload()} />

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>Auto-refresh every 2s</span>
          <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={reload}>
            Refresh now
          </Button>
        </div>
      </div>
    </ScrollArea>
  );
}

function StatCard({ label, value, sub }: { label: string; value: number; sub?: string }) {
  return (
    <Card className="transition-all hover:-translate-y-[1px] hover:shadow-md">
      <CardContent className="py-3">
        <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </div>
        <div className="mt-0.5 font-mono text-2xl font-semibold tracking-tight">{value}</div>
        {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
      </CardContent>
    </Card>
  );
}

function PortTable({
  rows,
  expectedMap,
  killing,
  onKill,
  onClickRow,
}: {
  rows: PortInfo[];
  expectedMap: Map<number, { project: string; script: string }>;
  killing: number | null;
  onKill: (port: number) => void;
  onClickRow: (p: PortInfo) => void;
}) {
  return (
    <div className="-mx-2 overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-muted-foreground">
            <th className="px-2 py-1 text-left font-medium">Port</th>
            <th className="px-2 py-1 text-left font-medium">PID</th>
            <th className="px-2 py-1 text-left font-medium">Process</th>
            <th className="px-2 py-1 text-left font-medium">Matched</th>
            <th className="px-2 py-1 text-right font-medium"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const match = expectedMap.get(p.port);
            return (
              <tr
                key={`${p.pid}-${p.port}`}
                className="cursor-pointer border-t transition-colors hover:bg-accent/50"
                onClick={() => onClickRow(p)}
              >
                <td className="px-2 py-1.5 font-mono">
                  <Badge variant={match ? 'default' : 'secondary'}>:{p.port}</Badge>
                </td>
                <td className="px-2 py-1.5 font-mono text-xs text-muted-foreground">{p.pid}</td>
                <td className="px-2 py-1.5 font-mono text-xs">{p.process_name}</td>
                <td className="px-2 py-1.5 text-xs">
                  {match ? (
                    <span>
                      <span className="font-medium">{match.project}</span>
                      <span className="text-muted-foreground"> / {match.script}</span>
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-2 py-1.5 text-right" onClick={(e) => e.stopPropagation()}>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-xs text-red-600 hover:text-red-700"
                    disabled={killing === p.port}
                    onClick={() => onKill(p.port)}
                  >
                    {killing === p.port ? 'Killing…' : 'Kill'}
                  </Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
