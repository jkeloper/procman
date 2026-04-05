import { useEffect, useRef, useState } from 'react';
// @ts-ignore - react-window default export types
import { FixedSizeList } from 'react-window';
import AnsiToHtml from 'ansi-to-html';
import { useLogStream } from '@/hooks/useLogStream';
import type { LogLine } from '@/api/tauri';

const ansi = new AnsiToHtml({
  fg: '#e5e5e5',
  bg: '#0a0a0a',
  newline: false,
  escapeXML: true,
});

interface Props {
  scriptId: string | null;
  scriptName?: string;
}

const ROW_HEIGHT = 18;

export function LogPanel({ scriptId, scriptName }: Props) {
  const lines = useLogStream(scriptId);
  const listRef = useRef<any>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [height, setHeight] = useState(260);
  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-tail: scroll to bottom when new lines arrive + autoScroll enabled.
  useEffect(() => {
    if (autoScroll && listRef.current && lines.length > 0) {
      listRef.current.scrollToItem(lines.length - 1, 'end');
    }
  }, [lines.length, autoScroll]);

  // Observe container height
  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const ro = new ResizeObserver(() => {
      setHeight(Math.max(120, el.clientHeight - 32));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (!scriptId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Select a process to view its logs.
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex h-full flex-col bg-[#0a0a0a] text-[#e5e5e5]">
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-white/10 px-3 text-xs">
        <div className="flex items-center gap-2">
          <span className="font-medium">{scriptName ?? scriptId}</span>
          <span className="text-muted-foreground">{lines.length} lines</span>
        </div>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
          />
          auto-scroll
        </label>
      </div>
      <div className="flex-1 overflow-hidden">
        {lines.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            (no output yet)
          </div>
        ) : (
          <FixedSizeList
            ref={listRef}
            height={height}
            width="100%"
            itemCount={lines.length}
            itemSize={ROW_HEIGHT}
            overscanCount={30}
          >
            {({ index, style }: any) => <Row style={style} line={lines[index]} />}
          </FixedSizeList>
        )}
      </div>
    </div>
  );
}

function Row({ style, line }: { style: React.CSSProperties; line: LogLine }) {
  const color = line.stream === 'stderr' ? '#f87171' : '#e5e5e5';
  const html = ansi.toHtml(line.text);
  return (
    <div
      style={{ ...style, color }}
      className="px-3 font-mono text-[11px] leading-[18px] whitespace-pre"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
