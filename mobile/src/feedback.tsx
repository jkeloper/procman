// Mobile in-app feedback — a glass toast + confirm sheet that replace the
// jarring native `window.alert` / `window.confirm`, mirroring the desktop's
// `useToast` / `useConfirm` API (app/src/components/Toast.tsx +
// ConfirmDialog.tsx) so the companion app feels of-a-piece. Styled with the
// mobile liquid-glass tokens from mobile.css rather than the desktop's Tailwind.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';

// ---- Toast ----

type ToastVariant = 'info' | 'success' | 'error';

interface ToastItem {
  id: number;
  message: string;
  variant: ToastVariant;
}

interface ToastApi {
  show: (message: string, variant?: ToastVariant) => void;
  /** Convenience for the common error path. */
  error: (message: string) => void;
}

// ---- Confirm ----

interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ToastContext = createContext<ToastApi>({ show: () => {}, error: () => {} });
const ConfirmContext = createContext<ConfirmFn>(async () => false);

export function useToast(): ToastApi {
  return useContext(ToastContext);
}

export function useConfirm(): ConfirmFn {
  return useContext(ConfirmContext);
}

let nextId = 1;

export function FeedbackProvider({ children }: { children: React.ReactNode }) {
  // Toast queue.
  const [items, setItems] = useState<ToastItem[]>([]);
  const remove = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);
  const show = useCallback(
    (message: string, variant: ToastVariant = 'info') => {
      const id = nextId++;
      setItems((prev) => [...prev, { id, message, variant }]);
      // Errors linger so they can be read; info/success auto-dismiss faster.
      const ttl = variant === 'error' ? 4500 : 2500;
      setTimeout(() => remove(id), ttl);
    },
    [remove],
  );
  const error = useCallback((message: string) => show(message, 'error'), [show]);

  // Confirm sheet (one at a time; promise resolves on choice / dismiss).
  const [confirmOpts, setConfirmOpts] = useState<ConfirmOptions | null>(null);
  const resolveRef = useRef<((v: boolean) => void) | null>(null);
  const confirm = useCallback((opts: ConfirmOptions): Promise<boolean> => {
    setConfirmOpts(opts);
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
    });
  }, []);
  const closeConfirm = useCallback((result: boolean) => {
    setConfirmOpts(null);
    resolveRef.current?.(result);
    resolveRef.current = null;
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      <ToastContext.Provider value={{ show, error }}>
        {children}
        <ToastHost items={items} />
        {confirmOpts && <ConfirmSheet opts={confirmOpts} onClose={closeConfirm} />}
      </ToastContext.Provider>
    </ConfirmContext.Provider>
  );
}

function ToastHost({ items }: { items: ToastItem[] }) {
  return (
    <div
      style={{
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 'calc(var(--safe-bottom) + 84px)',
        zIndex: 200,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 8,
        pointerEvents: 'none',
        padding: '0 16px',
      }}
    >
      {items.map((t) => (
        <ToastBubble key={t.id} item={t} />
      ))}
    </div>
  );
}

function ToastBubble({ item }: { item: ToastItem }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const f = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(f);
  }, []);

  const accent =
    item.variant === 'error'
      ? 'var(--red)'
      : item.variant === 'success'
        ? 'var(--green)'
        : 'var(--fg2)';

  return (
    <div
      style={{
        maxWidth: 'min(92vw, 440px)',
        background: 'rgba(22, 42, 30, 0.82)',
        color: 'var(--fg)',
        border: '1px solid var(--glass-stroke)',
        borderLeft: `3px solid ${accent}`,
        boxShadow: `inset 0 1px 0 var(--glass-highlight), 0 8px 28px var(--glass-shadow)`,
        backdropFilter: 'blur(28px) saturate(180%)',
        WebkitBackdropFilter: 'blur(28px) saturate(180%)',
        borderRadius: 14,
        padding: '12px 16px',
        fontSize: 14,
        lineHeight: 1.4,
        whiteSpace: 'pre-line',
        textAlign: 'left',
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateY(0)' : 'translateY(8px)',
        transition: 'opacity 0.2s ease-out, transform 0.2s ease-out',
        pointerEvents: 'auto',
      }}
    >
      {item.message}
    </div>
  );
}

function ConfirmSheet({
  opts,
  onClose,
}: {
  opts: ConfirmOptions;
  onClose: (result: boolean) => void;
}) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const f = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(f);
  }, []);

  return (
    <div
      role="presentation"
      onClick={() => onClose(false)}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 210,
        background: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        opacity: visible ? 1 : 0,
        transition: 'opacity 0.18s ease-out',
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 360,
          background: 'rgba(22, 42, 30, 0.9)',
          border: '1px solid var(--glass-stroke)',
          boxShadow: `inset 0 1px 0 var(--glass-highlight), 0 16px 48px var(--glass-shadow)`,
          backdropFilter: 'blur(36px) saturate(190%)',
          WebkitBackdropFilter: 'blur(36px) saturate(190%)',
          borderRadius: 18,
          padding: 20,
          transform: visible ? 'scale(1)' : 'scale(0.96)',
          transition: 'transform 0.18s ease-out',
        }}
      >
        <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--fg)' }}>
          {opts.title}
        </div>
        {opts.description && (
          <div
            style={{
              marginTop: 8,
              fontSize: 14,
              lineHeight: 1.45,
              color: 'var(--fg2)',
              whiteSpace: 'pre-line',
            }}
          >
            {opts.description}
          </div>
        )}
        <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
          <button
            className="btn-outline"
            style={{ flex: 1, padding: 12, minHeight: 48, fontSize: 15 }}
            onClick={() => onClose(false)}
          >
            {opts.cancelLabel || 'Cancel'}
          </button>
          <button
            className="btn-primary"
            style={{
              flex: 1,
              padding: 12,
              minHeight: 48,
              fontSize: 15,
              ...(opts.destructive
                ? { background: 'var(--red)', color: '#2a0f0f' }
                : {}),
            }}
            onClick={() => onClose(true)}
          >
            {opts.confirmLabel || 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}
