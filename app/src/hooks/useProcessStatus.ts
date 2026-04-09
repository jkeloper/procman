import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { api, type RuntimeStatus, type StatusEvent } from '@/api/tauri';
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';

/**
 * Tracks the current runtime status of each script_id based on
 * `process://status` events. Also primes the state from list_processes()
 * on mount so restarting the UI doesn't lose state.
 */
export function useProcessStatus() {
  const [statuses, setStatuses] = useState<Record<string, RuntimeStatus>>({});
  const [pids, setPids] = useState<Record<string, number>>({});
  const [startTimes, setStartTimes] = useState<Record<string, number>>({});

  useEffect(() => {
    api.listProcesses().then((snap) => {
      const s: Record<string, RuntimeStatus> = {};
      const p: Record<string, number> = {};
      const t: Record<string, number> = {};
      for (const row of snap) {
        s[row.id] = row.status;
        p[row.id] = row.pid;
        t[row.id] = row.started_at_ms;
      }
      setStatuses(s);
      setPids(p);
      setStartTimes(t);
    }).catch(() => {});

    const un = listen<StatusEvent>('process://status', (ev) => {
      const { id, status, pid } = ev.payload;
      setStatuses((prev) => ({ ...prev, [id]: status }));
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
      }
      // T27: persist running state for session restore on next launch
      invoke('mark_last_running', { scriptId: id, running: status === 'running' }).catch(() => {});
    });
    return () => {
      un.then((fn) => fn());
    };
  }, []);

  return { statuses, pids, startTimes };
}
