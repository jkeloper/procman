// WS6: AllRunningView aggregates running/crashed scripts across all projects
// into one Mission-Control list. These tests cover the empty state, the
// crashed-first ordering, project labelling, the summary counters, and
// (WS7) the per-call-projectId Start flow + crashed-only ✕ semantics.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

// useTunnelLauncher calls api.tunnelStatus() on mount; useScriptActions.start
// spawns. Stub the whole api so no real Tauri calls happen. The spawn spy is
// hoisted so the (hoisted) vi.mock factory can reference it.
const { spawnProcess } = vi.hoisted(() => ({
  spawnProcess: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/api/tauri', async () => {
  const actual = await vi.importActual<typeof import('@/api/tauri')>(
    '@/api/tauri',
  );
  return {
    ...actual,
    api: {
      ...actual.api,
      tunnelStatus: vi.fn().mockResolvedValue([]),
      listPorts: vi.fn().mockResolvedValue([]),
      checkPortConflicts: vi.fn().mockResolvedValue([]),
      spawnProcess,
    },
  };
});

import { AllRunningView } from '../AllRunningView';
import { RuntimeStatusContext, EMPTY_PROCESS_STATUS } from '@/context/runtimeStatus';
import type { ProcessStatusState } from '@/context/runtimeStatus';
import type { Project, RuntimeStatus } from '@/api/tauri';

function mkScript(id: string, name: string) {
  return {
    id,
    name,
    command: `echo ${name}`,
    ports: [],
    auto_restart: false,
    auto_restart_policy: null,
    env_file: null,
    schedule: null,
    depends_on: [],
  };
}

const projects: Project[] = [
  {
    id: 'web',
    name: 'web-app',
    path: '/tmp/web',
    scripts: [mkScript('s1', 'dev'), mkScript('s2', 'build')],
  },
  {
    id: 'api',
    name: 'api-server',
    path: '/tmp/api',
    scripts: [mkScript('s3', 'serve')],
  },
];

async function renderWith(
  statuses: Record<string, RuntimeStatus>,
  metrics: ProcessStatusState['metrics'] = {},
  kinds: ProcessStatusState['kinds'] = {},
) {
  const value: ProcessStatusState = {
    ...EMPTY_PROCESS_STATUS,
    statuses,
    metrics,
    kinds,
    runtimeLoading: false,
  };
  const utils = render(
    <RuntimeStatusContext.Provider value={value}>
      <AllRunningView projects={projects} />
    </RuntimeStatusContext.Provider>,
  );
  // Flush the useTunnelLauncher mount effect (api.tunnelStatus()).
  await act(async () => {
    await Promise.resolve();
  });
  return utils;
}

describe('AllRunningView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the empty state when nothing is running or crashed', async () => {
    await renderWith({ s1: 'stopped', s2: 'stopped', s3: 'stopped' });
    expect(screen.getByText('Nothing is running')).toBeInTheDocument();
  });

  it('lists only running/crashed scripts with their project labels', async () => {
    await renderWith({ s1: 'running', s2: 'stopped', s3: 'crashed' });
    // s1 (running) and s3 (crashed) appear; s2 (stopped) does not.
    expect(screen.getByText('dev')).toBeInTheDocument();
    expect(screen.getByText('serve')).toBeInTheDocument();
    expect(screen.queryByText('build')).not.toBeInTheDocument();
    // Project labels are shown for context.
    expect(screen.getByText('web-app')).toBeInTheDocument();
    expect(screen.getByText('api-server')).toBeInTheDocument();
  });

  it('orders crashed entries before running ones', async () => {
    await renderWith({ s1: 'running', s3: 'crashed' });
    const rows = screen.getAllByRole('listitem');
    // First row is the crashed one (s3 / serve), second is running (s1 / dev).
    expect(within(rows[0]).getByText('serve')).toBeInTheDocument();
    expect(within(rows[1]).getByText('dev')).toBeInTheDocument();
  });

  it('summarises running, crashed, and aggregate CPU/RSS', async () => {
    await renderWith(
      { s1: 'running', s3: 'crashed' },
      {
        s1: { cpu: 12.5, rss: 102400 }, // 100 MB
        s3: { cpu: 0, rss: 0 },
      },
    );
    // Summary pills.
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(screen.getByText('Crashed')).toBeInTheDocument();
    expect(screen.getByText('12.5%')).toBeInTheDocument();
    expect(screen.getByText('100 MB')).toBeInTheDocument();
  });

  it('shows "All healthy" for the Crashed pill when nothing crashed', async () => {
    await renderWith({ s1: 'running' });
    expect(screen.getByText('All healthy')).toBeInTheDocument();
  });

  // WS7 §1: the global Start runs through useScriptActions with the row's
  // resolved projectId — no declared ports here, so it spawns directly.
  it('starts a crashed script against its owning project', async () => {
    await renderWith({ s3: 'crashed' });
    const rows = screen.getAllByRole('listitem');
    fireEvent.click(within(rows[0]).getByRole('button', { name: 'Start' }));
    await act(async () => {
      await Promise.resolve();
    });
    // s3 belongs to project "api".
    expect(spawnProcess).toHaveBeenCalledWith('api', 's3', false);
  });

  // WS7 §2: ✕ (close-circle) is crashed-dismiss only — hidden on running rows.
  it('hides the ✕ close-circle on running rows and shows it on crashed rows', async () => {
    await renderWith({ s1: 'running', s3: 'crashed' });
    const rows = screen.getAllByRole('listitem');
    // rows[0] is crashed (serve/s3) — has the ✕; rows[1] is running (dev/s1).
    expect(within(rows[0]).queryByText('✕')).toBeInTheDocument();
    expect(within(rows[1]).queryByText('✕')).not.toBeInTheDocument();
  });

  // WS9: a PTY-backed running row shows a "terminal" badge; a piped run does
  // not. The badge is display-only — stop/restart route identically.
  it('badges a pty-backed running row as "terminal" and leaves piped runs unbadged', async () => {
    await renderWith({ s1: 'running', s3: 'running' }, {}, { s1: 'pty', s3: 'piped' });
    const rows = screen.getAllByRole('listitem');
    // Both run; rows are sorted by project name (api-server < web-app), so
    // rows[0] = serve/s3 (piped), rows[1] = dev/s1 (pty).
    const ptyRow = within(rows[1]);
    const pipedRow = within(rows[0]);
    expect(within(rows[1]).getByText('dev')).toBeInTheDocument();
    expect(ptyRow.getByText('terminal')).toBeInTheDocument();
    expect(pipedRow.queryByText('terminal')).not.toBeInTheDocument();
  });
});
