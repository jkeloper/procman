import { createContext, useCallback, useContext, useEffect, useState } from 'react';

interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastItem {
  id: number;
  message: string;
  variant: 'info' | 'success' | 'error';
  action?: ToastAction;
}

interface ShowOptions {
  variant?: ToastItem['variant'];
  /** Optional inline action button (e.g. "Retry"). */
  action?: ToastAction;
}

interface ToastApi {
  show: (message: string, opts?: ToastItem['variant'] | ShowOptions) => void;
  /** Convenience: surface an error message (optionally with a retry action). */
  error: (message: string, action?: ToastAction) => void;
  /** Convenience: copy text to clipboard and show a "Copied" toast. */
  copy: (text: string, label?: string) => Promise<void>;
}

const ToastContext = createContext<ToastApi>({
  show: () => {},
  error: () => {},
  copy: async () => {},
});

export function useToast(): ToastApi {
  return useContext(ToastContext);
}

let nextId = 1;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const remove = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const show = useCallback(
    (message: string, opts: ToastItem['variant'] | ShowOptions = 'info') => {
      const { variant = 'info', action } =
        typeof opts === 'string' ? { variant: opts, action: undefined } : opts;
      const id = nextId++;
      setItems((prev) => [...prev, { id, message, variant, action }]);
      // Errors and actionable toasts linger longer so they can be read/acted on.
      const ttl = action ? 6000 : variant === 'error' ? 4000 : 2000;
      setTimeout(() => remove(id), ttl);
    },
    [remove],
  );

  const error = useCallback(
    (message: string, action?: ToastAction) => {
      show(message, { variant: 'error', action });
    },
    [show],
  );

  const copy = useCallback(
    async (text: string, label = 'Copied') => {
      try {
        await navigator.clipboard.writeText(text);
        show(label, 'success');
      } catch {
        show('Copy failed', 'error');
      }
    },
    [show],
  );

  return (
    <ToastContext.Provider value={{ show, error, copy }}>
      {children}
      <ToastHost items={items} onAction={remove} />
    </ToastContext.Provider>
  );
}

function ToastHost({
  items,
  onAction,
}: {
  items: ToastItem[];
  onAction: (id: number) => void;
}) {
  return (
    <div className="pointer-events-none fixed bottom-6 left-1/2 z-[100] flex -translate-x-1/2 flex-col items-center gap-2">
      {items.map((t) => (
        <ToastBubble key={t.id} item={t} onAction={onAction} />
      ))}
    </div>
  );
}

function ToastBubble({
  item,
  onAction,
}: {
  item: ToastItem;
  onAction: (id: number) => void;
}) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    // Trigger fade-in on mount
    const f = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(f);
  }, []);

  const tone =
    item.variant === 'success'
      ? 'bg-emerald-500/90 text-emerald-50 ring-emerald-400/30'
      : item.variant === 'error'
      ? 'bg-red-500/90 text-red-50 ring-red-400/30'
      : 'bg-popover text-popover-foreground ring-foreground/10';

  return (
    <div
      className={`pointer-events-auto flex max-w-[90vw] items-center gap-3 rounded-full px-4 py-2 text-[13px] font-medium shadow-lg ring-1 backdrop-blur-md transition-all duration-200 ease-out ${tone} ${
        visible ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'
      }`}
    >
      <span className="min-w-0 truncate">{item.message}</span>
      {item.action && (
        <button
          className="shrink-0 rounded-full bg-white/20 px-2 py-0.5 text-[12px] font-semibold transition-colors hover:bg-white/30"
          onClick={() => {
            onAction(item.id);
            item.action!.onClick();
          }}
        >
          {item.action.label}
        </button>
      )}
    </div>
  );
}
