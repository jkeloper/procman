// Typed Tauri invoke wrappers with runtime zod validation.
//
// Each function maps to a #[tauri::command] in src-tauri/src/commands/.
// Output is zod-validated so schema drift fails loudly with command name +
// error + payload preview.

import { invoke } from '@tauri-apps/api/core';
import { z } from 'zod';
import {
  ProjectSchema,
  ScriptSchema,
  ProcessHandleSchema,
  LogLineSchema,
  PortInfoSchema,
  type Project,
  type Script,
  type ProcessHandle,
  type LogLine,
  type PortInfo,
} from './schemas';

async function call<T>(
  command: string,
  args: Record<string, unknown>,
  schema: z.ZodType<T>,
): Promise<T> {
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
  updateProject: (id: string, name?: string, path?: string) =>
    call('update_project', { id, name, path }, ProjectSchema),
  deleteProject: (id: string) =>
    call('delete_project', { id }, z.void()),

  // Scripts
  listScripts: (projectId: string) =>
    call('list_scripts', { projectId }, z.array(ScriptSchema)),
  createScript: (
    projectId: string,
    name: string,
    command: string,
    expectedPort: number | null,
    autoRestart: boolean,
  ) =>
    call(
      'create_script',
      { projectId, name, command, expectedPort, autoRestart },
      ScriptSchema,
    ),
  updateScript: (
    projectId: string,
    id: string,
    patch: {
      name?: string;
      command?: string;
      expectedPort?: number | null;
      autoRestart?: boolean;
    },
  ) => call('update_script', { projectId, id, ...patch }, ScriptSchema),
  deleteScript: (projectId: string, id: string) =>
    call('delete_script', { projectId, id }, z.void()),

  // Processes (stubs — wired in Sprint 2)
  spawnProcess: (projectId: string, scriptId: string) =>
    call('spawn_process', { projectId, scriptId }, ProcessHandleSchema),
  killProcess: (processId: string) =>
    call('kill_process', { processId }, z.void()),
  getLogs: (processId: string, limit: number) =>
    call('get_logs', { processId, limit }, z.array(LogLineSchema)),

  // Ports (stubs — wired in Sprint 3)
  listPorts: () => call('list_ports', {}, z.array(PortInfoSchema)),
  killPort: (port: number) => call('kill_port', { port }, z.void()),
};

export type { Project, Script, ProcessHandle, LogLine, PortInfo };
