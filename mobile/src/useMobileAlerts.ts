import { useCallback, useEffect, useRef } from 'react';
import { api, type PortConflict, type ProjectsPayload, type StreamEvent } from './api';
import { baseUrl } from './pair';
import {
  notifyProcman,
  type MobileNotificationSettings,
} from './notifications';

interface UseMobileAlertsOptions {
  projects: ProjectsPayload['projects'];
  connected: boolean;
  loadError: string | null;
  settings: MobileNotificationSettings;
}

export function useMobileAlerts({
  projects,
  connected,
  loadError,
  settings,
}: UseMobileAlertsOptions) {
  const settingsRef = useRef(settings);
  const namesRef = useRef<Map<string, string>>(new Map());
  const announcedCrashesRef = useRef<Set<string>>(new Set());
  const activeConflictKeysRef = useRef<Set<string>>(new Set());
  const hadConnectionRef = useRef(false);
  const unreachableNotifiedRef = useRef(false);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    const next = new Map<string, string>();
    for (const project of projects) {
      for (const script of project.scripts) {
        next.set(script.id, `${project.name}/${script.name}`);
      }
    }
    namesRef.current = next;
  }, [projects]);

  const notifyProcessStatus = useCallback((event: StreamEvent) => {
    if (event.type !== 'status' || event.status !== 'crashed') return;
    const current = settingsRef.current;
    if (!current.enabled || !current.processCrashes) return;

    const key = `${event.id}:${event.ts_ms}:${event.exit_code ?? 'x'}`;
    if (announcedCrashesRef.current.has(key)) return;
    announcedCrashesRef.current.add(key);
    trimSet(announcedCrashesRef.current, 100);

    const scriptName = namesRef.current.get(event.id) ?? event.id;
    const exit = event.exit_code == null ? 'unknown exit code' : `exit code ${event.exit_code}`;
    void notifyProcman(
      'process_crash',
      `${scriptName} crashed`,
      `procman detected ${exit}.`,
      { scriptId: event.id, exitCode: event.exit_code, tsMs: event.ts_ms },
    );
  }, []);

  useEffect(() => {
    if (connected) {
      hadConnectionRef.current = true;
      unreachableNotifiedRef.current = false;
      return;
    }

    const current = settingsRef.current;
    if (
      !current.enabled ||
      !current.unreachable ||
      !hadConnectionRef.current ||
      unreachableNotifiedRef.current
    ) {
      return;
    }

    const timer = window.setTimeout(() => {
      const latest = settingsRef.current;
      if (unreachableNotifiedRef.current || !latest.enabled || !latest.unreachable) return;
      unreachableNotifiedRef.current = true;
      const detail = loadError ? `Last error: ${shorten(loadError, 96)}` : 'The remote API did not respond.';
      void notifyProcman(
        'unreachable',
        'procman is unreachable',
        `${baseUrl()} is offline. ${detail}`,
      );
    }, current.unreachableAfterMs);

    return () => window.clearTimeout(timer);
  }, [connected, loadError, settings]);

  useEffect(() => {
    const current = settingsRef.current;
    if (!connected || !current.enabled || !current.portConflicts) return;

    const targets = projects
      .flatMap((project) =>
        project.scripts.map((script) => ({
          id: script.id,
          name: `${project.name}/${script.name}`,
          ports: script.ports,
        })),
      )
      .filter((script) => script.ports.length > 0);

    if (targets.length === 0) {
      activeConflictKeysRef.current.clear();
      return;
    }

    let cancelled = false;

    async function tick() {
      const activeKeys = new Set<string>();
      const fresh: Array<{ scriptName: string; conflict: PortConflict }> = [];

      await Promise.all(
        targets.map(async (script) => {
          try {
            const conflicts = await api.portConflicts(script.id);
            for (const conflict of conflicts) {
              const key = conflictKey(script.id, conflict);
              activeKeys.add(key);
              if (!activeConflictKeysRef.current.has(key)) {
                fresh.push({ scriptName: script.name, conflict });
              }
            }
          } catch {
            // Connectivity is handled by the unreachable watcher.
          }
        }),
      );

      if (cancelled) return;
      activeConflictKeysRef.current = activeKeys;
      if (fresh.length === 0) return;

      const first = fresh[0];
      const suffix = fresh.length > 1 ? ` (+${fresh.length - 1} more)` : '';
      void notifyProcman(
        'port_conflict',
        `Port conflict detected${suffix}`,
        describeConflict(first.scriptName, first.conflict),
        { count: fresh.length, port: first.conflict.spec.number },
      );
    }

    void tick();
    const interval = window.setInterval(tick, current.conflictPollIntervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [connected, projects, settings]);

  return { notifyProcessStatus };
}

function conflictKey(scriptId: string, conflict: PortConflict): string {
  return `${scriptId}:${conflict.spec.number}:${conflict.holder_pid}:${conflict.severity}`;
}

function describeConflict(scriptName: string, conflict: PortConflict): string {
  const label = conflict.spec.name
    ? `${conflict.spec.name}:${conflict.spec.number}`
    : `:${conflict.spec.number}`;
  return `${scriptName} cannot use ${label}; pid ${conflict.holder_pid} owns it (${shorten(
    conflict.holder_command,
    80,
  )}).`;
}

function shorten(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 3))}...`;
}

function trimSet<T>(set: Set<T>, max: number) {
  while (set.size > max) {
    const first = set.values().next();
    if (first.done) break;
    set.delete(first.value);
  }
}
