import { useCallback, useEffect, useState } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { api, type Project } from '@/api/tauri';
import { NewProjectDialog } from './NewProjectDialog';

interface Props {
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

export function ProjectList({ selectedId, onSelect }: Props) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const list = await api.listProjects();
      setProjects(list);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  async function handleDelete(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    if (!window.confirm('Delete this project?')) return;
    try {
      await api.deleteProject(id);
      if (selectedId === id) onSelect(null);
      reload();
    } catch (e: any) {
      alert(`Failed to delete: ${e?.message ?? e}`);
    }
  }

  return (
    <>
      <ScrollArea className="h-full">
        <div className="p-3">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Projects
            </h2>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs"
              onClick={() => setDialogOpen(true)}
            >
              + New
            </Button>
          </div>

          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : err ? (
            <p className="text-sm text-red-600">Error: {err}</p>
          ) : projects.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No projects yet. Click "+ New" to add one.
            </p>
          ) : (
            <ul className="space-y-1">
              {projects.map((p) => (
                <li
                  key={p.id}
                  className={`group flex cursor-pointer items-center justify-between rounded px-2 py-1.5 text-sm ${
                    selectedId === p.id ? 'bg-accent' : 'hover:bg-accent/50'
                  }`}
                  onClick={() => onSelect(p.id)}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{p.name}</div>
                    <div className="truncate text-xs text-muted-foreground">{p.path}</div>
                  </div>
                  <button
                    className="ml-2 hidden text-xs text-muted-foreground hover:text-red-600 group-hover:inline"
                    onClick={(e) => handleDelete(e, p.id)}
                    title="Delete project"
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </ScrollArea>

      <NewProjectDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreated={reload}
      />
    </>
  );
}
