import { useEffect, useRef, useState } from 'react';
import { api, openStream, type LogLine } from './api';

interface Props {
  scriptId: string;
  scriptName: string;
  onBack: () => void;
}

const MAX = 2000;

export function LogView({ scriptId, scriptName, onBack }: Props) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [connected, setConnected] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    api
      .logs(scriptId)
      .then((snap) => setLines(snap))
      .catch(() => {});
    const stop = openStream(
      (ev) => {
        if (ev.type === 'log' && ev.script_id === scriptId) {
          setLines((prev) => {
            const next = prev.concat(ev.line);
            if (next.length > MAX) next.splice(0, next.length - MAX);
            return next;
          });
        }
      },
      setConnected,
    );
    return stop;
  }, [scriptId]);

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines.length, autoScroll]);

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: '#0a0a0a',
        paddingTop: 'env(safe-area-inset-top, 0px)',
      }}
    >
      <header
        style={{
          padding: '10px 14px',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          background: '#0f0f0f',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <button
          onClick={onBack}
          style={{
            background: 'transparent',
            border: 'none',
            color: '#9bb5a4',
            fontSize: 16,
            padding: 0,
          }}
        >
          ←
        </button>
        <span style={{ fontSize: 14, fontWeight: 500, color: '#e4efe7' }}>{scriptName}</span>
        <span
          style={{
            fontSize: 10,
            fontFamily: 'ui-monospace, monospace',
            color: '#666',
          }}
        >
          {lines.length}
        </span>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 10, color: connected ? '#65C18C' : '#666' }}>●</span>
        <label style={{ fontSize: 10, color: '#9bb5a4', display: 'flex', gap: 4 }}>
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
            style={{ accentColor: '#65C18C' }}
          />
          tail
        </label>
      </header>
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflow: 'auto',
          padding: '8px 0',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: 11,
          lineHeight: '16px',
        }}
      >
        {lines.length === 0 ? (
          <p style={{ padding: 16, color: '#555', fontSize: 11 }}>waiting for output…</p>
        ) : (
          lines.map((l) => (
            <div
              key={l.seq}
              style={{
                padding: '0 12px',
                color: l.stream === 'stderr' ? '#f87171' : '#d4d4d8',
                background: l.stream === 'stderr' ? 'rgba(255,0,0,0.04)' : 'transparent',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                display: 'flex',
                gap: 8,
              }}
            >
              <span style={{ color: '#444', flexShrink: 0, userSelect: 'none' }}>{l.seq}</span>
              <span style={{ flex: 1 }}>{stripAnsi(l.text)}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// Quick-and-dirty ANSI escape strip for mobile (no color rendering for now)
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}
