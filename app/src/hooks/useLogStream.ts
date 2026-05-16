import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { api, type LogLine } from '@/api/tauri';

export const MAX_LINES = 5000;
const FLUSH_FALLBACK_MS = 250;

/**
 * Subscribes to `log://{scriptId}` events for a given script and maintains
 * a ring buffer of the most recent MAX_LINES lines. Primes from snapshot.
 *
 * Dedup strategy: Rust's LogBuffer assigns a monotonically increasing
 * `seq` to every line. Because the snapshot fetch and the live-stream
 * listener race each other on mount, some lines can arrive through
 * both paths. We dedup by building a Set of seen seqs and dropping any
 * duplicates before merging. Within the merged set, we sort by seq so
 * out-of-order arrivals still render correctly.
 */
export function mergeLines(prev: LogLine[], incoming: LogLine[]): LogLine[] {
  if (incoming.length === 0) return prev;
  // Restart detection. A fresh Rust LogBuffer starts seq at 0, so when
  // incoming brings a seq lower than anything we've already seen, the
  // backend rebuilt the buffer — typically because the script stopped/
  // crashed and was (re)started. Drop stale prev in that case so the
  // viewport reflects the new process only. This guards against
  // status-event races where `process://status=running` arrives after
  // the first log lines. We compare against prev's *minimum* (prev[0],
  // since prev is always sorted ascending) rather than the max so that
  // normal snapshot/live overlap on mount does not trigger a reset.
  if (prev.length > 0) {
    let minIncoming = incoming[0].seq;
    for (const l of incoming) {
      if (l.seq < minIncoming) minIncoming = l.seq;
    }
    if (minIncoming < prev[0].seq) {
      prev = [];
    }
  }
  if (prev.length === 0) {
    // Still possible to have dupes inside `incoming` itself
    const seen = new Set<number>();
    const uniq: LogLine[] = [];
    for (const l of incoming) {
      if (!seen.has(l.seq)) {
        seen.add(l.seq);
        uniq.push(l);
      }
    }
    uniq.sort((a, b) => a.seq - b.seq);
    return capRing(uniq);
  }
  const seen = new Set<number>();
  for (const l of prev) seen.add(l.seq);
  const fresh: LogLine[] = [];
  for (const l of incoming) {
    if (!seen.has(l.seq)) {
      seen.add(l.seq);
      fresh.push(l);
    }
  }
  if (fresh.length === 0) return prev;
  // Fast path: if all fresh lines come after prev's last seq, just append.
  const lastSeq = prev[prev.length - 1].seq;
  const allAfter = fresh.every((l) => l.seq > lastSeq);
  if (allAfter) {
    return capRing(prev.concat(fresh));
  }
  // Slow path: mix old + new and re-sort.
  const merged = prev.concat(fresh);
  merged.sort((a, b) => a.seq - b.seq);
  return capRing(merged);
}

function capRing(arr: LogLine[]): LogLine[] {
  if (arr.length > MAX_LINES) {
    return arr.slice(arr.length - MAX_LINES);
  }
  return arr;
}

export function useLogStream(scriptId: string | null) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const pendingRef = useRef<LogLine[]>([]);
  const rafRef = useRef<number | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelScheduledFlush = () => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (timeoutRef.current != null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  };

  /**
   * Clear only the currently visible lines in this panel. The Rust
   * LogBuffer is left untouched so that subsequent snapshot fetches
   * (e.g. when the user switches tabs and comes back) will restore
   * the history.
   *
   * Any new log lines arriving from the live stream continue to
   * append normally on top of the cleared view.
   */
  const clear = () => {
    pendingRef.current = [];
    cancelScheduledFlush();
    setLines([]);
  };

  useEffect(() => {
    // Always reset state at the start of a new subscription. Without
    // this, the `lines` state from the previous scriptId would leak
    // into the view for the new scriptId until snapshot/live events
    // replace it, and mergeLines would naively blend both streams.
    setLines([]);
    pendingRef.current = [];
    cancelScheduledFlush();
    if (!scriptId) {
      return;
    }
    let cancelled = false;
    // Prime snapshot
    api
      .logSnapshot(scriptId, MAX_LINES)
      .then((snap) => {
        if (!cancelled) setLines((prev) => mergeLines(prev, snap));
      })
      .catch(() => {});

    // Batch line emits via rAF to avoid render thrash. A timeout fallback
    // keeps the queue draining when rAF is throttled, and the queue itself is
    // capped so hidden/minimized windows cannot retain unbounded log events.
    const flush = () => {
      cancelScheduledFlush();
      if (pendingRef.current.length > 0) {
        const batch = pendingRef.current;
        pendingRef.current = [];
        setLines((prev) => mergeLines(prev, batch));
      }
    };

    const scheduleFlush = () => {
      if (rafRef.current == null) {
        rafRef.current = requestAnimationFrame(flush);
      }
      if (timeoutRef.current == null) {
        timeoutRef.current = setTimeout(flush, FLUSH_FALLBACK_MS);
      }
    };

    const un = listen<LogLine>(`log://${scriptId}`, (ev) => {
      pendingRef.current.push(ev.payload);
      if (pendingRef.current.length > MAX_LINES) {
        pendingRef.current = pendingRef.current.slice(-MAX_LINES);
      }
      scheduleFlush();
    });

    // When this script restarts (status → running), clear stale lines
    // from the previous run and re-prime from the fresh buffer.
    const unStatus = listen<{ id: string; status: string }>(
      'process://status',
      (ev) => {
        if (ev.payload.id === scriptId && ev.payload.status === 'running') {
          pendingRef.current = [];
          cancelScheduledFlush();
          setLines([]);
          api
            .logSnapshot(scriptId, MAX_LINES)
            .then((snap) => {
              if (!cancelled) setLines((prev) => mergeLines(prev, snap));
            })
            .catch(() => {});
        }
      },
    );

    return () => {
      cancelled = true;
      un.then((fn) => fn());
      unStatus.then((fn) => fn());
      cancelScheduledFlush();
      pendingRef.current = [];
    };
  }, [scriptId]);

  return { lines, clear };
}
