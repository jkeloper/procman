// Thin client wrappers around procman remote API.

import { authHeader, loadPair } from './pair';
import {
  isTerminalTransportError,
  openTransportSocket,
  TransportError,
  transportRequest,
  type TransportSocket,
} from './transport';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const pair = loadPair();
  if (!pair) throw new Error('not paired');
  const res = await transportRequest(pair, path, {
    ...init,
    headers: { ...authHeader(pair), ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) return res.json();
  return undefined as unknown as T;
}

export interface ProcessSnapshot {
  id: string;
  pid: number;
  status: 'running' | 'stopped' | 'crashed';
  started_at_ms: number;
  command: string;
  cpu_pct: number | null;
  rss_kb: number | null;
}

export interface PortSpec {
  name: string;
  number: number;
  bind: string;
  optional: boolean;
  note: string | null;
}

export interface DeclaredPortStatus {
  spec: PortSpec;
  state: 'free' | 'listening_managed' | 'taken_by_other';
  holder_pid: number | null;
  holder_command: string | null;
  owned_by_script: boolean;
  reachable: boolean | null;
}

export interface PortConflict {
  spec: PortSpec;
  severity: 'blocking' | 'warning';
  holder_pid: number;
  holder_command: string;
}

export interface ScheduleSpec {
  enabled: boolean;
  cron: string;
}

export interface LogLine {
  seq: number;
  ts_ms: number;
  stream: 'stdout' | 'stderr';
  text: string;
}

export interface GroupMember {
  project_id: string;
  script_id: string;
}

export interface Group {
  id: string;
  name: string;
  members: GroupMember[];
}

// WS8: mirrors the desktop `GroupRunResult` so partial-success can be
// surfaced (each member reports its own ok/error/pid).
export interface GroupRunResult {
  project_id: string;
  script_id: string;
  ok: boolean;
  error: string | null;
  pid: number | null;
}

export interface ProjectsPayload {
  version: string;
  projects: Array<{
    id: string;
    name: string;
    // SEC-14: server omits `path` from the remote payload to avoid
    // leaking local filesystem layout. Typed as optional so clients
    // don't rely on it.
    path?: string;
    scripts: Array<{
      id: string;
      name: string;
      command: string;
      ports: PortSpec[];
      auto_restart: boolean;
      schedule: ScheduleSpec | null;
      depends_on: string[];
    }>;
  }>;
  groups: Group[];
  settings: unknown;
}

export const api = {
  processes: () => req<ProcessSnapshot[]>('/api/processes'),
  projects: () => req<ProjectsPayload>('/api/projects'),
  logs: (scriptId: string) => req<LogLine[]>(`/api/logs/${scriptId}`),
  start: (scriptId: string) =>
    req<{ pid: number }>(`/api/processes/${scriptId}/start`, { method: 'POST' }),
  stop: (scriptId: string) =>
    req<void>(`/api/processes/${scriptId}/stop`, { method: 'POST' }),
  restart: (scriptId: string) =>
    req<{ pid: number }>(`/api/processes/${scriptId}/restart`, { method: 'POST' }),
  // WS8: batch-run a group. Server delegates to the same desktop run_group_core,
  // so ordering / depends_on gating / partial-success match the desktop.
  runGroup: (groupId: string) =>
    req<GroupRunResult[]>(`/api/groups/${groupId}/run`, { method: 'POST' }),
  ports: () =>
    req<Array<{ port: number; pid: number; process_name: string }>>('/api/ports'),
  // WS3: batch status — one round trip + one server-side ps/lsof build for
  // the whole dashboard poll. Returns [scriptId, statuses] tuples.
  portStatusBatch: (scriptIds: string[]) =>
    req<Array<[string, DeclaredPortStatus[]]>>('/api/ports/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script_ids: scriptIds }),
    }),
  portConflicts: (scriptId: string) =>
    req<PortConflict[]>(`/api/ports/${scriptId}/conflicts`),
  portAliases: () =>
    req<Record<string, string>>('/api/port-aliases'),
  setPortAlias: (port: number, alias: string) =>
    req<void>('/api/port-aliases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port, alias }),
    }),
};

// WebSocket stream for live updates.
export type StreamEvent =
  | { type: 'hello'; name: string; version: string }
  | { type: 'status'; id: string; status: string; pid: number | null; exit_code: number | null; ts_ms: number }
  | { type: 'log'; script_id: string; line: LogLine };

const STREAM_AUTH_PROBE_TIMEOUT_MS = 5_000;

function authRevokedError(): TransportError {
  return new TransportError('AUTH_REVOKED');
}

async function classifyStreamFailure(pair: NonNullable<ReturnType<typeof loadPair>>, error: Error): Promise<Error> {
  if (isTerminalTransportError(error)) return error;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), STREAM_AUTH_PROBE_TIMEOUT_MS);
  try {
    const response = await transportRequest(pair, '/api/ping', {
      headers: authHeader(pair),
      signal: controller.signal,
    });
    return response.status === 401 || response.status === 403
      ? authRevokedError()
      : error;
  } catch (probeError) {
    return isTerminalTransportError(probeError) && probeError instanceof Error
      ? probeError
      : error;
  } finally {
    clearTimeout(timeout);
  }
}

export function openStream(
  onEvent: (ev: StreamEvent) => void,
  onStatus: (connected: boolean) => void,
  onError?: (error: Error) => void,
): () => void {
  let closed = false;
  let terminal = false;
  let socket: TransportSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let generation = 0;

  const connect = () => {
    const pair = loadPair();
    if (!pair) return;
    const currentGeneration = ++generation;
    let ended = false;
    let classifying = false;

    const endConnection = (error?: Error) => {
      if (ended || closed || currentGeneration !== generation) return;
      ended = true;
      onStatus(false);
      if (error && isTerminalTransportError(error)) {
        terminal = true;
        onError?.(error);
        socket?.close();
        return;
      }
      socket?.close();
      scheduleReconnect();
    };

    const classifyAndEnd = (error: Error) => {
      if (ended || closed || classifying || currentGeneration !== generation) return;
      if (isTerminalTransportError(error)) {
        endConnection(error);
        return;
      }
      classifying = true;
      void classifyStreamFailure(pair, error).then((classifiedError) => {
        classifying = false;
        endConnection(classifiedError);
      });
    };

    // Token delivery remains in the WebSocket subprotocol; neither browser
    // URLs nor native connection metadata expose it as a query parameter.
    void openTransportSocket(
      pair,
      '/api/stream',
      ['procman', `procman-token.${pair.token}`],
      {
        onOpen: () => {
          if (closed || ended || currentGeneration !== generation) return;
          attempt = 0;
          onStatus(true);
        },
        onMessage: (message) => {
          if (closed || ended || currentGeneration !== generation) return;
          try {
            const data = JSON.parse(message);
            // Flatten the server's wrapped status payload.
            if (data.type === 'status' && 'id' in data === false) {
              Object.assign(data, data.data ?? {});
            }
            onEvent(data);
          } catch {
            // Ignore malformed stream frames and keep the socket alive.
          }
        },
        onClose: (code, reason) => {
          if (classifying) return;
          if (code === 4001) {
            endConnection(authRevokedError());
            return;
          }
          if (code === 1006) {
            classifyAndEnd(new Error(reason || 'WebSocket connection failed'));
            return;
          }
          endConnection();
        },
        onError: (error) => classifyAndEnd(error),
      },
    ).then((opened) => {
      if (closed || ended || currentGeneration !== generation) {
        opened.close();
      } else {
        socket = opened;
      }
    }).catch((error: unknown) => {
      classifyAndEnd(error instanceof Error ? error : new Error(String(error)));
    });
  };

  const scheduleReconnect = () => {
    if (closed || terminal || reconnectTimer) return;
    attempt++;
    const delay = Math.min(30000, 500 * Math.pow(2, Math.min(attempt, 6)));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  connect();

  return () => {
    closed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    generation++;
    socket?.close();
  };
}
