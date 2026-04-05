import { useEffect, useRef, useState } from 'react';
import { List, type ListImperativeAPI, type RowComponentProps } from 'react-window';
import AnsiToHtml from 'ansi-to-html';
import { useLogStream } from '@/hooks/useLogStream';
import type { LogLine } from '@/api/tauri';

const ansi = new AnsiToHtml({
  fg: '#d4d4d8',
  bg: '#0a0a0a',
  newline: false,
  escapeXML: true,
});

interface Props {
  scriptId: string | null;
  scriptName?: string;
}

const ROW_HEIGHT = 20;

type RowProps = { lines: LogLine[] };

function Row({ index, style, lines }: RowComponentProps<RowProps>) {
  const line = lines[index];
  if (!line) return null;
  const isErr = line.stream === 'stderr';
  const html = ansi.toHtml(line.text);
  return (
    <div
      style={style}
      className={`flex items-center gap-2 px-4 font-mono text-[11px] leading-[20px] whitespace-pre ${
        isErr ? 'bg-red-500/5 text-red-400' : 'text-zinc-200'
      } hover:bg-white/5`}
    >
      <span className="w-[52px] shrink-0 select-none text-right text-[9px] text-zinc-600 tabular-nums">
        {line.seq}
      </span>
      <span className="flex-1" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

export function LogPanel({ scriptId, scriptName }: Props) {
  const lines = useLogStream(scriptId);
  const listRef = useRef<ListImperativeAPI>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    if (autoScroll && listRef.current && lines.length > 0) {
      listRef.current.scrollToRow({ index: lines.length - 1, align: 'end' });
    }
  }, [lines.length, autoScroll]);

  if (!scriptId) {
    return (
      <div className="flex h-full items-center justify-center text-[11px] text-zinc-500">
        Select a process to view its logs.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-[#0a0a0a]">
      <div className="flex h-7 shrink-0 items-center justify-between border-b border-white/5 px-3 text-[10px]">
        <div className="flex items-center gap-2">
          <span className="font-medium text-zinc-300">{scriptName ?? scriptId}</span>
          <span className="font-mono text-zinc-500">{lines.length} lines</span>
        </div>
        <label className="flex cursor-pointer items-center gap-1 text-zinc-500 transition-colors hover:text-zinc-300">
          <input
            type="checkbox"
            className="h-3 w-3 accent-orange-500"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
          />
          auto-tail
        </label>
      </div>
      <div className="flex-1 overflow-hidden">
        {lines.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[11px] text-zinc-600">
            waiting for output…
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
