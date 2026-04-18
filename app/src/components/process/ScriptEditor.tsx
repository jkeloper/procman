import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { api, type Script, type PortSpec, type AutoRestartPolicy } from '@/api/tauri';
import { useConfirm } from '@/components/ConfirmDialog';

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  projectId: string;
  existing: Script | null;
  onSaved: () => void;
}

interface Template {
  label: string;
  category: string;
  name: string;
  command: string;
  port: string;
}

const TEMPLATES: Template[] = [
  // Node.js
  { category: 'Node.js', label: 'Dev server (pnpm)', name: 'dev', command: 'pnpm dev', port: '5173' },
  { category: 'Node.js', label: 'Dev server (npm)', name: 'dev', command: 'npm run dev', port: '3000' },
  { category: 'Node.js', label: 'Build (pnpm)', name: 'build', command: 'pnpm build', port: '' },
  { category: 'Node.js', label: 'Build (npm)', name: 'build', command: 'npm run build', port: '' },
  { category: 'Node.js', label: 'Start (production)', name: 'start', command: 'npm start', port: '3000' },
  { category: 'Node.js', label: 'Test (vitest)', name: 'test', command: 'pnpm vitest', port: '' },
  { category: 'Node.js', label: 'Next.js dev', name: 'next-dev', command: 'npx next dev', port: '3000' },
  { category: 'Node.js', label: 'Vite preview', name: 'preview', command: 'pnpm preview', port: '4173' },
  // Python
  { category: 'Python', label: 'Django runserver', name: 'django', command: 'python manage.py runserver', port: '8000' },
  { category: 'Python', label: 'FastAPI (uvicorn)', name: 'fastapi', command: 'uvicorn main:app --reload', port: '8000' },
  { category: 'Python', label: 'Streamlit', name: 'streamlit', command: 'streamlit run app.py', port: '8501' },
  { category: 'Python', label: 'Flask', name: 'flask', command: 'flask run', port: '5000' },
  { category: 'Python', label: 'Pytest', name: 'test', command: 'pytest -v', port: '' },
  // Rust
  { category: 'Rust', label: 'Cargo run', name: 'run', command: 'cargo run', port: '' },
  { category: 'Rust', label: 'Cargo test', name: 'test', command: 'cargo test', port: '' },
  { category: 'Rust', label: 'Cargo watch', name: 'watch', command: 'cargo watch -x run', port: '' },
  // Go
  { category: 'Go', label: 'Go run', name: 'run', command: 'go run .', port: '' },
  { category: 'Go', label: 'Go test', name: 'test', command: 'go test ./...', port: '' },
  { category: 'Go', label: 'Air (hot reload)', name: 'air', command: 'air', port: '8080' },
  // Docker
  { category: 'Docker', label: 'Docker Compose up', name: 'compose-up', command: 'docker compose up', port: '' },
  { category: 'Docker', label: 'Docker Compose down', name: 'compose-down', command: 'docker compose down', port: '' },
  { category: 'Docker', label: 'Docker Compose build', name: 'compose-build', command: 'docker compose build', port: '' },
  // Shell
  { category: 'Shell', label: 'Custom shell script', name: 'script', command: './run.sh', port: '' },
  { category: 'Shell', label: 'Watch files (fswatch)', name: 'watch', command: 'fswatch -o src/ | xargs -n1 -I{} make build', port: '' },
];

const CATEGORIES = [...new Set(TEMPLATES.map((t) => t.category))];

export function ScriptEditor({ open, onOpenChange, projectId, existing, onSaved }: Props) {
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [expectedPort, setExpectedPort] = useState('');
  const [ports, setPorts] = useState<PortSpec[]>([]);
  const [autoRestart, setAutoRestart] = useState(false);
  const [autoRestartPolicy, setAutoRestartPolicy] = useState<AutoRestartPolicy | null>(null);
  const [envFile, setEnvFile] = useState('');
  const [dependsOn, setDependsOn] = useState<string[]>([]);
  const [siblings, setSiblings] = useState<Script[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const confirm = useConfirm();

  useEffect(() => {
    if (open) {
      setName(existing?.name ?? '');
      setCommand(existing?.command ?? '');
      setExpectedPort(existing?.expected_port?.toString() ?? '');
      setPorts(existing?.ports ?? []);
      setAutoRestart(existing?.auto_restart ?? false);
      setAutoRestartPolicy(existing?.auto_restart_policy ?? null);
      setEnvFile(existing?.env_file ?? '');
      setDependsOn(existing?.depends_on ?? []);
      setErr(null);
      // Load sibling scripts for depends_on picker.
      api
        .listScripts(projectId)
        .then((list) => setSiblings(list.filter((s) => s.id !== existing?.id)))
        .catch(() => setSiblings([]));
    }
  }, [open, existing, projectId]);

  function addPort() {
    const nextNumber = ports.length === 0
      ? parseInt(expectedPort, 10) || 3000
      : (ports[ports.length - 1].number || 3000) + 1;
    setPorts([
      ...ports,
      {
        name: ports.length === 0 ? 'default' : `port${ports.length + 1}`,
        number: nextNumber,
        bind: '127.0.0.1',
        proto: 'tcp',
        optional: false,
        note: null,
      },
    ]);
  }
  function updatePort(idx: number, patch: Partial<PortSpec>) {
    setPorts(ports.map((p, i) => (i === idx ? { ...p, ...patch } : p)));
  }
  function removePort(idx: number) {
    setPorts(ports.filter((_, i) => i !== idx));
  }

  async function applyTemplate(t: Template) {
    const hasContent = name.trim() || command.trim();
    if (hasContent) {
      const ok = await confirm({ title: 'Apply template', description: 'Current content will be replaced with the template.', confirmLabel: 'Replace', destructive: false }); if (!ok) {
        return;
      }
    }
    setName(t.name);
    setCommand(t.command);
    setExpectedPort(t.port);
  }

  async function submit() {
    setErr(null);
    setBusy(true);
    const portNum = expectedPort.trim() === '' ? null : parseInt(expectedPort, 10);
    if (portNum != null && (isNaN(portNum) || portNum < 1 || portNum > 65535)) {
      setErr('Port must be 1–65535');
      setBusy(false);
      return;
    }
    // Validate declared ports
    const trimmedPorts: PortSpec[] = [];
    const seenNames = new Set<string>();
    for (const [i, p] of ports.entries()) {
      const nm = p.name.trim();
      if (!nm) { setErr(`Port row ${i + 1}: name required`); setBusy(false); return; }
      if (seenNames.has(nm)) { setErr(`Port name '${nm}' duplicated`); setBusy(false); return; }
      seenNames.add(nm);
      if (!Number.isInteger(p.number) || p.number < 1 || p.number > 65535) {
        setErr(`Port row ${i + 1}: number must be 1–65535`); setBusy(false); return;
      }
      trimmedPorts.push({ ...p, name: nm });
    }
    const envVal = envFile.trim() || null;
    try {
      if (existing) {
        await api.updateScript(projectId, existing.id, {
          name,
          command,
          expectedPort: portNum,
          autoRestart,
          autoRestartPolicy,
          envFile: envVal,
          ports: trimmedPorts,
          dependsOn,
        });
      } else {
        const created = await api.createScript(
          projectId,
          name,
          command,
          portNum,
          autoRestart,
          envVal,
          trimmedPorts,
          dependsOn,
        );
        // Backend create_script does not yet accept the structured
        // policy — patch it in immediately so creation + advanced
        // policy stay a single user action.
        if (autoRestartPolicy) {
          await api.updateScript(projectId, created.id, {
            autoRestartPolicy,
          });
        }
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
      <DialogContent className="max-w-4xl" style={{ height: '75vh', maxHeight: '75vh', display: 'flex', flexDirection: 'column' }}>
        {/* Template selector — only for new scripts */}
        {!existing && (
          <div className="mt-4 flex items-center gap-2 border-b border-border/60 pb-3">
            <span className="shrink-0 text-[13px] font-medium text-muted-foreground">Template</span>
            <select
              value=""
              onChange={(e) => {
                const idx = parseInt(e.target.value, 10);
                if (!isNaN(idx) && TEMPLATES[idx]) {
                  applyTemplate(TEMPLATES[idx]);
                }
              }}
              className="flex-1 rounded-md border border-border/60 bg-muted/30 px-2 py-1.5 text-[14px] text-foreground focus:border-primary/50 focus:outline-none"
            >
              <option value="" disabled>Select a template...</option>
              {CATEGORIES.map((cat) => (
                <optgroup key={cat} label={cat}>
                  {TEMPLATES.map((t, i) =>
                    t.category === cat ? (
                      <option key={i} value={i}>
                        {t.label}
                      </option>
                    ) : null,
                  )}
                </optgroup>
              ))}
            </select>
          </div>
        )}

        {/* Header — name + port inline */}
        <div className={`flex items-center gap-3 border-b border-border/60 pb-3 ${existing ? 'mt-4' : ''}`}>
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
            <span className="text-[13px] text-muted-foreground">:</span>
            <Input
              value={expectedPort}
              onChange={(e) => setExpectedPort(e.target.value)}
              placeholder="port"
              disabled={busy}
              className="w-[70px] border-border/60 bg-muted/30 px-2 py-1 text-center font-mono text-[14px]"
            />
            <label className="flex items-center gap-1.5 text-[13px] text-muted-foreground cursor-pointer select-none">
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

        {/* S1: Declared ports (v2) */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-medium text-muted-foreground">
              Declared ports
              {ports.length > 0 && (
                <span className="ml-1.5 text-muted-foreground/60">({ports.length})</span>
              )}
            </span>
            <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-[12px]" onClick={addPort} disabled={busy}>
              + Add port
            </Button>
          </div>
          {ports.length === 0 ? (
            <div className="rounded-md border border-dashed border-border/50 px-3 py-2 text-[12px] text-muted-foreground/70">
              No declared ports. Falling back to the <code className="font-mono">expected_port</code> field above.
            </div>
          ) : (
            <ul className="flex flex-col gap-1">
              {ports.map((p, i) => (
                <li key={i} className="flex items-center gap-1.5 rounded-md border border-border/50 bg-muted/20 px-2 py-1.5">
                  <Input
                    value={p.name}
                    onChange={(e) => updatePort(i, { name: e.target.value })}
                    placeholder="name"
                    disabled={busy}
                    className="w-[110px] border-0 bg-transparent px-1 font-mono text-[13px]"
                  />
                  <Input
                    value={p.number.toString()}
                    onChange={(e) => updatePort(i, { number: parseInt(e.target.value, 10) || 0 })}
                    placeholder="port"
                    disabled={busy}
                    className="w-[75px] border-0 bg-transparent px-1 text-center font-mono text-[13px]"
                  />
                  <select
                    value={p.bind}
                    onChange={(e) => updatePort(i, { bind: e.target.value })}
                    disabled={busy}
                    className="rounded border border-border/50 bg-background px-1.5 py-0.5 font-mono text-[12px]"
                  >
                    <option value="127.0.0.1">127.0.0.1</option>
                    <option value="0.0.0.0">0.0.0.0</option>
                    <option value="::1">::1</option>
                  </select>
                  <label className="flex items-center gap-1 text-[12px] text-muted-foreground cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={p.optional}
                      onChange={(e) => updatePort(i, { optional: e.target.checked })}
                      disabled={busy}
                      className="accent-primary"
                    />
                    optional
                  </label>
                  <Input
                    value={p.note ?? ''}
                    onChange={(e) => updatePort(i, { note: e.target.value || null })}
                    placeholder="note"
                    disabled={busy}
                    className="flex-1 border-0 bg-transparent px-1 text-[12px]"
                  />
                  <button
                    type="button"
                    onClick={() => removePort(i)}
                    disabled={busy}
                    className="shrink-0 rounded p-1 text-muted-foreground/60 hover:bg-destructive/10 hover:text-destructive"
                    aria-label="Remove port"
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* M5: Env file path */}
        <div className="flex items-center gap-2">
          <span className="shrink-0 text-[13px] font-medium text-muted-foreground">.env file</span>
          <Input
            value={envFile}
            onChange={(e) => setEnvFile(e.target.value)}
            placeholder=".env or /absolute/path/.env.local"
            disabled={busy}
            className="flex-1 border-border/60 bg-muted/30 px-2 py-1 font-mono text-[13px]"
          />
        </div>

        {/* S6-05: Structured auto-restart policy */}
        <div className="flex flex-col gap-1.5">
          <label className="flex items-center gap-2 text-[13px] font-medium text-muted-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              checked={autoRestartPolicy != null}
              onChange={(e) =>
                setAutoRestartPolicy(
                  e.target.checked
                    ? { enabled: true, max_retries: 5, backoff_ms: 1000, jitter_ms: 500 }
                    : null,
                )
              }
              disabled={busy}
              className="accent-primary"
            />
            Advanced auto-restart policy
            <span className="text-[11px] text-muted-foreground/70">
              (overrides the simple toggle)
            </span>
          </label>
          {autoRestartPolicy && (
            <div className="flex flex-col gap-2 rounded-md border border-border/50 bg-muted/20 px-3 py-2">
              <label className="flex items-center gap-2 text-[12px]">
                <input
                  type="checkbox"
                  checked={autoRestartPolicy.enabled}
                  onChange={(e) =>
                    setAutoRestartPolicy({ ...autoRestartPolicy, enabled: e.target.checked })
                  }
                  disabled={busy}
                  className="accent-primary"
                />
                Enabled
              </label>
              <div className="grid grid-cols-3 gap-2">
                <div className="flex flex-col gap-1">
                  <span className="text-[11px] text-muted-foreground">Max retries</span>
                  <Input
                    type="number"
                    min={0}
                    value={autoRestartPolicy.max_retries}
                    onChange={(e) =>
                      setAutoRestartPolicy({
                        ...autoRestartPolicy,
                        max_retries: Math.max(0, parseInt(e.target.value, 10) || 0),
                      })
                    }
                    disabled={busy}
                    className="h-7 font-mono text-[12px]"
                  />
                  <span className="text-[10px] text-muted-foreground/70">0 = unlimited</span>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-[11px] text-muted-foreground">Backoff (ms)</span>
                  <Input
                    type="number"
                    min={0}
                    value={autoRestartPolicy.backoff_ms}
                    onChange={(e) =>
                      setAutoRestartPolicy({
                        ...autoRestartPolicy,
                        backoff_ms: Math.max(0, parseInt(e.target.value, 10) || 0),
                      })
                    }
                    disabled={busy}
                    className="h-7 font-mono text-[12px]"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-[11px] text-muted-foreground">Jitter (ms)</span>
                  <Input
                    type="number"
                    min={0}
                    value={autoRestartPolicy.jitter_ms}
                    onChange={(e) =>
                      setAutoRestartPolicy({
                        ...autoRestartPolicy,
                        jitter_ms: Math.max(0, parseInt(e.target.value, 10) || 0),
                      })
                    }
                    disabled={busy}
                    className="h-7 font-mono text-[12px]"
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* S4: Depends-on picker */}
        {siblings.length > 0 && (
          <div className="flex flex-col gap-1">
            <span className="text-[13px] font-medium text-muted-foreground">
              Depends on
              {dependsOn.length > 0 && (
                <span className="ml-1.5 text-muted-foreground/60">({dependsOn.length})</span>
              )}
            </span>
            <div className="flex flex-wrap gap-1.5 rounded-md border border-border/50 bg-muted/20 px-2 py-1.5">
              {siblings.map((sib) => {
                const picked = dependsOn.includes(sib.id);
                return (
                  <button
                    type="button"
                    key={sib.id}
                    disabled={busy}
                    onClick={() =>
                      setDependsOn(
                        picked
                          ? dependsOn.filter((id) => id !== sib.id)
                          : [...dependsOn, sib.id],
                      )
                    }
                    className={`rounded border px-2 py-0.5 font-mono text-[12px] transition-colors ${
                      picked
                        ? 'border-primary bg-primary/15 text-primary'
                        : 'border-border/50 text-muted-foreground hover:border-primary/40 hover:text-foreground'
                    }`}
                    title={
                      picked
                        ? 'Click to remove dependency'
                        : 'Click to require this script to be running first'
                    }
                  >
                    {picked ? '✓ ' : ''}{sib.name}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Command — large editor-like textarea */}
        <div className="flex flex-1 flex-col min-h-0">
          <div className="mb-1.5 text-[13px] font-medium text-muted-foreground">
            Command
          </div>
          <textarea
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder="pnpm dev&#10;# or multi-line script..."
            disabled={busy}
            style={{ flex: 1, minHeight: 200 }}
            className="w-full resize-none rounded-lg border border-border/60 bg-log-bg p-4 font-mono text-[14px] leading-relaxed text-foreground placeholder:text-muted-foreground/30 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
            spellCheck={false}
          />
        </div>

        {err && <p className="text-[13px] text-red-500">{err}</p>}

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
