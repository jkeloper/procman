import { useState } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { api, type Project } from '@/api/tauri';
import { NewProjectDialog } from './NewProjectDialog';
import { ScanDialog } from './ScanDialog';
import { useProcessStatus } from '@/hooks/useProcessStatus';
import { useConfirm } from '@/components/ConfirmDialog';
import { IconOverview, IconReorder, IconChevronUp, IconChevronDown } from '@/components/icons/TabIcons';

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
  const confirm = useConfirm();
  const [reorderMode, setReorderMode] = useState(false);

  async function handleDelete(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    const ok = await confirm({ title: 'Delete project?', description: 'This project and all its scripts will be removed.', confirmLabel: 'Delete', destructive: true }); if (!ok) return;
    try {
      await api.deleteProject(id);
      if (selectedId === id) onSelect(null);
      onProjectsChanged();
    } catch (e: any) {
      alert(`Failed to delete: ${e?.message ?? e}`);
    }
  }

  async function moveProject(id: string, direction: 'up' | 'down') {
    const ids = projects.map((p) => p.id);
    const idx = ids.indexOf(id);
    if (idx < 0) return;
    const newIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (newIdx < 0 || newIdx >= ids.length) return;
    [ids[idx], ids[newIdx]] = [ids[newIdx], ids[idx]];
    try {
      await api.reorderProjects(ids);
      onProjectsChanged();
    } catch {}
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
              <IconOverview />
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
                  className={`rounded px-1.5 py-0.5 text-[11px] transition-colors ${
                    reorderMode
                      ? 'bg-primary/20 font-medium text-primary'
                      : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                  }`}
                  onClick={() => setReorderMode((v) => !v)}
                  title="Reorder projects"
                >
                  {reorderMode ? 'done' : <IconReorder />}
                </button>
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
              <ul className="space-y-px">
                {projects.map((p, idx) => {
                  const running = projectRunningCount(p);
                  const isSelected = selectedId === p.id;
                  return (
                    <li
                      key={p.id}
                      className={`group flex items-center gap-1.5 rounded-md px-1.5 py-2 text-[13px] transition-all duration-200 ${
                        isSelected
                          ? 'bg-accent font-medium text-foreground'
                          : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                      }`}
                      onClick={() => onSelect(p.id)}
                    >
                      {/* Reorder buttons */}
                      {reorderMode && (
                        <div className="flex shrink-0 flex-col gap-0.5" onClick={(e) => e.stopPropagation()}>
                          <button
                            className="flex h-4 w-4 items-center justify-center rounded text-[8px] text-muted-foreground/50 transition-colors hover:bg-accent hover:text-foreground disabled:opacity-20"
                            disabled={idx === 0}
                            onClick={() => moveProject(p.id, 'up')}
                          ><IconChevronUp /></button>
                          <button
                            className="flex h-4 w-4 items-center justify-center rounded text-[8px] text-muted-foreground/50 transition-colors hover:bg-accent hover:text-foreground disabled:opacity-20"
                            disabled={idx === projects.length - 1}
                            onClick={() => moveProject(p.id, 'down')}
                          ><IconChevronDown /></button>
                        </div>
                      )}

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
                        className="close-circle opacity-0 group-hover:opacity-100"
                        onClick={(e) => { e.stopPropagation(); handleDelete(e, p.id); }}
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
