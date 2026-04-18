import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { api, type ProcessSnapshot, type RuntimeStatus, type StatusEvent } from '@/api/tauri';
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';

/**
 * Tracks the current runtime status of each script_id based on
 * `process://status` events. Also primes the state from list_processes()
 * on mount so restarting the UI doesn't lose state.
 *
 * Phase B Worker L: previously polled `list_processes` every 2s for both
 * status reconciliation and cpu/rss metrics. Polling is now replaced by:
 *   - one mount-time `list_processes` call for the initial snapshot;
 *   - a `process://status` subscription for lifecycle transitions (running
 *     → crashed/stopped etc.); and
 *   - a `process://metrics` subscription (BE emits every 2s globally) for
 *     cpu/rss. When no process is running, BE skips the emit so we simply
 *     hold the last map — it'll be cleared by status events as processes
 *     stop.
 * The authority ordering is unchanged: status events drive lifecycle,
 * metrics events only populate cpu/rss for pids that were already marked
 * running by status.
 */
export function useProcessStatus() {
  const [statuses, setStatuses] = useState<Record<string, RuntimeStatus>>({});
  const [pids, setPids] = useState<Record<string, number>>({});
  const [startTimes, setStartTimes] = useState<Record<string, number>>({});
  const [restartCounts, setRestartCounts] = useState<Record<string, number>>({});
  // S3: observability metrics per script. Updated from `process://metrics`
  // broadcasts instead of local polling.
  const [metrics, setMetrics] = useState<Record<string, { cpu: number | null; rss: number | null }>>({});

  useEffect(() => {
    // One-shot mount snapshot so a refreshed UI doesn't miss running
    // processes that were started before the window loaded.
    (async () => {
      try {
        const snap = await api.listProcesses();
        const s: Record<string, RuntimeStatus> = {};
        const p: Record<string, number> = {};
        const t: Record<string, number> = {};
        const m: Record<string, { cpu: number | null; rss: number | null }> = {};
        for (const row of snap) {
          s[row.id] = row.status;
          p[row.id] = row.pid;
          t[row.id] = row.started_at_ms;
          m[row.id] = { cpu: row.cpu_pct, rss: row.rss_kb };
        }
        setStatuses((prev) => ({ ...prev, ...s }));
        setPids((prev) => ({ ...prev, ...p }));
        setStartTimes((prev) => ({ ...prev, ...t }));
        setMetrics((prev) => ({ ...prev, ...m }));
      } catch {}
    })();

    const unStatus = listen<StatusEvent>('process://status', (ev) => {
      const { id, status, pid, restart_count } = ev.payload;
      setStatuses((prev) => ({ ...prev, [id]: status }));
      if (restart_count != null) {
        setRestartCounts((prev) => ({ ...prev, [id]: restart_count }));
      }
      // M3: Send macOS notification on crash
      if (status === 'crashed') {
        (async () => {
          let granted = await isPermissionGranted();
          if (!granted) {
            const perm = await requestPermission();
            granted = perm === 'granted';
          }
          if (granted) {
            sendNotification({ title: 'procman — Process Crashed', body: `Script ${id.slice(0, 8)} crashed (exit code: ${ev.payload.exit_code ?? 'unknown'})` });
          }
        })();
      }
      if (status === 'running' && pid != null) {
        setPids((prev) => ({ ...prev, [id]: pid }));
        setStartTimes((prev) => ({ ...prev, [id]: ev.payload.ts_ms }));
      } else if (status !== 'running') {
        setPids((prev) => {
          const { [id]: _, ...rest } = prev;
          return rest;
        });
        setStartTimes((prev) => {
          const { [id]: _, ...rest } = prev;
          return rest;
        });
        // Drop stale cpu/rss for processes that are no longer running
        // so the dashboard doesn't display a ghost metric.
        setMetrics((prev) => {
          if (!(id in prev)) return prev;
          const { [id]: _, ...rest } = prev;
          return rest;
        });
      }
      // T27: persist running state for session restore on next launch
      invoke('mark_last_running', { scriptId: id, running: status === 'running' }).catch(() => {});
    });

    // Phase B Worker L: cpu/rss updates piggy-back on the global BE
    // broadcast. Payload mirrors `list_processes` output; we only consume
    // the metrics columns here because lifecycle is owned by `status`.
    const unMetrics = listen<ProcessSnapshot[]>('process://metrics', (ev) => {
      const snap = ev.payload ?? [];
      if (snap.length === 0) return;
      setMetrics((prev) => {
        const next: Record<string, { cpu: number | null; rss: number | null }> = { ...prev };
        for (const row of snap) {
          next[row.id] = { cpu: row.cpu_pct, rss: row.rss_kb };
        }
        return next;
      });
    });

    return () => {
      unStatus.then((fn) => fn());
      unMetrics.then((fn) => fn());
    };
  }, []);

  return { statuses, pids, startTimes, restartCounts, metrics };
}
