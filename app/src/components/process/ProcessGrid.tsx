import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { api, type Script } from '@/api/tauri';
import { ScriptEditor } from './ScriptEditor';
import { StatusBadge } from './StatusBadge';
import { VSCodeImportDialog } from './VSCodeImportDialog';
import { useProcessStatus } from '@/hooks/useProcessStatus';

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

  const onSaved = () => {
    reload();
    onScriptsChanged();
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between border-b px-4 py-2">
        <h3 className="text-sm font-semibold">Scripts</h3>
        <div className="flex gap-1">
          <Button
            size="sm"
            variant="ghost"
            className="text-xs"
            onClick={() => setVscodeOpen(true)}
          >
            VSCode import
          </Button>
          <Button size="sm" variant="outline" onClick={() => openEditor(null)}>
            + Script
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {loading ? (
          <p className="p-4 text-sm text-muted-foreground">Loading…</p>
        ) : err ? (
          <p className="p-4 text-sm text-red-600">Error: {err}</p>
        ) : scripts.length === 0 ? (
          <div className="flex h-64 items-center justify-center text-muted-foreground">
            No scripts. Click "+ Script" to add one.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2.5 p-4 md:grid-cols-2 lg:grid-cols-3">
            {scripts.map((s) => {
              const status = statuses[s.id];
              const pid = pids[s.id];
              const isRunning = status === 'running';
              const b = busy.has(s.id);
              return (
                <Card
                  key={s.id}
                  className="group transition-all duration-200 hover:-translate-y-[1px] hover:shadow-md"
                >
                  <CardHeader className="pb-2 pt-3">
                    <CardTitle className="flex items-center justify-between text-sm">
                      <span className="truncate font-medium">{s.name}</span>
                      <StatusBadge status={status} />
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pb-3 pt-0">
                    <div className="mb-2 truncate font-mono text-[11px] text-muted-foreground">
                      $ {s.command}
                    </div>
                    <div className="mb-2 flex items-center gap-3 text-[11px] text-muted-foreground">
                      {s.expected_port != null && (
                        <span className="font-mono">:{s.expected_port}</span>
                      )}
                      {pid != null && <span className="font-mono">pid {pid}</span>}
                    </div>
                    <div className="flex items-center justify-end gap-1">
                      {isRunning ? (
                        <>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-xs"
                            disabled={b}
                            onClick={() =>
                              withBusy(s.id, () => api.restartProcess(projectId, s.id))
                            }
                            title="Restart"
                          >
                            ↻
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 px-2 text-xs"
                            disabled={b}
                            onClick={() => withBusy(s.id, () => api.killProcess(s.id))}
                          >
                            stop
                          </Button>
                        </>
                      ) : (
                        <Button
                          size="sm"
                          className="h-7 px-3 text-xs"
                          disabled={b}
                          onClick={() => withBusy(s.id, () => api.spawnProcess(projectId, s.id))}
                        >
                          start
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-xs opacity-0 transition-opacity group-hover:opacity-100"
                        onClick={() => openEditor(s)}
                      >
                        edit
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-xs text-red-500/70 opacity-0 transition-opacity hover:text-red-500 group-hover:opacity-100"
                        onClick={() => handleDelete(s.id)}
                      >
                        ✕
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
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
    </div>
  );
}
