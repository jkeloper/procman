import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { api, type LogLine } from '@/api/tauri';

const MAX_LINES = 5000;

/**
 * Subscribes to `log://{scriptId}` events for a given script and maintains
 * a ring buffer of the most recent MAX_LINES lines. Primes from snapshot.
 */
export function useLogStream(scriptId: string | null) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const pendingRef = useRef<LogLine[]>([]);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!scriptId) {
      setLines([]);
      return;
    }
    let cancelled = false;
    // Prime snapshot
    api.logSnapshot(scriptId).then((snap) => {
      if (!cancelled) setLines(snap);
    }).catch(() => {});

    // Batch line emits via rAF to avoid render thrash
    const flush = () => {
      if (pendingRef.current.length > 0) {
        const batch = pendingRef.current;
        pendingRef.current = [];
        setLines((prev) => {
          const next = prev.concat(batch);
          if (next.length > MAX_LINES) next.splice(0, next.length - MAX_LINES);
          return next;
        });
      }
      rafRef.current = null;
    };

    const un = listen<LogLine>(`log://${scriptId}`, (ev) => {
      pendingRef.current.push(ev.payload);
      if (rafRef.current == null) {
        rafRef.current = requestAnimationFrame(flush);
      }
    });
    return () => {
      cancelled = true;
      un.then((fn) => fn());
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      pendingRef.current = [];
    };
  }, [scriptId]);

  return lines;
}
