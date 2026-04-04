import { useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { api } from '@/api/tauri';

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: () => void;
}

export function NewProjectDialog({ open: isOpen, onOpenChange, onCreated }: Props) {
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function pickFolder() {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === 'string') {
      setPath(selected);
      if (!name.trim()) {
        // Default name = last segment of the path
        const seg = selected.split('/').filter(Boolean).pop();
        if (seg) setName(seg);
      }
    }
  }

  async function submit() {
    setErr(null);
    setBusy(true);
    try {
      await api.createProject(name, path);
      setName('');
      setPath('');
      onCreated();
      onOpenChange(false);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New Project</DialogTitle>
          <DialogDescription>
            Register a local project folder. Scripts are added afterwards.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="project-name">Name</Label>
            <Input
              id="project-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. procman"
              disabled={busy}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="project-path">Path</Label>
            <div className="flex gap-2">
              <Input
                id="project-path"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="/Users/.../project"
                disabled={busy}
              />
              <Button type="button" variant="outline" onClick={pickFolder} disabled={busy}>
                Browse…
              </Button>
            </div>
          </div>
          {err && <p className="text-sm text-red-600">{err}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || !name.trim() || !path.trim()}>
            {busy ? 'Creating…' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
