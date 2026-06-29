import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { api, type Script } from '@/api/tauri';
import { ScriptEditor } from './ScriptEditor';
import { ScriptRow } from './ScriptRow';
import { VSCodeImportDialog } from './VSCodeImportDialog';
import { PortConflictDialog } from './PortConflictDialog';
import { PortPickerDialog } from './PortPickerDialog';
import { useProcessStatus } from '@/hooks/useProcessStatus';
import { useScriptActions } from '@/hooks/useScriptActions';
import { useTunnelLauncher } from '@/hooks/useTunnelLauncher';
import { useConfirm } from '@/components/ConfirmDialog';
import { useVisibleInterval } from '@/hooks/useVisibleInterval';
import { isShutdownActive } from '@/lib/shutdown';
import type { DeclaredPortStatus } from '@/api/tauri';

interface Props {
  projectId: string;
  projectPath: string;
  onScriptsChanged: () => void;
}

export function ProcessGrid({ projectId, projectPath, onScriptsChanged }: Props) {
  const [scripts, setScripts] = useState<Script[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [vscodeOpen, setVscodeOpen] = useState(false);
  const [editingScript, setEditingScript] = useState<Script | null>(null);
  const { statuses, pids, startTimes, restartCounts, metrics, kinds, shutdowns, refreshRuntime } = useProcessStatus();
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const confirm = useConfirm();

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
  } = useScriptActions(projectId);

  const { tunnels, startTunnelFor, handleTunnelClick, killTunnel } = useTunnelLauncher({
    withBusy,
    pids,
    openPortPicker: setPortPicker,
    projectId,
  });

  // S2: scriptId -> declared port statuses (includes TCP liveness probe).
  // Polled every 3s for running scripts with declared ports.
  const [portStatuses, setPortStatuses] = useState<Record<string, DeclaredPortStatus[]>>({});

  const reload = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const list = await api.listScripts(projectId);
      setScripts(list);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    reload();
  }, [reload]);

  // S2: Poll declared-port statuses (includes TCP liveness probe) for
  // running scripts with declared ports. Every 3 seconds. Cleared when
  // the set of running scripts changes or the component unmounts.
  const reloadPortStatuses = useCallback(async () => {
    const targets = scripts.filter(
      (s) => statuses[s.id] === 'running' && s.ports && s.ports.length > 0,
    );
    if (targets.length === 0) {
      setPortStatuses({});
      return;
    }
    // WS3: one batch call instead of N per-script calls — the backend builds
    // the ps/lsof ownership snapshot a single time for the whole poll.
    try {
      const rows = await api.portStatusAll(targets.map((s) => s.id));
      const next: Record<string, DeclaredPortStatus[]> = {};
      for (const [id, st] of rows) next[id] = st;
      // Only commit on success; a transient poll failure must not blank the
      // panel (it would flicker every failed tick).
      setPortStatuses(next);
    } catch {
      // Preserve the last good statuses until the next successful poll.
    }
  }, [scripts, statuses]);
  useVisibleInterval(reloadPortStatuses, 3000);

  function openEditor(script: Script | null) {
    setEditingScript(script);
    setEditorOpen(true);
  }

  async function handleDelete(scriptId: string) {
    const ok = await confirm({ title: 'Delete script?', description: 'This script will be removed.', confirmLabel: 'Delete', destructive: true });
    if (!ok) return;
    let err: any = null;
    try {
      await api.deleteScript(projectId, scriptId);
    } catch (e: any) {
      err = e;
    }
    // Always reload — even on error the user wants the row gone.
    reload();
    onScriptsChanged();
    if (err) {
      console.warn('Delete returned error (ignored):', err);
    }
  }

  // Pointer-based drag & drop for script reordering. HTML5 drag is
  // unreliable in WKWebView so we track pointermove manually and swap
  // rows as the pointer crosses their midpoints.
  function handleDragStart(e: React.PointerEvent, id: string) {
    e.preventDefault();
    e.stopPropagation();
    setDraggingId(id);
    // Capture subsequent pointer events on document so we don't lose
    // the drag when the pointer leaves the row.
    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';
  }

  useEffect(() => {
    if (!draggingId) return;

    function onMove(e: PointerEvent) {
      const list = listRef.current;
      if (!list) return;
      const rows = Array.from(
        list.querySelectorAll<HTMLLIElement>('li[data-script-id]'),
      );
      for (const row of rows) {
        const id = row.dataset.scriptId;
        if (!id || id === draggingId) continue;
        const rect = row.getBoundingClientRect();
        if (e.clientY >= rect.top && e.clientY <= rect.bottom) {
          setScripts((prev) => {
            const dragIdx = prev.findIndex((s) => s.id === draggingId);
            const overIdx = prev.findIndex((s) => s.id === id);
            if (dragIdx < 0 || overIdx < 0 || dragIdx === overIdx) return prev;
            const next = [...prev];
            const [moved] = next.splice(dragIdx, 1);
            next.splice(overIdx, 0, moved);
            return next;
          });
          break;
        }
      }
    }

    async function onUp() {
      const finalIds = scripts.map((s) => s.id);
      setDraggingId(null);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      try {
        await api.reorderScripts(projectId, finalIds);
        onScriptsChanged();
      } catch {
        reload();
      }
    }

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [draggingId, scripts, projectId, reload, onScriptsChanged]);

  const onSaved = () => {
    reload();
    onScriptsChanged();
  };

  // WS6: dismiss a crashed script's retained post-mortem entry/log buffer.
  // Distinct from delete (which removes the script config itself).
  async function handleDismiss(s: Script) {
    await withBusy(s.id, async () => {
      await api.dismissProcess(s.id);
      await refreshRuntime();
    });
  }

  // Stop from the row's Stop button: confirm, then clear log + kill.
  async function handleStopClick(s: Script) {
    const ok = await confirm({
      title: `Stop "${s.name}"?`,
      description: 'The process will be terminated. This cannot be undone.',
      confirmLabel: 'Stop',
      destructive: true,
    });
    if (ok) withBusy(s.id, async () => {
      await api.clearLog(s.id);
      await api.killProcess(s.id);
    });
  }

  // Double-click toggles start/stop, guarded against drags + busy rows.
  async function handleRowDoubleClick(s: Script) {
    if (draggingId) return;
    const stopping = isShutdownActive(shutdowns[s.id]);
    const actionBusy = busy.has(s.id) || stopping;
    if (actionBusy) return;
    if (statuses[s.id] === 'running') {
      const ok = await confirm({ title: `Stop "${s.name}"?`, description: 'Double-click detected. Stop this process?', confirmLabel: 'Stop', destructive: true });
      if (ok) withBusy(s.id, () => api.killProcess(s.id));
    } else {
      handleStart(s);
    }
  }

  // P3: Bulk actions
  const runningScripts = scripts.filter((s) => statuses[s.id] === 'running');
  const stoppedScripts = scripts.filter((s) => statuses[s.id] !== 'running');

  async function startAll() {
    for (const s of stoppedScripts) {
      if (!busy.has(s.id)) {
        if (s.ports && s.ports.length > 0) {
          try {
            const conflicts = await api.checkPortConflicts(s.id);
            const first = conflicts.find((c) => c.severity === 'blocking');
            if (first) {
              setConflict({
                script: s,
                projectId,
                port: first.spec.number,
                info: {
                  port: first.spec.number,
                  pid: first.holder_pid,
                  process_name: first.holder_command,
                  command: first.holder_command,
                },
              });
              return;
            }
          } catch (e) {
            if (import.meta.env.DEV) console.warn('[start-all] checkPortConflicts failed', e);
          }
        }
        await withBusy(s.id, () => api.spawnProcess(projectId, s.id));
      }
    }
  }

  async function stopAll() {
    const ok = await confirm({
      title: 'Stop all processes?',
      description: `${runningScripts.length} running process${runningScripts.length !== 1 ? 'es' : ''} will be terminated.`,
      confirmLabel: 'Stop all',
      destructive: true,
    });
    if (!ok) return;
    await Promise.all(
      runningScripts
        .filter((s) => !busy.has(s.id) && !isShutdownActive(shutdowns[s.id]))
        .map((s) => withBusy(s.id, () => api.killProcess(s.id))),
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="glass-bar flex shrink-0 items-center justify-between px-4 py-2">
        <div className="flex items-center gap-3 text-[13px]">
          <h3 className="font-semibold">Scripts</h3>
          <span className="text-muted-foreground">{scripts.length}</span>
        </div>
        <div className="flex items-center gap-1">
          {/* P3: Bulk actions */}
          {scripts.length > 1 && stoppedScripts.length > 0 && (
            <Button variant="ghost" size="sm" onClick={startAll}>
              Start all
            </Button>
          )}
          {scripts.length > 1 && runningScripts.length > 0 && (
            <Button variant="ghost" size="sm" className="text-destructive" onClick={stopAll}>
              Stop all
            </Button>
          )}
          <span className="w-px h-4 bg-border/60 mx-1" />
          <Button variant="ghost" size="sm" onClick={() => setVscodeOpen(true)}>
            Import from VSCode
          </Button>
          <Button
            size="sm"
            className="h-7"
            onClick={() => openEditor(null)}
          >
            + New script
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="p-8 text-center text-[13px] text-muted-foreground">Loading…</div>
        ) : err ? (
          <div className="p-8 text-center text-[13px] text-red-500">Error: {err}</div>
        ) : scripts.length === 0 ? (
          <div className="flex h-64 flex-col items-center justify-center gap-2">
            <div className="text-[13px] text-muted-foreground">No scripts yet.</div>
            <Button variant="ghost" size="sm" onClick={() => setVscodeOpen(true)}>
              Import from .vscode/launch.json
            </Button>
          </div>
        ) : (
          <ul ref={listRef} className="divide-y divide-border/40">
            {scripts.map((s) => (
              <ScriptRow
                key={s.id}
                script={s}
                status={statuses[s.id]}
                kind={kinds[s.id]}
                pid={pids[s.id]}
                startTimeMs={startTimes[s.id]}
                restarts={restartCounts[s.id] ?? 0}
                metric={metrics[s.id]}
                portStatuses={portStatuses[s.id]}
                tunnel={tunnels[s.id]}
                busy={busy.has(s.id)}
                shutdownEvent={shutdowns[s.id]}
                onStart={handleStart}
                onStop={handleStopClick}
                onRestart={(sc) => restart(sc.id)}
                onEdit={openEditor}
                onDelete={(sc) => handleDelete(sc.id)}
                onLaunchTunnel={handleTunnelClick}
                onKillTunnel={(sc) => killTunnel(sc.id)}
                onDismiss={handleDismiss}
                onRowDoubleClick={handleRowDoubleClick}
                dragHandleProps={{
                  onPointerDown: (e) => handleDragStart(e, s.id),
                  isDragging: draggingId === s.id,
                }}
              />
            ))}
          </ul>
        )}
      </div>

      <ScriptEditor
        open={editorOpen}
        onOpenChange={setEditorOpen}
        projectId={projectId}
        existing={editingScript}
        onSaved={onSaved}
      />
      <VSCodeImportDialog
        open={vscodeOpen}
        onOpenChange={setVscodeOpen}
        projectId={projectId}
        projectPath={projectPath}
        onImported={onSaved}
      />
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
