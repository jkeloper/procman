import type { ShutdownEvent } from '@/api/tauri';

/** True while a shutdown is in progress (not yet stopped / not_running). */
export function isShutdownActive(evt: ShutdownEvent | undefined): boolean {
  return Boolean(evt && evt.phase !== 'stopped' && evt.phase !== 'not_running');
}

/** Progress percentage (3..100) for the shutdown progress bar. */
export function shutdownProgress(evt: ShutdownEvent): number {
  if (evt.phase === 'stopped' || evt.phase === 'not_running') return 100;
  if (evt.timeout_ms <= 0) return 0;
  return Math.min(100, Math.max(3, (evt.elapsed_ms / evt.timeout_ms) * 100));
}

/** Human-readable label for the current shutdown phase. */
export function shutdownLabel(evt: ShutdownEvent): string {
  switch (evt.phase) {
    case 'terminating':
    case 'waiting':
      return `Stopping (${Math.ceil(Math.max(0, evt.timeout_ms - evt.elapsed_ms) / 1000)}s)`;
    case 'killing':
      return 'Force stopping';
    case 'cleanup':
      return 'Cleaning up ports';
    case 'stopped':
      return 'Stopped';
    case 'not_running':
      return 'Already stopped';
  }
}
