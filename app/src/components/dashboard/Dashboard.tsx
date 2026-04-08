import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, type PortInfo, type Project } from '@/api/tauri';
import { GroupsPanel } from '@/components/group/GroupsPanel';
import { CloudflareTunnelsCard } from './CloudflareTunnelsCard';
import { RemoteAccessCard } from '@/components/remote/RemoteAccessCard';
import { IconOverview, IconPorts, IconGroups, IconNetwork } from '@/components/icons/TabIcons';

interface Props {
  projects: Project[];
  onSelectProject?: (id: string | null) => void;
}

type Tab = 'dashboard' | 'ports' | 'groups' | 'network';

const TABS: { key: Tab; label: string; icon: ReactNode }[] = [
  { key: 'dashboard', label: 'Dashboard', icon: <IconOverview /> },
  { key: 'ports', label: 'Ports', icon: <IconPorts /> },
  { key: 'groups', label: 'Groups', icon: <IconGroups /> },
  { key: 'network', label: 'Network', icon: <IconNetwork /> },
];

export function Dashboard({ projects, onSelectProject }: Props) {
  const [tab, setTab] = useState<Tab>('dashboard');
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [managedPids, setManagedPids] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [killing, setKilling] = useState<number | null>(null);

  const reload = useCallback(async () => {
    try {
      const [list, procs] = await Promise.all([
        api.listPorts(),
        api.listProcesses().catch(() => []),
      ]);
      setPorts(list);
      setManagedPids(new Set(procs.map((p) => p.pid)));
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
    if (!window.confirm(`Kill process on port :${port}?\n\nThis will forcefully terminate the process. This action cannot be undone.`)) return;
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

  const expectedPortMap = new Map<number, { project: string; script: string }>();
  for (const p of projects) {
    for (const s of p.scripts) {
      if (s.expected_port != null) {
        expectedPortMap.set(s.expected_port, { project: p.name, script: s.name });
      }
    }
  }

  const matched = ports.filter((p) => expectedPortMap.has(p.port));
  const others = ports.filter((p) => !expectedPortMap.has(p.port));
  const totalScripts = projects.reduce((n, p) => n + p.scripts.length, 0);

  return (
    <div className="flex h-full flex-col">
      {/* Tab ribbon — also serves as macOS drag area for Dashboard view */}
      <div
        className="flex shrink-0 items-center gap-0 border-b border-border/60 bg-card/30 pl-3"
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
              className={`flex items-center gap-1.5 border-b-2 px-4 py-3 text-[13px] font-medium transition-colors ${
                tab === t.key
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              <span className="flex items-center">{t.icon}</span>
              {t.label}
              {t.key === 'ports' && (
                <span className="ml-1 rounded-full bg-muted/60 px-1.5 py-0.5 text-[10px] font-mono">
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
                <p className="text-[12px] text-muted-foreground">
                  {projects.length} projects · {totalScripts} scripts · {ports.length} listening ports
                  {loading && ' · loading…'}
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
        <h2 className="text-[13px] font-semibold">{title}</h2>
        {count != null && (
          <span className="font-mono text-[11px] text-muted-foreground">{count}</span>
        )}
      </div>
      {sub && <p className="text-[11px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-border/60 bg-card/50 p-4 text-center text-[12px] text-muted-foreground">
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
    <div className="rounded-lg border border-border/60 bg-card p-3 transition-all hover:-translate-y-[1px] hover:shadow-md">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
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
}: {
  rows: PortInfo[];
  expectedMap: Map<number, { project: string; script: string }>;
  managedPids: Set<number>;
  killing: number | null;
  onKill: (port: number) => void;
  onClickRow: (p: PortInfo) => void;
  variant: 'matched' | 'other';
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border/60 bg-card">
      <table className="w-full text-[12px]">
        <thead className="bg-muted/30">
          <tr className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <th className="px-3 py-2 text-left">Port</th>
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
                    className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold ${
                      variant === 'matched'
                        ? 'bg-primary/15 text-primary'
                        : 'bg-muted/50 text-muted-foreground'
                    }`}
                  >
                    {managed && <span className="text-[8px]">↗</span>}
                    :{p.port}
                  </span>
                </td>
                <td className="px-3 py-2 font-mono text-[11px] text-muted-foreground">
                  {p.pid}
                </td>
                <td className="px-3 py-2">
                  <div className="text-[11px] font-medium">{p.process_name}</div>
                  {p.command && p.command !== p.process_name && (
                    <div className="mt-0.5 max-w-[400px] truncate font-mono text-[10px] text-muted-foreground/70" title={p.command}>
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
                  <button
                    className="rounded bg-red-600 px-3 py-1 text-[11px] font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
                    disabled={killing === p.port}
                    onClick={() => onKill(p.port)}
                  >
                    {killing === p.port ? 'killing…' : 'Kill'}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
