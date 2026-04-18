import { useEffect, useRef, useState } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { api, type Project } from '@/api/tauri';
import { NewProjectDialog } from './NewProjectDialog';
import { ScanDialog } from './ScanDialog';
import { useProcessStatus } from '@/hooks/useProcessStatus';
import { useConfirm } from '@/components/ConfirmDialog';
import { LayoutDashboard, Equal } from 'lucide-react';
import { Button } from '@/components/ui/button';

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
  // Local ordering so we can reorder optimistically without waiting
  // for the parent to reload the projects prop.
  const [order, setOrder] = useState<string[] | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Reset local order whenever the parent changes the project set
  // (add/delete/reload). We compare by id-join so reordering inside
  // doesn't clobber our optimistic list.
  useEffect(() => {
    setOrder((prev) => {
      const parentIds = projects.map((p) => p.id);
      if (!prev) return parentIds;
      // If parent and local have the same id set, keep our local order.
      const sameSet =
        prev.length === parentIds.length &&
        prev.every((id) => parentIds.includes(id));
      return sameSet ? prev : parentIds;
    });
  }, [projects]);

  const orderedProjects: Project[] = (() => {
    if (!order) return projects;
    const byId = new Map(projects.map((p) => [p.id, p]));
    const result: Project[] = [];
    for (const id of order) {
      const p = byId.get(id);
      if (p) result.push(p);
    }
    // Append any new projects the parent added that we don't know about yet
    for (const p of projects) {
      if (!order.includes(p.id)) result.push(p);
    }
    return result;
  })();

  async function handleDelete(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    const ok = await confirm({ title: 'Delete project?', description: 'This project and all its scripts will be removed.', confirmLabel: 'Delete', destructive: true }); if (!ok) return;
    let err: any = null;
    try {
      await api.deleteProject(id);
    } catch (e: any) {
      err = e;
    }
    // Always clear selection + reload, even on error — the user wants
    // the entry gone from the UI either way (e.g. stale ghost from a
    // race or out-of-band config edit).
    if (selectedId === id) onSelect(null);
    setOrder((prev) => (prev ? prev.filter((p) => p !== id) : prev));
    onProjectsChanged();
    if (err) {
      console.warn('Delete returned error (ignored):', err);
    }
  }

  function handleDragStart(e: React.PointerEvent, id: string) {
    e.preventDefault();
    e.stopPropagation();
    setDraggingId(id);
    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';
  }

  useEffect(() => {
    if (!draggingId) return;

    function onMove(e: PointerEvent) {
      const list = listRef.current;
      if (!list) return;
      const rows = Array.from(
        list.querySelectorAll<HTMLLIElement>('li[data-project-id]'),
      );
      for (const row of rows) {
        const id = row.dataset.projectId;
        if (!id || id === draggingId) continue;
        const rect = row.getBoundingClientRect();
        if (e.clientY >= rect.top && e.clientY <= rect.bottom) {
          setOrder((prev) => {
            const cur = prev ?? projects.map((p) => p.id);
            const dragIdx = cur.indexOf(draggingId!);
            const overIdx = cur.indexOf(id);
            if (dragIdx < 0 || overIdx < 0 || dragIdx === overIdx) return cur;
            const next = [...cur];
            const [moved] = next.splice(dragIdx, 1);
            next.splice(overIdx, 0, moved);
            return next;
          });
          break;
        }
      }
    }

    async function onUp() {
      const finalOrder = order ?? projects.map((p) => p.id);
      setDraggingId(null);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      try {
        await api.reorderProjects(finalOrder);
        onProjectsChanged();
      } catch {
        // On failure reset to parent state
        setOrder(projects.map((p) => p.id));
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
  }, [draggingId, order, projects, onProjectsChanged]);

  function projectRunningCount(p: Project) {
    return p.scripts.filter((s) => statuses[s.id] === 'running').length;
  }

  return (
    <div className="flex h-full flex-col">
      <ScrollArea className="flex-1 min-h-0 overflow-hidden">
        <div className="flex flex-col gap-4 p-2">
          {/* Dashboard */}
          <div>
            <div className="mb-1 px-2 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
              Overview
            </div>
            <button
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[14px] transition-colors ${
                selectedId === null
                  ? 'bg-accent font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
              }`}
              onClick={() => onSelect(null)}
            >
              <LayoutDashboard size={16} />
              <span className="flex-1">Dashboard</span>
            </button>
          </div>

          {/* Projects */}
          <div>
            <div className="mb-1 flex items-center justify-between px-2">
              <span className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
                Projects
              </span>
              <div className="flex items-center gap-0.5">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2"
                  onClick={() => setScanOpen(true)}
                  title="Scan folder for projects"
                >
                  Scan
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-primary"
                  onClick={() => setDialogOpen(true)}
                  title="Add project manually"
                >
                  + New
                </Button>
              </div>
            </div>
            {orderedProjects.length === 0 ? (
              <p className="px-2 text-[13px] text-muted-foreground">
                No projects yet. <button className="text-primary hover:underline" onClick={() => setScanOpen(true)}>Scan a folder</button> to start.
              </p>
            ) : (
              <ul ref={listRef} className="space-y-px">
                {orderedProjects.map((p) => {
                  const running = projectRunningCount(p);
                  const isSelected = selectedId === p.id;
                  const isDragging = draggingId === p.id;
                  return (
                    <li
                      key={p.id}
                      data-project-id={p.id}
                      className={`group flex min-h-[44px] items-center gap-1 rounded-md pl-0.5 pr-1.5 py-3 text-[14px] transition-all duration-200 ${
                        isSelected
                          ? 'bg-accent font-medium text-foreground'
                          : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                      } ${isDragging ? 'opacity-80 shadow-lg' : ''}`}
                      onClick={() => onSelect(p.id)}
                    >
                      {/* Drag handle — two-line hamburger */}
                      <button
                        className="flex h-5 w-5 shrink-0 cursor-grab items-center justify-center rounded text-muted-foreground/40 opacity-0 transition-opacity hover:text-foreground active:cursor-grabbing group-hover:opacity-100"
                        onPointerDown={(e) => handleDragStart(e, p.id)}
                        onClick={(e) => e.stopPropagation()}
                        aria-label="Drag to reorder"
                        title="Drag to reorder"
                      >
                        <Equal size={12} />
                      </button>

                      <span className="min-w-0 flex-1 truncate">{p.name}</span>

                      <div className="flex items-center gap-1 shrink-0">
                        {running > 0 && (
                          <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[12px] font-mono font-semibold text-emerald-600 dark:text-emerald-400">
                            {running}
                          </span>
                        )}
                        <span className="rounded-full bg-muted/60 px-1.5 py-0.5 text-[12px] font-mono text-muted-foreground">
                          {p.scripts.length}
                        </span>
                      </div>

                      <button
                        aria-label="Delete project"
                        className="close-circle opacity-0 group-hover:opacity-100"
                        onClick={(e) => { e.stopPropagation(); handleDelete(e, p.id); }}
                      />
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
        <div className="flex w-full items-center justify-between text-[12px] leading-tight">
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
