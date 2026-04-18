import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { PortInfo } from '@/api/tauri';

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  port: number;
  conflict: PortInfo | null;
  scriptName: string;
  onKillAndStart: () => void;
  onStartAnyway: () => void;
}

export function PortConflictDialog({
  open,
  onOpenChange,
  port,
  conflict,
  scriptName,
  onKillAndStart,
  onStartAnyway,
}: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="text-amber-500">⚠</span>
            Port :{port} already in use
          </DialogTitle>
          <DialogDescription>
            <span className="font-medium">{scriptName}</span> expects port{' '}
            <span className="font-mono font-semibold">{port}</span>, but it's already bound.
          </DialogDescription>
        </DialogHeader>

        {conflict && (
          <div className="rounded-lg border border-border/60 bg-muted/30 p-3 font-mono text-[11px]">
            <div className="flex gap-4">
              <span className="text-muted-foreground">pid</span>
              <span className="tabular-nums">{conflict.pid}</span>
            </div>
            <div className="flex gap-4">
              <span className="text-muted-foreground">process</span>
              <span>{conflict.process_name}</span>
            </div>
            <div className="flex gap-4">
              <span className="text-muted-foreground">port</span>
              <span>:{conflict.port}</span>
            </div>
          </div>
        )}

        <DialogFooter className="gap-1">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="outline" onClick={onStartAnyway}>
            Start anyway
          </Button>
          <Button
            variant="destructive"
            onClick={onKillAndStart}
            title={`Kill ${conflict?.process_name ?? 'process'} (pid ${conflict?.pid ?? '?'}) and start`}
          >
            Yes, kill & start
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
