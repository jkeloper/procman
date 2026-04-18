// Typed Tauri invoke wrappers with runtime zod validation.

import { invoke } from '@tauri-apps/api/core';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { z } from 'zod';
import {
  ProjectSchema,
  ScriptSchema,
  ProjectCandidateSchema,
  LaunchConfigCandidateSchema,
  NamedTunnelSchema,
  RunningCloudflaredSchema,
  CfInstalledSchema,
  LogLineSchema,
  LogLineRecordSchema,
  LogStorageStatsSchema,
  PortInfoSchema,
  ProcessSnapshotSchema,
  DeclaredPortStatusSchema,
  PortConflictSchema,
  AppSettingsSchema,
  ComposeProjectSchema,
  ComposeServiceSchema,
  type Project,
  type Script,
  type PortSpec,
  type AutoRestartPolicy,
  type AppSettings,
  type DeclaredPortStatus,
  type PortConflict,
  type ProjectCandidate,
  type LaunchConfigCandidate,
  type NamedTunnel,
  type RunningCloudflared,
  type CfInstalled,
  type LogLine,
  type LogLineRecord,
  type LogStorageStats,
  type PortInfo,
  type ProcessSnapshot,
  type StatusEvent,
  type RuntimeStatus,
  type ComposeProject,
  type ComposeService,
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
  reorderProjects: (ids: string[]) => callRaw<null>('reorder_projects', { ids }),

  // Scripts
  listScripts: (projectId: string) =>
    call('list_scripts', { projectId }, z.array(ScriptSchema)),
  createScript: (
    projectId: string,
    name: string,
    command: string,
    expectedPort: number | null,
    autoRestart: boolean,
    envFile?: string | null,
    ports?: PortSpec[],
    dependsOn?: string[],
  ) =>
    call(
      'create_script',
      {
        projectId,
        name,
        command,
        expectedPort,
        autoRestart,
        envFile: envFile ?? null,
        ports: ports ?? [],
        dependsOn: dependsOn ?? [],
      },
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
      autoRestartPolicy?: AutoRestartPolicy | null;
      envFile?: string | null;
      ports?: PortSpec[];
      dependsOn?: string[];
    },
  ) => call('update_script', { projectId, id, ...patch }, ScriptSchema),
  deleteScript: (projectId: string, id: string) =>
    call('delete_script', { projectId, id }, z.void()),
  reorderScripts: (projectId: string, ids: string[]) =>
    callRaw<null>('reorder_scripts', { projectId, ids }),

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
  clearLog: (scriptId: string) => callRaw<null>('clear_log', { scriptId }),
  forceQuit: () => callRaw<null>('force_quit', {}),

  // Persistent log search (Worker K). `query` is FTS5 MATCH syntax; empty
  // string returns the most-recent N rows respecting the optional filters.
  searchLog: (
    query: string,
    scriptId?: string | null,
    sinceMs?: number | null,
    limit?: number,
  ) =>
    call(
      'search_log',
      {
        query,
        scriptId: scriptId ?? null,
        sinceMs: sinceMs ?? null,
        limit: limit ?? null,
      },
      z.array(LogLineRecordSchema),
    ),
  getLogStorageStats: () =>
    call('get_log_storage_stats', {}, LogStorageStatsSchema),

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
  resolvePidToScript: (pid: number) =>
    call('resolve_pid_to_script', { pid }, z.string().nullable()),
  listPortsForScriptPid: (rootPid: number) =>
    call('list_ports_for_script_pid', { rootPid }, z.array(PortInfoSchema)),
  // S1: declared-port APIs (backend lookup_script scans all projects)
  portStatusForScript: (scriptId: string) =>
    call('port_status_for_script', { scriptId }, z.array(DeclaredPortStatusSchema)),
  checkPortConflicts: (scriptId: string) =>
    call('check_port_conflicts', { scriptId }, z.array(PortConflictSchema)),
  listPortsForScript: (scriptId: string) =>
    call('list_ports_for_script', { scriptId }, z.array(PortInfoSchema)),
  listDescendantPids: (rootPids: number[]) =>
    callRaw<number[]>('list_descendant_pids', { rootPids }),
  getPortAliases: () =>
    callRaw<Record<string, string>>('get_port_aliases', {}),
  setPortAlias: (port: number, alias: string) =>
    callRaw<null>('set_port_alias', { port, alias }),

  // Tunnel (external access) — per-script
  startTunnel: (port: number, scriptId: string) =>
    callRaw<{
      running: boolean;
      url: string | null;
      pid: number | null;
      port: number | null;
      script_id: string | null;
    }>('start_tunnel', { port, scriptId }),
  stopTunnel: (scriptId: string) => callRaw<null>('stop_tunnel', { scriptId }),
  tunnelStatus: () =>
    callRaw<Array<{ script_id: string; url: string; pid: number; port: number }>>(
      'tunnel_status',
      {},
    ),

  // Remote server
  serverStatus: () =>
    callRaw<{
      running: boolean;
      port: number | null;
      mode: 'loopback' | 'lan' | null;
      token: string;
    }>('server_status', {}),
  startServer: (port: number, mode: 'loopback' | 'lan') =>
    callRaw('start_server', { port, mode }),
  stopServer: () => callRaw<null>('stop_server', {}),
  rotateToken: () => callRaw<string>('rotate_token', {}),
  getAuditLog: () =>
    callRaw<
      Array<{
        ts_ms: number;
        action: string;
        target: string;
        ok: boolean;
        detail: string | null;
      }>
    >('get_audit_log', {}),
  localIp: () => callRaw<string>('local_ip', {}),

  // Settings (v3)
  getSettings: () => call('get_settings', {}, AppSettingsSchema),
  updateSettings: (patch: Partial<AppSettings>) =>
    call('update_settings', { patch }, AppSettingsSchema),

  // Autostart (v3) — wraps tauri-plugin-autostart
  getAutostartStatus: () => callRaw<boolean>('get_autostart_status', {}),
  setAutostart: (enabled: boolean) =>
    callRaw<null>('set_autostart', { enabled }),

  // VSCode
  scanVscodeConfigs: (projectPath: string) =>
    call('scan_vscode_configs', { projectPath }, z.array(LaunchConfigCandidateSchema)),

  // Cloudflared
  cloudflaredInstalled: () => call('cloudflared_installed', {}, CfInstalledSchema),
  listCfTunnels: () => call('list_cf_tunnels', {}, z.array(NamedTunnelSchema)),
  detectRunningCloudflared: () =>
    call('detect_running_cloudflared', {}, z.array(RunningCloudflaredSchema)),
  killCloudflaredPid: (pid: number) => callRaw<null>('kill_cloudflared_pid', { pid }),

  // Docker Compose (Worker J)
  composeInstalled: () => callRaw<boolean>('compose_installed', {}),
  composeProjectsList: () =>
    call('compose_projects_list', {}, z.array(ComposeProjectSchema)),
  composeAddProject: (name: string, composePath: string, projectName: string | null) =>
    call(
      'compose_add_project',
      { name, composePath, projectName },
      ComposeProjectSchema,
    ),
  composeRemoveProject: (id: string) =>
    callRaw<null>('compose_remove_project', { id }),
  composeUp: (id: string) => callRaw<null>('compose_up', { id }),
  composeDown: (id: string) => callRaw<null>('compose_down', { id }),
  composePs: (id: string) =>
    call('compose_ps', { id }, z.array(ComposeServiceSchema)),
};

// Auto-update — GitHub Releases 기반. pubkey/endpoints 는 tauri.conf.json.
export interface UpdateCheckResult {
  available: boolean;
  version?: string;
  notes?: string;
}

export async function checkForUpdates(): Promise<UpdateCheckResult> {
  const update = await check();
  if (update) {
    return {
      available: true,
      version: update.version,
      notes: update.body ?? undefined,
    };
  }
  return { available: false };
}

export async function installUpdateAndRestart(
  onProgress?: (chunk: number, total?: number) => void,
): Promise<boolean> {
  const update = await check();
  if (!update) return false;
  let total: number | undefined;
  await update.downloadAndInstall((event) => {
    if (event.event === 'Started') {
      total = event.data.contentLength;
    } else if (event.event === 'Progress' && onProgress) {
      onProgress(event.data.chunkLength, total);
    }
  });
  await relaunch();
  return true;
}

export type {
  Project,
  Script,
  PortSpec,
  AutoRestartPolicy,
  AppSettings,
  DeclaredPortStatus,
  PortConflict,
  ProjectCandidate,
  LaunchConfigCandidate,
  NamedTunnel,
  RunningCloudflared,
  CfInstalled,
  LogLine,
  LogLineRecord,
  LogStorageStats,
  PortInfo,
  ProcessSnapshot,
  StatusEvent,
  RuntimeStatus,
  ComposeProject,
  ComposeService,
};
