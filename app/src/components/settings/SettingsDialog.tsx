// App-wide Settings dialog.
//
// Backed by `useSettings` (debounced updateSettings call). Toggle changes
// commit immediately; slider/input changes are debounced so typing feels
// smooth. `start_at_login` additionally wires through the autostart
// command so the launchd agent stays in sync.

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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, checkForUpdates, installUpdateAndRestart } from '@/api/tauri';
import { useSettings } from '@/hooks/useSettings';

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onShowOnboarding: () => void;
}

export function SettingsDialog({ open, onOpenChange, onShowOnboarding }: Props) {
  const { settings, save, err } = useSettings();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Changes are saved automatically and synced across windows.
          </DialogDescription>
        </DialogHeader>

        {!settings ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="space-y-6">
            {err && (
              <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-700 dark:text-amber-300">
                {err}
              </p>
            )}

            <section className="space-y-3">
              <h3 className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
                General
              </h3>

              {/* Log buffer size */}
              <div className="space-y-1">
                <Label htmlFor="lbs">Log buffer size: {settings.log_buffer_size} lines</Label>
                <input
                  id="lbs"
                  type="range"
                  min={500}
                  max={50000}
                  step={500}
                  value={settings.log_buffer_size}
                  onChange={(e) =>
                    save({ log_buffer_size: parseInt(e.target.value, 10) }, 250)
                  }
                  className="w-full accent-primary"
                />
                <p className="text-[11px] text-muted-foreground">
                  Higher values keep more scrollback per process (memory trade-off).
                </p>
              </div>

              {/* Start at login */}
              <StartAtLoginRow
                enabled={settings.start_at_login}
                onChange={async (v) => {
                  // Best effort — flip the OS registration first, then
                  // persist. If the plugin call fails we still save the
                  // user's intent so the toggle doesn't "snap back".
                  try {
                    await api.setAutostart(v);
                  } catch {}
                  save({ start_at_login: v }, 0);
                }}
              />
            </section>

            <section className="space-y-3">
              <h3 className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
                Remote Access
              </h3>
              <ToggleRow
                label="Allow LAN mode (opt-in)"
                hint="Required before you can start the remote server on a LAN address."
                checked={settings.lan_mode_opt_in}
                onChange={(v) => save({ lan_mode_opt_in: v }, 0)}
              />
              {settings.lan_mode_opt_in && (
                <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-700 dark:text-amber-300">
                  Warning: LAN mode uses a self-signed TLS certificate and the mobile client does
                  not yet pin it. Prefer Cloudflare Tunnel for anything outside a trusted Wi-Fi.
                </p>
              )}
            </section>

            <section className="space-y-2">
              <h3 className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
                Port aliases
              </h3>
              <PortAliasEditor
                aliases={settings.port_aliases}
                onChange={(next) => save({ port_aliases: next }, 250)}
              />
            </section>

            <section className="space-y-2">
              <h3 className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
                Onboarding
              </h3>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  onOpenChange(false);
                  onShowOnboarding();
                }}
              >
                Show onboarding again
              </Button>
            </section>

            <section className="space-y-2">
              <h3 className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
                About / Updates
              </h3>
              <UpdatesRow />
            </section>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border/50 bg-muted/20 px-3 py-2">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 accent-primary"
      />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-foreground">{label}</div>
        {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
      </div>
    </label>
  );
}

function StartAtLoginRow({
  enabled,
  onChange,
}: {
  enabled: boolean;
  onChange: (v: boolean) => Promise<void>;
}) {
  // Double-check the real OS state once on mount so the UI is truthful
  // even if the settings.yaml drifted (e.g. user removed the login item
  // manually in System Settings).
  const [actual, setActual] = useState<boolean | null>(null);
  useEffect(() => {
    api.getAutostartStatus()
      .then((s) => setActual(s))
      .catch(() => setActual(null));
  }, []);
  const effective = actual ?? enabled;
  return (
    <ToggleRow
      label="Start procman at login"
      hint={
        actual != null && actual !== enabled
          ? 'System state differs from the saved setting — toggle to sync.'
          : undefined
      }
      checked={effective}
      onChange={async (v) => {
        setActual(v);
        await onChange(v);
      }}
    />
  );
}

type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'up-to-date' }
  | { kind: 'available'; version: string; notes?: string }
  | { kind: 'installing'; percent: number | null }
  | { kind: 'error'; message: string };

function UpdatesRow() {
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [state, setState] = useState<UpdateState>({ kind: 'idle' });

  useEffect(() => {
    import('@tauri-apps/api/app')
      .then(({ getVersion }) => getVersion())
      .then((v) => setCurrentVersion(v))
      .catch(() => setCurrentVersion(null));
  }, []);

  async function onCheck() {
    setState({ kind: 'checking' });
    try {
      const res = await checkForUpdates();
      if (!res.available) {
        setState({ kind: 'up-to-date' });
      } else {
        setState({
          kind: 'available',
          version: res.version ?? 'unknown',
          notes: res.notes,
        });
      }
    } catch (e) {
      setState({
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async function onInstall() {
    setState({ kind: 'installing', percent: null });
    try {
      await installUpdateAndRestart((chunk, total) => {
        if (total && total > 0) {
          setState((s) =>
            s.kind === 'installing'
              ? { kind: 'installing', percent: Math.min(100, (chunk / total) * 100) }
              : s,
          );
        }
      });
    } catch (e) {
      setState({
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return (
    <div className="space-y-2 rounded-md border border-border/50 bg-muted/20 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[13px] text-foreground">
          Current version:{' '}
          <span className="font-mono">{currentVersion ?? '…'}</span>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={onCheck}
          disabled={state.kind === 'checking' || state.kind === 'installing'}
        >
          {state.kind === 'checking' ? 'Checking…' : 'Check for updates'}
        </Button>
      </div>

      {state.kind === 'up-to-date' && (
        <p className="text-[12px] text-muted-foreground">
          You're on the latest version.
        </p>
      )}

      {state.kind === 'available' && (
        <div className="space-y-2">
          <p className="text-[12px] text-foreground">
            Update available: <span className="font-mono">v{state.version}</span>
          </p>
          {state.notes && (
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded border border-border/50 bg-background/60 p-2 text-[11px] text-muted-foreground">
              {state.notes}
            </pre>
          )}
          <Button variant="default" size="sm" onClick={onInstall}>
            Install & Restart
          </Button>
        </div>
      )}

      {state.kind === 'installing' && (
        <p className="text-[12px] text-muted-foreground">
          Installing
          {state.percent != null ? ` (${state.percent.toFixed(0)}%)` : ''}… the
          app will restart when done.
        </p>
      )}

      {state.kind === 'error' && (
        <p className="rounded-md border border-red-500/40 bg-red-500/10 px-2 py-1 text-[11px] text-red-600 dark:text-red-300">
          {state.message}
        </p>
      )}
    </div>
  );
}

function PortAliasEditor({
  aliases,
  onChange,
}: {
  aliases: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}) {
  const [newPort, setNewPort] = useState('');
  const [newAlias, setNewAlias] = useState('');

  const entries = Object.entries(aliases).sort(
    (a, b) => parseInt(a[0], 10) - parseInt(b[0], 10),
  );

  function remove(port: string) {
    const next = { ...aliases };
    delete next[port];
    onChange(next);
  }

  function rename(port: string, alias: string) {
    onChange({ ...aliases, [port]: alias });
  }

  function add() {
    const p = parseInt(newPort, 10);
    if (!Number.isInteger(p) || p < 1 || p > 65535 || !newAlias.trim()) return;
    onChange({ ...aliases, [String(p)]: newAlias.trim() });
    setNewPort('');
    setNewAlias('');
  }

  return (
    <div className="space-y-2">
      {entries.length > 0 ? (
        <ul className="divide-y divide-border/50 rounded-md border border-border/50">
          {entries.map(([port, alias]) => (
            <li key={port} className="flex items-center gap-2 px-2 py-1">
              <span className="w-16 font-mono text-[12px] text-muted-foreground">
                {port}
              </span>
              <Input
                value={alias}
                onChange={(e) => rename(port, e.target.value)}
                className="h-7 flex-1 text-[13px]"
              />
              <Button variant="ghost" size="sm" onClick={() => remove(port)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[11px] text-muted-foreground">No aliases yet.</p>
      )}

      <div className="flex items-center gap-2">
        <Input
          value={newPort}
          onChange={(e) => setNewPort(e.target.value.replace(/\D/g, ''))}
          placeholder="port"
          className="h-7 w-20 font-mono text-[13px]"
        />
        <Input
          value={newAlias}
          onChange={(e) => setNewAlias(e.target.value)}
          placeholder="alias (e.g. Frontend)"
          className="h-7 flex-1 text-[13px]"
        />
        <Button
          variant="outline"
          size="sm"
          onClick={add}
          disabled={!newPort.trim() || !newAlias.trim()}
        >
          Add
        </Button>
      </div>
    </div>
  );
}
