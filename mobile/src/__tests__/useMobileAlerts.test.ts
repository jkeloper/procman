import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PortConflict, ProjectsPayload, StreamEvent } from '../api';
import type { MobileNotificationSettings } from '../notifications';

const alertMocks = vi.hoisted(() => ({
  notifyProcman: vi.fn(),
  portConflicts: vi.fn(),
  baseUrl: vi.fn(() => 'https://desktop.local:9443'),
}));

vi.mock('../notifications', () => ({
  notifyProcman: alertMocks.notifyProcman,
}));

vi.mock('../api', () => ({
  api: { portConflicts: alertMocks.portConflicts },
}));

vi.mock('../pair', () => ({
  baseUrl: alertMocks.baseUrl,
}));

import { useMobileAlerts } from '../useMobileAlerts';

const projects: ProjectsPayload['projects'] = [
  {
    id: 'project',
    name: 'Workspace',
    scripts: [
      {
        id: 'worker',
        name: 'Worker',
        command: 'pnpm worker',
        ports: [
          { name: 'http', number: 8080, bind: '127.0.0.1', optional: false, note: null },
        ],
        auto_restart: false,
        schedule: null,
        depends_on: [],
      },
    ],
  },
];

const settings: MobileNotificationSettings = {
  enabled: true,
  processCrashes: true,
  portConflicts: true,
  unreachable: true,
  unreachableAfterMs: 15_000,
  conflictPollIntervalMs: 20_000,
};

const blockingConflict: PortConflict = {
  spec: { name: 'http', number: 8080, bind: '127.0.0.1', optional: false, note: null },
  severity: 'blocking',
  holder_pid: 123,
  holder_command: 'node server.js',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe('useMobileAlerts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    alertMocks.notifyProcman.mockResolvedValue(true);
    alertMocks.portConflicts.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('names crash alerts and suppresses duplicate stream events', () => {
    const { result } = renderHook(() =>
      useMobileAlerts({ projects, connected: true, loadError: null, settings }),
    );
    const crash: StreamEvent = {
      type: 'status',
      id: 'worker',
      status: 'crashed',
      pid: null,
      exit_code: 7,
      ts_ms: 42,
    };

    act(() => {
      result.current.notifyProcessStatus(crash);
      result.current.notifyProcessStatus(crash);
      result.current.notifyProcessStatus({ ...crash, status: 'running' });
    });

    expect(alertMocks.notifyProcman).toHaveBeenCalledOnce();
    expect(alertMocks.notifyProcman).toHaveBeenCalledWith(
      'process_crash',
      'Workspace/Worker crashed',
      'procman detected exit code 7.',
      { scriptId: 'worker', exitCode: 7, tsMs: 42 },
    );
  });

  it('waits through the unreachable grace period and cancels on reconnect', () => {
    vi.useFakeTimers();
    const initialProps = { projects, connected: true, loadError: null as string | null, settings };
    const { rerender } = renderHook((props) => useMobileAlerts(props), { initialProps });

    rerender({ ...initialProps, connected: false, loadError: 'connection refused' });
    act(() => vi.advanceTimersByTime(14_999));
    expect(alertMocks.notifyProcman).not.toHaveBeenCalled();

    rerender(initialProps);
    act(() => vi.advanceTimersByTime(1));
    expect(alertMocks.notifyProcman).not.toHaveBeenCalled();

    rerender({ ...initialProps, connected: false, loadError: 'connection refused' });
    act(() => vi.advanceTimersByTime(15_000));
    expect(alertMocks.notifyProcman).toHaveBeenCalledWith(
      'unreachable',
      'procman is unreachable',
      'https://desktop.local:9443 is offline. Last error: connection refused',
    );
  });

  it('announces only newly observed port conflicts', async () => {
    alertMocks.portConflicts.mockResolvedValue([blockingConflict]);
    const initialProps = { projects, connected: true, loadError: null, settings };
    const { rerender } = renderHook((props) => useMobileAlerts(props), { initialProps });

    await waitFor(() => expect(alertMocks.notifyProcman).toHaveBeenCalledOnce());
    expect(alertMocks.notifyProcman).toHaveBeenCalledWith(
      'port_conflict',
      'Port conflict detected',
      'Workspace/Worker cannot use http:8080; pid 123 owns it (node server.js).',
      { count: 1, port: 8080 },
    );

    rerender({ ...initialProps, settings: { ...settings } });
    await waitFor(() => expect(alertMocks.portConflicts).toHaveBeenCalledTimes(2));
    expect(alertMocks.notifyProcman).toHaveBeenCalledOnce();
  });

  it('skips overlapping conflict polls and resumes after the active poll completes', async () => {
    vi.useFakeTimers();
    const firstPoll = deferred<PortConflict[]>();
    alertMocks.portConflicts
      .mockReset()
      .mockReturnValueOnce(firstPoll.promise)
      .mockResolvedValue([blockingConflict]);

    renderHook(() =>
      useMobileAlerts({ projects, connected: true, loadError: null, settings }),
    );
    expect(alertMocks.portConflicts).toHaveBeenCalledOnce();

    act(() => vi.advanceTimersByTime(60_000));
    expect(alertMocks.portConflicts).toHaveBeenCalledOnce();
    expect(alertMocks.notifyProcman).not.toHaveBeenCalled();

    await act(async () => {
      firstPoll.resolve([blockingConflict]);
      await firstPoll.promise;
      await Promise.resolve();
    });
    expect(alertMocks.notifyProcman).toHaveBeenCalledOnce();

    await act(async () => {
      vi.advanceTimersByTime(20_000);
      await Promise.resolve();
    });
    expect(alertMocks.portConflicts).toHaveBeenCalledTimes(2);
    expect(alertMocks.notifyProcman).toHaveBeenCalledOnce();
  });
});
