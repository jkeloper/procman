import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { api } from '@/api/tauri';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

/**
 * Intercepts the window close event when processes are running.
 * Shows a confirmation dialog before quitting.
 */
export function QuitGuard() {
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(0);

  useEffect(() => {
    const un = listen<number>('procman://confirm-quit', (ev) => {
      setCount(ev.payload);
      setOpen(true);
    });
    return () => {
      un.then((fn) => fn());
    };
  }, []);

  function cancel() {
    setOpen(false);
  }

  async function quit() {
    setOpen(false);
    // E1: Kill all processes gracefully, then exit the app.
    await api.forceQuit();
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && cancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Quit procman?</DialogTitle>
          <DialogDescription>
            {count} process{count !== 1 ? 'es are' : ' is'} still running.
            Quitting will stop {count === 1 ? 'it' : 'all of them'}.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-1">
          <Button variant="outline" onClick={cancel}>
            Cancel
          </Button>
          <Button
            onClick={quit}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            Quit & stop all
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
