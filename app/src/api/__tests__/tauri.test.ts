// Tests the `api` wrapper in src/api/tauri.ts.
//
// We mock `@tauri-apps/api/core` so invoke() returns a caller-controlled
// payload. The wrapper MUST validate the response shape against its zod
// schema and throw a descriptive "IPC schema drift" error on mismatch.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

// Import AFTER the mock is registered.
import { api } from '../tauri';

describe('api wrapper (mocked invoke)', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  afterEach(() => {
    invokeMock.mockReset();
  });

  it('listProjects forwards the correct command and validates response', async () => {
    invokeMock.mockResolvedValueOnce([
      { id: 'p1', name: 'web', path: '/tmp/web', scripts: [] },
    ]);
    const out = await api.listProjects();
    expect(invokeMock).toHaveBeenCalledWith('list_projects', {});
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('p1');
  });

  it('throws an IPC schema drift error on invalid response', async () => {
    invokeMock.mockResolvedValueOnce([
      // Missing required `path` — zod should reject.
      { id: 'p1', name: 'web', scripts: [] },
    ]);
    await expect(api.listProjects()).rejects.toThrow(/IPC schema drift/);
  });

  it('createScript wires camelCase args + applies script defaults', async () => {
    invokeMock.mockResolvedValueOnce({
      id: 's1',
      name: 'dev',
      command: 'pnpm dev',
    });
    const out = await api.createScript('p1', 'dev', 'pnpm dev', null, false);
    expect(invokeMock).toHaveBeenCalledWith(
      'create_script',
      expect.objectContaining({
        projectId: 'p1',
        name: 'dev',
        command: 'pnpm dev',
        expectedPort: null,
        autoRestart: false,
        envFile: null,
        ports: [],
        dependsOn: [],
      }),
    );
    // Default population from schema.
    expect(out.depends_on).toEqual([]);
    expect(out.ports).toEqual([]);
  });

  it('spawnProcess returns the raw number without schema validation', async () => {
    invokeMock.mockResolvedValueOnce(42);
    const pid = await api.spawnProcess('p1', 's1');
    expect(pid).toBe(42);
    expect(invokeMock).toHaveBeenCalledWith('spawn_process', {
      projectId: 'p1',
      scriptId: 's1',
    });
  });
});
