import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { LogPanel } from './LogPanel';
import { api, type StatusEvent } from '@/api/tauri';

interface Tab {
  scriptId: string;
  name: string;
}

export function LogViewer() {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
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

    const onFocus = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.scriptId) setActive(detail.scriptId);
    };
    window.addEventListener('procman:focus-log', onFocus);

    const un = listen<StatusEvent>('process://status', async (ev) => {
      const { id, status } = ev.payload;
      if (status === 'running') {
        const projects = await api.listProjects().catch(() => []);
        let name = id.slice(0, 8);
        for (const p of projects) {
          const s = p.scripts.find((s) => s.id === id);
          if (s) {
            name = `${p.name}/${s.name}`;
            break;
          }
        }
        setTabs((prev) =>
          prev.some((t) => t.scriptId === id) ? prev : [...prev, { scriptId: id, name }],
        );
        setActive(id);
      }
    });
    return () => {
      un.then((fn) => fn());
      window.removeEventListener('procman:focus-log', onFocus);
    };
  }, []);

  function closeTab(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    setTabs((prev) => prev.filter((t) => t.scriptId !== id));
    setActive((cur) => (cur === id ? null : cur));
  }

  const activeTab = tabs.find((t) => t.scriptId === active) ?? tabs[0];

  if (tabs.length === 0) {
    return (
      <div className="flex items-center justify-center bg-[#161b18] text-[11px] text-zinc-600" style={{ height: 32, minHeight: 32 }}>
        No active processes. Start a script to see its logs.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-[#0a0a0a]">
      {/* Tab bar — compact, dark */}
      <div className="flex h-8 shrink-0 items-center gap-0 border-b border-white/10 bg-[#161b18] px-2 text-[11px]">
        {/* Minimize drawer button */}
        <button
          onClick={() => window.dispatchEvent(new CustomEvent('procman:close-logs'))}
          className="mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded text-zinc-500 transition-colors hover:bg-white/10 hover:text-zinc-200"
          title="Minimize (⌘L)"
        >
          ▾
        </button>
        {tabs.map((t) => {
          const isActive = t.scriptId === activeTab?.scriptId;
          return (
            <div
              key={t.scriptId}
              className={`group flex cursor-pointer items-center gap-1 border-b-2 px-2.5 py-1.5 transition-colors ${
                isActive
                  ? 'border-primary bg-[#0a0a0a] text-zinc-100'
                  : 'border-transparent text-zinc-500 hover:bg-white/5 hover:text-zinc-300'
              }`}
              onClick={() => {
                setActive(t.scriptId);
                // If minimized, re-open the drawer
                window.dispatchEvent(new CustomEvent('procman:open-logs'));
              }}
            >
              <span className="font-mono">{t.name}</span>
              <button
                onClick={(e) => closeTab(t.scriptId, e)}
                className={`ml-0.5 rounded px-1 text-zinc-600 hover:text-zinc-100 ${
                  isActive ? '' : 'opacity-0 group-hover:opacity-100'
                }`}
              >
                ✕
              </button>
            </div>
          );
        })}
      </div>
      <div className="flex-1 overflow-hidden">
        {activeTab && (
          <LogPanel scriptId={activeTab.scriptId} scriptName={activeTab.name} />
        )}
      </div>
    </div>
  );
}
