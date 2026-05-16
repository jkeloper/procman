import { useCallback, useEffect, useState } from 'react';
import { api, type Project } from '@/api/tauri';
import { NewGroupDialog } from './NewGroupDialog';
import { Button } from '@/components/ui/button';
import { useProcessStatus } from '@/hooks/useProcessStatus';
import type { ShutdownEvent } from '@/api/tauri';

interface Group {
  id: string;
  name: string;
  members: Array<{ project_id: string; script_id: string }>;
}

interface Props {
  projects: Project[];
}

export function GroupsPanel({ projects }: Props) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [stopping, setStopping] = useState<string | null>(null);
  const { statuses, shutdowns } = useProcessStatus();

  const reload = useCallback(async () => {
    try {
      const list = (await api.listGroups()) as Group[];
      setGroups(list);
    } catch {}
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  function memberLabel(m: { project_id: string; script_id: string }) {
    const p = projects.find((p) => p.id === m.project_id);
    const s = p?.scripts.find((s) => s.id === m.script_id);
    if (!p || !s) return '(deleted)';
    return `${p.name}/${s.name}`;
  }

  async function handleRun(id: string) {
    setBusy(id);
    try {
      await api.runGroup(id);
    } catch (e: any) {
      alert(`Run failed: ${e?.message ?? e}`);
    } finally {
      setBusy(null);
    }
  }

  async function handleStop(id: string) {
    setStopping(id);
    try {
      const result = (await api.stopGroup(id)) as Array<{ ok: boolean; error?: string | null }>;
      const failed = result.find((row) => !row.ok);
      if (failed) {
        alert(`Stop failed: ${failed.error ?? 'unknown error'}`);
      }
    } catch (e: any) {
      alert(`Stop failed: ${e?.message ?? e}`);
    } finally {
      setStopping(null);
    }
  }

  async function handleDelete(id: string) {
    if (!window.confirm('Delete this group?')) return;
    try {
      await api.deleteGroup(id);
      reload();
    } catch (e: any) {
      alert(`Delete failed: ${e?.message ?? e}`);
    }
  }

  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between">
        <div className="flex items-baseline gap-2">
          <h2 className="text-[13px] font-semibold">Groups</h2>
          <span className="font-mono text-[11px] text-muted-foreground">{groups.length}</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-primary"
          onClick={() => setDialogOpen(true)}
          disabled={projects.length === 0}
        >
          + New
        </Button>
      </div>

      {groups.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/60 bg-card/50 p-4 text-center text-[12px] text-muted-foreground">
          No groups. Bundle scripts to launch them together.
        </div>
      ) : (
        <ul className="space-y-1.5">
          {groups.map((g) => {
            const activeShutdown = g.members
              .map((m) => shutdowns[m.script_id])
              .find((evt): evt is ShutdownEvent => isShutdownActive(evt));
            const groupStopping = stopping === g.id || Boolean(activeShutdown);
            const groupRunning = g.members.some(
              (m) => statuses[m.script_id] === 'running' || isShutdownActive(shutdowns[m.script_id]),
            );
            const progress = activeShutdown ? shutdownProgress(activeShutdown) : 0;
            return (
              <li
                key={g.id}
                className="group rounded-lg border border-border/60 bg-card p-3 transition-all hover:border-border hover:shadow-sm"
              >
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-[13px] font-medium">{g.name}</span>
                <div className="flex items-center gap-0.5">
                  <Button
                    size="sm"
                    disabled={busy === g.id || groupStopping || g.members.length === 0}
                    onClick={() => handleRun(g.id)}
                  >
                    {busy === g.id ? 'Launching...' : 'Run'}
                  </Button>
                  {(groupRunning || groupStopping) && (
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={groupStopping || busy === g.id}
                      onClick={() => handleStop(g.id)}
                    >
                      {groupStopping ? 'Stopping...' : 'Stop'}
                    </Button>
                  )}
                  <button
                    className="close-circle opacity-0 group-hover:opacity-100"
                    onClick={() => handleDelete(g.id)}
                  >
                    ✕
                  </button>
                </div>
              </div>
              <div className="flex flex-wrap gap-1">
                {g.members.map((m, i) => (
                  <span
                    key={i}
                    className="rounded bg-muted/50 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                  >
                    {memberLabel(m)}
                  </span>
                ))}
              </div>
              {activeShutdown && (
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className={`h-full rounded-full transition-all ${
                      activeShutdown.phase === 'killing' ? 'bg-destructive' : 'bg-primary'
                    }`}
                    style={{ width: `${progress}%` }}
                  />
                </div>
              )}
              </li>
            );
          })}
        </ul>
      )}

      <NewGroupDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        projects={projects}
        onCreated={reload}
      />
    </section>
  );
}

function isShutdownActive(evt: ShutdownEvent | undefined): boolean {
  return Boolean(evt && evt.phase !== 'stopped' && evt.phase !== 'not_running');
}

function shutdownProgress(evt: ShutdownEvent): number {
  if (evt.timeout_ms <= 0) return 0;
  return Math.min(100, Math.max(3, (evt.elapsed_ms / evt.timeout_ms) * 100));
}
