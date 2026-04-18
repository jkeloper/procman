// Small hook wrapping the procman AppSettings store.
//
// - Loads once on mount and whenever the backend emits `config-changed`.
// - `save(patch)` debounces rapid edits (sliders etc.) and eagerly
//   updates local state so the UI feels instant.
import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { api, type AppSettings } from '@/api/tauri';

const DEFAULTS: AppSettings = {
  log_buffer_size: 5000,
  port_poll_interval_ms: 1000,
  theme: 'system',
  port_aliases: {},
  lan_mode_opt_in: false,
  start_at_login: false,
  onboarded: false,
};

export function useSettings() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const pendingRef = useRef<Partial<AppSettings>>({});
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reload = useCallback(async () => {
    try {
      const s = await api.getSettings();
      setSettings(s);
      setErr(null);
    } catch (e: any) {
      // The command may not exist yet in older backends — fall back to
      // defaults so the UI can still render.
      setSettings(DEFAULTS);
      setErr(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
    const un = listen('config-changed', () => reload());
    return () => {
      un.then((fn) => fn()).catch(() => {});
    };
  }, [reload]);

  const flush = useCallback(async () => {
    const patch = pendingRef.current;
    pendingRef.current = {};
    if (Object.keys(patch).length === 0) return;
    try {
      const next = await api.updateSettings(patch);
      setSettings(next);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    }
  }, []);

  // Optimistic + debounced save. `debounceMs = 0` forces immediate flush
  // (useful for toggles; sliders pass 250 or so).
  const save = useCallback(
    (patch: Partial<AppSettings>, debounceMs = 250) => {
      setSettings((prev) => (prev ? { ...prev, ...patch } : prev));
      pendingRef.current = { ...pendingRef.current, ...patch };
      if (timerRef.current) clearTimeout(timerRef.current);
      if (debounceMs === 0) {
        flush();
      } else {
        timerRef.current = setTimeout(flush, debounceMs);
      }
    },
    [flush],
  );

  return { settings, loading, err, save, reload };
}
