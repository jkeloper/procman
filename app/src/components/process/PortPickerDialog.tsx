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
  scriptName: string;
  ports: PortInfo[];
  fallback?: boolean;
  rootPid?: number;
  onPick: (port: number) => void;
  onCancel: () => void;
}

export function PortPickerDialog({
  open,
  scriptName,
  ports,
  fallback = false,
  rootPid,
  onPick,
  onCancel,
}: Props) {
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Pick a port to tunnel</DialogTitle>
          <DialogDescription>
            {fallback ? (
              <>
                Couldn't match a port to <strong>{scriptName}</strong>'s
                process tree
                {rootPid != null && (
                  <> (root pid <code className="font-mono">{rootPid}</code>)</>
                )}
                . Showing every listening port on this machine — pick the
                right one manually.
              </>
            ) : (
              <>
                "{scriptName}" is listening on multiple ports. Choose
                which one to expose via Cloudflare.
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        {ports.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">
            No listening ports were found for this script. Set an
            <code className="mx-1 rounded bg-muted px-1.5 py-0.5 font-mono text-[12px]">
              expected_port
            </code>
            in Edit, or run the process first.
          </p>
        ) : (
          <ul className="divide-y divide-border/40 rounded-lg border border-border/60">
            {ports.map((p) => (
              <li
                key={`${p.pid}-${p.port}`}
                className="flex cursor-pointer items-center gap-3 px-4 py-2.5 transition-colors hover:bg-accent/40"
                onClick={() => onPick(p.port)}
              >
                <span className="rounded bg-primary/15 px-2 py-1 font-mono text-[13px] font-semibold text-primary">
                  :{p.port}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium">{p.process_name}</div>
                  <div className="truncate font-mono text-[11px] text-muted-foreground">
                    pid {p.pid}
                  </div>
                </div>
                <Button size="sm" className="h-7" onClick={(e) => { e.stopPropagation(); onPick(p.port); }}>
                  Tunnel
                </Button>
              </li>
            ))}
          </ul>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
