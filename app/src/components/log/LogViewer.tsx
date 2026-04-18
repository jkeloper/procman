import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { LogPanel } from './LogPanel';
import { api, type StatusEvent } from '@/api/tauri';

interface Tab {
  projectId: string;
  scriptId: string;
  name: string;
}

interface Props {
  isExpanded?: boolean;
  /** When null the viewer shows the dashboard (no project scope).
   *  When set, only that project's log tabs are visible. */
  currentProjectId: string | null;
}

export function LogViewer({ isExpanded = true, currentProjectId }: Props) {
  // Global pool of ALL open log tabs (across every project). We filter
  // to the current project when rendering so each project gets its own
  // isolated console strip.
  const [tabs, setTabs] = useState<Tab[]>([]);
  // Active script id PER project, so switching away and back keeps the
  // previously-focused tab selected.
  const [activeByProject, setActiveByProject] = useState<Record<string, string>>({});

  useEffect(() => {
    (async () => {
      try {
        const [procs, projects] = await Promise.all([
          api.listProcesses(),
          api.listProjects(),
        ]);
        const resolve = (id: string): { projectId: string; name: string } | null => {
          for (const p of projects) {
            const s = p.scripts.find((s) => s.id === id);
            if (s) return { projectId: p.id, name: `${p.name}/${s.name}` };
          }
          return null;
        };
        const initial: Tab[] = [];
        for (const proc of procs) {
          const r = resolve(proc.id);
          if (r) {
            initial.push({ projectId: r.projectId, scriptId: proc.id, name: r.name });
          }
        }
        setTabs(initial);
        const firstByProject: Record<string, string> = {};
        for (const t of initial) {
          if (!firstByProject[t.projectId]) firstByProject[t.projectId] = t.scriptId;
        }
        setActiveByProject(firstByProject);
      } catch {}
    })();

    const onFocus = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.scriptId) {
        // Set active for whichever project this script belongs to
        setTabs((prev) => {
          const tab = prev.find((t) => t.scriptId === detail.scriptId);
          if (tab) {
            setActiveByProject((a) => ({ ...a, [tab.projectId]: tab.scriptId }));
          }
          return prev;
        });
      }
    };
    window.addEventListener('procman:focus-log', onFocus);

    const un = listen<StatusEvent>('process://status', async (ev) => {
      const { id, status } = ev.payload;
      if (status === 'running') {
        const projects = await api.listProjects().catch(() => []);
        let projectId: string | null = null;
        let name = id.slice(0, 8);
        for (const p of projects) {
          const s = p.scripts.find((s) => s.id === id);
          if (s) {
            projectId = p.id;
            name = `${p.name}/${s.name}`;
            break;
          }
        }
        if (!projectId) return;
        setTabs((prev) =>
          prev.some((t) => t.scriptId === id)
            ? prev
            : [...prev, { projectId: projectId!, scriptId: id, name }],
        );
        setActiveByProject((a) => ({ ...a, [projectId!]: id }));
      }
      // NOTE: we intentionally do NOT close tabs on `stopped` or
      // `crashed`. The user wants to keep reading logs after a
      // process exits (especially to see the error that caused a
      // crash). Tabs are closed manually via the ✕ button.
    });
    return () => {
      un.then((fn) => fn());
      window.removeEventListener('procman:focus-log', onFocus);
    };
  }, []);

  function closeTab(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    setTabs((prev) => {
      const tab = prev.find((t) => t.scriptId === id);
      if (tab) {
        setActiveByProject((a) => {
          if (a[tab.projectId] !== id) return a;
          // Move focus to another tab in the same project if any
          const siblings = prev.filter((t) => t.projectId === tab.projectId && t.scriptId !== id);
          const next = { ...a };
          if (siblings.length > 0) {
            next[tab.projectId] = siblings[0].scriptId;
          } else {
            delete next[tab.projectId];
          }
          return next;
        });
      }
      return prev.filter((t) => t.scriptId !== id);
    });
  }

  // Filter tabs to the current project. If we're on the Dashboard
  // (currentProjectId == null) show nothing — the console bar is
  // a per-project affordance.
  const visibleTabs = currentProjectId
    ? tabs.filter((t) => t.projectId === currentProjectId)
    : [];
  const activeScriptId = currentProjectId ? activeByProject[currentProjectId] ?? null : null;
  const activeTab =
    visibleTabs.find((t) => t.scriptId === activeScriptId) ?? visibleTabs[0];

  if (visibleTabs.length === 0) {
    return (
      <div className="flex items-center justify-center bg-log-bg/80 text-[12px] text-log-muted/60" style={{ height: 32, minHeight: 32 }}>
        {currentProjectId
          ? 'No running scripts in this project. Start one to see its logs.'
          : 'Open a project to see its console.'}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-log-bg">
      {/* Tab bar — compact, dark, horizontal-scroll when overflowing */}
      <div className="flex h-8 shrink-0 items-stretch gap-0 border-b border-log-border bg-log-bg/80 text-[12px]">
        {/* Toggle minimize/maximize (pinned left, never shrinks) */}
        <button
          onClick={() => window.dispatchEvent(new CustomEvent('procman:toggle-logs'))}
          className="mx-1 flex h-6 w-6 shrink-0 items-center justify-center self-center rounded text-log-muted transition-colors hover:bg-foreground/10 hover:text-log-fg"
          title="Toggle logs (⌘L)"
        >
          {isExpanded ? (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <line x1="3" y1="11" x2="11" y2="11" />
              <polyline points="4,7 7,10 10,7" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <line x1="3" y1="3" x2="11" y2="3" />
              <polyline points="4,7 7,4 10,7" />
            </svg>
          )}
        </button>
        {/* Scrollable tab strip */}
        <div className="flex min-w-0 flex-1 items-stretch gap-0 overflow-x-auto">
          {visibleTabs.map((t) => {
            const isActive = t.scriptId === activeTab?.scriptId;
            return (
              <div
                key={t.scriptId}
                className={`group flex h-8 shrink-0 max-w-[220px] cursor-pointer items-center gap-1 whitespace-nowrap border-b-2 px-2.5 transition-colors ${
                  isActive
                    ? 'border-primary bg-log-bg text-log-fg'
                    : 'border-transparent text-log-muted hover:bg-foreground/5 hover:text-log-fg'
                }`}
                onClick={() => {
                  setActiveByProject((a) => ({ ...a, [t.projectId]: t.scriptId }));
                  // If minimized, re-open the drawer
                  window.dispatchEvent(new CustomEvent('procman:open-logs'));
                }}
                title={t.name}
              >
                <span className="min-w-0 truncate font-mono">{t.name}</span>
                <button
                  aria-label="Close tab"
                  onClick={(e) => closeTab(t.scriptId, e)}
                  className={`close-circle ml-0.5 shrink-0 ${
                    isActive ? '' : 'opacity-0 group-hover:opacity-100'
                  }`}
                />
              </div>
            );
          })}
        </div>
      </div>
      <div className="flex-1 overflow-hidden">
        {activeTab && (
          // Key on scriptId so switching tabs unmounts the previous
          // LogPanel entirely. This prevents state from one script's
          // stream leaking into another's view and guarantees a clean
          // snapshot + listener pair per script.
          <LogPanel
            key={activeTab.scriptId}
            scriptId={activeTab.scriptId}
            scriptName={activeTab.name}
          />
        )}
      </div>
    </div>
  );
}
