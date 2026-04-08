import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { api, type Script } from '@/api/tauri';

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  projectId: string;
  existing: Script | null;
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
      <DialogContent className="max-w-3xl" style={{ maxHeight: '66vh', display: 'flex', flexDirection: 'column' }}>
        {/* Header — name + port inline */}
        <div className="flex items-center gap-3 border-b border-border/60 pb-3">
          <div className="flex-1 min-w-0">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Script name"
              disabled={busy}
              className="border-0 bg-transparent px-0 text-[18px] font-semibold placeholder:text-muted-foreground/40 focus-visible:ring-0"
            />
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-[12px] text-muted-foreground">:</span>
            <Input
              value={expectedPort}
              onChange={(e) => setExpectedPort(e.target.value)}
              placeholder="port"
              disabled={busy}
              className="w-[70px] border-border/60 bg-muted/30 px-2 py-1 text-center font-mono text-[13px]"
            />
            <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer select-none">
              <input
                type="checkbox"
                checked={autoRestart}
                onChange={(e) => setAutoRestart(e.target.checked)}
                disabled={busy}
                className="accent-primary"
              />
              auto-restart
            </label>
          </div>
        </div>

        {/* Command — large editor-like textarea */}
        <div className="flex-1">
          <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">
            Command
          </div>
          <textarea
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder="pnpm dev&#10;# or multi-line script..."
            disabled={busy}
            rows={10}
            className="w-full resize-none rounded-lg border border-border/60 bg-[#0a0a0a] p-4 font-mono text-[13px] leading-relaxed text-foreground placeholder:text-muted-foreground/30 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
            spellCheck={false}
          />
        </div>

        {err && <p className="text-[12px] text-red-500">{err}</p>}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={busy || !name.trim() || !command.trim()}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {busy ? 'Saving…' : existing ? 'Save changes' : 'Create script'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
