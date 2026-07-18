import { beforeEach, describe, expect, it, vi } from 'vitest';

const localNotificationMocks = vi.hoisted(() => ({
  checkPermissions: vi.fn(),
  requestPermissions: vi.fn(),
  schedule: vi.fn(),
}));

vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: localNotificationMocks,
}));

import {
  DEFAULT_NOTIFICATION_SETTINGS,
  checkNotificationPermission,
  loadNotificationSettings,
  notifyProcman,
  requestNotificationPermission,
  saveNotificationSettings,
} from '../notifications';

describe('mobile notification settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses safe defaults for missing or corrupt settings', () => {
    expect(loadNotificationSettings()).toEqual(DEFAULT_NOTIFICATION_SETTINGS);

    localStorage.setItem('procman.mobileNotifications', '{broken');
    expect(loadNotificationSettings()).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
  });

  it('normalizes partial settings and clamps polling thresholds', () => {
    saveNotificationSettings({
      enabled: true,
      processCrashes: false,
      portConflicts: true,
      unreachable: true,
      unreachableAfterMs: 1_234.9,
      conflictPollIntervalMs: 999_999,
    });

    expect(loadNotificationSettings()).toEqual({
      enabled: true,
      processCrashes: false,
      portConflicts: true,
      unreachable: true,
      unreachableAfterMs: 5_000,
      conflictPollIntervalMs: 120_000,
    });
  });
});

describe('mobile notification permissions and delivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('requests permission only while the state is prompt', async () => {
    localNotificationMocks.checkPermissions.mockResolvedValueOnce({ display: 'prompt' });
    localNotificationMocks.requestPermissions.mockResolvedValueOnce({ display: 'granted' });

    await expect(requestNotificationPermission()).resolves.toBe('granted');
    expect(localNotificationMocks.requestPermissions).toHaveBeenCalledOnce();

    localNotificationMocks.checkPermissions.mockResolvedValueOnce({ display: 'denied' });
    await expect(requestNotificationPermission()).resolves.toBe('denied');
    expect(localNotificationMocks.requestPermissions).toHaveBeenCalledOnce();
  });

  it('reports unsupported when the native permission bridge fails', async () => {
    localNotificationMocks.checkPermissions.mockRejectedValueOnce(new Error('not native'));

    await expect(checkNotificationPermission()).resolves.toBe('unsupported');
  });

  it('does not schedule when permission is not granted', async () => {
    localNotificationMocks.checkPermissions.mockResolvedValueOnce({ display: 'denied' });

    await expect(notifyProcman('process_crash', 'Crashed', 'worker stopped')).resolves.toBe(false);
    expect(localNotificationMocks.schedule).not.toHaveBeenCalled();
  });

  it('schedules native alerts with stable metadata and monotonic IDs', async () => {
    localNotificationMocks.checkPermissions.mockResolvedValue({ display: 'granted' });
    localNotificationMocks.schedule.mockResolvedValue(undefined);

    await expect(
      notifyProcman('unreachable', 'Offline', 'desktop is offline', { host: 'desktop.local' }),
    ).resolves.toBe(true);
    await expect(
      notifyProcman('port_conflict', 'Conflict', 'port 8080 is busy'),
    ).resolves.toBe(true);

    const first = localNotificationMocks.schedule.mock.calls[0][0].notifications[0];
    const second = localNotificationMocks.schedule.mock.calls[1][0].notifications[0];
    expect(first).toMatchObject({
      id: 1001,
      title: 'Offline',
      body: 'desktop is offline',
      threadIdentifier: 'procman-alerts',
      relevanceScore: 0.9,
      extra: { kind: 'unreachable', host: 'desktop.local' },
    });
    expect(second.id).toBe(1002);
    expect(second.extra).toEqual({ kind: 'port_conflict' });
  });

  it('returns false when native scheduling fails', async () => {
    localNotificationMocks.checkPermissions.mockResolvedValueOnce({ display: 'granted' });
    localNotificationMocks.schedule.mockRejectedValueOnce(new Error('schedule failed'));

    await expect(notifyProcman('process_crash', 'Crashed', 'worker stopped')).resolves.toBe(false);
  });
});
