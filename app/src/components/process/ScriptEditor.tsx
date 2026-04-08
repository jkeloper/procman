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

  function applyTemplate(t: Template) {
    const hasContent = name.trim() || command.trim();
    if (hasContent) {
      if (!window.confirm('현재 편집 중인 내용을 템플릿으로 대체하시겠습니까?\n\n입력한 내용이 사라집니다.')) {
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
      <DialogContent className="max-w-4xl" style={{ height: '75vh', maxHeight: '75vh', display: 'flex', flexDirection: 'column' }}>
        {/* Template selector — only for new scripts */}
        {!existing && (
          <div className="mt-4 flex items-center gap-2 border-b border-border/60 pb-3">
            <span className="shrink-0 text-[12px] font-medium text-muted-foreground">Template</span>
            <select
              value=""
              onChange={(e) => {
                const idx = parseInt(e.target.value, 10);
                if (!isNaN(idx) && TEMPLATES[idx]) {
                  applyTemplate(TEMPLATES[idx]);
                }
              }}
              className="flex-1 rounded-md border border-border/60 bg-muted/30 px-2 py-1.5 text-[13px] text-foreground focus:border-primary/50 focus:outline-none"
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
        <div className="flex flex-1 flex-col min-h-0">
          <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">
            Command
          </div>
          <textarea
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder="pnpm dev&#10;# or multi-line script..."
            disabled={busy}
            style={{ flex: 1, minHeight: 200 }}
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
