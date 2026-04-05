// Thin client wrappers around procman remote API.

import { baseUrl, authHeader, loadPair } from './pair';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: { ...authHeader(), ...(init?.headers ?? {}) },
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
}

export interface LogLine {
  seq: number;
  ts_ms: number;
  stream: 'stdout' | 'stderr';
  text: string;
}

export interface ProjectsPayload {
  version: string;
  projects: Array<{
    id: string;
    name: string;
    path: string;
    scripts: Array<{
      id: string;
      name: string;
      command: string;
      expected_port: number | null;
      auto_restart: boolean;
    }>;
  }>;
  groups: unknown[];
  settings: unknown;
}

export const api = {
  health: () => fetch(`${baseUrl()}/api/health`).then((r) => r.json()),
  ping: () => req<{ pong: boolean; ts_ms: number }>('/api/ping'),
  processes: () => req<ProcessSnapshot[]>('/api/processes'),
  projects: () => req<ProjectsPayload>('/api/projects'),
  logs: (scriptId: string) => req<LogLine[]>(`/api/logs/${scriptId}`),
  start: (scriptId: string) =>
    req<{ pid: number }>(`/api/processes/${scriptId}/start`, { method: 'POST' }),
  stop: (scriptId: string) =>
    req<void>(`/api/processes/${scriptId}/stop`, { method: 'POST' }),
  restart: (scriptId: string) =>
    req<{ pid: number }>(`/api/processes/${scriptId}/restart`, { method: 'POST' }),
  ports: () =>
    req<Array<{ port: number; pid: number; process_name: string }>>('/api/ports'),
};

// WebSocket stream for live updates.
export type StreamEvent =
  | { type: 'hello'; name: string; version: string }
  | { type: 'status'; id: string; status: string; pid: number | null; exit_code: number | null; ts_ms: number }
  | { type: 'log'; script_id: string; line: LogLine };

export function openStream(
  onEvent: (ev: StreamEvent) => void,
  onStatus: (connected: boolean) => void,
): () => void {
  let closed = false;
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;

  const connect = () => {
    const pair = loadPair();
    if (!pair) return;
    const url = `${baseUrl().replace(/^http/, 'ws')}/api/stream?token=${encodeURIComponent(pair.token)}`;
    try {
      ws = new WebSocket(url);
    } catch {
      scheduleReconnect();
      return;
    }
    ws.onopen = () => {
      attempt = 0;
      onStatus(true);
    };
    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        // flatten `status` nested payload
        if (data.type === 'status' && 'id' in data === false) {
          // event is wrapped
          Object.assign(data, data.data ?? {});
        }
        onEvent(data);
      } catch {}
    };
    ws.onclose = () => {
      onStatus(false);
      if (!closed) scheduleReconnect();
    };
    ws.onerror = () => {
      ws?.close();
    };
  };

  const scheduleReconnect = () => {
    if (closed) return;
    attempt++;
    const delay = Math.min(30000, 500 * Math.pow(2, Math.min(attempt, 6)));
    reconnectTimer = setTimeout(connect, delay);
  };

  connect();

  return () => {
    closed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    ws?.close();
  };
}
