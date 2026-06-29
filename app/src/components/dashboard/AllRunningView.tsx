import { useCallback, useMemo } from 'react';
import { api, type Project, type Script } from '@/api/tauri';
import { ScriptRow } from '@/components/process/ScriptRow';
import { useProcessStatus } from '@/hooks/useProcessStatus';
import { useScriptActions } from '@/hooks/useScriptActions';
import { useTunnelLauncher } from '@/hooks/useTunnelLauncher';
import { useConfirm } from '@/components/ConfirmDialog';
import { PortConflictDialog } from '@/components/process/PortConflictDialog';
import { PortPickerDialog } from '@/components/process/PortPickerDialog';

interface Props {
  projects: Project[];
  /** Jump into a project (used by the project-name chip on each row). */
  onSelectProject?: (id: string | null) => void;
}

/** A script plus the project it belongs to, flattened for the global list. */
interface FlatRow {
  project: Project;
  script: Script;
}

/**
 * WS6: global "All running" view. Aggregates every project's running or
 * crashed script into a single Mission-Control list so the 1-person dev
 * can see, at a glance, what's up and what died — without diving into each
 * project. Reuses the project view's ScriptRow (drag handle omitted) and
 * the shared tunnel launcher + useScriptActions, with inline
 * stop/restart/dismiss/logs. Start goes through the exact same
 * port-conflict pre-flight + PortConflictDialog as the project view.
 */
export function AllRunningView({ projects, onSelectProject }: Props) {
  const { statuses, pids, startTimes, restartCounts, metrics, kinds, shutdowns } =
    useProcessStatus();
  const confirm = useConfirm();

  // WS7: per-call projectId — the global view spans projects, so each row
  // resolves its own project. handleStart runs the same conflict pre-flight
  // as the project view (checkPortConflicts → PortConflictDialog).
  const {
    busy,
    conflict,
    setConflict,
    portPicker,
    setPortPicker,
    withBusy,
    handleStart,
    resolveConflictKillAndStart,
    resolveConflictStartAnyway,
    restart,
  } = useScriptActions(null);

  // Tunnel launcher scoped globally (projectId=null) — tunnel APIs key off
  // script_id, not project, so this works for every row.
  const { tunnels, startTunnelFor, handleTunnelClick, killTunnel } =
    useTunnelLauncher({
      withBusy,
      pids,
      openPortPicker: setPortPicker,
      projectId: null,
    });

  // Build the flat list of running/crashed scripts across all projects.
  const rows = useMemo<FlatRow[]>(() => {
    const out: FlatRow[] = [];
    for (const p of projects) {
      for (const s of p.scripts) {
        const st = statuses[s.id];
        if (st === 'running' || st === 'crashed') {
          out.push({ project: p, script: s });
        }
      }
    }
    // crashed first (most urgent), then running; within each, by project name
    // then script name for stable grouping.
    const rank = (id: string) => (statuses[id] === 'crashed' ? 0 : 1);
    out.sort((a, b) => {
      const r = rank(a.script.id) - rank(b.script.id);
      if (r !== 0) return r;
      const pn = a.project.name.localeCompare(b.project.name);
      if (pn !== 0) return pn;
      return a.script.name.localeCompare(b.script.name);
    });
    return out;
  }, [projects, statuses]);

  const runningCount = rows.filter((r) => statuses[r.script.id] === 'running').length;
  const crashedCount = rows.filter((r) => statuses[r.script.id] === 'crashed').length;
  const totalCpu = rows.reduce((n, r) => n + (metrics[r.script.id]?.cpu ?? 0), 0);
  const totalRssMb =
    rows.reduce((n, r) => n + (metrics[r.script.id]?.rss ?? 0), 0) / 1024;

  // --- Actions (mirror ProcessGrid flows; resolve projectId per row) ---

  function findProjectId(scriptId: string): string | null {
    for (const p of projects) {
      if (p.scripts.some((s) => s.id === scriptId)) return p.id;
    }
    return null;
  }

  const handleStartRow = useCallback(
    (s: Script) => {
      const projectId = findProjectId(s.id);
      if (projectId) handleStart(s, projectId);
    },
    // findProjectId closes over `projects`; handleStart is stable per project set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projects, handleStart],
  );

  async function handleStop(s: Script) {
    const ok = await confirm({
      title: `Stop "${s.name}"?`,
      description: 'The process will be terminated. This cannot be undone.',
      confirmLabel: 'Stop',
      destructive: true,
    });
    if (!ok) return;
    await withBusy(s.id, async () => {
      await api.clearLog(s.id);
      await api.killProcess(s.id);
    });
  }

  function handleRestart(s: Script) {
    const projectId = findProjectId(s.id);
    if (projectId) void restart(s.id, projectId);
  }

  async function handleDismiss(s: Script) {
    await withBusy(s.id, () => api.dismissProcess(s.id));
  }

  function handleOpenLogs(s: Script) {
    // Focus this script's log tab in the global drawer. We do NOT navigate
    // into the project — the whole point of the global view is to read logs
    // without leaving it (multi-project log tracking, WS6 §4). The viewer
    // lazily creates the tab if it doesn't exist yet (e.g. after a crash).
    window.dispatchEvent(
      new CustomEvent('procman:focus-log', { detail: { scriptId: s.id } }),
    );
    window.dispatchEvent(new CustomEvent('procman:open-logs'));
  }

  // The row's "Edit" affordance has no inline editor in the global view, so
  // it jumps into the owning project where the editor lives.
  function handleEditJump(s: Script) {
    const projectId = findProjectId(s.id);
    if (projectId) onSelectProject?.(projectId);
  }

  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-white/10 bg-white/5 p-12 text-center backdrop-blur-md">
        <p className="text-[14px] font-medium text-foreground">
          Nothing is running
        </p>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Open a project and start a script — it'll show up here across every
          project.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Summary strip */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatPill label="Running" value={runningCount} accent="primary" />
        <StatPill
          label="Crashed"
          value={crashedCount === 0 ? 'All healthy' : crashedCount}
          accent={crashedCount > 0 ? 'danger' : 'ok'}
        />
        <StatPill
          label="Total CPU"
          value={`${totalCpu.toFixed(1)}%`}
          accent="muted"
          hint="Summed across all running processes; can exceed 100% on multi-core machines."
        />
        <StatPill label="Total RSS" value={`${totalRssMb.toFixed(0)} MB`} accent="muted" />
      </div>

      {/* Unified list — crashed first, then running */}
      <div className="glass-card overflow-hidden rounded-2xl">
        <ul className="divide-y divide-border/40">
          {rows.map(({ project, script: s }) => {
            const isCrashed = statuses[s.id] === 'crashed';
            return (
              <ScriptRow
                key={s.id}
                script={s}
                status={statuses[s.id]}
                kind={kinds[s.id]}
                pid={pids[s.id]}
                startTimeMs={startTimes[s.id]}
                restarts={restartCounts[s.id] ?? 0}
                metric={metrics[s.id]}
                tunnel={tunnels[s.id]}
                busy={busy.has(s.id)}
                shutdownEvent={shutdowns[s.id]}
                projectLabel={project.name}
                onProjectLabelClick={() => onSelectProject?.(project.id)}
                onStart={handleStartRow}
                onStop={handleStop}
                onRestart={handleRestart}
                onEdit={handleEditJump}
                // ✕ is crashed-dismiss only here (Stop already stops running
                // rows). showDelete hides it on running rows so ✕ never means
                // "stop"; onDelete maps to dismiss for the crashed case.
                showDelete={isCrashed}
                onDelete={handleDismiss}
                onLaunchTunnel={handleTunnelClick}
                onKillTunnel={(sc) => killTunnel(sc.id)}
                onOpenLogs={handleOpenLogs}
                onDismiss={handleDismiss}
              />
            );
          })}
        </ul>
      </div>

      <PortConflictDialog
        open={conflict != null}
        onOpenChange={(v) => !v && setConflict(null)}
        port={conflict?.port ?? 0}
        conflict={conflict?.info ?? null}
        scriptName={conflict?.script.name ?? ''}
        onKillAndStart={resolveConflictKillAndStart}
        onStartAnyway={resolveConflictStartAnyway}
      />

      <PortPickerDialog
        open={portPicker != null}
        scriptName={portPicker?.script.name ?? ''}
        ports={portPicker?.ports ?? []}
        fallback={portPicker?.fallback ?? false}
        rootPid={portPicker?.rootPid}
        onCancel={() => setPortPicker(null)}
        onPick={(port) => {
          if (!portPicker) return;
          const script = portPicker.script;
          setPortPicker(null);
          startTunnelFor(script, port);
        }}
      />
    </div>
  );
}

function StatPill({
  label,
  value,
  accent,
  hint,
}: {
  label: string;
  value: number | string;
  accent: 'muted' | 'primary' | 'danger' | 'ok';
  hint?: string;
}) {
  const valueColor =
    accent === 'primary'
      ? 'text-primary'
      : accent === 'danger'
        ? 'text-red-500'
        : accent === 'ok'
          ? 'text-emerald-500'
          : 'text-foreground';
  // "All healthy" is a label, not a metric — render it smaller than the
  // big tabular numbers so the pill stays balanced.
  const isLabel = typeof value === 'string' && !/^[\d.]/.test(value);
  return (
    <div className="glass-card rounded-2xl p-4" title={hint}>
      <div className="flex items-center gap-1 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
        {hint && <span className="text-muted-foreground/50">ⓘ</span>}
      </div>
      <div
        className={`mt-0.5 font-mono font-semibold tabular-nums tracking-tight ${
          isLabel ? 'text-[16px]' : 'text-[24px]'
        } ${valueColor}`}
      >
        {value}
      </div>
    </div>
  );
}
