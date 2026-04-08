import { useState } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { api, type Project } from '@/api/tauri';
import { NewProjectDialog } from './NewProjectDialog';
import { ScanDialog } from './ScanDialog';
import { useProcessStatus } from '@/hooks/useProcessStatus';

interface Props {
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  projects: Project[];
  onProjectsChanged: () => void;
}

export function ProjectList({ selectedId, onSelect, projects, onProjectsChanged }: Props) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const { statuses } = useProcessStatus();

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

  function projectRunningCount(p: Project) {
    return p.scripts.filter((s) => statuses[s.id] === 'running').length;
  }

  return (
    <div className="flex h-full flex-col">
      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-4 p-2">
          {/* Dashboard */}
          <div>
            <div className="mb-1 px-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Overview
            </div>
            <button
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors ${
                selectedId === null
                  ? 'bg-accent font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
              }`}
              onClick={() => onSelect(null)}
            >
              <span className="text-sm">⊞</span>
              <span className="flex-1">Dashboard</span>
            </button>
          </div>

          {/* Projects */}
          <div>
            <div className="mb-1 flex items-center justify-between px-2">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Projects
              </span>
              <div className="flex items-center gap-0.5">
                <button
                  className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  onClick={() => setScanOpen(true)}
                  title="Scan folder for projects"
                >
                  scan
                </button>
                <button
                  className="rounded px-1.5 py-0.5 text-[11px] font-medium text-primary transition-colors hover:bg-primary/10"
                  onClick={() => setDialogOpen(true)}
                  title="Add project manually"
                >
                  + new
                </button>
              </div>
            </div>
            {projects.length === 0 ? (
              <p className="px-2 text-[12px] text-muted-foreground">
                No projects yet. <button className="text-primary hover:underline" onClick={() => setScanOpen(true)}>Scan a folder</button> to start.
              </p>
            ) : (
              <ul className="space-y-0.5">
                {projects.map((p) => {
                  const running = projectRunningCount(p);
                  const isSelected = selectedId === p.id;
                  return (
                    <li
                      key={p.id}
                      className={`group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] transition-all ${
                        isSelected
                          ? 'bg-accent font-medium text-foreground'
                          : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                      }`}
                      onClick={() => onSelect(p.id)}
                    >
                      <span className={`status-dot ${running > 0 ? 'bg-emerald-500' : 'bg-border'}`} style={{ marginRight: 0 }} />
                      <span className="min-w-0 flex-1 truncate">{p.name}</span>
                      <div className="flex items-center gap-1 shrink-0">
                        {running > 0 && (
                          <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-mono font-semibold text-emerald-600 dark:text-emerald-400">
                            {running}
                          </span>
                        )}
                        <span className="rounded-full bg-muted/60 px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
                          {p.scripts.length}
                        </span>
                      </div>
                      <button
                        className="opacity-0 transition-opacity text-muted-foreground hover:text-red-500 group-hover:opacity-100"
                        onClick={(e) => handleDelete(e, p.id)}
                      >
                        ✕
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </ScrollArea>

      {/* Footer — status summary */}
      <div className="shrink-0 flex items-center border-t border-border/60 px-3" style={{ height: 31, minHeight: 31, maxHeight: 31 }}>
        <div className="flex w-full items-center justify-between text-[10px] leading-tight">
          <span className="text-muted-foreground/60">
            {projects.reduce((n, p) => n + p.scripts.filter((s) => statuses[s.id] === 'running').length, 0)} running
            {' · '}
            {projects.reduce((n, p) => n + p.scripts.length, 0)} scripts
          </span>
          <span className="font-mono text-muted-foreground/40">v0.1.0</span>
        </div>
      </div>

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
    </div>
  );
}
