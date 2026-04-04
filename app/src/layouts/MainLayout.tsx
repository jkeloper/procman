import { useState } from 'react';
import { ProjectList } from '@/components/project/ProjectList';
import { ProcessGrid } from '@/components/process/ProcessGrid';
import { LogViewer } from '@/components/log/LogViewer';
import { Button } from '@/components/ui/button';

export function MainLayout() {
  const [logOpen, setLogOpen] = useState(true);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      <header className="flex h-12 items-center justify-between border-b px-4">
        <div className="font-semibold">procman</div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setLogOpen((v) => !v)}
        >
          {logOpen ? 'Hide logs' : 'Show logs'}
        </Button>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Left sidebar — project list (280px fixed) */}
        <aside className="w-[280px] shrink-0 border-r">
          <ProjectList
            selectedId={selectedProjectId}
            onSelect={setSelectedProjectId}
          />
        </aside>

        {/* Main — process grid (flex-1) */}
        <main className="flex flex-1 flex-col overflow-hidden">
          <section className="flex-1 overflow-auto">
            <ProcessGrid projectId={selectedProjectId} />
          </section>

          {/* Bottom drawer — log viewer (280px, collapsible) */}
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
