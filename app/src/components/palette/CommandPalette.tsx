import { useEffect, useMemo, useState } from 'react';
import { api, type Project, type RuntimeStatus } from '@/api/tauri';
import { IconOverview, IconGroups, IconFolder, IconPlay, IconStop, IconRestart } from '@/components/icons/TabIcons';

interface Group {
  id: string;
  name: string;
  members: Array<{ project_id: string; script_id: string }>;
}

interface Props {
  projects: Project[];
  statuses: Record<string, RuntimeStatus>;
  onSelectProject: (id: string | null) => void;
}

export function CommandPalette({ projects, statuses, onSelectProject }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [groups, setGroups] = useState<Group[]>([]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
        setQuery('');
      }
      if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    (async () => {
      try {
        const g = (await api.listGroups()) as Group[];
        setGroups(g);
      } catch {}
    })();
  }, [open]);

  const scriptRows = useMemo(() => {
    const rows: Array<{
      projectId: string;
      projectName: string;
      scriptId: string;
      scriptName: string;
      command: string;
      status: RuntimeStatus;
    }> = [];
    for (const p of projects) {
      for (const s of p.scripts) {
        rows.push({
          projectId: p.id,
          projectName: p.name,
          scriptId: s.id,
          scriptName: s.name,
          command: s.command,
          status: statuses[s.id] ?? 'stopped',
        });
      }
    }
    return rows;
  }, [projects, statuses]);

  const q = query.toLowerCase();

  // Filter items by query
  const filteredProjects = projects.filter(
    (p) => !q || p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q),
  );
  const stoppedScripts = scriptRows.filter(
    (r) =>
      r.status !== 'running' &&
      (!q ||
        r.scriptName.toLowerCase().includes(q) ||
        r.projectName.toLowerCase().includes(q) ||
        r.command.toLowerCase().includes(q)),
  );
  const runningScripts = scriptRows.filter(
    (r) =>
      r.status === 'running' &&
      (!q ||
        r.scriptName.toLowerCase().includes(q) ||
        r.projectName.toLowerCase().includes(q)),
  );
  const filteredGroups = groups.filter(
    (g) => !q || g.name.toLowerCase().includes(q),
  );

  // Only show sections that have items
  const hasProjects = filteredProjects.length > 0;
  const hasGroups = filteredGroups.length > 0;
  const hasStopped = stoppedScripts.length > 0;
  const hasRunning = runningScripts.length > 0;
  const hasAnything = hasProjects || hasGroups || hasStopped || hasRunning;

  function close() {
    setOpen(false);
    setQuery('');
  }

  async function runAction(
    action: 'start' | 'stop' | 'restart',
    projectId: string,
    scriptId: string,
  ) {
    close();
    try {
      if (action === 'start') await api.spawnProcess(projectId, scriptId);
      else if (action === 'stop') await api.killProcess(scriptId);
      else await api.restartProcess(projectId, scriptId);
    } catch (e: any) {
      alert(`${action} failed: ${e?.message ?? e}`);
    }
  }

  async function runGroupAction(groupId: string) {
    close();
    try {
      await api.runGroup(groupId);
    } catch (e: any) {
      alert(`Run group failed: ${e?.message ?? e}`);
    }
  }

  if (!open) return null;

  return (
    <>
      {/* Backdrop — semi-transparent so content is still visible */}
      <div
        className="fixed inset-0 z-[200] bg-black/40"
        onClick={close}
      />
      {/* Palette */}
      <div className="fixed left-1/2 top-[15%] z-[201] w-[560px] max-w-[90vw] -translate-x-1/2 overflow-hidden rounded-xl border border-border/60 bg-card shadow-2xl">
        {/* Search input */}
        <div className="flex items-center border-b border-border/60 px-4">
          <span className="text-[16px] text-muted-foreground">⌘</span>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search projects, scripts, groups…"
            autoFocus
            className="flex-1 border-0 bg-transparent px-3 py-4 text-[15px] text-foreground placeholder:text-muted-foreground/50 focus:outline-none"
          />
          <kbd className="rounded border border-border/60 bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground">
            esc
          </kbd>
        </div>

        {/* Results */}
        <div className="max-h-[420px] overflow-y-auto p-2">
          {!hasAnything && (
            <div className="py-8 text-center text-[14px] text-muted-foreground">
              No results for "{query}"
            </div>
          )}

          {/* Navigation */}
          <PaletteItem
            icon="grid"
            label="Dashboard"
            sub=""
            onClick={() => {
              onSelectProject(null);
              close();
            }}
            visible={!q || 'dashboard'.includes(q)}
          />

          {/* Groups */}
          {hasGroups && (
            <>
              <SectionLabel>Groups</SectionLabel>
              {filteredGroups.map((g) => (
                <PaletteItem
                  key={`g-${g.id}`}
                  icon="play-double"
                  label={g.name}
                  sub={`${g.members.length} scripts`}
                  onClick={() => runGroupAction(g.id)}
                />
              ))}
            </>
          )}

          {/* Projects */}
          {hasProjects && (
            <>
              <SectionLabel>Projects</SectionLabel>
              {filteredProjects.map((p) => (
                <PaletteItem
                  key={`p-${p.id}`}
                  icon="folder"
                  label={p.name}
                  sub={`${p.scripts.length} scripts`}
                  onClick={() => {
                    onSelectProject(p.id);
                    close();
                  }}
                />
              ))}
            </>
          )}

          {/* Start scripts */}
          {hasStopped && (
            <>
              <SectionLabel>Start</SectionLabel>
              {stoppedScripts.map((r) => (
                <PaletteItem
                  key={`start-${r.scriptId}`}
                  icon="play"
                  label={`${r.projectName} / ${r.scriptName}`}
                  sub={r.command}
                  onClick={() => runAction('start', r.projectId, r.scriptId)}
                />
              ))}
            </>
          )}

          {/* Running scripts */}
          {hasRunning && (
            <>
              <SectionLabel>Running</SectionLabel>
              {runningScripts.map((r) => (
                <div key={`run-${r.scriptId}`} className="flex gap-1">
                  <PaletteItem
                    icon="stop"
                    label={`Stop ${r.projectName}/${r.scriptName}`}
                    sub=""
                    onClick={() => runAction('stop', r.projectId, r.scriptId)}
                    className="flex-1"
                  />
                  <PaletteItem
                    icon="restart"
                    label="Restart"
                    sub=""
                    onClick={() => runAction('restart', r.projectId, r.scriptId)}
                    className="w-auto shrink-0"
                  />
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-3 mb-1 px-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </div>
  );
}

function PaletteItem({
  icon,
  label,
  sub,
  onClick,
  visible = true,
  className = '',
}: {
  icon: string;
  label: string;
  sub: string;
  onClick: () => void;
  visible?: boolean;
  className?: string;
}) {
  if (!visible) return null;
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-accent/60 ${className}`}
    >
      <span className="flex w-5 shrink-0 items-center justify-center">
        {icon === 'grid' ? <IconOverview /> :
         icon === 'play-double' ? <IconGroups /> :
         icon === 'folder' ? <IconFolder /> :
         icon === 'play' ? <IconPlay /> :
         icon === 'stop' ? <IconStop /> :
         icon === 'restart' ? <IconRestart /> :
         <span className="text-[14px]">{icon}</span>}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] font-medium text-foreground">{label}</span>
        {sub && (
          <span className="block truncate font-mono text-[11px] text-muted-foreground">
            {sub}
          </span>
        )}
      </span>
    </button>
  );
}
