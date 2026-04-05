import { useEffect } from 'react';

/**
 * Global hotkey registry.
 * - ⌘K / Ctrl+K: command palette (handled in CommandPalette)
 * - ⌘L / Ctrl+L: toggle log drawer
 * - ⌘, / Ctrl+,: back to dashboard
 */
export function useHotkeys(handlers: {
  toggleLogs: () => void;
  goDashboard: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      // Ignore inside inputs
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 'l') {
        e.preventDefault();
        handlers.toggleLogs();
      } else if (e.key === ',') {
        e.preventDefault();
        handlers.goDashboard();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handlers]);
}
