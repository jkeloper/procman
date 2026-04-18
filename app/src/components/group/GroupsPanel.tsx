import { useCallback, useEffect, useState } from 'react';
import { api, type Project } from '@/api/tauri';
import { NewGroupDialog } from './NewGroupDialog';
import { Button } from '@/components/ui/button';

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
          {groups.map((g) => (
            <li
              key={g.id}
              className="group rounded-lg border border-border/60 bg-card p-3 transition-all hover:border-border hover:shadow-sm"
            >
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-[13px] font-medium">{g.name}</span>
                <div className="flex items-center gap-0.5">
                  <Button
                    size="sm"
                    disabled={busy === g.id || g.members.length === 0}
                    onClick={() => handleRun(g.id)}
                  >
                    {busy === g.id ? 'Launching...' : 'Run'}
                  </Button>
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
            </li>
          ))}
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
