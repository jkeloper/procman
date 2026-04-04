// Typed Tauri invoke wrappers with runtime validation.
//
// Each function corresponds to a #[tauri::command] in src-tauri/src/commands/.
// Input args are typed at compile time; outputs are validated at runtime
// via zod so schema drift between Rust and TS fails loudly with a clear error.
//
// Usage: `const projects = await api.listProjects()` rather than raw
// `invoke('list_projects')` — do not bypass this module.

import { invoke } from '@tauri-apps/api/core';
import { z } from 'zod';
import {
  ProjectSchema,
  ProcessHandleSchema,
  LogLineSchema,
  PortInfoSchema,
  type Project,
  type ProcessHandle,
  type LogLine,
  type PortInfo,
} from './schemas';

async function call<T>(command: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
  const raw = await invoke(command, args);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `IPC schema drift on '${command}': ${parsed.error.message}. Raw: ${JSON.stringify(raw).slice(0, 200)}`,
    );
  }
  return parsed.data;
}

export const api = {
  // Projects
  listProjects: () => call('list_projects', {}, z.array(ProjectSchema)),
  createProject: (name: string, path: string) =>
    call('create_project', { name, path }, ProjectSchema),
  deleteProject: (id: string) =>
    call('delete_project', { id }, z.void()),

  // Processes
  spawnProcess: (projectId: string, scriptId: string) =>
    call('spawn_process', { projectId, scriptId }, ProcessHandleSchema),
  killProcess: (processId: string) =>
    call('kill_process', { processId }, z.void()),
  getLogs: (processId: string, limit: number) =>
    call('get_logs', { processId, limit }, z.array(LogLineSchema)),

  // Ports
  listPorts: () => call('list_ports', {}, z.array(PortInfoSchema)),
  killPort: (port: number) => call('kill_port', { port }, z.void()),
};

// Re-export types for convenience.
export type { Project, ProcessHandle, LogLine, PortInfo };
