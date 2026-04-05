import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { api, type LaunchConfigCandidate, type Script } from '@/api/tauri';

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  projectId: string;
  projectPath: string;
  onImported: () => void;
}

export function VSCodeImportDialog({
  open,
  onOpenChange,
  projectId,
  projectPath,
  onImported,
}: Props) {
  const [candidates, setCandidates] = useState<LaunchConfigCandidate[] | null>(null);
  const [existingSet, setExistingSet] = useState<Set<string>>(new Set());
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      setCandidates(null);
      setChecked(new Set());
      setErr(null);
      return;
    }
    (async () => {
      setBusy(true);
      setErr(null);
      try {
        const [found, existing] = await Promise.all([
          api.scanVscodeConfigs(projectPath),
          api.listScripts(projectId),
        ]);
        const taken = new Set<string>();
        existing.forEach((s: Script) => {
          taken.add(`name:${s.name}`);
          taken.add(`cmd:${s.command}`);
        });
        setExistingSet(taken);
        setCandidates(found);
        const initial = new Set<number>();
        found.forEach((c, i) => {
          if (c.skipped_reason) return;
          if (taken.has(`name:${c.name}`) || taken.has(`cmd:${c.command}`)) return;
          initial.add(i);
        });
        setChecked(initial);
      } catch (e: any) {
        setErr(e?.message ?? String(e));
      } finally {
        setBusy(false);
      }
    })();
  }, [open, projectPath, projectId]);

  function isDuplicate(c: LaunchConfigCandidate): boolean {
    return existingSet.has(`name:${c.name}`) || existingSet.has(`cmd:${c.command}`);
  }

  function toggle(i: number) {
    const n = new Set(checked);
    if (n.has(i)) n.delete(i);
    else n.add(i);
    setChecked(n);
  }

  async function importSelected() {
    if (!candidates) return;
    setBusy(true);
    setErr(null);
    try {
      for (const i of checked) {
        const c = candidates[i];
        if (!c.script) continue;
        await api.createScript(
          projectId,
          c.script.name,
          c.script.command,
          c.script.expected_port,
          c.script.auto_restart,
        );
      }
      onImported();
      onOpenChange(false);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  const importableCount =
    candidates?.filter((c) => !c.skipped_reason).length ?? 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import from VSCode launch.json</DialogTitle>
          <DialogDescription className="font-mono text-xs">
            {projectPath}/.vscode/launch.json
          </DialogDescription>
        </DialogHeader>

        {busy && !candidates ? (
          <p className="text-sm text-muted-foreground">Scanning…</p>
        ) : err ? (
          <p className="text-sm text-red-600">{err}</p>
        ) : !candidates || candidates.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No launch.json configurations found.
          </p>
        ) : (
          <ScrollArea className="h-80 rounded border">
            <ul className="divide-y">
              {candidates.map((c, i) => {
                const isImportable = !c.skipped_reason;
                const dup = isImportable && isDuplicate(c);
                const disabled = !isImportable || dup;
                return (
                  <li key={i} className="p-3 text-sm">
                    <div className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={checked.has(i)}
                        disabled={disabled}
                        onChange={() => toggle(i)}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{c.name}</span>
                          <Badge variant="secondary" className="text-xs">
                            {c.kind}
                          </Badge>
                          {!isImportable && (
                            <Badge variant="destructive" className="text-xs">
                              skipped
                            </Badge>
                          )}
                          {dup && (
                            <Badge variant="outline" className="text-xs">
                              already imported
                            </Badge>
                          )}
                        </div>
                        {isImportable ? (
                          <div className="mt-1 truncate font-mono text-xs text-muted-foreground">
                            $ {c.command}
                          </div>
                        ) : (
                          <div className="mt-1 text-xs text-muted-foreground">
                            {c.skipped_reason}
                          </div>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </ScrollArea>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={importSelected}
            disabled={busy || checked.size === 0 || importableCount === 0}
          >
            {busy ? 'Importing…' : `Import ${checked.size}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
