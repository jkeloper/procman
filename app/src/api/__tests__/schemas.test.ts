// Zod schema round-trip tests for procman FE.
//
// Goals:
//   1. Defaults populate correctly on minimal input.
//   2. round-trip (JSON stringify → parse → schema.parse) preserves shape.
//   3. port_aliases is preserved as a string-keyed record.
//   4. depends_on defaults to [] (S4 invariant).

import { describe, expect, it } from 'vitest';
import {
  AppConfigSchema,
  AppSettingsSchema,
  ScriptSchema,
  PortSpecSchema,
  DeclaredPortStatusSchema,
  ProcessSnapshotSchema,
} from '../schemas';

describe('AppSettingsSchema', () => {
  it('applies defaults when given an empty object', () => {
    const parsed = AppSettingsSchema.parse({});
    expect(parsed.log_buffer_size).toBe(5000);
    expect(parsed.port_poll_interval_ms).toBe(1000);
    expect(parsed.theme).toBe('system');
    expect(parsed.port_aliases).toEqual({});
  });

  it('preserves port_aliases values through round-trip', () => {
    const input = {
      log_buffer_size: 5000,
      port_poll_interval_ms: 1000,
      theme: 'dark',
      port_aliases: { '3000': 'Frontend', '5432': 'Postgres' },
    };
    const parsed = AppSettingsSchema.parse(input);
    const back = AppSettingsSchema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(back.port_aliases).toEqual(input.port_aliases);
  });
});

describe('ScriptSchema', () => {
  it('defaults depends_on to empty array (S4)', () => {
    const parsed = ScriptSchema.parse({
      id: 's1',
      name: 'dev',
      command: 'pnpm dev',
    });
    expect(parsed.depends_on).toEqual([]);
    expect(parsed.ports).toEqual([]);
    expect(parsed.auto_restart).toBe(false);
    expect(parsed.env_file).toBeNull();
    expect(parsed.expected_port).toBeNull();
  });

  it('preserves depends_on list verbatim', () => {
    const parsed = ScriptSchema.parse({
      id: 'a',
      name: 'api',
      command: 'node api',
      depends_on: ['db', 'redis'],
    });
    expect(parsed.depends_on).toEqual(['db', 'redis']);
  });
});

describe('PortSpecSchema', () => {
  it('applies default bind/proto/optional', () => {
    const spec = PortSpecSchema.parse({ name: 'http', number: 8080 });
    expect(spec.bind).toBe('127.0.0.1');
    expect(spec.proto).toBe('tcp');
    expect(spec.optional).toBe(false);
    expect(spec.note).toBeNull();
  });

  it('rejects port 0 and >65535', () => {
    expect(() => PortSpecSchema.parse({ name: 'x', number: 0 })).toThrow();
    expect(() => PortSpecSchema.parse({ name: 'x', number: 70000 })).toThrow();
  });
});

describe('AppConfigSchema round-trip', () => {
  it('round-trips a realistic v2 config', () => {
    const cfg = {
      version: '2',
      projects: [
        {
          id: 'p1',
          name: 'web',
          path: '/tmp/web',
          scripts: [
            {
              id: 's1',
              name: 'dev',
              command: 'pnpm dev',
              expected_port: 5173,
              ports: [
                {
                  name: 'http',
                  number: 5173,
                  bind: '127.0.0.1',
                  proto: 'tcp' as const,
                  optional: false,
                  note: null,
                },
              ],
              auto_restart: false,
              env_file: null,
              depends_on: [],
            },
          ],
        },
      ],
      groups: [],
      settings: {
        log_buffer_size: 5000,
        port_poll_interval_ms: 1000,
        theme: 'system',
        port_aliases: {},
      },
    };
    const first = AppConfigSchema.parse(cfg);
    const back = AppConfigSchema.parse(JSON.parse(JSON.stringify(first)));
    expect(back).toEqual(first);
  });

  it('accepts a minimal config with only version', () => {
    const parsed = AppConfigSchema.parse({ version: '3' });
    expect(parsed.projects).toEqual([]);
    expect(parsed.groups).toEqual([]);
    expect(parsed.settings.log_buffer_size).toBe(5000);
  });

  it('ignores unknown top-level keys (forward compat)', () => {
    // zod default behaviour is passthrough-strip; future Worker F fields
    // like lan_mode_opt_in inside settings will not throw on older clients.
    const parsed = AppConfigSchema.parse({
      version: '3',
      projects: [],
      groups: [],
      settings: {
        log_buffer_size: 5000,
        port_poll_interval_ms: 1000,
        theme: 'system',
        port_aliases: {},
        // Unknown fields — schema should strip, not throw.
        lan_mode_opt_in: true,
        start_at_login: false,
        onboarded: true,
      },
    });
    expect(parsed.settings.log_buffer_size).toBe(5000);
  });
});

describe('Runtime-only schemas', () => {
  it('DeclaredPortStatusSchema defaults reachable to null', () => {
    const s = DeclaredPortStatusSchema.parse({
      spec: { name: 'http', number: 8080 },
      state: 'free',
    });
    expect(s.reachable).toBeNull();
    expect(s.owned_by_script).toBe(false);
    expect(s.holder_pid).toBeNull();
  });

  it('ProcessSnapshotSchema defaults cpu/rss to null (S3)', () => {
    const snap = ProcessSnapshotSchema.parse({
      id: 's1',
      pid: 1234,
      status: 'running',
      started_at_ms: 1_700_000_000_000,
      command: 'node api.js',
    });
    expect(snap.cpu_pct).toBeNull();
    expect(snap.rss_kb).toBeNull();
  });
});
