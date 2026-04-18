// Worker J: Docker Compose stacks card.
//
// Pattern mirrors CloudflareTunnelsCard — polls `compose_installed` + list,
// shows an install banner when docker is missing, and surfaces Up/Down/PS
// buttons per registered stack. PS output collapses into an inline service
// table rather than a modal to stay consistent with the rest of the network tab.
//
// Scope scan integration is intentionally NOT wired here. scan.rs already
// detects docker-compose.yml and surfaces it as a stack hint under project
// candidates; a one-click "import as compose project" button would require
// touching scan.rs / project flow which is out of this Worker's file scope.
// TODO(worker-J+): wire auto-import once the scan UI supports per-candidate
// side actions.

import { useCallback, useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import {
  api,
  type ComposeProject,
  type ComposeService,
} from '@/api/tauri';
import { useConfirm } from '@/components/ConfirmDialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

type BusyKey =
  | null
  | { kind: 'add' }
  | { kind: 'remove'; id: string }
  | { kind: 'up'; id: string }
  | { kind: 'down'; id: string }
  | { kind: 'ps'; id: string };

export function DockerComposeCard() {
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [projects, setProjects] = useState<ComposeProject[]>([]);
  const [expanded, setExpanded] = useState<Record<string, ComposeService[]>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<BusyKey>(null);
  const [addOpen, setAddOpen] = useState(false);
  const confirm = useConfirm();

  const reload = useCallback(async () => {
    try {
      const inst = await api.composeInstalled().catch(() => false);
      setInstalled(inst);
      if (!inst) {
        setProjects([]);
        return;
      }
      const list = await api.composeProjectsList().catch(() => []);
      setProjects(list);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
    const id = setInterval(reload, 5000);
    return () => clearInterval(id);
  }, [reload]);

  async function handleUp(cp: ComposeProject) {
    setBusy({ kind: 'up', id: cp.id });
    try {
      await api.composeUp(cp.id);
      await refreshPs(cp.id);
    } catch (e: any) {
      await confirm({
        title: `Up failed: ${cp.name}`,
        description: e?.message ?? String(e),
        confirmLabel: 'OK',
        destructive: true,
      });
    } finally {
      setBusy(null);
    }
  }

  async function handleDown(cp: ComposeProject) {
    const ok = await confirm({
      title: `Stop ${cp.name}?`,
      description: 'This runs `docker compose down` and stops every service in this stack.',
      confirmLabel: 'Down',
      destructive: true,
    });
    if (!ok) return;
    setBusy({ kind: 'down', id: cp.id });
    try {
      await api.composeDown(cp.id);
      await refreshPs(cp.id);
    } catch (e: any) {
      await confirm({
        title: `Down failed: ${cp.name}`,
        description: e?.message ?? String(e),
        confirmLabel: 'OK',
        destructive: true,
      });
    } finally {
      setBusy(null);
    }
  }

  async function refreshPs(id: string) {
    setBusy({ kind: 'ps', id });
    try {
      const svcs = await api.composePs(id).catch(() => []);
      setExpanded((prev) => ({ ...prev, [id]: svcs }));
    } finally {
      setBusy(null);
    }
  }

  async function handlePsToggle(cp: ComposeProject) {
    if (expanded[cp.id]) {
      setExpanded((prev) => {
        const next = { ...prev };
        delete next[cp.id];
        return next;
      });
      return;
    }
    await refreshPs(cp.id);
  }

  async function handleRemove(cp: ComposeProject) {
    const ok = await confirm({
      title: `Unregister ${cp.name}?`,
      description:
        'The compose file stays on disk; this only removes it from procman. Running containers are not stopped.',
      confirmLabel: 'Remove',
      destructive: true,
    });
    if (!ok) return;
    setBusy({ kind: 'remove', id: cp.id });
    try {
      await api.composeRemoveProject(cp.id);
      await reload();
    } finally {
      setBusy(null);
    }
  }

  if (loading) return null;

  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between">
        <div className="flex items-baseline gap-2">
          <h2 className="text-[13px] font-semibold">Docker Compose</h2>
          <span className="font-mono text-[11px] text-muted-foreground">
            {projects.length} stack{projects.length === 1 ? '' : 's'}
          </span>
        </div>
        {installed && (
          <Button size="sm" onClick={() => setAddOpen(true)}>
            Add stack
          </Button>
        )}
      </div>

      {!installed ? (
        <div className="rounded-lg border border-dashed border-border/60 bg-card/50 p-3 text-[11px] text-muted-foreground">
          <span className="mr-1">🐳</span>
          Docker not installed.{' '}
          <a
            href="https://docs.docker.com/desktop/install/mac-install/"
            target="_blank"
            rel="noreferrer"
            className="text-primary underline-offset-2 hover:underline"
          >
            Install Docker Desktop
          </a>{' '}
          or run{' '}
          <code className="rounded bg-muted/50 px-1 py-0.5">
            brew install --cask docker
          </code>
          .
        </div>
      ) : projects.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/60 bg-card/50 p-3 text-center text-[11px] text-muted-foreground">
          No compose stacks registered. Click{' '}
          <span className="font-medium">Add stack</span> to point at a
          docker-compose.yml.
        </div>
      ) : (
        <div className="space-y-2">
          {projects.map((cp) => {
            const services = expanded[cp.id];
            const isUp = busy?.kind === 'up' && busy.id === cp.id;
            const isDown = busy?.kind === 'down' && busy.id === cp.id;
            const isPs = busy?.kind === 'ps' && busy.id === cp.id;
            const isRem = busy?.kind === 'remove' && busy.id === cp.id;
            return (
              <div
                key={cp.id}
                className="overflow-hidden rounded-lg border border-border/60 bg-card"
              >
                <div className="flex items-center gap-2 border-b border-border/40 bg-muted/20 px-3 py-2 text-[12px]">
                  <span className="font-medium">{cp.name}</span>
                  <span
                    className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground"
                    title={cp.compose_path}
                  >
                    {cp.compose_path}
                  </span>
                  {cp.project_name && (
                    <span className="rounded bg-muted/50 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                      -p {cp.project_name}
                    </span>
                  )}
                  <Button
                    size="sm"
                    disabled={isUp || isDown}
                    onClick={() => handleUp(cp)}
                  >
                    {isUp ? 'Up...' : 'Up'}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={isUp || isDown}
                    onClick={() => handleDown(cp)}
                  >
                    {isDown ? 'Down...' : 'Down'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={isPs}
                    onClick={() => handlePsToggle(cp)}
                  >
                    {isPs ? '...' : services ? 'Hide' : 'PS'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={isRem}
                    onClick={() => handleRemove(cp)}
                    title="Unregister (file stays on disk)"
                  >
                    {isRem ? '...' : '✕'}
                  </Button>
                </div>
                {services && (
                  <ServiceList services={services} />
                )}
              </div>
            );
          })}
        </div>
      )}

      <AddComposeDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onAdded={async () => {
          setAddOpen(false);
          await reload();
        }}
      />
    </section>
  );
}

function ServiceList({ services }: { services: ComposeService[] }) {
  if (services.length === 0) {
    return (
      <div className="px-3 py-2 text-center text-[11px] text-muted-foreground">
        No services running. Click <span className="font-medium">Up</span> to start the stack.
      </div>
    );
  }
  return (
    <table className="w-full text-[12px]">
      <thead className="bg-white/5">
        <tr className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          <th className="px-3 py-1.5 text-left">Service</th>
          <th className="px-3 py-1.5 text-left">State</th>
          <th className="px-3 py-1.5 text-left">Image</th>
          <th className="px-3 py-1.5 text-left">Ports</th>
        </tr>
      </thead>
      <tbody>
        {services.map((s) => (
          <tr key={s.service} className="border-t border-border/40">
            <td className="px-3 py-1.5 font-medium">{s.service}</td>
            <td className="px-3 py-1.5">
              <span
                className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold ${
                  s.state === 'running'
                    ? 'bg-emerald-500/15 text-emerald-400'
                    : s.state === 'exited'
                    ? 'bg-muted/60 text-muted-foreground'
                    : 'bg-amber-500/15 text-amber-400'
                }`}
              >
                {s.state}
              </span>
            </td>
            <td className="px-3 py-1.5 font-mono text-[10px] text-muted-foreground">
              {s.image ?? '—'}
            </td>
            <td className="px-3 py-1.5 font-mono text-[10px] text-muted-foreground">
              {s.ports.length > 0 ? s.ports.join(', ') : '—'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AddComposeDialog({
  open: isOpen,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onAdded: () => void;
}) {
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [projectName, setProjectName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      setName('');
      setPath('');
      setProjectName('');
      setErr(null);
      setBusy(false);
    }
  }, [isOpen]);

  async function pick() {
    setErr(null);
    const selected = await open({
      title: 'Select docker-compose.yml',
      multiple: false,
      filters: [
        { name: 'Compose file', extensions: ['yml', 'yaml'] },
      ],
    });
    if (typeof selected !== 'string') return;
    setPath(selected);
    if (!name) {
      // Default name = parent directory name for a sensible starting point.
      const parts = selected.split('/');
      const parent = parts[parts.length - 2];
      if (parent) setName(parent);
    }
  }

  async function submit() {
    if (!name.trim() || !path.trim()) {
      setErr('Name and compose file are required.');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api.composeAddProject(
        name.trim(),
        path.trim(),
        projectName.trim() || null,
      );
      onAdded();
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add compose stack</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2 text-[13px]">
          <div>
            <label className="mb-1 block text-[12px] text-muted-foreground">
              Name
            </label>
            <input
              className="h-8 w-full rounded border border-border/60 bg-muted/30 px-2 text-[13px] focus:border-primary/50 focus:outline-none"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. db-stack"
            />
          </div>
          <div>
            <label className="mb-1 block text-[12px] text-muted-foreground">
              Compose file
            </label>
            <div className="flex gap-2">
              <input
                className="h-8 flex-1 rounded border border-border/60 bg-muted/30 px-2 font-mono text-[12px] focus:border-primary/50 focus:outline-none"
                value={path}
                readOnly
                placeholder="/path/to/docker-compose.yml"
              />
              <Button size="sm" variant="secondary" onClick={pick}>
                Browse…
              </Button>
            </div>
          </div>
          <div>
            <label className="mb-1 block text-[12px] text-muted-foreground">
              Project name <span className="opacity-60">(optional, -p flag)</span>
            </label>
            <input
              className="h-8 w-full rounded border border-border/60 bg-muted/30 px-2 text-[13px] focus:border-primary/50 focus:outline-none"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder="Leave empty to use parent directory"
            />
          </div>
          {err && (
            <div className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[12px] text-destructive">
              {err}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? 'Adding...' : 'Add'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
