import { useEffect, useRef, useState } from 'react';
// Type-only import keeps `html5-qrcode` (≈3.3MB unpacked, ~370KB in the bundle)
// OUT of the eager dependency graph; the runtime lib is fetched on demand in
// the effect below, and this component itself is a `lazy()` boundary
// (see PairView). The common already-paired launch never downloads it.
import type { Html5Qrcode } from 'html5-qrcode';

interface Props {
  onScan: (text: string) => void;
  onClose: () => void;
}

export default function QrScanner({ onScan, onClose }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    // Scanner creation is async now (dynamic import). Guard against the user
    // closing / unmounting before the import resolves, or the camera stream
    // would be started on a dead component and never stopped.
    let cancelled = false;
    let scanner: Html5Qrcode | null = null;
    void (async () => {
      const { Html5Qrcode } = await import('html5-qrcode');
      if (cancelled) return;
      scanner = new Html5Qrcode(el.id);
      scannerRef.current = scanner;
      scanner
        .start(
          { facingMode: 'environment' },
          { fps: 10, qrbox: { width: 250, height: 250 } },
          (text) => {
            scanner?.stop().catch(() => {});
            onScan(text);
          },
          () => {},
        )
        .catch((e) => {
          if (cancelled) return;
          setErr(
            String(e).includes('NotAllowedError')
              ? 'Camera permission denied. Allow camera access in Settings.'
              : `Camera error: ${e}`,
          );
        });
    })();

    return () => {
      cancelled = true;
      scanner?.stop().catch(() => {});
    };
  }, [onScan]);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100,
        background: 'rgba(0,0,0,0.95)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          fontSize: 18,
          fontWeight: 600,
          color: '#e4efe7',
          marginBottom: 16,
        }}
      >
        Scan QR Code
      </div>
      <div
        id="qr-reader"
        ref={containerRef}
        style={{
          width: 300,
          height: 300,
          borderRadius: 12,
          overflow: 'hidden',
        }}
      />
      {err && (
        <p
          style={{
            color: 'var(--red)',
            fontSize: 13,
            marginTop: 12,
            textAlign: 'center',
            padding: '0 24px',
          }}
        >
          {err}
        </p>
      )}
      <button
        onClick={onClose}
        style={{
          marginTop: 20,
          padding: '12px 32px',
          fontSize: 15,
          fontWeight: 600,
          border: '1px solid rgba(255,255,255,0.15)',
          borderRadius: 10,
          background: 'transparent',
          color: '#e4efe7',
          cursor: 'pointer',
        }}
      >
        Cancel
      </button>
    </div>
  );
}
