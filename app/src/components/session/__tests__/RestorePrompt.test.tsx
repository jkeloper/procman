// Light smoke test: RestorePrompt must NOT open when there are no projects
// and must NOT call get_last_running more than once across rerenders (the
// `checkedRef` guard in the component).

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';

const invokeMock = vi.fn();
const spawnProcessMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

// Mock the api module so RestorePrompt's api.spawnProcess doesn't escape.
vi.mock('@/api/tauri', async () => {
  const actual = await vi.importActual<typeof import('@/api/tauri')>(
    '@/api/tauri',
  );
  return {
    ...actual,
    api: {
      ...actual.api,
      spawnProcess: (...args: unknown[]) => spawnProcessMock(...args),
    },
  };
});

import { RestorePrompt } from '../RestorePrompt';
import type { Project } from '@/api/tauri';

describe('RestorePrompt', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    spawnProcessMock.mockReset();
  });

  it('does not invoke get_last_running when projects list is empty', async () => {
    render(<RestorePrompt projects={[]} />);
    // Give the effect a tick.
    await new Promise((r) => setTimeout(r, 0));
    expect(invokeMock).not.toHaveBeenCalledWith('get_last_running');
  });

  it('invokes get_last_running exactly once when projects become non-empty', async () => {
    invokeMock.mockResolvedValue([]); // no last_running
    const projects: Project[] = [
      { id: 'p1', name: 'web', path: '/tmp/web', scripts: [] },
    ];
    const { rerender } = render(<RestorePrompt projects={projects} />);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('get_last_running'),
    );
    // Rerender with the same projects (reference-identical or not) — the
    // checkedRef guard must prevent re-calling.
    rerender(<RestorePrompt projects={[...projects]} />);
    await new Promise((r) => setTimeout(r, 10));
    const calls = invokeMock.mock.calls.filter(
      (c) => c[0] === 'get_last_running',
    );
    expect(calls).toHaveLength(1);
  });

  it('clears last_running when no ids match current config', async () => {
    // Backend says ["ghost"] was running, but no project/script matches.
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'get_last_running') return Promise.resolve(['ghost']);
      if (cmd === 'clear_last_running') return Promise.resolve(null);
      return Promise.resolve(null);
    });
    const projects: Project[] = [
      { id: 'p1', name: 'web', path: '/tmp/web', scripts: [] },
    ];
    render(<RestorePrompt projects={projects} />);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('clear_last_running'),
    );
  });
});
