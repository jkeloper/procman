// First-run onboarding — 3 steps:
//   1. Pick a project folder (reuses NewProjectDialog flow)
//   2. Auto-scan + select scripts (reuses ScanDialog flow)
//   3. Start your first script
//
// Flips `settings.onboarded = true` on completion or skip so it never
// reappears unless the user hits "Show onboarding again" in Settings.

import { useCallback, useEffect, useState } from 'react';
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
import { ScrollArea } from '@/components/ui/scroll-area';
import { api, type Project, type ProjectCandidate } from '@/api/tauri';

interface Props {
  open: boolean;
  onFinish: () => void; // called after commit OR skip
}

type Step = 1 | 2 | 3;

export function OnboardingOverlay({ open: isOpen, onFinish }: Props) {
  const [step, setStep] = useState<Step>(1);

  // Step 1 — project
  const [projectName, setProjectName] = useState('');
  const [projectPath, setProjectPath] = useState('');
  const [createdProject, setCreatedProject] = useState<Project | null>(null);

  // Step 2 — scan/scripts
  const [candidates, setCandidates] = useState<ProjectCandidate[] | null>(null);
  const [checked, setChecked] = useState<Set<number>>(new Set());

  // Step 3 — pick a script to start
  const [selectedScriptId, setSelectedScriptId] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Reset everything whenever the overlay is re-opened so "Show again"
  // from Settings gives a clean slate.
  useEffect(() => {
    if (isOpen) {
      setStep(1);
      setProjectName('');
      setProjectPath('');
      setCreatedProject(null);
      setCandidates(null);
      setChecked(new Set());
      setSelectedScriptId(null);
      setErr(null);
      setBusy(false);
    }
  }, [isOpen]);

  async function pickFolder() {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === 'string') {
      setProjectPath(selected);
      if (!projectName.trim()) {
        const seg = selected.split('/').filter(Boolean).pop();
        if (seg) setProjectName(seg);
      }
    }
  }

  const commitProject = useCallback(async () => {
    setErr(null);
    setBusy(true);
    try {
      const proj = await api.createProject(projectName, projectPath);
      setCreatedProject(proj);
      // Kick off a scan of the same folder so Step 2 has something to show.
      try {
        const found = await api.scanDirectory(projectPath);
        setCandidates(found);
        setChecked(new Set(found.map((_, i) => i)));
      } catch {
        setCandidates([]);
      }
      setStep(2);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }, [projectName, projectPath]);

  async function commitScripts() {
    if (!createdProject) {
      setStep(3);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      if (candidates && checked.size > 0) {
        // Merge scripts from all checked candidates into the project the
        // user already created. Skip duplicates silently (same as ScanDialog).
        for (const i of checked) {
          const c = candidates[i];
          for (const s of c.scripts) {
            try {
              await api.createScript(
                createdProject.id,
                s.name,
                s.command,
                s.expected_port,
                s.auto_restart,
              );
            } catch (e: any) {
              const msg = String(e?.message ?? e);
              if (msg.includes('already exists')) continue;
              // Surface other errors but keep going.
              setErr(`${s.name}: ${msg}`);
            }
          }
        }
      }
      // Refresh so Step 3 can list the fresh scripts.
      const scripts = await api.listScripts(createdProject.id);
      if (scripts.length > 0) setSelectedScriptId(scripts[0].id);
      setStep(3);
    } finally {
      setBusy(false);
    }
  }

  async function startFirstScript() {
    if (!createdProject || !selectedScriptId) {
      finish();
      return;
    }
    setBusy(true);
    try {
      await api.spawnProcess(createdProject.id, selectedScriptId);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy(false);
      finish();
    }
  }

  function finish() {
    onFinish();
  }

  return (
    <Dialog open={isOpen} onOpenChange={(v) => !v && finish()}>
      <DialogContent className="max-w-lg" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Welcome to procman</DialogTitle>
          <DialogDescription>
            Let's get your first project running in three steps.
          </DialogDescription>
          <StepIndicator step={step} />
        </DialogHeader>

        {step === 1 && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Step 1 — pick the folder where your scripts live.
            </p>
            <div className="space-y-1">
              <Label htmlFor="ob-name">Project name</Label>
              <Input
                id="ob-name"
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                placeholder="e.g. procman"
                disabled={busy}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ob-path">Project path</Label>
              <div className="flex gap-2">
                <Input
                  id="ob-path"
                  value={projectPath}
                  onChange={(e) => setProjectPath(e.target.value)}
                  placeholder="/Users/.../my-app"
                  disabled={busy}
                />
                <Button type="button" variant="outline" onClick={pickFolder} disabled={busy}>
                  Browse…
                </Button>
              </div>
            </div>
            {err && <p className="text-sm text-red-600">{err}</p>}
          </div>
        )}

        {step === 2 && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Step 2 — we scanned{' '}
              <code className="font-mono text-[12px]">{createdProject?.path}</code>{' '}
              for package.json files. Pick the scripts to import.
            </p>
            {candidates === null ? (
              <p className="text-sm text-muted-foreground">Scanning…</p>
            ) : candidates.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No package.json found. You can add scripts manually after onboarding.
              </p>
            ) : (
              <ScrollArea className="h-56 rounded border">
                <ul className="divide-y">
                  {candidates.map((c, i) => (
                    <li key={i} className="flex items-center gap-3 p-2 text-sm">
                      <input
                        type="checkbox"
                        checked={checked.has(i)}
                        onChange={() => {
                          const next = new Set(checked);
                          if (next.has(i)) next.delete(i);
                          else next.add(i);
                          setChecked(next);
                        }}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{c.name}</div>
                        <div className="truncate text-xs text-muted-foreground">
                          {c.path}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {c.stacks.join(', ')} · {c.scripts.length} scripts
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </ScrollArea>
            )}
            {err && <p className="text-sm text-red-600">{err}</p>}
          </div>
        )}

        {step === 3 && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Step 3 — start your first script. You can stop/restart it any time
              from the dashboard.
            </p>
            {createdProject && createdProject.scripts.length > 0 ? (
              <div className="space-y-2">
                <Label>Script</Label>
                <select
                  value={selectedScriptId ?? ''}
                  onChange={(e) => setSelectedScriptId(e.target.value || null)}
                  disabled={busy}
                  className="w-full rounded-md border border-border/60 bg-muted/30 px-2 py-1.5 text-sm"
                >
                  {createdProject.scripts.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} — {s.command}
                    </option>
                  ))}
                </select>
                <p className="rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-[13px] text-foreground">
                  <span className="font-semibold">Tip:</span> press{' '}
                  <kbd className="rounded border border-border/60 bg-muted px-1.5 py-0.5 text-[11px]">
                    ⌘K
                  </kbd>{' '}
                  any time to open the command palette.
                </p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No scripts imported. You can add them manually from the project page
                later — hit "Finish" to close onboarding.
              </p>
            )}
            {err && <p className="text-sm text-red-600">{err}</p>}
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={finish} disabled={busy}>
            Skip
          </Button>
          {step === 1 && (
            <Button
              onClick={commitProject}
              disabled={busy || !projectName.trim() || !projectPath.trim()}
            >
              {busy ? 'Creating…' : 'Next'}
            </Button>
          )}
          {step === 2 && (
            <Button onClick={commitScripts} disabled={busy}>
              {busy ? 'Importing…' : candidates && candidates.length > 0 ? `Import ${checked.size}` : 'Next'}
            </Button>
          )}
          {step === 3 && (
            <Button
              onClick={startFirstScript}
              disabled={busy}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {busy
                ? 'Starting…'
                : selectedScriptId
                ? 'Start & finish'
                : 'Finish'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StepIndicator({ step }: { step: Step }) {
  return (
    <div className="flex items-center gap-2 pt-1">
      {[1, 2, 3].map((n) => (
        <div key={n} className="flex items-center gap-2">
          <div
            className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-semibold ${
              n === step
                ? 'bg-primary text-primary-foreground'
                : n < step
                ? 'bg-primary/30 text-primary'
                : 'bg-muted text-muted-foreground'
            }`}
          >
            {n}
          </div>
          {n < 3 && (
            <div
              className={`h-px w-8 ${n < step ? 'bg-primary/40' : 'bg-border'}`}
            />
          )}
        </div>
      ))}
    </div>
  );
}
