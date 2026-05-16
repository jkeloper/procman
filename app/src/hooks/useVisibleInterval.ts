import { useEffect, useRef } from 'react';

export function useVisibleInterval(callback: () => void | Promise<void>, delayMs: number | null) {
  const saved = useRef(callback);

  useEffect(() => {
    saved.current = callback;
  }, [callback]);

  useEffect(() => {
    if (delayMs == null) return;

    let interval: number | null = null;

    const tick = () => {
      if (document.visibilityState === 'visible') {
        void saved.current();
      }
    };
    const stop = () => {
      if (interval != null) {
        window.clearInterval(interval);
        interval = null;
      }
    };
    const start = () => {
      if (interval == null) {
        interval = window.setInterval(tick, delayMs);
      }
    };
    const sync = () => {
      if (document.visibilityState === 'visible') {
        tick();
        start();
      } else {
        stop();
      }
    };

    sync();
    document.addEventListener('visibilitychange', sync);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', sync);
    };
  }, [delayMs]);
}
