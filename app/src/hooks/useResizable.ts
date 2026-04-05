import { useCallback, useEffect, useRef, useState } from 'react';

interface Options {
  /** localStorage key for persisting the value */
  storageKey: string;
  /** initial size if nothing stored */
  defaultSize: number;
  /** clamp range */
  min: number;
  max: number;
  /** 'horizontal' = drag left/right to change width
   *  'vertical' = drag up/down to change height */
  axis: 'horizontal' | 'vertical';
  /** 'start' means the handle is on the trailing edge of the pane and
   *  dragging toward the opposite side GROWS the pane (sidebar from left).
   *  'end' means the handle is on the leading edge, dragging toward the
   *  opposite grows the pane (log drawer from bottom). */
  edge: 'start' | 'end';
}

export function useResizable(opts: Options) {
  const { storageKey, defaultSize, min, max, axis, edge } = opts;
  const [size, setSize] = useState<number>(() => {
    const stored = localStorage.getItem(storageKey);
    const parsed = stored ? parseInt(stored, 10) : NaN;
    return !isNaN(parsed) && parsed >= min && parsed <= max ? parsed : defaultSize;
  });
  const dragging = useRef(false);
  const startCoord = useRef(0);
  const startSize = useRef(0);

  useEffect(() => {
    localStorage.setItem(storageKey, String(size));
  }, [storageKey, size]);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      dragging.current = true;
      startCoord.current = axis === 'horizontal' ? e.clientX : e.clientY;
      startSize.current = size;
      document.body.style.cursor = axis === 'horizontal' ? 'col-resize' : 'row-resize';
      document.body.style.userSelect = 'none';
    },
    [axis, size],
  );

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const cur = axis === 'horizontal' ? e.clientX : e.clientY;
      const delta = cur - startCoord.current;
      // For 'start' edge (sidebar): drag right = grow. delta positive = grow.
      // For 'end' edge (log drawer): drag up = grow. delta negative = grow.
      const signed = edge === 'start' ? delta : -delta;
      const next = Math.max(min, Math.min(max, startSize.current + signed));
      setSize(next);
    };
    const onUp = () => {
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [axis, edge, min, max]);

  return { size, setSize, onMouseDown };
}
