import { useCallback, useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { ProjectList } from '@/components/project/ProjectList';
import { ProcessGrid } from '@/components/process/ProcessGrid';
import { LogViewer } from '@/components/log/LogViewer';
import { Dashboard } from '@/components/dashboard/Dashboard';
import { Button } from '@/components/ui/button';
import { api, type Project } from '@/api/tauri';

export function MainLayout() {
  const [logOpen, setLogOpen] = useState(true);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);

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
      <header className="flex h-12 items-center justify-between border-b px-4">
        <div className="flex items-center gap-3">
          <div className="font-semibold">procman</div>
          {showingProject && (
            <>
              <span className="text-muted-foreground">/</span>
              <button
                className="text-sm text-muted-foreground hover:text-foreground"
                onClick={() => setSelectedProjectId(null)}
              >
                ← Dashboard
              </button>
            </>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={() => setLogOpen((v) => !v)}>
          {logOpen ? 'Hide logs' : 'Show logs'}
        </Button>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <aside className="w-[280px] shrink-0 border-r">
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
              <ProcessGrid projectId={selectedProjectId} onScriptsChanged={reloadProjects} />
            ) : (
              <Dashboard projects={projects} />
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
