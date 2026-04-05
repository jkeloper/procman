import { useState } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { api, type Project } from '@/api/tauri';
import { NewProjectDialog } from './NewProjectDialog';
import { ScanDialog } from './ScanDialog';

interface Props {
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  projects: Project[];
  onProjectsChanged: () => void;
}

export function ProjectList({ selectedId, onSelect, projects, onProjectsChanged }: Props) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);

  async function handleDelete(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    if (!window.confirm('Delete this project?')) return;
    try {
      await api.deleteProject(id);
      if (selectedId === id) onSelect(null);
      onProjectsChanged();
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
            <div className="flex gap-1">
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-xs"
                onClick={() => setScanOpen(true)}
              >
                Scan…
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-xs"
                onClick={() => setDialogOpen(true)}
              >
                + New
              </Button>
            </div>
          </div>

          {/* Dashboard pseudo-item */}
          <button
            className={`mb-2 flex w-full items-center rounded px-2 py-1.5 text-left text-sm ${
              selectedId === null ? 'bg-accent' : 'hover:bg-accent/50'
            }`}
            onClick={() => onSelect(null)}
          >
            <span className="mr-2">📊</span>
            <span className="font-medium">Dashboard</span>
          </button>

          {projects.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No projects yet. Click "Scan…" or "+ New" to add one.
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
                    <div className="truncate text-xs text-muted-foreground">
                      {p.scripts.length} scripts
                    </div>
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
        onCreated={onProjectsChanged}
      />
      <ScanDialog
        open={scanOpen}
        onOpenChange={setScanOpen}
        onImported={onProjectsChanged}
      />
    </>
  );
}
