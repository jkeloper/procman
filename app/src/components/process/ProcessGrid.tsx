import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { api, type Script } from '@/api/tauri';
import { ScriptEditor } from './ScriptEditor';
import { StatusBadge } from './StatusBadge';
import { VSCodeImportDialog } from './VSCodeImportDialog';
import { PortConflictDialog } from './PortConflictDialog';
import { PortPickerDialog } from './PortPickerDialog';
import { useProcessStatus } from '@/hooks/useProcessStatus';
import { UptimeLabel } from '@/hooks/useUptime';
import { useConfirm } from '@/components/ConfirmDialog';
import { useToast } from '@/components/Toast';
import { Cable, Equal } from 'lucide-react';
import type { PortInfo, DeclaredPortStatus } from '@/api/tauri';

interface Props {
  projectId: string;
  projectPath: string;
  onScriptsChanged: () => void;
}

/**
 * Best-effort port extraction from a shell command string. Catches:
 *   --port 3000          --port=3000
 *   -p 3000              -p=3000
 *   --server.port=4242   --server.port 4242
 *   PORT=8080            -Dserver.port=4242
 *   --host 0.0.0.0 --port 8000
 */
function inferPortFromCommand(cmd: string): number | null {
  const patterns: RegExp[] = [
    /(?:^|\s)(?:--port|--server\.port|-p|-Dserver\.port)[=\s]+(\d{2,5})\b/,
    /\bPORT=(\d{2,5})\b/,
    /\b--server\.port=(\d{2,5})\b/,
  ];
  for (const re of patterns) {
    const m = cmd.match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > 0 && n <= 65535) return n;
    }
  }
  return null;
}

export function ProcessGrid({ projectId, projectPath, onScriptsChanged }: Props) {
  const [scripts, setScripts] = useState<Script[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [vscodeOpen, setVscodeOpen] = useState(false);
  const [editingScript, setEditingScript] = useState<Script | null>(null);
  const { statuses, pids, startTimes, restartCounts } = useProcessStatus();
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [tunnels, setTunnels] = useState<Record<string, { url: string; port: number }>>({});
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const confirm = useConfirm();
  const toast = useToast();
  const [conflict, setConflict] = useState<{
    script: Script;
    port: number;
    info: PortInfo | null;
  } | null>(null);
  const [portPicker, setPortPicker] = useState<{
    script: Script;
    ports: PortInfo[];
    fallback?: boolean;
    rootPid?: number;
  } | null>(null);
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
  useEffect(() => {
    const targets = scripts.filter(
      (s) => statuses[s.id] === 'running' && s.ports && s.ports.length > 0,
    );
    if (targets.length === 0) {
      setPortStatuses({});
      return;
    }
    let cancelled = false;
    async function tick() {
      const next: Record<string, DeclaredPortStatus[]> = {};
      await Promise.all(
        targets.map(async (s) => {
          try {
            next[s.id] = await api.portStatusForScript(s.id);
          } catch {}
        }),
      );
      if (!cancelled) setPortStatuses(next);
    }
    tick();
    const iv = setInterval(tick, 3000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [scripts, statuses]);

  // Restore tunnel state from the backend on mount / project change.
  // Without this, the tunnel URL badge under each script disappears
  // when the user navigates away and comes back, even though the
  // cloudflared process is still running.
  useEffect(() => {
    let cancelled = false;
    api
      .tunnelStatus()
      .then((list) => {
        if (cancelled) return;
        const next: Record<string, { url: string; port: number }> = {};
        for (const t of list) {
          next[t.script_id] = { url: t.url, port: t.port };
        }
        setTunnels(next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  function openEditor(script: Script | null) {
    setEditingScript(script);
    setEditorOpen(true);
  }

  async function startTunnelFor(script: Script, port: number) {
    setBusy((prev) => new Set(prev).add(script.id));
    try {
      const result = await api.startTunnel(port, script.id);
      if (result.url) {
        setTunnels((prev) => ({ ...prev, [script.id]: { url: result.url!, port } }));
      } else {
        await confirm({
          title: 'Tunnel started',
          description: `Tunnel running on port :${port} but no URL was returned by cloudflared.`,
          confirmLabel: 'OK',
        });
      }
    } catch (e: any) {
      await confirm({
        title: 'Tunnel failed',
        description: e?.message ?? String(e),
        confirmLabel: 'OK',
        destructive: true,
      });
    } finally {
      setBusy((prev) => { const n = new Set(prev); n.delete(script.id); return n; });
    }
  }

  async function handleTunnelClick(script: Script) {
    // S1: Declared ports are authoritative when present. Single declared
    // port tunnels immediately; multiple declared ports → picker.
    if (script.ports && script.ports.length > 0) {
      if (script.ports.length === 1) {
        await startTunnelFor(script, script.ports[0].number);
        return;
      }
      const declared: PortInfo[] = script.ports.map((p) => ({
        port: p.number,
        pid: pids[script.id] ?? 0,
        process_name: p.name,
        command: p.note ?? '',
      }));
      setPortPicker({ script, ports: declared });
      return;
    }

    // Legacy fallback: expected_port
    if (script.expected_port) {
      await startTunnelFor(script, script.expected_port);
      return;
    }

    // 2. Look up ports owned by this script's process tree.
    const rootPid = pids[script.id];
    let candidates: PortInfo[] = [];
    if (rootPid) {
      try {
        candidates = await api.listPortsForScriptPid(rootPid);
      } catch (e) {
        console.warn('[tunnel] listPortsForScriptPid failed', e);
      }
    }
    console.log('[tunnel]', script.name, 'rootPid', rootPid, 'tree-ports', candidates);

    if (candidates.length === 1) {
      await startTunnelFor(script, candidates[0].port);
      return;
    }
    if (candidates.length > 1) {
      setPortPicker({ script, ports: candidates });
      return;
    }

    // 3. Tree match returned nothing. Open the picker in fallback mode
    //    showing all listening ports — keep an info banner in the dialog
    //    so the user knows the tree match failed.
    let allPorts: PortInfo[] = [];
    try {
      allPorts = await api.listPorts();
    } catch (e) {
      console.warn('[tunnel] listPorts failed', e);
    }
    if (allPorts.length === 0) {
      await confirm({
        title: 'No listening ports',
        description:
          'No listening TCP ports were found on this machine. Wait for ' +
          'the server to bind, or set `expected_port` in Edit.',
        confirmLabel: 'OK',
      });
      return;
    }
    setPortPicker({ script, ports: allPorts, fallback: true, rootPid });
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

  async function withBusy(id: string, fn: () => Promise<unknown>) {
    setBusy((s) => new Set(s).add(id));
    try {
      await fn();
    } catch (e: any) {
      alert(`${e?.message ?? e}`);
    } finally {
      setBusy((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      });
    }
  }

  /**
   * Pre-flight port check before spawning. If script declares an
   * expected_port that's already bound by something other than an
   * already-running procman managed instance (which `spawn_process`
   * handles internally via single-instance guard), show a dialog.
   */
  async function handleStart(script: Script) {
    // S1: When declared ports exist, use the backend conflict checker
    // which handles multi-port scripts and owned_by_script semantics.
    if (script.ports && script.ports.length > 0) {
      try {
        const conflicts = await api.checkPortConflicts(script.id);
        const blocking = conflicts.filter((c) => c.severity === 'blocking');
        if (blocking.length > 0) {
          // Reuse single-port dialog for the first blocking conflict.
          const first = blocking[0];
          setConflict({
            script,
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
        console.warn('[start] checkPortConflicts failed', e);
      }
      return withBusy(script.id, () => api.spawnProcess(projectId, script.id));
    }

    // Legacy path:
    //   1. Explicit expected_port wins
    //   2. Otherwise infer from the command string (--port N, -p N,
    //      --server.port=N, PORT=N, --port=N, etc.)
    const port = script.expected_port ?? inferPortFromCommand(script.command);
    if (port == null) {
      return withBusy(script.id, () => api.spawnProcess(projectId, script.id));
    }
    try {
      const ports = await api.listPorts();
      const hit = ports.find((p) => p.port === port);
      if (hit) {
        setConflict({ script, port, info: hit });
        return;
      }
    } catch {}
    return withBusy(script.id, () => api.spawnProcess(projectId, script.id));
  }

  async function resolveConflictKillAndStart() {
    if (!conflict) return;
    const { script, port } = conflict;
    setConflict(null);
    await withBusy(script.id, async () => {
      await api.killPort(port).catch(() => {});
      // Small delay so the port is released before we re-bind.
      await new Promise((r) => setTimeout(r, 600));
      return api.spawnProcess(projectId, script.id);
    });
  }

  async function resolveConflictStartAnyway() {
    if (!conflict) return;
    const { script } = conflict;
    setConflict(null);
    await withBusy(script.id, () => api.spawnProcess(projectId, script.id));
  }

  const onSaved = () => {
    reload();
    onScriptsChanged();
  };

  // P3: Bulk actions
  const runningScripts = scripts.filter((s) => statuses[s.id] === 'running');
  const stoppedScripts = scripts.filter((s) => statuses[s.id] !== 'running');

  async function startAll() {
    for (const s of stoppedScripts) {
      if (!busy.has(s.id)) {
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
        .filter((s) => !busy.has(s.id))
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
            {scripts.map((s) => {
              const status = statuses[s.id];
              const pid = pids[s.id];
              const isRunning = status === 'running';
              const b = busy.has(s.id);
              const tunnel = tunnels[s.id];
              const restarts = restartCounts[s.id] ?? 0;
              const isDragging = draggingId === s.id;
              return (
                <li
                  key={s.id}
                  data-script-id={s.id}
                  className={`group transition-colors hover:bg-accent/40 ${
                    isDragging ? 'bg-accent/60 opacity-80 shadow-lg' : ''
                  }`}
                  onDoubleClick={async () => {
                    if (draggingId) return;
                    if (b) return;
                    if (isRunning) {
                      const ok = await confirm({ title: `Stop "${s.name}"?`, description: 'Double-click detected. Stop this process?', confirmLabel: 'Stop', destructive: true });
                      if (ok) withBusy(s.id, () => api.killProcess(s.id));
                    } else {
                      handleStart(s);
                    }
                  }}
                >
                <div className="flex items-center gap-2 px-2 py-2.5">
                  {/* Drag handle — two-line hamburger, always cursor-grab */}
                  <button
                    className="flex h-6 w-6 shrink-0 cursor-grab items-center justify-center rounded text-muted-foreground/40 opacity-0 transition-opacity hover:text-foreground active:cursor-grabbing group-hover:opacity-100"
                    onPointerDown={(e) => handleDragStart(e, s.id)}
                    onClick={(e) => e.stopPropagation()}
                    aria-label="Drag to reorder"
                    title="Drag to reorder"
                  >
                    <Equal size={14} />
                  </button>
                  {/* Status dot */}
                  <div className="shrink-0 w-[70px]">
                    <StatusBadge status={status} />
                  </div>

                  {/* Name + command */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[14px] font-medium text-foreground">
                        {s.name}
                      </span>
                      {s.ports && s.ports.length > 0 ? (
                        s.ports.map((p) => {
                          const st = portStatuses[s.id]?.find(
                            (x) => x.spec.number === p.number,
                          );
                          // S2: liveness dot — green=reachable, red=declared but unreachable,
                          // gray=unknown (not yet probed / script not running)
                          const dotClass = !isRunning
                            ? 'bg-muted-foreground/30'
                            : st?.reachable === true
                              ? 'bg-emerald-500'
                              : st?.reachable === false
                                ? 'bg-red-500/70'
                                : 'bg-muted-foreground/30';
                          const title =
                            `${p.name}${p.note ? ` — ${p.note}` : ''}${p.optional ? ' (optional)' : ''}` +
                            (isRunning
                              ? st?.reachable === true
                                ? ' · reachable'
                                : st?.reachable === false
                                  ? ' · not reachable'
                                  : ' · probing…'
                              : '');
                          return (
                            <span
                              key={p.name}
                              className="inline-flex items-center gap-1 rounded bg-muted/50 px-1.5 py-0.5 font-mono text-[12px] text-muted-foreground"
                              title={title}
                            >
                              <span className={`inline-block h-1.5 w-1.5 rounded-full ${dotClass}`} />
                              {p.name}:{p.number}
                            </span>
                          );
                        })
                      ) : s.expected_port != null ? (
                        <span className="rounded bg-muted/50 px-1.5 py-0.5 font-mono text-[12px] text-muted-foreground">
                          :{s.expected_port}
                        </span>
                      ) : null}
                      {s.auto_restart && (
                        <span className="rounded bg-muted/50 px-1.5 py-0.5 text-[12px] text-muted-foreground">
                          auto-restart{restarts > 0 ? ` #${restarts}` : ''}
                        </span>
                      )}
                      {s.env_file && (
                        <span className="rounded bg-muted/50 px-1.5 py-0.5 font-mono text-[12px] text-muted-foreground" title={s.env_file}>
                          .env
                        </span>
                      )}
                      {pid != null && (
                        <span className="font-mono text-[12px] text-muted-foreground/70">
                          pid {pid} · {startTimes[s.id] && statuses[s.id] === "running" ? <UptimeLabel ms={startTimes[s.id]} /> : null}
                        </span>
                      )}
                    </div>
                    <div className="truncate font-mono text-[12px] text-muted-foreground">
                      $ {s.command}
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex shrink-0 items-center gap-1">
                    {isRunning ? (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 opacity-0 group-hover:opacity-100"
                          disabled={b}
                          title={s.expected_port ? `Tunnel :${s.expected_port}` : 'Tunnel via Cloudflare'}
                          onClick={() => handleTunnelClick(s)}
                        >
                          Tunnel
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7"
                          disabled={b}
                          onClick={() =>
                            withBusy(s.id, () => api.restartProcess(projectId, s.id))
                          }
                        >
                          Restart
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          className="h-7"
                          disabled={b}
                          onClick={async () => {
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
                          }}
                        >
                          Stop
                        </Button>
                      </>
                    ) : (
                      <Button size="sm" className="h-7" disabled={b} onClick={() => handleStart(s)}>
                        {b ? '…' : 'Start'}
                      </Button>
                    )}
                    <span className="w-1" />
                    <Button variant="ghost" size="sm" className="h-7 opacity-0 group-hover:opacity-100" onClick={() => openEditor(s)}>
                      Edit
                    </Button>
                    <button
                      className="close-circle opacity-0 group-hover:opacity-100"
                      onClick={() => handleDelete(s.id)}
                    >
                      ✕
                    </button>
                  </div>
                </div>
                {/* Inline tunnel bar */}
                {tunnel && (
                  <div className="flex items-center gap-2 border-t border-border/20 bg-primary/5 px-4 py-1.5 text-[12px] transition-all duration-200">
                    <Cable size={16} />
                    <span className="min-w-0 flex-1 truncate font-mono text-primary">
                      {tunnel.url}
                    </span>
                    <span className="shrink-0 font-mono text-muted-foreground/60">
                      :{tunnel.port}
                    </span>
                    <Button variant="ghost" size="sm" className="h-6 px-2"
                      onClick={() => toast.copy(tunnel.url, 'Tunnel URL copied')}
                    >
                      Copy
                    </Button>
                    <Button variant="destructive" size="sm" className="h-6"
                      onClick={async () => {
                        try {
                          await api.stopTunnel(s.id);
                          setTunnels((prev) => {
                            const n = { ...prev };
                            delete n[s.id];
                            return n;
                          });
                        } catch {}
                      }}
                    >
                      Stop tunnel
                    </Button>
                  </div>
                )}
                </li>
              );
            })}
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
