import { useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { api, type ProjectCandidate } from '@/api/tauri';

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onImported: () => void;
}

export function ScanDialog({ open: isOpen, onOpenChange, onImported }: Props) {
  const [candidates, setCandidates] = useState<ProjectCandidate[] | null>(null);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [rootPath, setRootPath] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function pickAndScan() {
    setErr(null);
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected !== 'string') return;
    setRootPath(selected);
    setBusy(true);
    try {
      const found = await api.scanDirectory(selected);
      setCandidates(found);
      setChecked(new Set(found.map((_, i) => i)));
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  function toggle(i: number) {
    const next = new Set(checked);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    setChecked(next);
  }

  async function importSelected() {
    if (!candidates) return;
    setBusy(true);
    setErr(null);
    try {
      for (const i of checked) {
        const c = candidates[i];
        const project = await api.createProject(c.name, c.path);
        // Also import the scripts found in package.json so the project
        // isn't empty after import.
        for (const s of c.scripts) {
          await api.createScript(
            project.id,
            s.name,
            s.command,
            s.expected_port,
            s.auto_restart,
          );
        }
      }
      onImported();
      onOpenChange(false);
      setCandidates(null);
      setRootPath(null);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Auto-detect projects</DialogTitle>
        </DialogHeader>
        {!candidates ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Pick a root folder. procman will scan for package.json files
              (up to 5 levels deep, skipping node_modules/.git/target).
            </p>
            <Button onClick={pickAndScan} disabled={busy}>
              {busy ? 'Scanning…' : 'Choose folder & scan'}
            </Button>
            {err && <p className="text-sm text-red-600">{err}</p>}
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Found {candidates.length} package.json in <code>{rootPath}</code>.
              Select projects to import.
            </p>
            <ScrollArea className="h-64 rounded border">
              {candidates.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">No package.json found.</p>
              ) : (
                <ul className="divide-y">
                  {candidates.map((c, i) => (
                    <li key={i} className="flex items-center gap-3 p-2 text-sm">
                      <input
                        type="checkbox"
                        checked={checked.has(i)}
                        onChange={() => toggle(i)}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{c.name}</div>
                        <div className="truncate text-xs text-muted-foreground">{c.path}</div>
                        <div className="text-xs text-muted-foreground">
                          {c.scripts.length} scripts
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </ScrollArea>
            {err && <p className="text-sm text-red-600">{err}</p>}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          {candidates && (
            <Button onClick={importSelected} disabled={busy || checked.size === 0}>
              {busy ? 'Importing…' : `Import ${checked.size}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
