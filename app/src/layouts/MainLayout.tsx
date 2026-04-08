import { useCallback, useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { ProjectList } from '@/components/project/ProjectList';
import { ProcessGrid } from '@/components/process/ProcessGrid';
import { LogViewer } from '@/components/log/LogViewer';
import { Dashboard } from '@/components/dashboard/Dashboard';
import { CommandPalette } from '@/components/palette/CommandPalette';
import { RestorePrompt } from '@/components/session/RestorePrompt';
import { QuitGuard } from '@/components/QuitGuard';
import { api, type Project } from '@/api/tauri';
import { useProcessStatus } from '@/hooks/useProcessStatus';
import { useHotkeys } from '@/hooks/useHotkeys';
import { useResizable } from '@/hooks/useResizable';

export function MainLayout() {
  const [logOpen, setLogOpen] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const { statuses } = useProcessStatus();
  useHotkeys({
    toggleLogs: () => setLogOpen((v) => !v),
    goDashboard: () => setSelectedProjectId(null),
  });

  const sidebar = useResizable({
    storageKey: 'procman.sidebarWidth',
    defaultSize: 240,
    min: 180,
    max: 420,
    axis: 'horizontal',
    edge: 'start',
  });
  const logDrawer = useResizable({
    storageKey: 'procman.logHeight',
    defaultSize: 260,
    min: 120,
    max: 720,
    axis: 'vertical',
    edge: 'end',
  });

  const reloadProjects = useCallback(async () => {
    try {
      setProjects(await api.listProjects());
    } catch {}
  }, []);

  // Auto-open log drawer when a process starts
  useEffect(() => {
    const un = listen('process://status', (ev: any) => {
      if (ev.payload?.status === 'running') {
        setLogOpen(true);
      }
    });
    // Close-logs event from LogViewer ✕ button
    const onClose = () => setLogOpen(false);
    window.addEventListener('procman:close-logs', onClose);
    return () => {
      un.then((fn) => fn());
      window.removeEventListener('procman:close-logs', onClose);
    };
  }, []);

  useEffect(() => {
    reloadProjects();
    const un = listen('config-changed', () => reloadProjects());
    return () => {
      un.then((fn) => fn());
    };
  }, [reloadProjects]);

  const showingProject = selectedProjectId != null;
  const currentProject = projects.find((p) => p.id === selectedProjectId) ?? null;
  const runningCount = Object.values(statuses).filter((s) => s === 'running').length;

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      {/* Titlebar — draggable on macOS */}
      <header
        className="glass flex h-9 items-center justify-between border-b border-border/60 pl-20 pr-2 text-[11px]"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div className="flex items-center gap-2 font-medium tracking-tight">
          <span className="text-[14px]">🐸</span>
          <span>procman</span>
          {runningCount > 0 && (
            <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
              {runningCount} running
            </span>
          )}
        </div>
        <div
          className="flex items-center gap-2 text-muted-foreground"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <kbd>⌘K</kbd>
          <span className="text-border">·</span>
          <button
            className="rounded px-1.5 py-0.5 transition-colors hover:bg-accent hover:text-foreground"
            onClick={() => setLogOpen((v) => !v)}
          >
            {logOpen ? 'hide logs' : 'show logs'} <kbd className="ml-0.5">⌘L</kbd>
          </button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Left sidebar */}
        <aside
          className="flex shrink-0 flex-col border-r border-border/60 bg-sidebar"
          style={{ width: sidebar.size }}
        >
          <ProjectList
            selectedId={selectedProjectId}
            onSelect={setSelectedProjectId}
            projects={projects}
            onProjectsChanged={reloadProjects}
          />
        </aside>
        {/* Sidebar resize handle */}
        <div
          onMouseDown={sidebar.onMouseDown}
          className="group relative w-[3px] shrink-0 cursor-col-resize bg-border/60 transition-colors hover:bg-primary/60"
          title="Drag to resize sidebar"
        >
          <div className="absolute inset-y-0 -left-1 -right-1" />
        </div>

        {/* Main content */}
        <main className="flex flex-1 flex-col overflow-hidden">
          {/* Tab bar / breadcrumb */}
          <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border/60 bg-card/50 px-3 text-[12px]">
            <button
              className={`rounded px-2 py-1 transition-colors ${
                !showingProject
                  ? 'bg-accent font-medium text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
              onClick={() => setSelectedProjectId(null)}
            >
              Dashboard
            </button>
            {currentProject && (
              <>
                <span className="text-border">/</span>
                <button className="rounded bg-accent px-2 py-1 font-medium text-foreground">
                  {currentProject.name}
                </button>
                <span className="ml-2 font-mono text-[10px] text-muted-foreground">
                  {currentProject.path}
                </span>
              </>
            )}
          </div>

          <section className="flex-1 overflow-hidden">
            {showingProject && currentProject ? (
              <ProcessGrid
                projectId={currentProject.id}
                projectPath={currentProject.path}
                onScriptsChanged={reloadProjects}
              />
            ) : (
              <Dashboard projects={projects} onSelectProject={setSelectedProjectId} />
            )}
          </section>

          {/* Log drawer — always rendered, slides up/down */}
          {logOpen && (
            <div
              onMouseDown={logDrawer.onMouseDown}
              className="group relative h-[3px] shrink-0 cursor-row-resize bg-border/60 transition-colors hover:bg-primary/60"
              title="Drag to resize log drawer"
            >
              <div className="absolute inset-x-0 -top-1 -bottom-1" />
            </div>
          )}
          <section
            className="shrink-0 overflow-hidden border-t border-border/60 transition-all duration-300 ease-in-out"
            style={{ height: logOpen ? logDrawer.size : 0 }}
          >
            <LogViewer />
          </section>
        </main>
      </div>

      <CommandPalette
        projects={projects}
        statuses={statuses}
        onSelectProject={setSelectedProjectId}
      />
      <RestorePrompt projects={projects} />
      <QuitGuard />
    </div>
  );
}
