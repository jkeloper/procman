import { useEffect, useMemo, useState } from 'react';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import { api, type Project, type RuntimeStatus } from '@/api/tauri';

interface Props {
  projects: Project[];
  statuses: Record<string, RuntimeStatus>;
  onSelectProject: (id: string | null) => void;
}

/**
 * ⌘K command palette — fuzzy search across projects, scripts, and
 * quick actions (start/stop/restart).
 */
export function CommandPalette({ projects, statuses, onSelectProject }: Props) {
  const [open, setOpen] = useState(false);

  // Global ⌘K / Ctrl+K
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Flattened action list for fuzzy search
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

  function close() {
    setOpen(false);
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

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Type to search projects, scripts, actions…" />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>

        <CommandGroup heading="Navigation">
          <CommandItem
            onSelect={() => {
              onSelectProject(null);
              close();
            }}
          >
            📊 Go to Dashboard
          </CommandItem>
        </CommandGroup>

        {projects.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Projects">
              {projects.map((p) => (
                <CommandItem
                  key={`p-${p.id}`}
                  value={`project ${p.name} ${p.path}`}
                  onSelect={() => {
                    onSelectProject(p.id);
                    close();
                  }}
                >
                  📁 {p.name}
                  <span className="ml-auto text-xs text-muted-foreground">
                    {p.scripts.length} scripts
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {scriptRows.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Scripts — Start">
              {scriptRows
                .filter((r) => r.status !== 'running')
                .map((r) => (
                  <CommandItem
                    key={`start-${r.scriptId}`}
                    value={`start ${r.projectName} ${r.scriptName} ${r.command}`}
                    onSelect={() => runAction('start', r.projectId, r.scriptId)}
                  >
                    ▶ {r.projectName}/{r.scriptName}
                    <span className="ml-auto truncate font-mono text-xs text-muted-foreground">
                      {r.command}
                    </span>
                  </CommandItem>
                ))}
            </CommandGroup>
          </>
        )}

        {scriptRows.some((r) => r.status === 'running') && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Scripts — Running">
              {scriptRows
                .filter((r) => r.status === 'running')
                .flatMap((r) => [
                  <CommandItem
                    key={`stop-${r.scriptId}`}
                    value={`stop ${r.projectName} ${r.scriptName}`}
                    onSelect={() => runAction('stop', r.projectId, r.scriptId)}
                  >
                    ■ Stop {r.projectName}/{r.scriptName}
                  </CommandItem>,
                  <CommandItem
                    key={`restart-${r.scriptId}`}
                    value={`restart ${r.projectName} ${r.scriptName}`}
                    onSelect={() => runAction('restart', r.projectId, r.scriptId)}
                  >
                    ↻ Restart {r.projectName}/{r.scriptName}
                  </CommandItem>,
                ])}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}
