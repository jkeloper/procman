import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';
import { listen } from '@tauri-apps/api/event';
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import {
  api,
  type ProcessKind,
  type RuntimeDelta,
  type RuntimePortInfo,
  type RuntimeSnapshot,
  type RuntimeStatus,
  type ShutdownEvent,
  type StatusEvent,
} from '@/api/tauri';
import { useVisibleInterval } from '@/hooks/useVisibleInterval';
import { RuntimeStatusContext } from './runtimeStatus';

export function RuntimeProvider({ children }: { children: ReactNode }) {
  const [statuses, setStatuses] = useState<Record<string, RuntimeStatus>>({});
  const [pids, setPids] = useState<Record<string, number>>({});
  const [startTimes, setStartTimes] = useState<Record<string, number>>({});
  const [restartCounts, setRestartCounts] = useState<Record<string, number>>({});
  const [metrics, setMetrics] = useState<Record<string, { cpu: number | null; rss: number | null }>>({});
  // WS9: scriptId → backend owner (`piped`/`pty`). Sourced from the runtime
  // snapshot + metrics delta (both carry ProcessSnapshot.kind). Lets the
  // process rows badge a terminal-backed run. Cleared on a non-running status.
  const [kinds, setKinds] = useState<Record<string, ProcessKind>>({});
  const [shutdowns, setShutdowns] = useState<Record<string, ShutdownEvent>>({});
  const [ports, setPorts] = useState<RuntimePortInfo[]>([]);
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot | null>(null);
  const [runtimeLoading, setRuntimeLoading] = useState(true);
  const refreshingRef = useRef(false);
  const shutdownClearTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const applyRuntimeSnapshot = useCallback((snap: RuntimeSnapshot) => {
    setSnapshot(snap);
    setPorts(snap.ports);
    const s: Record<string, RuntimeStatus> = {};
    const p: Record<string, number> = {};
    const t: Record<string, number> = {};
    const m: Record<string, { cpu: number | null; rss: number | null }> = {};
    const k: Record<string, ProcessKind> = {};
    for (const row of snap.processes) {
      s[row.id] = row.status;
      p[row.id] = row.pid;
      t[row.id] = row.started_at_ms;
      m[row.id] = { cpu: row.cpu_pct, rss: row.rss_kb };
      k[row.id] = row.kind;
    }
    setStatuses((prev) => ({ ...prev, ...s }));
    setPids((prev) => ({ ...prev, ...p }));
    setStartTimes((prev) => ({ ...prev, ...t }));
    setMetrics((prev) => ({ ...prev, ...m }));
    setKinds((prev) => ({ ...prev, ...k }));
    setRuntimeLoading(false);
  }, []);

  const applyRuntimeDelta = useCallback((delta: RuntimeDelta) => {
    switch (delta.kind) {
      case 'metrics': {
        if (delta.processes.length === 0) return;
        setMetrics((prev) => {
          const next: Record<string, { cpu: number | null; rss: number | null }> = { ...prev };
          for (const row of delta.processes) {
            next[row.id] = { cpu: row.cpu_pct, rss: row.rss_kb };
          }
          return next;
        });
        // WS9: metrics rows carry ProcessSnapshot.kind, so this 5s tick picks
        // up the backend owner for any run that started after the initial
        // snapshot (e.g. a terminal session opened mid-session). Only merge the
        // kind for *running* rows — the metrics payload includes retained
        // Crashed entries, and re-adding their kind here would defeat the
        // per-status cleanup (`removeKey(setKinds, id)` on stop/crash) and
        // resurrect a stale discriminator within 5s of a crash.
        setKinds((prev) => {
          const next: Record<string, ProcessKind> = { ...prev };
          for (const row of delta.processes) {
            if (row.status === 'running') {
              next[row.id] = row.kind;
            } else {
              delete next[row.id];
            }
          }
          return next;
        });
        break;
      }
      case 'ports': {
        setPorts(delta.ports);
        setSnapshot((prev) =>
          prev ? { ...prev, generated_at_ms: delta.generated_at_ms, ports: delta.ports } : prev,
        );
        break;
      }
    }
  }, []);

  const refreshRuntime = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    try {
      const snap = await api.runtimeSnapshot();
      applyRuntimeSnapshot(snap);
    } catch {
    } finally {
      refreshingRef.current = false;
      setRuntimeLoading(false);
    }
  }, [applyRuntimeSnapshot]);

  const refreshRuntimePorts = useCallback(async () => {
    try {
      const snap = await api.runtimePorts();
      applyRuntimeDelta({
        kind: 'ports',
        generated_at_ms: snap.generated_at_ms,
        ports: snap.ports,
      });
    } catch {
    }
  }, [applyRuntimeDelta]);

  useVisibleInterval(refreshRuntimePorts, 15000);

  useEffect(() => {
    refreshRuntime();

    const unStatus = listen<StatusEvent>('process://status', (ev) => {
      const { id, status, pid, restart_count } = ev.payload;
      setStatuses((prev) => ({ ...prev, [id]: status }));
      if (restart_count != null) {
        setRestartCounts((prev) => ({ ...prev, [id]: restart_count }));
      }

      if (status === 'crashed') {
        notifyCrash(id, ev.payload.exit_code);
      }

      if (status === 'running' && pid != null) {
        clearShutdownTimer(shutdownClearTimers.current, id);
        removeKey(setShutdowns, id);
        setPids((prev) => ({ ...prev, [id]: pid }));
        setStartTimes((prev) => ({ ...prev, [id]: ev.payload.ts_ms }));
      } else if (status !== 'running') {
        removeKey(setPids, id);
        removeKey(setStartTimes, id);
        removeKey(setMetrics, id);
        // WS9: drop the kind discriminator once the entry stops/crashes; a
        // crashed row no longer reflects an active terminal vs piped owner.
        removeKey(setKinds, id);
      }

      // WS5: `last_running` is now owned by the backend (ProcessManager marks
      // running on spawn, clears on user-stop / clean self-exit). The FE no
      // longer mirrors process://status into mark_last_running — that drifted
      // from the backend truth on window-close / FE-crash / remote spawn.
    });

    const unShutdown = listen<ShutdownEvent>('process://shutdown', (ev) => {
      const evt = ev.payload;
      clearShutdownTimer(shutdownClearTimers.current, evt.id);
      setShutdowns((prev) => ({ ...prev, [evt.id]: evt }));
      if (evt.phase === 'stopped' || evt.phase === 'not_running') {
        shutdownClearTimers.current[evt.id] = setTimeout(() => {
          removeKey(setShutdowns, evt.id);
          delete shutdownClearTimers.current[evt.id];
        }, 800);
      }
    });

    const unDelta = listen<RuntimeDelta>('runtime://delta', (ev) => {
      applyRuntimeDelta(ev.payload);
    });

    return () => {
      unStatus.then((fn) => fn());
      unShutdown.then((fn) => fn());
      unDelta.then((fn) => fn());
      Object.values(shutdownClearTimers.current).forEach(clearTimeout);
      shutdownClearTimers.current = {};
    };
  }, [applyRuntimeDelta, applyRuntimeSnapshot, refreshRuntime]);

  const value = useMemo(
    () => ({
      statuses,
      pids,
      startTimes,
      restartCounts,
      metrics,
      kinds,
      shutdowns,
      snapshot,
      ports,
      runtimeLoading,
      refreshRuntime,
    }),
    [
      statuses,
      pids,
      startTimes,
      restartCounts,
      metrics,
      kinds,
      shutdowns,
      snapshot,
      ports,
      runtimeLoading,
      refreshRuntime,
    ],
  );

  return (
    <RuntimeStatusContext.Provider value={value}>
      {children}
    </RuntimeStatusContext.Provider>
  );
}

function removeKey<T>(
  setter: Dispatch<SetStateAction<Record<string, T>>>,
  key: string,
) {
  setter((prev) => {
    if (!(key in prev)) return prev;
    const rest = { ...prev };
    delete rest[key];
    return rest;
  });
}

function clearShutdownTimer(
  timers: Record<string, ReturnType<typeof setTimeout>>,
  id: string,
) {
  if (!timers[id]) return;
  clearTimeout(timers[id]);
  delete timers[id];
}

async function notifyCrash(id: string, exitCode: number | null) {
  let granted = await isPermissionGranted();
  if (!granted) {
    const perm = await requestPermission();
    granted = perm === 'granted';
  }
  if (granted) {
    sendNotification({
      title: 'procman — Process Crashed',
      body: `Script ${id.slice(0, 8)} crashed (exit code: ${exitCode ?? 'unknown'})`,
    });
  }
}
