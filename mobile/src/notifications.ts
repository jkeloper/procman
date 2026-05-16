import { LocalNotifications } from '@capacitor/local-notifications';
import type { PermissionState } from '@capacitor/core';

export type ProcmanNotificationKind = 'process_crash' | 'port_conflict' | 'unreachable';
export type NotificationCapability = PermissionState | 'unsupported';

export interface MobileNotificationSettings {
  enabled: boolean;
  processCrashes: boolean;
  portConflicts: boolean;
  unreachable: boolean;
  unreachableAfterMs: number;
  conflictPollIntervalMs: number;
}

const SETTINGS_KEY = 'procman.mobileNotifications';
const NEXT_ID_KEY = 'procman.mobileNotifications.nextId';

export const DEFAULT_NOTIFICATION_SETTINGS: MobileNotificationSettings = {
  enabled: false,
  processCrashes: true,
  portConflicts: true,
  unreachable: true,
  unreachableAfterMs: 15_000,
  conflictPollIntervalMs: 20_000,
};

export function loadNotificationSettings(): MobileNotificationSettings {
  const raw = localStorage.getItem(SETTINGS_KEY);
  if (!raw) return DEFAULT_NOTIFICATION_SETTINGS;
  try {
    const parsed = JSON.parse(raw) as Partial<MobileNotificationSettings>;
    return normalizeSettings(parsed);
  } catch {
    return DEFAULT_NOTIFICATION_SETTINGS;
  }
}

export function saveNotificationSettings(settings: MobileNotificationSettings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(normalizeSettings(settings)));
}

export async function checkNotificationPermission(): Promise<NotificationCapability> {
  try {
    const status = await LocalNotifications.checkPermissions();
    return status.display;
  } catch {
    return 'unsupported';
  }
}

export async function requestNotificationPermission(): Promise<NotificationCapability> {
  try {
    const current = await LocalNotifications.checkPermissions();
    if (current.display === 'granted' || current.display === 'denied') {
      return current.display;
    }
    const requested = await LocalNotifications.requestPermissions();
    return requested.display;
  } catch {
    return 'unsupported';
  }
}

export async function notifyProcman(
  kind: ProcmanNotificationKind,
  title: string,
  body: string,
  extra: Record<string, unknown> = {},
): Promise<boolean> {
  const permission = await checkNotificationPermission();
  if (permission !== 'granted') return false;

  try {
    await LocalNotifications.schedule({
      notifications: [
        {
          id: nextNotificationId(),
          title,
          body,
          largeBody: body,
          threadIdentifier: 'procman-alerts',
          relevanceScore: kind === 'unreachable' ? 0.9 : 0.75,
          interruptionLevel: 'active',
          autoCancel: true,
          extra: { kind, ...extra },
        },
      ],
    });
    return true;
  } catch {
    return false;
  }
}

function normalizeSettings(input: Partial<MobileNotificationSettings>): MobileNotificationSettings {
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : DEFAULT_NOTIFICATION_SETTINGS.enabled,
    processCrashes:
      typeof input.processCrashes === 'boolean'
        ? input.processCrashes
        : DEFAULT_NOTIFICATION_SETTINGS.processCrashes,
    portConflicts:
      typeof input.portConflicts === 'boolean'
        ? input.portConflicts
        : DEFAULT_NOTIFICATION_SETTINGS.portConflicts,
    unreachable:
      typeof input.unreachable === 'boolean'
        ? input.unreachable
        : DEFAULT_NOTIFICATION_SETTINGS.unreachable,
    unreachableAfterMs: clampNumber(
      input.unreachableAfterMs,
      5_000,
      120_000,
      DEFAULT_NOTIFICATION_SETTINGS.unreachableAfterMs,
    ),
    conflictPollIntervalMs: clampNumber(
      input.conflictPollIntervalMs,
      10_000,
      120_000,
      DEFAULT_NOTIFICATION_SETTINGS.conflictPollIntervalMs,
    ),
  };
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function nextNotificationId(): number {
  const current = Number.parseInt(localStorage.getItem(NEXT_ID_KEY) ?? '1000', 10);
  const next = Number.isFinite(current) ? current + 1 : 1001;
  const normalized = next > 2_000_000_000 ? 1001 : next;
  localStorage.setItem(NEXT_ID_KEY, String(normalized));
  return normalized;
}
