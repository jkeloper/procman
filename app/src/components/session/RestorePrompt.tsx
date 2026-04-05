import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { api, type Project } from '@/api/tauri';

interface Props {
  projects: Project[];
}

/**
 * Checks `last_running` on mount; if non-empty and at least one id still
 * exists in the current config, shows a prompt to restart them all.
 */
export function RestorePrompt({ projects }: Props) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<
    Array<{ projectId: string; scriptId: string; label: string }>
  >([]);

  useEffect(() => {
    if (projects.length === 0) return;
    (async () => {
      try {
        const ids = await invoke<string[]>('get_last_running');
        if (!ids || ids.length === 0) return;
        // Resolve ids → project/script names
        const resolved: typeof items = [];
        for (const id of ids) {
          for (const p of projects) {
            const s = p.scripts.find((s) => s.id === id);
            if (s) {
              resolved.push({
                projectId: p.id,
                scriptId: s.id,
                label: `${p.name}/${s.name}`,
              });
              break;
            }
          }
        }
        if (resolved.length > 0) {
          setItems(resolved);
          setOpen(true);
        } else {
          // All stale → clear
          await invoke('clear_last_running');
        }
      } catch (e) {
        console.error('restore check failed:', e);
      }
    })();
  }, [projects]);

  async function restoreAll() {
    for (const it of items) {
      try {
        await api.spawnProcess(it.projectId, it.scriptId);
      } catch (e) {
        console.error('restore failed for', it.label, e);
      }
    }
    setOpen(false);
  }

  async function dismiss() {
    await invoke('clear_last_running').catch(() => {});
    setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && dismiss()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Restore previous session?</DialogTitle>
        </DialogHeader>
        <div className="space-y-2 text-sm">
          <p className="text-muted-foreground">
            These scripts were running when procman last closed:
          </p>
          <ul className="ml-4 list-disc space-y-0.5">
            {items.map((it) => (
              <li key={it.scriptId} className="font-mono">
                {it.label}
              </li>
            ))}
          </ul>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={dismiss}>
            Not now
          </Button>
          <Button onClick={restoreAll}>Start all ({items.length})</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
