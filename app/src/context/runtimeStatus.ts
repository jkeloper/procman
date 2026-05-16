import { createContext } from 'react';
import type {
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
  shutdowns: {},
  snapshot: null,
  ports: [],
  runtimeLoading: true,
  refreshRuntime: async () => {},
};

export const RuntimeStatusContext = createContext<ProcessStatusState | null>(null);
