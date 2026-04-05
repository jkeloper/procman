import { useCallback, useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { ProjectList } from '@/components/project/ProjectList';
import { ProcessGrid } from '@/components/process/ProcessGrid';
import { LogViewer } from '@/components/log/LogViewer';
import { Dashboard } from '@/components/dashboard/Dashboard';
import { CommandPalette } from '@/components/palette/CommandPalette';
import { RestorePrompt } from '@/components/session/RestorePrompt';
import { Button } from '@/components/ui/button';
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
    } catch {
      // swallow; ProjectList shows detailed error
    }
  }, []);

  useEffect(() => {
    reloadProjects();
    const un = listen('config-changed', () => reloadProjects());
    return () => {
      un.then((fn) => fn());
    };
  }, [reloadProjects]);

  const showingProject = selectedProjectId != null;

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      <header className="glass flex h-10 items-center justify-between border-b px-3">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-semibold tracking-tight">procman</span>
          {showingProject && (
            <>
              <span className="text-muted-foreground/50">/</span>
              <button
                className="text-muted-foreground transition-colors hover:text-foreground"
                onClick={() => setSelectedProjectId(null)}
              >
                dashboard
              </button>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          <kbd className="hidden sm:inline">⌘K</kbd>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={() => setLogOpen((v) => !v)}
          >
            {logOpen ? 'hide logs' : 'show logs'} <kbd className="ml-1.5">⌘L</kbd>
          </Button>
        </div>
      </header>
      <CommandPalette
        projects={projects}
        statuses={statuses}
        onSelectProject={setSelectedProjectId}
      />
      <RestorePrompt projects={projects} />

      <div className="flex flex-1 overflow-hidden">
        <aside className="glass w-[240px] shrink-0 border-r">
          <ProjectList
            selectedId={selectedProjectId}
            onSelect={setSelectedProjectId}
            projects={projects}
            onProjectsChanged={reloadProjects}
          />
        </aside>

        <main className="flex flex-1 flex-col overflow-hidden">
          <section className="flex-1 overflow-hidden">
            {showingProject ? (
              <ProcessGrid
                projectId={selectedProjectId}
                projectPath={projects.find((p) => p.id === selectedProjectId)?.path ?? ''}
                onScriptsChanged={reloadProjects}
              />
            ) : (
              <Dashboard projects={projects} onSelectProject={setSelectedProjectId} />
            )}
          </section>

          {logOpen && (
            <section className="h-[280px] shrink-0 border-t">
              <LogViewer />
            </section>
          )}
        </main>
      </div>
    </div>
  );
}
