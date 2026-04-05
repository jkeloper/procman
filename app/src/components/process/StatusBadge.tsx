import type { RuntimeStatus } from '@/api/tauri';

interface Props {
  status: RuntimeStatus | undefined;
}

export function StatusBadge({ status }: Props) {
  const actual = status ?? 'stopped';
  const color =
    actual === 'running'
      ? 'bg-emerald-500'
      : actual === 'crashed'
      ? 'bg-red-500'
      : 'bg-muted-foreground/40';
  const label = actual === 'running' ? 'running' : actual === 'crashed' ? 'crashed' : 'idle';
  return (
    <span className="inline-flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
      <span
        className={`status-dot ${color} ${actual === 'running' ? 'animate-pulse' : ''}`}
        style={{ marginRight: 0 }}
      />
      {label}
    </span>
  );
}
