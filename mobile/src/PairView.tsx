import { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { savePair } from './pair';

interface Props {
  onPaired: () => void;
}

export function PairView({ onPaired }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const [host, setHost] = useState('');
  const [port, setPort] = useState('7777');
  const [token, setToken] = useState('');

  useEffect(() => {
    if (manual) return;
    let stream: MediaStream | null = null;

    async function start() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        });
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
          scan();
        }
      } catch (e: any) {
        setErr(`camera: ${e?.message ?? e}`);
      }
    }

    function scan() {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas) return;
      const loop = () => {
        if (video.readyState === video.HAVE_ENOUGH_DATA) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          if (ctx) {
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const code = jsQR(img.data, img.width, img.height);
            if (code) {
              try {
                const parsed = JSON.parse(code.data);
                if (parsed.host && parsed.port && parsed.token) {
                  savePair({ host: parsed.host, port: parsed.port, token: parsed.token });
                  onPaired();
                  return;
                }
              } catch {}
            }
          }
        }
        rafRef.current = requestAnimationFrame(loop);
      };
      rafRef.current = requestAnimationFrame(loop);
    }

    start();
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [manual, onPaired]);

  function submitManual(e: React.FormEvent) {
    e.preventDefault();
    const p = parseInt(port, 10);
    if (!host || !p || !token) {
      setErr('all fields required');
      return;
    }
    savePair({ host, port: p, token });
    onPaired();
  }

  return (
    <div
      style={{
        minHeight: '100%',
        display: 'flex',
        flexDirection: 'column',
        padding: 'env(safe-area-inset-top, 16px) 16px env(safe-area-inset-bottom, 16px)',
        boxSizing: 'border-box',
        gap: 16,
      }}
    >
      <div>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600 }}>Pair with procman</h1>
        <p style={{ margin: '4px 0 0', fontSize: 13, opacity: 0.6 }}>
          Open procman → Dashboard → Remote Access → scan this device.
        </p>
      </div>

      {!manual ? (
        <>
          <div
            style={{
              position: 'relative',
              width: '100%',
              aspectRatio: '1 / 1',
              borderRadius: 16,
              overflow: 'hidden',
              background: '#000',
              border: '2px solid rgba(255,255,255,0.1)',
            }}
          >
            <video
              ref={videoRef}
              playsInline
              muted
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
            <canvas ref={canvasRef} style={{ display: 'none' }} />
            <div
              style={{
                position: 'absolute',
                inset: '20%',
                border: '2px solid #65C18C',
                borderRadius: 12,
                boxShadow: '0 0 0 9999px rgba(0,0,0,0.3)',
              }}
            />
          </div>
          {err && (
            <p style={{ color: '#ff8a8a', fontSize: 13, margin: 0 }}>{err}</p>
          )}
          <button
            onClick={() => setManual(true)}
            style={{
              background: 'transparent',
              border: '1px solid rgba(255,255,255,0.2)',
              color: '#e4efe7',
              padding: '12px 16px',
              borderRadius: 10,
              fontSize: 14,
              fontWeight: 500,
            }}
          >
            Enter manually
          </button>
        </>
      ) : (
        <form onSubmit={submitManual} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Field label="Host / IP" value={host} onChange={setHost} placeholder="192.168.1.10" />
          <Field label="Port" value={port} onChange={setPort} placeholder="7777" />
          <Field label="Token" value={token} onChange={setToken} placeholder="pasted from app" />
          {err && <p style={{ color: '#ff8a8a', fontSize: 13, margin: 0 }}>{err}</p>}
          <button
            type="submit"
            style={{
              background: '#65C18C',
              border: 'none',
              color: '#0d1a12',
              padding: '14px 16px',
              borderRadius: 10,
              fontSize: 15,
              fontWeight: 600,
            }}
          >
            Connect
          </button>
          <button
            type="button"
            onClick={() => setManual(false)}
            style={{
              background: 'transparent',
              border: 'none',
              color: '#9bb5a4',
              padding: 8,
              fontSize: 13,
            }}
          >
            ← Back to scanner
          </button>
        </form>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, opacity: 0.7 }}>
      {label}
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoCapitalize="off"
        autoCorrect="off"
        style={{
          background: 'rgba(255,255,255,0.05)',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 8,
          padding: '10px 12px',
          color: '#e4efe7',
          fontSize: 14,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        }}
      />
    </label>
  );
}
