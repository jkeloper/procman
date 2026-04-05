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

type ExpandMode = 'parsed' | 'raw';

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
  const [expanded, setExpanded] = useState<Map<number, ExpandMode>>(new Map());
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      setCandidates(null);
      setChecked(new Set());
      setExpanded(new Map());
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

  function toggleExpand(i: number, mode: ExpandMode) {
    const next = new Map(expanded);
    if (next.get(i) === mode) next.delete(i);
    else next.set(i, mode);
    setExpanded(next);
  }

  async function importSelected() {
    if (!candidates) return;
    setBusy(true);
    setErr(null);
    const errors: string[] = [];
    try {
      for (const i of checked) {
        const c = candidates[i];
        if (!c.script) continue;
        try {
          await api.createScript(
            projectId,
            c.script.name,
            c.script.command,
            c.script.expected_port,
            c.script.auto_restart,
          );
        } catch (e: any) {
          errors.push(`${c.name}: ${e?.message ?? e}`);
        }
      }
      onImported();
      if (errors.length > 0) {
        setErr(`Imported with ${errors.length} error(s):\n${errors.join('\n')}`);
      } else {
        onOpenChange(false);
      }
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
          <DialogDescription className="truncate font-mono text-[11px]">
            {projectPath}/.vscode/launch.json
          </DialogDescription>
        </DialogHeader>

        {busy && !candidates ? (
          <p className="text-[12px] text-muted-foreground">Scanning…</p>
        ) : err ? (
          <p className="whitespace-pre-wrap text-[12px] text-red-500">{err}</p>
        ) : !candidates || candidates.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">
            No launch.json configurations found.
          </p>
        ) : (
          <ScrollArea className="h-[420px] rounded-md border border-border/60">
            <ul className="divide-y divide-border/40">
              {candidates.map((c, i) => {
                const isImportable = !c.skipped_reason;
                const dup = isImportable && isDuplicate(c);
                const disabled = !isImportable || dup;
                const exp = expanded.get(i);
                return (
                  <li key={i} className="text-[12px]">
                    <div className="flex items-start gap-2.5 px-3 py-2.5">
                      <input
                        type="checkbox"
                        className="mt-1 h-3.5 w-3.5 shrink-0 accent-primary"
                        checked={checked.has(i)}
                        disabled={disabled}
                        onChange={() => toggle(i)}
                      />
                      <div className="min-w-0 flex-1">
                        {/* Name row — clickable to expand */}
                        <button
                          className="flex w-full items-center gap-1.5 text-left"
                          onClick={() => toggleExpand(i, 'parsed')}
                        >
                          <span
                            className={`shrink-0 text-muted-foreground/60 transition-transform ${
                              exp ? 'rotate-90' : ''
                            }`}
                          >
                            ›
                          </span>
                          <span className="min-w-0 truncate text-[13px] font-medium text-foreground">
                            {c.name}
                          </span>
                          <Badge variant="secondary" className="shrink-0 text-[10px]">
                            {c.kind}
                          </Badge>
                          {!isImportable && (
                            <Badge variant="destructive" className="shrink-0 text-[10px]">
                              skipped
                            </Badge>
                          )}
                          {dup && (
                            <Badge variant="outline" className="shrink-0 text-[10px]">
                              already imported
                            </Badge>
                          )}
                        </button>

                        {/* Collapsed summary */}
                        {!exp && isImportable && (
                          <div className="mt-0.5 ml-3.5 truncate font-mono text-[11px] text-muted-foreground">
                            $ {c.command}
                          </div>
                        )}
                        {!exp && !isImportable && (
                          <div className="mt-0.5 ml-3.5 text-[11px] text-muted-foreground">
                            {c.skipped_reason}
                          </div>
                        )}

                        {/* Expanded detail */}
                        {exp && (
                          <div className="mt-2 ml-3.5 space-y-2">
                            <div className="flex gap-1 text-[10px]">
                              <button
                                className={`rounded px-2 py-0.5 font-medium transition-colors ${
                                  exp === 'parsed'
                                    ? 'bg-primary text-primary-foreground'
                                    : 'bg-muted/50 text-muted-foreground hover:bg-muted'
                                }`}
                                onClick={() => toggleExpand(i, 'parsed')}
                              >
                                parsed
                              </button>
                              <button
                                className={`rounded px-2 py-0.5 font-medium transition-colors ${
                                  exp === 'raw'
                                    ? 'bg-primary text-primary-foreground'
                                    : 'bg-muted/50 text-muted-foreground hover:bg-muted'
                                }`}
                                onClick={() => toggleExpand(i, 'raw')}
                              >
                                원문 보기
                              </button>
                            </div>
                            {exp === 'parsed' ? (
                              <div className="space-y-1 rounded border border-border/60 bg-muted/20 p-2 font-mono text-[11px]">
                                {isImportable ? (
                                  <>
                                    <div>
                                      <span className="text-muted-foreground">$ </span>
                                      <span className="break-all">{c.command}</span>
                                    </div>
                                    {c.cwd && (
                                      <div>
                                        <span className="text-muted-foreground">cwd: </span>
                                        <span className="break-all">{c.cwd}</span>
                                      </div>
                                    )}
                                  </>
                                ) : (
                                  <div className="text-muted-foreground">
                                    Skipped: {c.skipped_reason}
                                  </div>
                                )}
                              </div>
                            ) : (
                              <pre className="overflow-x-auto rounded border border-border/60 bg-[#0a0a0a] p-2 font-mono text-[10px] leading-snug text-zinc-200">
                                {c.raw_json}
                              </pre>
                            )}
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
