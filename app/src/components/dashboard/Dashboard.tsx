import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { api, type PortInfo, type Project } from '@/api/tauri';
import { GroupsPanel } from '@/components/group/GroupsPanel';
import { CloudflareTunnelsCard } from './CloudflareTunnelsCard';
import { DockerComposeCard } from './DockerComposeCard';
import { RemoteAccessCard } from '@/components/remote/RemoteAccessCard';
import { useConfirm } from '@/components/ConfirmDialog';
import { LayoutDashboard, Network, Play, Globe } from 'lucide-react';

interface Props {
  projects: Project[];
  onSelectProject?: (id: string | null) => void;
}

type Tab = 'dashboard' | 'ports' | 'groups' | 'network';

const TABS: { key: Tab; label: string; icon: ReactNode }[] = [
  { key: 'dashboard', label: 'Dashboard', icon: <LayoutDashboard size={16} /> },
  { key: 'ports', label: 'Ports', icon: <Network size={16} /> },
  { key: 'groups', label: 'Groups', icon: <Play size={16} /> },
  { key: 'network', label: 'Network', icon: <Globe size={16} /> },
];

export function Dashboard({ projects, onSelectProject }: Props) {
  const [tab, setTab] = useState<Tab>('dashboard');
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [managedPids, setManagedPids] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [killing, setKilling] = useState<number | null>(null);
  const [aliases, setAliases] = useState<Record<string, string>>({});
  const confirm = useConfirm();

  const [pidScriptMap, setPidScriptMap] = useState<Map<number, string>>(new Map());

  const reload = useCallback(async () => {
    try {
      const [list, procs, als] = await Promise.all([
        api.listPorts(),
        api.listProcesses().catch(() => []),
        api.getPortAliases().catch(() => ({})),
      ]);
      setPorts(list);
      const rootPids = procs.map((p) => p.pid);
      const descendants = rootPids.length > 0
        ? await api.listDescendantPids(rootPids).catch(() => rootPids)
        : [];
      setManagedPids(new Set([...rootPids, ...descendants]));
      // Build pid → scriptId map so port-to-project matching is exact.
      const psMap = new Map<number, string>();
      for (const p of procs) {
        psMap.set(p.pid, p.id);
      }
      setPidScriptMap(psMap);
      setAliases(als ?? {});
    } catch {
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
    const id = setInterval(reload, 2000);
    return () => clearInterval(id);
  }, [reload]);

  async function handleKill(port: number) {
    const ok = await confirm({ title: `Kill process on port :${port}?`, description: 'This will forcefully terminate the process.\nThis action cannot be undone.', confirmLabel: 'Kill', destructive: true });
    if (!ok) return;
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
    try {
      const scriptId = await api.resolvePidToScript(p.pid);
      if (!scriptId) return;
      const proj = projects.find((pr) =>
        pr.scripts.some((s) => s.id === scriptId),
      );
      if (proj && onSelectProject) {
        onSelectProject(proj.id);
        window.dispatchEvent(
          new CustomEvent('procman:focus-log', { detail: { scriptId } }),
        );
      }
    } catch (e: any) {
      console.error('resolve pid', e);
    }
  }

  // Build match map: expected_port OR managed pid
  const expectedPortMap = new Map<number, { project: string; script: string }>();
  for (const p of projects) {
    for (const sc of p.scripts) {
      if (sc.expected_port != null) {
        expectedPortMap.set(sc.expected_port, { project: p.name, script: sc.name });
      }
    }
  }
  // Also match by managed pid — trace pid → wrapper → scriptId → project
  for (const port of ports) {
    if (!expectedPortMap.has(port.port) && managedPids.has(port.pid)) {
      // Walk from the port's pid back to a root wrapper pid that
      // we track, then look up which script and project it belongs to.
      const scriptId = pidScriptMap.get(port.pid);
      if (scriptId) {
        for (const p of projects) {
          const sc = p.scripts.find((s) => s.id === scriptId);
          if (sc) {
            expectedPortMap.set(port.port, { project: p.name, script: sc.name });
            break;
          }
        }
      }
      // If the pid isn't a root wrapper (it's a descendant), we can't
      // precisely map it without a full pid→scriptId reverse index.
      // Leave it as unmatched rather than wrongly assigning it.
    }
  }

  const matched = ports.filter((p) => expectedPortMap.has(p.port) || managedPids.has(p.pid));
  const others = ports.filter((p) => !expectedPortMap.has(p.port) && !managedPids.has(p.pid));
  const totalScripts = projects.reduce((n, p) => n + p.scripts.length, 0);

  return (
    <div className="flex h-full flex-col">
      {/* Tab ribbon — also serves as macOS drag area for Dashboard view */}
      <div
        className="glass-bar flex shrink-0 items-center gap-0 pl-3"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div
          className="flex items-center gap-0"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex items-center gap-1.5 border-b-2 px-4 py-3 text-[14px] font-medium transition-colors ${
                tab === t.key
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              <span className="flex items-center">{t.icon}</span>
              {t.label}
              {t.key === 'ports' && (
                <span className="ml-1 rounded-full bg-muted/60 px-1.5 py-0.5 text-[12px] font-mono">
                  {ports.length}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-auto">
        <div className="mx-auto max-w-5xl px-6 py-4">

          {tab === 'dashboard' && (
            <div className="space-y-5">
              <div>
                <p className="text-[13px] text-muted-foreground">
                  {projects.length} projects · {totalScripts} scripts · {ports.length} listening ports
                  {loading && ' · loading...'}
                </p>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <StatPill label="Projects" value={projects.length} accent="muted" />
                <StatPill label="Scripts" value={totalScripts} accent="muted" />
                <StatPill label="Listening" value={ports.length} accent="primary" />
              </div>

              {/* Quick port summary — matched only */}
              {matched.length > 0 && (
                <section>
                  <SectionHeader title="Active ports" count={matched.length} />
                  <PortTable
                    rows={matched}
                    expectedMap={expectedPortMap}
                    managedPids={managedPids}
                    killing={killing}
                    onKill={handleKill}
                    onClickRow={handlePortClick}
                    variant="matched"
                    aliases={aliases}
                    onSetAlias={async (port, alias) => { await api.setPortAlias(port, alias); reload(); }}
                  />
                </section>
              )}
            </div>
          )}

          {tab === 'ports' && (
            <div className="space-y-5">


              <section>
                <SectionHeader
                  title="Matched ports"
                  sub="bound by your registered scripts"
                  count={matched.length}
                />
                {matched.length === 0 ? (
                  <EmptyHint>None of your scripts' expected ports are currently listening.</EmptyHint>
                ) : (
                  <PortTable
                    rows={matched}
                    expectedMap={expectedPortMap}
                    managedPids={managedPids}
                    killing={killing}
                    onKill={handleKill}
                    onClickRow={handlePortClick}
                    variant="matched"
                    aliases={aliases}
                    onSetAlias={async (port, alias) => { await api.setPortAlias(port, alias); reload(); }}
                  />
                )}
              </section>

              <section>
                <SectionHeader title="Other listening ports" count={others.length} />
                {others.length === 0 ? (
                  <EmptyHint>No other ports.</EmptyHint>
                ) : (
                  <PortTable
                    rows={others}
                    expectedMap={expectedPortMap}
                    managedPids={managedPids}
                    killing={killing}
                    onKill={handleKill}
                    onClickRow={handlePortClick}
                    variant="other"
                    aliases={aliases}
                    onSetAlias={async (port, alias) => { await api.setPortAlias(port, alias); reload(); }}
                  />
                )}
              </section>
            </div>
          )}

          {tab === 'groups' && (
            <div className="space-y-5">

              <GroupsPanel projects={projects} />
            </div>
          )}

          {tab === 'network' && (
            <div className="space-y-5">

              <CloudflareTunnelsCard projects={projects} onProjectsChanged={reload} />
              <DockerComposeCard />
              <RemoteAccessCard />
            </div>
          )}

        </div>
      </div>
    </div>
  );
}

function SectionHeader({
  title,
  sub,
  count,
}: {
  title: string;
  sub?: string;
  count?: number;
}) {
  return (
    <div className="mb-2 flex items-baseline justify-between">
      <div className="flex items-baseline gap-2">
        <h2 className="text-[14px] font-semibold">{title}</h2>
        {count != null && (
          <span className="font-mono text-[12px] text-muted-foreground">{count}</span>
        )}
      </div>
      {sub && <p className="text-[12px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-white/10 bg-white/5 p-4 text-center text-[13px] text-muted-foreground backdrop-blur-md">
      {children}
    </div>
  );
}

function StatPill({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent: 'muted' | 'primary';
}) {
  return (
    <div className="glass-card rounded-2xl p-4">
      <div className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div
        className={`mt-0.5 font-mono text-[24px] font-semibold tabular-nums tracking-tight ${
          accent === 'primary' ? 'text-primary' : 'text-foreground'
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function PortTable({
  rows,
  expectedMap,
  managedPids,
  killing,
  onKill,
  onClickRow,
  variant,
  aliases,
  onSetAlias,
}: {
  rows: PortInfo[];
  expectedMap: Map<number, { project: string; script: string }>;
  managedPids: Set<number>;
  killing: number | null;
  onKill: (port: number) => void;
  onClickRow: (p: PortInfo) => void;
  variant: 'matched' | 'other';
  aliases: Record<string, string>;
  onSetAlias: (port: number, alias: string) => void;
}) {
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  return (
    <div className="glass-card overflow-hidden rounded-2xl">
      <table className="w-full text-[13px]">
        <thead className="bg-white/5">
          <tr className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
            <th className="px-3 py-2 text-left">Port</th>
            <th className="px-3 py-2 text-left">Alias</th>
            <th className="px-3 py-2 text-left">PID</th>
            <th className="px-3 py-2 text-left">Process</th>
            <th className="px-3 py-2 text-left">Matched</th>
            <th className="px-3 py-2 text-right"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const match = expectedMap.get(p.port);
            const managed = managedPids.has(p.pid);
            const alias = aliases[String(p.port)] ?? '';
            const isEditing = editing === p.port;
            return (
              <tr
                key={`${p.pid}-${p.port}`}
                className={`border-t border-border/40 transition-colors ${
                  managed
                    ? 'cursor-pointer hover:bg-accent/50'
                    : 'cursor-default'
                }`}
                title={managed ? 'Click to jump to logs' : 'External process'}
                onClick={() => managed && onClickRow(p)}
              >
                <td className="px-3 py-2">
                  <span
                    className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[12px] font-semibold ${
                      variant === 'matched'
                        ? 'bg-primary/15 text-primary'
                        : 'bg-muted/50 text-muted-foreground'
                    }`}
                  >
                    {managed && <span className="text-[8px]">↗</span>}
                    :{p.port}
                  </span>
                </td>
                <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                  {isEditing ? (
                    <input
                      autoFocus
                      className="h-6 w-28 rounded border border-border/60 bg-muted/30 px-1.5 text-[12px] focus:border-primary/50 focus:outline-none"
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onBlur={() => { onSetAlias(p.port, draft); setEditing(null); }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { onSetAlias(p.port, draft); setEditing(null); }
                        if (e.key === 'Escape') setEditing(null);
                      }}
                    />
                  ) : (
                    <span
                      className="cursor-text rounded px-1 py-0.5 text-[12px] text-foreground/80 hover:bg-muted/50"
                      onClick={() => { setEditing(p.port); setDraft(alias); }}
                      title="Click to set alias"
                    >
                      {alias || <span className="text-muted-foreground/40 italic">—</span>}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 font-mono text-[12px] text-muted-foreground">
                  {p.pid}
                </td>
                <td className="px-3 py-2">
                  <div className="text-[12px] font-medium">{p.process_name}</div>
                  {p.command && p.command !== p.process_name && (
                    <div className="mt-0.5 max-w-[400px] truncate font-mono text-[12px] text-muted-foreground/70" title={p.command}>
                      {p.command}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2">
                  {match ? (
                    <span>
                      <span className="font-medium">{match.project}</span>
                      <span className="text-muted-foreground">/{match.script}</span>
                    </span>
                  ) : (
                    <span className="text-muted-foreground/60">—</span>
                  )}
                </td>
                <td
                  className="px-3 py-2 text-right"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Button
                    variant="destructive"
                    size="sm"
                    className="h-7"
                    disabled={killing === p.port}
                    onClick={() => onKill(p.port)}
                  >
                    {killing === p.port ? 'Killing...' : 'Kill'}
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
