import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { api, type Script } from '@/api/tauri';
import { ScriptEditor } from './ScriptEditor';
import { StatusBadge } from './StatusBadge';
import { VSCodeImportDialog } from './VSCodeImportDialog';
import { PortConflictDialog } from './PortConflictDialog';
import { useProcessStatus } from '@/hooks/useProcessStatus';
import { IconTunnel } from '@/components/icons/TabIcons';
import type { PortInfo } from '@/api/tauri';

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
  const { statuses, pids } = useProcessStatus();
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [conflict, setConflict] = useState<{
    script: Script;
    port: number;
    info: PortInfo | null;
  } | null>(null);

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

  function openEditor(script: Script | null) {
    setEditingScript(script);
    setEditorOpen(true);
  }

  async function handleDelete(scriptId: string) {
    if (!window.confirm('Delete this script?')) return;
    try {
      await api.deleteScript(projectId, scriptId);
      reload();
      onScriptsChanged();
    } catch (e: any) {
      alert(`Failed to delete: ${e?.message ?? e}`);
    }
  }

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
    if (script.expected_port == null) {
      return withBusy(script.id, () => api.spawnProcess(projectId, script.id));
    }
    try {
      const ports = await api.listPorts();
      const hit = ports.find((p) => p.port === script.expected_port);
      if (hit) {
        // If this port is owned by this very script's previous instance,
        // spawn_process will kill it anyway — still warn so the user is explicit.
        setConflict({ script, port: script.expected_port, info: hit });
        return;
      }
    } catch {
      // Port probe failed — fall through and try to start anyway
    }
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

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Toolbar */}
      <div className="flex shrink-0 items-center justify-between border-b border-border/60 px-4 py-2">
        <div className="flex items-center gap-3 text-[12px]">
          <h3 className="font-semibold">Scripts</h3>
          <span className="text-muted-foreground">{scripts.length}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            className="rounded-md px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onClick={() => setVscodeOpen(true)}
          >
            Import from VSCode
          </button>
          <Button
            size="sm"
            className="h-7 bg-primary text-[11px] text-primary-foreground hover:bg-primary/90"
            onClick={() => openEditor(null)}
          >
            + New script
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="p-8 text-center text-[12px] text-muted-foreground">Loading…</div>
        ) : err ? (
          <div className="p-8 text-center text-[12px] text-red-500">Error: {err}</div>
        ) : scripts.length === 0 ? (
          <div className="flex h-64 flex-col items-center justify-center gap-2">
            <div className="text-[12px] text-muted-foreground">No scripts yet.</div>
            <button
              className="text-[12px] text-primary hover:underline"
              onClick={() => setVscodeOpen(true)}
            >
              Import from .vscode/launch.json
            </button>
          </div>
        ) : (
          <ul className="divide-y divide-border/40">
            {scripts.map((s) => {
              const status = statuses[s.id];
              const pid = pids[s.id];
              const isRunning = status === 'running';
              const b = busy.has(s.id);
              return (
                <li
                  key={s.id}
                  className="group flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-accent/40"
                >
                  {/* Status dot */}
                  <div className="shrink-0 w-[70px]">
                    <StatusBadge status={status} />
                  </div>

                  {/* Name + command */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[13px] font-medium text-foreground">
                        {s.name}
                      </span>
                      {s.expected_port != null && (
                        <span className="rounded bg-muted/50 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                          :{s.expected_port}
                        </span>
                      )}
                      {s.auto_restart && (
                        <span className="rounded bg-muted/50 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          auto-restart
                        </span>
                      )}
                      {pid != null && (
                        <span className="font-mono text-[10px] text-muted-foreground/70">
                          pid {pid}
                        </span>
                      )}
                    </div>
                    <div className="truncate font-mono text-[11px] text-muted-foreground">
                      $ {s.command}
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex shrink-0 items-center gap-1">
                    {isRunning ? (
                      <>
                        {s.expected_port != null && (
                          <button
                            className="rounded px-2 py-1 text-[11px] text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100 disabled:opacity-50"
                            disabled={b}
                            title={`Tunnel :${s.expected_port} via Cloudflare`}
                            onClick={() =>
                              withBusy(s.id, async () => {
                                try {
                                  const result = await api.startTunnel(s.expected_port!);
                                  if (result.url) {
                                    navigator.clipboard.writeText(result.url);
                                    alert(`Tunnel active!\n${result.url}\n\nURL copied to clipboard.`);
                                  }
                                } catch (e: any) {
                                  alert(`Tunnel failed: ${e?.message ?? e}`);
                                }
                              })
                            }
                          >
                            <IconTunnel />
                          </button>
                        )}
                        <button
                          className="rounded px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                          disabled={b}
                          title="Restart"
                          onClick={() =>
                            withBusy(s.id, () => api.restartProcess(projectId, s.id))
                          }
                        >
                          ↻
                        </button>
                        <button
                          className="rounded border border-border/60 px-2.5 py-1 text-[11px] text-foreground transition-colors hover:bg-accent disabled:opacity-50"
                          disabled={b}
                          onClick={() => withBusy(s.id, () => api.killProcess(s.id))}
                        >
                          Stop
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          className="rounded bg-primary px-3 py-1 text-[11px] font-medium text-primary-foreground transition-all hover:bg-primary/90 disabled:opacity-50"
                          disabled={b}
                          onClick={() => handleStart(s)}
                        >
                          {b ? '…' : 'Start'}
                        </button>
                        {s.expected_port != null && (
                          <button
                            className="rounded px-2 py-1 text-[11px] text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100 disabled:opacity-50"
                            disabled={b}
                            title={`Tunnel :${s.expected_port} via Cloudflare`}
                            onClick={() =>
                              withBusy(s.id, async () => {
                                try {
                                  const result = await api.startTunnel(s.expected_port!);
                                  if (result.url) {
                                    navigator.clipboard.writeText(result.url);
                                    alert(`Tunnel active!\n${result.url}\n\nURL copied to clipboard.`);
                                  }
                                } catch (e: any) {
                                  alert(`Tunnel failed: ${e?.message ?? e}`);
                                }
                              })
                            }
                          >
                            <IconTunnel />
                          </button>
                        )}
                      </>
                    )}
                    <span className="w-1" />
                    <button
                      className="rounded px-2 py-1 text-[11px] text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100"
                      onClick={() => openEditor(s)}
                    >
                      edit
                    </button>
                    <button
                      className="close-circle opacity-0 group-hover:opacity-100"
                      onClick={() => handleDelete(s.id)}
                    >
                      ✕
                    </button>
                  </div>
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
    </div>
  );
}
