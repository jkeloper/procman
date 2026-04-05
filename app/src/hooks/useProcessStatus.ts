import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { api, type RuntimeStatus, type StatusEvent } from '@/api/tauri';

/**
 * Tracks the current runtime status of each script_id based on
 * `process://status` events. Also primes the state from list_processes()
 * on mount so restarting the UI doesn't lose state.
 */
export function useProcessStatus() {
  const [statuses, setStatuses] = useState<Record<string, RuntimeStatus>>({});
  const [pids, setPids] = useState<Record<string, number>>({});

  useEffect(() => {
    // Prime from snapshot
    api.listProcesses().then((snap) => {
      const s: Record<string, RuntimeStatus> = {};
      const p: Record<string, number> = {};
      for (const row of snap) {
        s[row.id] = row.status;
        p[row.id] = row.pid;
      }
      setStatuses(s);
      setPids(p);
    }).catch(() => {});

    const un = listen<StatusEvent>('process://status', (ev) => {
      const { id, status, pid } = ev.payload;
      setStatuses((prev) => ({ ...prev, [id]: status }));
      if (status === 'running' && pid != null) {
        setPids((prev) => ({ ...prev, [id]: pid }));
      } else if (status !== 'running') {
        setPids((prev) => {
          const { [id]: _, ...rest } = prev;
          return rest;
        });
      }
    });
    return () => {
      un.then((fn) => fn());
    };
  }, []);

  return { statuses, pids };
}
