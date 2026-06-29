import { createContext } from 'react';
import type {
  ProcessKind,
  RuntimeSnapshot,
  RuntimeStatus,
  RuntimePortInfo,
  ShutdownEvent,
} from '@/api/tauri';

export interface ProcessStatusState {
  statuses: Record<string, RuntimeStatus>;
  pids: Record<string, number>;
  startTimes: Record<string, number>;
  restartCounts: Record<string, number>;
  metrics: Record<string, { cpu: number | null; rss: number | null }>;
  /** WS9: scriptId → backend owner (`piped`/`pty`) for currently-tracked runs. */
  kinds: Record<string, ProcessKind>;
  shutdowns: Record<string, ShutdownEvent>;
  snapshot: RuntimeSnapshot | null;
  ports: RuntimePortInfo[];
  runtimeLoading: boolean;
  refreshRuntime: () => Promise<void>;
}

export const EMPTY_PROCESS_STATUS: ProcessStatusState = {
  statuses: {},
  pids: {},
  startTimes: {},
  restartCounts: {},
  metrics: {},
  kinds: {},
  shutdowns: {},
  snapshot: null,
  ports: [],
  runtimeLoading: true,
  refreshRuntime: async () => {},
};

export const RuntimeStatusContext = createContext<ProcessStatusState | null>(null);
