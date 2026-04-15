// Runtime validation schemas mirroring Rust types in src-tauri/src/types.rs.
// Field names MUST match 1:1 — any drift fails zod.safeParse with a clear error.
import { z } from 'zod';

// --- Persisted config types ---

export const PortProtoSchema = z.enum(['tcp']);
export type PortProto = z.infer<typeof PortProtoSchema>;

export const PortSpecSchema = z.object({
  name: z.string(),
  number: z.number().int().min(1).max(65535),
  bind: z.string().default('127.0.0.1'),
  proto: PortProtoSchema.default('tcp'),
  optional: z.boolean().default(false),
  note: z.string().nullable().default(null),
});
export type PortSpec = z.infer<typeof PortSpecSchema>;

export const ScriptSchema = z.object({
  id: z.string(),
  name: z.string(),
  command: z.string(),
  expected_port: z.number().int().min(1).max(65535).nullable().default(null),
  ports: z.array(PortSpecSchema).default([]),
  auto_restart: z.boolean().default(false),
  env_file: z.string().nullable().default(null),
});
export type Script = z.infer<typeof ScriptSchema>;

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  scripts: z.array(ScriptSchema).default([]),
});
export type Project = z.infer<typeof ProjectSchema>;

export const GroupMemberSchema = z.object({
  project_id: z.string(),
  script_id: z.string(),
});
export type GroupMember = z.infer<typeof GroupMemberSchema>;

export const GroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  members: z.array(GroupMemberSchema).default([]),
});
export type Group = z.infer<typeof GroupSchema>;

export const AppSettingsSchema = z.object({
  log_buffer_size: z.number().int().default(5000),
  port_poll_interval_ms: z.number().int().default(1000),
  theme: z.string().default('system'),
});
export type AppSettings = z.infer<typeof AppSettingsSchema>;

export const AppConfigSchema = z.object({
  version: z.string(),
  projects: z.array(ProjectSchema).default([]),
  groups: z.array(GroupSchema).default([]),
  settings: AppSettingsSchema.default({
    log_buffer_size: 5000,
    port_poll_interval_ms: 1000,
    theme: 'system',
  }),
});
export type AppConfig = z.infer<typeof AppConfigSchema>;

// --- Runtime-only types (not persisted) ---

export const RuntimeStatusSchema = z.enum(['running', 'stopped', 'crashed']);
export type RuntimeStatus = z.infer<typeof RuntimeStatusSchema>;

export const StatusEventSchema = z.object({
  id: z.string(),
  status: RuntimeStatusSchema,
  pid: z.number().int().nullable(),
  exit_code: z.number().int().nullable(),
  ts_ms: z.number().int(),
  restart_count: z.number().int().default(0),
});
export type StatusEvent = z.infer<typeof StatusEventSchema>;

export const ProcessSnapshotSchema = z.object({
  id: z.string(),
  pid: z.number().int(),
  status: RuntimeStatusSchema,
  started_at_ms: z.number().int(),
  command: z.string(),
});
export type ProcessSnapshot = z.infer<typeof ProcessSnapshotSchema>;


export const LogStreamSchema = z.enum(['stdout', 'stderr']);
export type LogStream = z.infer<typeof LogStreamSchema>;

export const LogLineSchema = z.object({
  seq: z.number().int(),
  ts_ms: z.number().int(),
  stream: LogStreamSchema,
  text: z.string(),
});
export type LogLine = z.infer<typeof LogLineSchema>;

export const LaunchConfigCandidateSchema = z.object({
  name: z.string(),
  command: z.string(),
  cwd: z.string().nullable(),
  kind: z.string(),
  skipped_reason: z.string().nullable(),
  script: ScriptSchema.nullable(),
  raw_json: z.string(),
});
export type LaunchConfigCandidate = z.infer<typeof LaunchConfigCandidateSchema>;

export const NamedTunnelSchema = z.object({
  id: z.string(),
  name: z.string(),
  created_at: z.string().nullable(),
  connections: z.number().int(),
});
export type NamedTunnel = z.infer<typeof NamedTunnelSchema>;

export const RunningCloudflaredSchema = z.object({
  pid: z.number().int(),
  command: z.string(),
  url: z.string().nullable(),
  tunnel_name: z.string().nullable(),
});
export type RunningCloudflared = z.infer<typeof RunningCloudflaredSchema>;

export const CfInstalledSchema = z.object({
  installed: z.boolean(),
  version: z.string().nullable(),
});
export type CfInstalled = z.infer<typeof CfInstalledSchema>;

export const ProjectCandidateSchema = z.object({
  name: z.string(),
  path: z.string(),
  stacks: z.array(z.string()),
  scripts: z.array(ScriptSchema),
});
export type ProjectCandidate = z.infer<typeof ProjectCandidateSchema>;

// --- S1: declared-port status + conflict types ---

export const PortStateSchema = z.enum(['free', 'listening_managed', 'taken_by_other']);
export type PortState = z.infer<typeof PortStateSchema>;

export const DeclaredPortStatusSchema = z.object({
  spec: PortSpecSchema,
  state: PortStateSchema,
  holder_pid: z.number().int().nullable().default(null),
  holder_command: z.string().nullable().default(null),
  owned_by_script: z.boolean().default(false),
});
export type DeclaredPortStatus = z.infer<typeof DeclaredPortStatusSchema>;

export const ConflictSeveritySchema = z.enum(['blocking', 'warning']);
export type ConflictSeverity = z.infer<typeof ConflictSeveritySchema>;

export const PortConflictSchema = z.object({
  spec: PortSpecSchema,
  severity: ConflictSeveritySchema,
  holder_pid: z.number().int(),
  holder_command: z.string(),
});
export type PortConflict = z.infer<typeof PortConflictSchema>;

export const PortInfoSchema = z.object({
  port: z.number().int().min(1).max(65535),
  pid: z.number().int(),
  process_name: z.string(),
  command: z.string().default(''),
});
export type PortInfo = z.infer<typeof PortInfoSchema>;
