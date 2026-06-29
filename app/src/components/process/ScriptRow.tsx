import { Button } from '@/components/ui/button';
import { StatusBadge } from './StatusBadge';
import { UptimeLabel } from '@/hooks/useUptime';
import { useToast } from '@/components/Toast';
import { Cable, Equal, TerminalSquare } from 'lucide-react';
import { isShutdownActive, shutdownProgress, shutdownLabel } from '@/lib/shutdown';
import type {
  Script,
  RuntimeStatus,
  ProcessKind,
  DeclaredPortStatus,
  ShutdownEvent,
} from '@/api/tauri';
import type { TunnelInfo } from '@/hooks/useTunnelLauncher';

export interface DragHandleProps {
  onPointerDown: (e: React.PointerEvent) => void;
  isDragging: boolean;
}

export interface ScriptRowProps {
  script: Script;
  status: RuntimeStatus | undefined;
  /**
   * WS9: backend owner of the live entry. `pty` renders a small terminal
   * badge so the user can tell a terminal-backed run from a piped one at a
   * glance. Stop/restart/dismiss all route the same way (single lifecycle
   * owner), so this is display-only. Undefined/`piped` → no badge.
   */
  kind?: ProcessKind;
  pid?: number;
  startTimeMs?: number;
  restarts?: number;
  metric?: { cpu: number | null; rss: number | null };
  portStatuses?: DeclaredPortStatus[];
  tunnel?: TunnelInfo;
  busy: boolean;
  shutdownEvent?: ShutdownEvent;
  onStart: (script: Script) => void;
  onStop: (script: Script) => void;
  onRestart: (script: Script) => void;
  onEdit: (script: Script) => void;
  onDelete: (script: Script) => void;
  onLaunchTunnel: (script: Script) => void;
  onKillTunnel: (script: Script) => void;
  onOpenLogs?: (script: Script) => void;
  onDismiss?: (script: Script) => void;
  /**
   * Whether to show the trailing ✕ (close-circle → `onDelete`). The project
   * view uses it to delete the script config (always available); the global
   * view hides it on running rows so ✕ never means "stop" — Stop already
   * does that. Defaults to true to keep the project view unchanged.
   */
  showDelete?: boolean;
  /** Global view shows which project a row belongs to; project view omits it. */
  projectLabel?: string;
  /** Global view: clicking the project label jumps into that project. */
  onProjectLabelClick?: () => void;
  /** Project view injects pointer-drag reordering; global view omits it. */
  dragHandleProps?: DragHandleProps;
  /** Project view wires double-click → toggle start/stop. */
  onRowDoubleClick?: (script: Script) => void;
}

/**
 * One script row: status badge, port liveness dots, metadata badges,
 * start/stop/restart/edit/delete actions, and the inline tunnel bar.
 * Extracted verbatim from ProcessGrid; the markup/classes are pixel
 * identical so the project view is unchanged. The drag handle is opt-in
 * via `dragHandleProps` so the global (non-reorderable) view can reuse
 * the same row.
 */
export function ScriptRow({
  script: s,
  status,
  kind,
  pid,
  startTimeMs,
  restarts = 0,
  metric,
  portStatuses,
  tunnel,
  busy: b,
  shutdownEvent: shutdown,
  onStart,
  onStop,
  onRestart,
  onEdit,
  onDelete,
  onLaunchTunnel,
  onKillTunnel,
  onOpenLogs,
  onDismiss,
  showDelete = true,
  projectLabel,
  onProjectLabelClick,
  dragHandleProps,
  onRowDoubleClick,
}: ScriptRowProps) {
  const toast = useToast();
  const isRunning = status === 'running';
  const isCrashed = status === 'crashed';
  const stopping = isShutdownActive(shutdown);
  const progress = shutdown ? shutdownProgress(shutdown) : 0;
  const actionBusy = b || stopping;
  const isDragging = dragHandleProps?.isDragging ?? false;

  return (
    <li
      data-script-id={s.id}
      className={`group transition-colors hover:bg-accent/40 ${
        isDragging ? 'bg-accent/60 opacity-80 shadow-lg' : ''
      }`}
      onDoubleClick={onRowDoubleClick ? () => onRowDoubleClick(s) : undefined}
    >
      <div className="flex items-center gap-2 px-2 py-2.5">
        {/* Drag handle — two-line hamburger, always cursor-grab */}
        {dragHandleProps && (
          <button
            className="flex h-6 w-6 shrink-0 cursor-grab items-center justify-center rounded text-muted-foreground/40 opacity-0 transition-opacity hover:text-foreground active:cursor-grabbing group-hover:opacity-100"
            onPointerDown={dragHandleProps.onPointerDown}
            onClick={(e) => e.stopPropagation()}
            aria-label="Drag to reorder"
            title="Drag to reorder"
          >
            <Equal size={14} />
          </button>
        )}
        {/* Status dot */}
        <div className="shrink-0 w-[70px]">
          <StatusBadge status={status} />
        </div>

        {/* Name + command */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {projectLabel &&
              (onProjectLabelClick ? (
                <button
                  className="max-w-[140px] shrink-0 truncate rounded-full bg-muted/50 px-2 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
                  title={`Open ${projectLabel}`}
                  onClick={onProjectLabelClick}
                >
                  {projectLabel}
                </button>
              ) : (
                <span className="max-w-[140px] shrink-0 truncate rounded-full bg-muted/50 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                  {projectLabel}
                </span>
              ))}
            <span className="truncate text-[14px] font-medium text-foreground">
              {s.name}
            </span>
            {s.ports && s.ports.length > 0 ? (
              s.ports.map((p) => {
                const st = portStatuses?.find((x) => x.spec.number === p.number);
                // S2: liveness dot — green=reachable, red=declared but unreachable,
                // gray=unknown (not yet probed / script not running)
                const dotClass = !isRunning
                  ? 'bg-muted-foreground/30'
                  : st?.reachable === true
                    ? 'bg-emerald-500'
                    : st?.reachable === false
                      ? 'bg-red-500/70'
                      : 'bg-muted-foreground/30';
                const title =
                  `${p.name}${p.note ? ` — ${p.note}` : ''}${p.optional ? ' (optional)' : ''}` +
                  (isRunning
                    ? st?.reachable === true
                      ? ' · reachable'
                      : st?.reachable === false
                        ? ' · not reachable'
                        : ' · probing…'
                    : '');
                return (
                  <span
                    key={p.name}
                    className="inline-flex items-center gap-1 rounded bg-muted/50 px-1.5 py-0.5 font-mono text-[12px] text-muted-foreground"
                    title={title}
                  >
                    <span className={`inline-block h-1.5 w-1.5 rounded-full ${dotClass}`} />
                    {p.name}:{p.number}
                  </span>
                );
              })
            ) : null}
            {isRunning && kind === 'pty' && (
              <span
                className="inline-flex items-center gap-1 rounded bg-muted/50 px-1.5 py-0.5 text-[12px] text-muted-foreground"
                title="Running in an interactive terminal session"
              >
                <TerminalSquare size={11} />
                terminal
              </span>
            )}
            {s.auto_restart && (
              <span className="rounded bg-muted/50 px-1.5 py-0.5 text-[12px] text-muted-foreground">
                auto-restart{restarts > 0 ? ` #${restarts}` : ''}
              </span>
            )}
            {s.schedule?.enabled && (
              <span
                className="max-w-[150px] truncate rounded bg-muted/50 px-1.5 py-0.5 font-mono text-[12px] text-muted-foreground"
                title={`Scheduled: ${s.schedule.cron}`}
              >
                cron {s.schedule.cron}
              </span>
            )}
            {shutdown && (
              <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[12px] text-amber-700 dark:text-amber-300">
                {shutdownLabel(shutdown)}
              </span>
            )}
            {s.env_file && (
              <span className="rounded bg-muted/50 px-1.5 py-0.5 font-mono text-[12px] text-muted-foreground" title={s.env_file}>
                .env
              </span>
            )}
            {pid != null && (
              <span className="font-mono text-[12px] text-muted-foreground/70">
                pid {pid} · {startTimeMs && isRunning ? <UptimeLabel ms={startTimeMs} /> : null}
                {metric?.cpu != null && (
                  <> · {metric.cpu!.toFixed(1)}% cpu</>
                )}
                {metric?.rss != null && (
                  <> · {(metric.rss! / 1024).toFixed(0)} MB</>
                )}
              </span>
            )}
          </div>
          <div className="truncate font-mono text-[12px] text-muted-foreground">
            $ {s.command}
          </div>
          {shutdown && (
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className={`h-full rounded-full transition-all ${
                  shutdown.phase === 'killing'
                    ? 'bg-destructive'
                    : shutdown.phase === 'stopped' || shutdown.phase === 'not_running'
                      ? 'bg-emerald-500'
                      : 'bg-primary'
                }`}
                style={{ width: `${progress}%` }}
              />
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex shrink-0 items-center gap-1">
          {isRunning ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 opacity-0 group-hover:opacity-100"
                disabled={actionBusy}
                title={s.ports?.[0] ? `Tunnel :${s.ports[0].number}` : 'Tunnel via Cloudflare'}
                onClick={() => onLaunchTunnel(s)}
              >
                Tunnel
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7"
                disabled={actionBusy}
                onClick={() => onRestart(s)}
              >
                Restart
              </Button>
              <Button
                variant="destructive"
                size="sm"
                className="h-7"
                disabled={actionBusy}
                onClick={() => onStop(s)}
              >
                Stop
              </Button>
            </>
          ) : (
            <Button size="sm" className="h-7" disabled={actionBusy} onClick={() => onStart(s)}>
              {actionBusy ? '…' : 'Start'}
            </Button>
          )}
          {/* Dismiss — only for crashed entries, when the caller wires it.
              Clears the retained post-mortem entry/log buffer. */}
          {isCrashed && onDismiss && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7"
              disabled={actionBusy}
              title="Dismiss this crashed process"
              onClick={() => onDismiss(s)}
            >
              Dismiss
            </Button>
          )}
          <span className="w-1" />
          {/* Logs — opt-in jump to this script's log tab (global view). */}
          {onOpenLogs && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 opacity-0 group-hover:opacity-100"
              onClick={() => onOpenLogs(s)}
            >
              Logs
            </Button>
          )}
          <Button variant="ghost" size="sm" className="h-7 opacity-0 group-hover:opacity-100" onClick={() => onEdit(s)}>
            Edit
          </Button>
          {showDelete && (
            <button
              className="close-circle opacity-0 group-hover:opacity-100"
              onClick={() => onDelete(s)}
            >
              ✕
            </button>
          )}
        </div>
      </div>
      {/* Inline tunnel bar */}
      {tunnel && (
        <div className="flex items-center gap-2 border-t border-border/20 bg-primary/5 px-4 py-1.5 text-[12px] transition-all duration-200">
          <Cable size={16} />
          <span className="min-w-0 flex-1 truncate font-mono text-primary">
            {tunnel.url}
          </span>
          <span className="shrink-0 font-mono text-muted-foreground/60">
            :{tunnel.port}
          </span>
          <Button variant="ghost" size="sm" className="h-6 px-2"
            onClick={() => toast.copy(tunnel.url, 'Tunnel URL copied')}
          >
            Copy
          </Button>
          <Button variant="destructive" size="sm" className="h-6"
            onClick={() => onKillTunnel(s)}
          >
            Stop tunnel
          </Button>
        </div>
      )}
    </li>
  );
}
