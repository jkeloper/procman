import { useCallback, useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { ProjectList } from '@/components/project/ProjectList';
import { ProcessGrid } from '@/components/process/ProcessGrid';
import { LogViewer } from '@/components/log/LogViewer';
import { Dashboard } from '@/components/dashboard/Dashboard';
import { CommandPalette } from '@/components/palette/CommandPalette';
import { RestorePrompt } from '@/components/session/RestorePrompt';
import { api, type Project } from '@/api/tauri';
import { useProcessStatus } from '@/hooks/useProcessStatus';
import { useHotkeys } from '@/hooks/useHotkeys';

export function MainLayout() {
  const [logOpen, setLogOpen] = useState(true);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const { statuses } = useProcessStatus();
  useHotkeys({
    toggleLogs: () => setLogOpen((v) => !v),
    goDashboard: () => setSelectedProjectId(null),
  });

  const reloadProjects = useCallback(async () => {
    try {
      setProjects(await api.listProjects());
    } catch {}
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
          <span className="text-primary">●</span>
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
        <aside className="flex w-[240px] shrink-0 flex-col border-r border-border/60 bg-sidebar">
          <ProjectList
            selectedId={selectedProjectId}
            onSelect={setSelectedProjectId}
            projects={projects}
            onProjectsChanged={reloadProjects}
          />
        </aside>

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

          {logOpen && (
            <section className="h-[260px] shrink-0 border-t border-border/60">
              <LogViewer />
            </section>
          )}
        </main>
      </div>

      <CommandPalette
        projects={projects}
        statuses={statuses}
        onSelectProject={setSelectedProjectId}
      />
      <RestorePrompt projects={projects} />
    </div>
  );
}
