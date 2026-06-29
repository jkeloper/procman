import { useEffect, useMemo, useRef, useState } from 'react';
import AnsiToHtml from 'ansi-to-html';
import { api, openStream, type LogLine } from './api';
import { ArrowLeft } from './icons';
import './mobile.css';

interface Props {
  scriptId: string;
  scriptName: string;
  onBack: () => void;
}

const MAX = 2000;

// WS8: render ANSI colors instead of stripping them (matches the desktop
// LogPanel). `escapeXML` neutralises HTML-special chars in log text before it
// reaches dangerouslySetInnerHTML, so log output can't inject markup.
const ansi = new AnsiToHtml({
  fg: '#d4d4d8',
  bg: 'rgba(8, 16, 12, 0.85)',
  newline: false,
  escapeXML: true,
});

export function LogView({ scriptId, scriptName, onBack }: Props) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [connected, setConnected] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [query, setQuery] = useState('');

  useEffect(() => {
    api.logs(scriptId).then(setLines).catch(() => {
      // Keep the live stream usable even if the initial snapshot fails.
    });
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

  const filtered = query
    ? lines.filter((l) => l.text.toLowerCase().includes(query.toLowerCase()))
    : lines;

  // Convert each visible line's ANSI to HTML once per render pass. escapeXML
  // means the text is HTML-safe before colorization, so the rendered spans
  // can't carry injected markup.
  const rendered = useMemo(
    () => filtered.map((l) => ({ line: l, html: ansi.toHtml(l.text) })),
    [filtered],
  );

  useEffect(() => {
    if (autoScroll && !query && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [filtered.length, autoScroll, query]);

  // Auto-detect scroll position
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      setAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <div className="page" style={{ background: 'rgba(8, 16, 12, 0.85)', backdropFilter: 'blur(20px)' }}>
      <div className="logbar">
        <button className="btn-ghost" onClick={onBack}><ArrowLeft size={18} /></button>
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
      <div style={{ padding: '4px 8px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="filter logs…"
          style={{
            width: '100%', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 6, padding: '6px 10px', fontSize: 13, fontFamily: 'var(--mono)',
            color: '#e4efe7', outline: 'none',
          }}
        />
      </div>
      <div ref={scrollRef} style={{ flex: 1, overflow: 'auto', padding: '6px 0' }}>
        {filtered.length === 0 ? (
          <p style={{ padding: 16, color: '#444', fontSize: 12 }}>
            {lines.length === 0 ? 'waiting for output…' : query ? `no matches for "${query}"` : 'waiting for output…'}
          </p>
        ) : (
          rendered.map(({ line: l, html }) => (
            <div
              key={l.seq}
              className="log-line"
              style={{
                color: l.stream === 'stderr' ? 'var(--red)' : '#d4d4d8',
                background: l.stream === 'stderr' ? 'rgba(255,0,0,0.04)' : 'transparent',
              }}
            >
              <span className="log-seq">{l.seq}</span>
              <span style={{ flex: 1 }} dangerouslySetInnerHTML={{ __html: html }} />
            </div>
          ))
        )}
      </div>
    </div>
  );
}
