import { useEffect, useState } from 'react';

/** Returns a live-updating human-readable uptime string for a given start timestamp. */
export function useUptime(startedAtMs: number | null | undefined): string {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!startedAtMs) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAtMs]);

  if (!startedAtMs) return '';
  const diff = Math.max(0, now - startedAtMs);
  return formatDuration(diff);
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

/** Inline component for use in lists (avoids conditional hook call). */
export function UptimeLabel({ ms }: { ms: number }) {
  const text = useUptime(ms);
  if (!text) return null;
  return <span>{text}</span>;
}
