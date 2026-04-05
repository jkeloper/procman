import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { api, type Project } from '@/api/tauri';
import { NewGroupDialog } from './NewGroupDialog';

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
  const [err, setErr] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const list = (await api.listGroups()) as Group[];
      setGroups(list);
      setErr(null);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    }
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
    <>
      <Card>
        <CardHeader className="flex-row items-center justify-between pb-2">
          <CardTitle className="text-sm">Groups</CardTitle>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setDialogOpen(true)}
            disabled={projects.length === 0}
          >
            + Group
          </Button>
        </CardHeader>
        <CardContent>
          {err && <p className="mb-2 text-xs text-red-600">{err}</p>}
          {groups.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No groups yet. Create one to launch multiple scripts at once.
            </p>
          ) : (
            <ul className="space-y-2">
              {groups.map((g) => (
                <li key={g.id} className="rounded border p-2">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-sm font-medium">{g.name}</span>
                    <div className="flex items-center gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy === g.id || g.members.length === 0}
                        onClick={() => handleRun(g.id)}
                      >
                        {busy === g.id ? 'Launching…' : '▶ Run'}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-red-600"
                        onClick={() => handleDelete(g.id)}
                      >
                        ✕
                      </Button>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {g.members.map((m, i) => (
                      <Badge key={i} variant="secondary" className="text-xs">
                        {memberLabel(m)}
                      </Badge>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <NewGroupDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        projects={projects}
        onCreated={reload}
      />
    </>
  );
}
