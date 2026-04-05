import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { LogPanel } from './LogPanel';
import { api, type StatusEvent } from '@/api/tauri';

interface Tab {
  scriptId: string;
  name: string;
}

/**
 * Global log drawer: opens a new tab whenever a process starts.
 * Closes tabs on user demand (tab exit button).
 */
export function LogViewer() {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    // Prime from running processes + their scripts.
    (async () => {
      try {
        const [procs, projects] = await Promise.all([
          api.listProcesses(),
          api.listProjects(),
        ]);
        const nameOf = (id: string) => {
          for (const p of projects) {
            const s = p.scripts.find((s) => s.id === id);
            if (s) return `${p.name}/${s.name}`;
          }
          return id.slice(0, 8);
        };
        const initial = procs.map((p) => ({ scriptId: p.id, name: nameOf(p.id) }));
        setTabs(initial);
        if (initial.length > 0) setActive(initial[0].scriptId);
      } catch {}
    })();

    const un = listen<StatusEvent>('process://status', async (ev) => {
      const { id, status } = ev.payload;
      if (status === 'running') {
        // Look up a friendly name
        const projects = await api.listProjects().catch(() => []);
        let name = id.slice(0, 8);
        for (const p of projects) {
          const s = p.scripts.find((s) => s.id === id);
          if (s) {
            name = `${p.name}/${s.name}`;
            break;
          }
        }
        setTabs((prev) => (prev.some((t) => t.scriptId === id) ? prev : [...prev, { scriptId: id, name }]));
        setActive(id);
      }
    });
    return () => {
      un.then((fn) => fn());
    };
  }, []);

  function closeTab(id: string) {
    setTabs((prev) => prev.filter((t) => t.scriptId !== id));
    setActive((cur) => (cur === id ? null : cur));
  }

  if (tabs.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No active processes. Start a script to see its logs here.
      </div>
    );
  }

  return (
    <Tabs
      value={active ?? tabs[0].scriptId}
      onValueChange={setActive}
      className="flex h-full flex-col"
    >
      <TabsList className="justify-start rounded-none border-b bg-background px-2">
        {tabs.map((t) => (
          <div key={t.scriptId} className="flex items-center">
            <TabsTrigger value={t.scriptId} className="text-xs">
              {t.name}
            </TabsTrigger>
            <button
              onClick={() => closeTab(t.scriptId)}
              className="px-1 text-xs text-muted-foreground hover:text-foreground"
              title="Close tab"
            >
              ✕
            </button>
          </div>
        ))}
      </TabsList>
      {tabs.map((t) => (
        <TabsContent key={t.scriptId} value={t.scriptId} className="flex-1 overflow-hidden p-0">
          <LogPanel scriptId={t.scriptId} scriptName={t.name} />
        </TabsContent>
      ))}
    </Tabs>
  );
}
