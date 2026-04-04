import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { api, type Script } from '@/api/tauri';

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  projectId: string;
  existing: Script | null; // null = create mode
  onSaved: () => void;
}

export function ScriptEditor({ open, onOpenChange, projectId, existing, onSaved }: Props) {
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [expectedPort, setExpectedPort] = useState('');
  const [autoRestart, setAutoRestart] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setName(existing?.name ?? '');
      setCommand(existing?.command ?? '');
      setExpectedPort(existing?.expected_port?.toString() ?? '');
      setAutoRestart(existing?.auto_restart ?? false);
      setErr(null);
    }
  }, [open, existing]);

  async function submit() {
    setErr(null);
    setBusy(true);
    const portNum = expectedPort.trim() === '' ? null : parseInt(expectedPort, 10);
    if (portNum != null && (isNaN(portNum) || portNum < 1 || portNum > 65535)) {
      setErr('Port must be 1–65535');
      setBusy(false);
      return;
    }
    try {
      if (existing) {
        await api.updateScript(projectId, existing.id, {
          name,
          command,
          expectedPort: portNum,
          autoRestart,
        });
      } else {
        await api.createScript(projectId, name, command, portNum, autoRestart);
      }
      onSaved();
      onOpenChange(false);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{existing ? 'Edit Script' : 'New Script'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="script-name">Name</Label>
            <Input
              id="script-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. dev"
              disabled={busy}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="script-command">Command</Label>
            <Textarea
              id="script-command"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="pnpm dev"
              rows={2}
              disabled={busy}
              className="font-mono text-sm"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="script-port">Expected port (optional)</Label>
              <Input
                id="script-port"
                value={expectedPort}
                onChange={(e) => setExpectedPort(e.target.value)}
                placeholder="5173"
                disabled={busy}
              />
            </div>
            <div className="flex items-end space-x-2">
              <input
                id="script-restart"
                type="checkbox"
                checked={autoRestart}
                onChange={(e) => setAutoRestart(e.target.checked)}
                disabled={busy}
              />
              <Label htmlFor="script-restart">Auto-restart on crash</Label>
            </div>
          </div>
          {err && <p className="text-sm text-red-600">{err}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || !name.trim() || !command.trim()}>
            {busy ? 'Saving…' : existing ? 'Save' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
