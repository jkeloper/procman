import { createContext, useCallback, useContext, useEffect, useState } from 'react';

interface ToastItem {
  id: number;
  message: string;
  variant: 'info' | 'success' | 'error';
}

interface ToastApi {
  show: (message: string, variant?: ToastItem['variant']) => void;
  /** Convenience: copy text to clipboard and show a "Copied" toast. */
  copy: (text: string, label?: string) => Promise<void>;
}

const ToastContext = createContext<ToastApi>({
  show: () => {},
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
    (message: string, variant: ToastItem['variant'] = 'info') => {
      const id = nextId++;
      setItems((prev) => [...prev, { id, message, variant }]);
      // Auto-dismiss after 2 seconds
      setTimeout(() => remove(id), 2000);
    },
    [remove],
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
    <ToastContext.Provider value={{ show, copy }}>
      {children}
      <ToastHost items={items} />
    </ToastContext.Provider>
  );
}

function ToastHost({ items }: { items: ToastItem[] }) {
  return (
    <div className="pointer-events-none fixed bottom-6 left-1/2 z-[100] flex -translate-x-1/2 flex-col items-center gap-2">
      {items.map((t) => (
        <ToastBubble key={t.id} item={t} />
      ))}
    </div>
  );
}

function ToastBubble({ item }: { item: ToastItem }) {
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
      className={`pointer-events-auto rounded-full px-4 py-2 text-[13px] font-medium shadow-lg ring-1 backdrop-blur-md transition-all duration-200 ease-out ${tone} ${
        visible ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'
      }`}
    >
      {item.message}
    </div>
  );
}
