// Runtime validation schemas mirroring Rust types in src-tauri/src/types.rs.
// These catch mismatches between frontend and backend at the IPC boundary
// instead of letting them fail silently.
//
// Keep field names + enum variants in sync with types.rs.
import { z } from 'zod';

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const ScriptSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  name: z.string(),
  command: z.string(),
  expected_port: z.number().int().min(1).max(65535).nullable(),
});
export type Script = z.infer<typeof ScriptSchema>;

export const ProcessStatusSchema = z.enum(['running', 'stopped', 'error']);
export type ProcessStatus = z.infer<typeof ProcessStatusSchema>;

export const ProcessHandleSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  script_id: z.string(),
  status: ProcessStatusSchema,
  pid: z.number().int().nullable(),
  started_at_ms: z.number().int().nullable(),
});
export type ProcessHandle = z.infer<typeof ProcessHandleSchema>;

export const LogStreamSchema = z.enum(['stdout', 'stderr']);
export type LogStream = z.infer<typeof LogStreamSchema>;

export const LogLineSchema = z.object({
  ts_ms: z.number().int(),
  stream: LogStreamSchema,
  text: z.string(),
});
export type LogLine = z.infer<typeof LogLineSchema>;

export const PortInfoSchema = z.object({
  port: z.number().int().min(1).max(65535),
  pid: z.number().int(),
  process_name: z.string(),
});
export type PortInfo = z.infer<typeof PortInfoSchema>;
