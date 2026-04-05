import { useEffect, useRef, useState } from 'react';
import { List, type ListImperativeAPI, type RowComponentProps } from 'react-window';
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

type RowProps = { lines: LogLine[] };

function Row({ index, style, lines }: RowComponentProps<RowProps>) {
  const line = lines[index];
  if (!line) return null;
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

export function LogPanel({ scriptId, scriptName }: Props) {
  const lines = useLogStream(scriptId);
  const listRef = useRef<ListImperativeAPI>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  // Auto-tail: scroll to bottom when new lines arrive + autoScroll enabled.
  useEffect(() => {
    if (autoScroll && listRef.current && lines.length > 0) {
      listRef.current.scrollToRow({ index: lines.length - 1, align: 'end' });
    }
  }, [lines.length, autoScroll]);

  if (!scriptId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Select a process to view its logs.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-[#0a0a0a] text-[#e5e5e5]">
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
          <List
            listRef={listRef}
            style={{ height: '100%', width: '100%' }}
            rowCount={lines.length}
            rowHeight={ROW_HEIGHT}
            rowComponent={Row}
            rowProps={{ lines }}
            overscanCount={30}
          />
        )}
      </div>
    </div>
  );
}
