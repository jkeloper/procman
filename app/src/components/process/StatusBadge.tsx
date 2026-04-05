import { Badge } from '@/components/ui/badge';
import type { RuntimeStatus } from '@/api/tauri';

interface Props {
  status: RuntimeStatus | undefined;
}

export function StatusBadge({ status }: Props) {
  const actual = status ?? 'stopped';
  const variant = actual === 'running' ? 'default' : actual === 'crashed' ? 'destructive' : 'secondary';
  const label = actual === 'running' ? '● running' : actual === 'crashed' ? '⚠ crashed' : 'stopped';
  return <Badge variant={variant}>{label}</Badge>;
}
