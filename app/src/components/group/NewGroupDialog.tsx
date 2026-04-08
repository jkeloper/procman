import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { api, type Project } from '@/api/tauri';

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  projects: Project[];
  onCreated: () => void;
}

export function NewGroupDialog({ open, onOpenChange, projects, onCreated }: Props) {
  const [name, setName] = useState('');
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function toggle(key: string) {
    const n = new Set(checked);
    if (n.has(key)) n.delete(key);
    else n.add(key);
    setChecked(n);
  }

  async function submit() {
    setErr(null);
    setBusy(true);
    try {
      const members = Array.from(checked).map((key) => {
        const [project_id, script_id] = key.split('::');
        return { project_id, script_id };
      });
      await api.createGroup(name, members);
      onCreated();
      onOpenChange(false);
      setName('');
      setChecked(new Set());
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>New Group</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="group-name">Name</Label>
            <Input
              id="group-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Morning Stack"
              disabled={busy}
            />
          </div>
          <div>
            <Label>Members</Label>
            <ScrollArea className="mt-1 h-72 rounded border">
              <div className="space-y-2 p-2">
                {projects.map((p) => (
                  <div key={p.id}>
                    <div className="mb-1 text-xs font-semibold text-muted-foreground">
                      {p.name}
                    </div>
                    {p.scripts.length === 0 ? (
                      <p className="ml-3 text-xs text-muted-foreground">(no scripts)</p>
                    ) : (
                      p.scripts.map((s) => {
                        const key = `${p.id}::${s.id}`;
                        return (
                          <label
                            key={key}
                            className="ml-3 flex cursor-pointer items-start gap-2 rounded-md px-2 py-2 text-sm hover:bg-accent/40"
                          >
                            <input
                              type="checkbox"
                              checked={checked.has(key)}
                              onChange={() => toggle(key)}
                              className="mt-0.5 shrink-0 accent-primary"
                            />
                            <div className="min-w-0 flex-1">
                              <div className="font-medium">{s.name}</div>
                              <div className="truncate font-mono text-[11px] text-muted-foreground">
                                $ {s.command}
                              </div>
                            </div>
                          </label>
                        );
                      })
                    )}
                  </div>
                ))}
              </div>
            </ScrollArea>
          </div>
          {err && <p className="text-sm text-red-600">{err}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || !name.trim() || checked.size === 0}>
            {busy ? 'Creating…' : `Create (${checked.size})`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
