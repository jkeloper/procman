import { useEffect, useRef, useState } from 'react';
import { api, openStream, type LogLine } from './api';
import './mobile.css';

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
    api.logs(scriptId).then(setLines).catch(() => {});
    const stop = openStream((ev) => {
      if (ev.type === 'log' && ev.script_id === scriptId) {
        setLines((prev) => {
          const next = prev.concat(ev.line);
          if (next.length > MAX) next.splice(0, next.length - MAX);
          return next;
        });
      }
    }, setConnected);
    return stop;
  }, [scriptId]);

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines.length, autoScroll]);

  return (
    <div className="page" style={{ background: '#0a0a0a' }}>
      <div className="logbar">
        <button className="btn-ghost" onClick={onBack}>←</button>
        <span style={{ fontSize: 14, fontWeight: 600, flex: 1, color: '#e4efe7' }}>
          {scriptName}
        </span>
        <span style={{ fontSize: 10, fontFamily: 'var(--mono)', color: '#555' }}>
          {lines.length}
        </span>
        <div className="dot" style={{
          width: 6, height: 6,
          background: connected ? 'var(--green)' : '#555',
        }} />
        <label style={{ fontSize: 10, color: '#777', display: 'flex', alignItems: 'center', gap: 4 }}>
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
            style={{ accentColor: 'var(--green)', width: 14, height: 14 }}
          />
          tail
        </label>
      </div>
      <div ref={scrollRef} style={{ flex: 1, overflow: 'auto', padding: '6px 0' }}>
        {lines.length === 0 ? (
          <p style={{ padding: 16, color: '#444', fontSize: 12 }}>waiting for output…</p>
        ) : (
          lines.map((l) => (
            <div
              key={l.seq}
              className="log-line"
              style={{
                color: l.stream === 'stderr' ? 'var(--red)' : '#d4d4d8',
                background: l.stream === 'stderr' ? 'rgba(255,0,0,0.04)' : 'transparent',
              }}
            >
              <span className="log-seq">{l.seq}</span>
              <span style={{ flex: 1 }}>{l.text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
