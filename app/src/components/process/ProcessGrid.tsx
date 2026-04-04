import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { api, type Script } from '@/api/tauri';
import { ScriptEditor } from './ScriptEditor';

interface Props {
  projectId: string | null;
}

export function ProcessGrid({ projectId }: Props) {
  const [scripts, setScripts] = useState<Script[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingScript, setEditingScript] = useState<Script | null>(null);

  const reload = useCallback(async () => {
    if (!projectId) return;
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
    if (projectId) reload();
    else setScripts([]);
  }, [projectId, reload]);

  function openEditor(script: Script | null) {
    setEditingScript(script);
    setEditorOpen(true);
  }

  async function handleDelete(scriptId: string) {
    if (!projectId) return;
    if (!window.confirm('Delete this script?')) return;
    try {
      await api.deleteScript(projectId, scriptId);
      reload();
    } catch (e: any) {
      alert(`Failed to delete: ${e?.message ?? e}`);
    }
  }

  if (!projectId) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        Select a project to see its scripts.
      </div>
    );
  }

  return (
    <div className="h-full">
      <div className="flex items-center justify-between border-b px-4 py-2">
        <h3 className="text-sm font-semibold">Scripts</h3>
        <Button size="sm" variant="outline" onClick={() => openEditor(null)}>
          + Script
        </Button>
      </div>

      {loading ? (
        <p className="p-4 text-sm text-muted-foreground">Loading…</p>
      ) : err ? (
        <p className="p-4 text-sm text-red-600">Error: {err}</p>
      ) : scripts.length === 0 ? (
        <div className="flex h-64 items-center justify-center text-muted-foreground">
          No scripts registered. Click "+ Script" to add one.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 p-4 md:grid-cols-2 lg:grid-cols-3">
          {scripts.map((s) => (
            <Card key={s.id}>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center justify-between text-sm">
                  <span className="truncate">{s.name}</span>
                  <Badge variant="secondary">stopped</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="mb-2 truncate font-mono text-xs text-muted-foreground">
                  {s.command}
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">
                    {s.expected_port != null ? `:${s.expected_port}` : 'no port'}
                    {s.auto_restart && ' · auto-restart'}
                  </span>
                  <div className="space-x-1">
                    <Button size="sm" variant="outline" disabled title="Sprint 2">
                      Start
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => openEditor(s)}>
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-red-600"
                      onClick={() => handleDelete(s.id)}
                    >
                      ✕
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <ScriptEditor
        open={editorOpen}
        onOpenChange={setEditorOpen}
        projectId={projectId}
        existing={editingScript}
        onSaved={reload}
      />
    </div>
  );
}
