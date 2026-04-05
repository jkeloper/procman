// Typed Tauri invoke wrappers with runtime zod validation.

import { invoke } from '@tauri-apps/api/core';
import { z } from 'zod';
import {
  ProjectSchema,
  ScriptSchema,
  ProjectCandidateSchema,
  LogLineSchema,
  PortInfoSchema,
  ProcessSnapshotSchema,
  type Project,
  type Script,
  type ProjectCandidate,
  type LogLine,
  type PortInfo,
  type ProcessSnapshot,
  type StatusEvent,
  type RuntimeStatus,
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

// Untyped call (for commands returning simple primitives / u32)
async function callRaw<T>(command: string, args: Record<string, unknown>): Promise<T> {
  return (await invoke(command, args)) as T;
}

export const api = {
  // Projects
  listProjects: () => call('list_projects', {}, z.array(ProjectSchema)),
  createProject: (name: string, path: string) =>
    call('create_project', { name, path }, ProjectSchema),
  updateProject: (id: string, name?: string, path?: string) =>
    call('update_project', { id, name, path }, ProjectSchema),
  deleteProject: (id: string) => call('delete_project', { id }, z.void()),

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

  // Scan
  scanDirectory: (path: string) =>
    call('scan_directory', { path }, z.array(ProjectCandidateSchema)),

  // Processes (runtime control)
  spawnProcess: (projectId: string, scriptId: string) =>
    callRaw<number>('spawn_process', { projectId, scriptId }),
  killProcess: (scriptId: string) =>
    callRaw<null>('kill_process', { scriptId }),
  restartProcess: (projectId: string, scriptId: string) =>
    callRaw<number>('restart_process', { projectId, scriptId }),
  listProcesses: () =>
    call('list_processes', {}, z.array(ProcessSnapshotSchema)),
  logSnapshot: (scriptId: string) =>
    call('log_snapshot', { scriptId }, z.array(LogLineSchema)),

  // Groups
  listGroups: () => callRaw('list_groups', {}),
  createGroup: (name: string, members: Array<{ project_id: string; script_id: string }>) =>
    callRaw('create_group', { name, members }),
  updateGroup: (
    id: string,
    patch: { name?: string; members?: Array<{ project_id: string; script_id: string }> },
  ) => callRaw('update_group', { id, ...patch }),
  deleteGroup: (id: string) => callRaw<null>('delete_group', { id }),
  runGroup: (id: string) => callRaw('run_group', { id }),

  // Ports
  listPorts: () => call('list_ports', {}, z.array(PortInfoSchema)),
  killPort: (port: number) => callRaw<null>('kill_port', { port }),
};

export type { Project, Script, ProjectCandidate, LogLine, PortInfo, ProcessSnapshot, StatusEvent, RuntimeStatus };
