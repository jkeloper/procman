import { useCallback, useState } from 'react';
import { api, type Script, type PortInfo } from '@/api/tauri';
import { useToast } from '@/components/Toast';

export interface ConflictState {
  script: Script;
  port: number;
  info: PortInfo | null;
  /** Project the conflicting start should spawn against. */
  projectId: string;
}

export interface PortPickerState {
  script: Script;
  ports: PortInfo[];
  fallback?: boolean;
  rootPid?: number;
}

/**
 * Encapsulates per-script lifecycle actions: busy-set tracking, start
 * (with port-conflict pre-flight + conflict dialog state), stop, restart,
 * plus the port-picker dialog state shared with the tunnel launcher.
 * Extracted from ProcessGrid so the global view can reuse the exact same
 * control flow.
 *
 * `defaultProjectId` is the project the actions operate against when no
 * per-call project is supplied. The global "All running" view passes a
 * per-call projectId (resolved from the row) since it spans projects.
 */
export function useScriptActions(defaultProjectId: string | null = null) {
  const toast = useToast();
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [portPicker, setPortPicker] = useState<PortPickerState | null>(null);

  const withBusy = useCallback(
    async (
      id: string,
      fn: () => Promise<unknown>,
      onError?: (message: string) => void,
    ) => {
      setBusy((s) => new Set(s).add(id));
      try {
        await fn();
      } catch (e: any) {
        const message = `${e?.message ?? e}`;
        if (onError) onError(message);
        else toast.error(message);
      } finally {
        setBusy((s) => {
          const n = new Set(s);
          n.delete(id);
          return n;
        });
      }
    },
    [toast],
  );

  // Spawn a script, surfacing failures as a toast with a one-tap Retry.
  const spawnWithRetry = useCallback(
    (projectId: string, script: Script, force = false) =>
      withBusy(
        script.id,
        () => api.spawnProcess(projectId, script.id, force),
        (message) =>
          toast.error(message, {
            label: 'Retry',
            onClick: () => {
              void spawnWithRetry(projectId, script, force);
            },
          }),
      ),
    [withBusy, toast],
  );

  /**
   * Pre-flight port check before spawning. If the script declares ports
   * already bound by something other than an already-running procman
   * managed instance, show the conflict dialog. `projectIdArg` overrides
   * the hook's default project (used by the global view).
   */
  const handleStart = useCallback(
    async (script: Script, projectIdArg?: string) => {
      const projectId = projectIdArg ?? defaultProjectId;
      if (projectId == null) return;
      // S1: When declared ports exist, use the backend conflict checker
      // which handles multi-port scripts and owned_by_script semantics.
      if (script.ports && script.ports.length > 0) {
        try {
          const conflicts = await api.checkPortConflicts(script.id);
          const blocking = conflicts.filter((c) => c.severity === 'blocking');
          if (blocking.length > 0) {
            // Reuse single-port dialog for the first blocking conflict.
            const first = blocking[0];
            setConflict({
              script,
              projectId,
              port: first.spec.number,
              info: {
                port: first.spec.number,
                pid: first.holder_pid,
                process_name: first.holder_command,
                command: first.holder_command,
              },
            });
            return;
          }
        } catch (e) {
          if (import.meta.env.DEV) console.warn('[start] checkPortConflicts failed', e);
        }
        return spawnWithRetry(projectId, script);
      }

      // WS7-2: no declared ports → nothing authoritative to pre-flight
      // against, so spawn directly. (Port inference moved to ScriptEditor as
      // a declare-time autofill convenience; it is no longer a runtime path.)
      return spawnWithRetry(projectId, script);
    },
    [defaultProjectId, spawnWithRetry],
  );

  const resolveConflictKillAndStart = useCallback(async () => {
    if (!conflict) return;
    const { script, port, projectId } = conflict;
    setConflict(null);
    await withBusy(script.id, async () => {
      await api.killPort(port).catch(() => {});
      // Small delay so the port is released before we re-bind.
      await new Promise((r) => setTimeout(r, 600));
      return api.spawnProcess(projectId, script.id);
    });
  }, [conflict, withBusy]);

  const resolveConflictStartAnyway = useCallback(async () => {
    if (!conflict) return;
    const { script, projectId } = conflict;
    setConflict(null);
    await spawnWithRetry(projectId, script, true);
  }, [conflict, spawnWithRetry]);

  const stop = useCallback(
    (scriptId: string) => withBusy(scriptId, () => api.killProcess(scriptId)),
    [withBusy],
  );

  const restart = useCallback(
    (scriptId: string, projectIdArg?: string) => {
      const projectId = projectIdArg ?? defaultProjectId;
      if (projectId == null) return Promise.resolve();
      return withBusy(scriptId, () => api.restartProcess(projectId, scriptId));
    },
    [defaultProjectId, withBusy],
  );

  return {
    busy,
    conflict,
    setConflict,
    portPicker,
    setPortPicker,
    withBusy,
    handleStart,
    resolveConflictKillAndStart,
    resolveConflictStartAnyway,
    stop,
    restart,
  };
}
