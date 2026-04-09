import { useEffect, useMemo, useRef, useState } from 'react';
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

type RowProps = { lines: LogLine[]; query: string };

function highlight(text: string, query: string): string {
  // Escape HTML-special chars in text first (ansi.toHtml already does that),
  // then wrap matches in <mark>. query is already lower-cased.
  if (!query) return ansi.toHtml(text);
  // Case-insensitive plain-text search; wrap matches by indices to avoid
  // HTML injection via user text.
  const lowered = text.toLowerCase();
  const html = ansi.toHtml(text);
  // We can't easily inject into the ansi-produced HTML (spans), so fall
  // back to a simpler approach: apply ansi first, then replace occurrences
  // in the rendered text outside of tag markers.
  let out = '';
  let i = 0;
  let inTag = false;
  let charIdx = 0; // index into the visible text
  while (i < html.length) {
    const ch = html[i];
    if (ch === '<') inTag = true;
    if (!inTag) {
      // Try to match query starting at charIdx of visible text = i here
      if (lowered.startsWith(query, charIdx)) {
        const slice = html.substring(i, i + query.length);
        out += `<mark class="bg-amber-400/40 text-amber-100 rounded-sm px-0.5">${slice}</mark>`;
        i += query.length;
        charIdx += query.length;
        continue;
      }
      charIdx++;
    }
    out += ch;
    if (ch === '>') inTag = false;
    i++;
  }
  return out;
}

function Row({ index, style, lines, query }: RowComponentProps<RowProps>) {
  const line = lines[index];
  if (!line) return null;
  const isErr = line.stream === 'stderr';
  const html = highlight(line.text, query);
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
  const searchRef = useRef<HTMLInputElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [query, setQuery] = useState('');
  const [showStdout, setShowStdout] = useState(true);
  const [showStderr, setShowStderr] = useState(true);

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return lines.filter((l) => {
      if (l.stream === 'stdout' && !showStdout) return false;
      if (l.stream === 'stderr' && !showStderr) return false;
      if (q && !l.text.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [lines, query, showStdout, showStderr]);

  // Disable auto-scroll while filtering (user is reading).
  const effectiveAutoScroll = autoScroll && !query;

  useEffect(() => {
    if (effectiveAutoScroll && listRef.current && filtered.length > 0) {
      listRef.current.scrollToRow({ index: filtered.length - 1, align: 'end' });
    }
  }, [filtered.length, effectiveAutoScroll]);

  // Focus search on ⌘F when this panel is visible
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        if (searchRef.current) {
          e.preventDefault();
          searchRef.current.focus();
          searchRef.current.select();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!scriptId) {
    return (
      <div className="flex h-full items-center justify-center text-[11px] text-zinc-500">
        Select a process to view its logs.
      </div>
    );
  }

  const hiddenCount = lines.length - filtered.length;

  return (
    <div className="flex h-full flex-col bg-[#0a0a0a]">
      {/* Toolbar */}
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-white/10 px-3 text-[10px]">
        <span className="font-medium text-zinc-300">{scriptName ?? scriptId}</span>
        <span className="font-mono text-zinc-500">
          {filtered.length}
          {hiddenCount > 0 && <span className="text-zinc-600"> / {lines.length}</span>}
        </span>
        <div className="flex-1" />

        {/* Stream toggles */}
        <button
          onClick={() => setShowStdout(!showStdout)}
          className={`rounded px-1.5 py-0.5 transition-colors ${
            showStdout ? 'text-zinc-300' : 'text-zinc-600 line-through'
          } hover:bg-white/5`}
          title="Toggle stdout"
        >
          stdout
        </button>
        <button
          onClick={() => setShowStderr(!showStderr)}
          className={`rounded px-1.5 py-0.5 transition-colors ${
            showStderr ? 'text-red-400' : 'text-zinc-600 line-through'
          } hover:bg-white/5`}
          title="Toggle stderr"
        >
          stderr
        </button>

        {/* Search */}
        <div className="relative">
          <input
            ref={searchRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="filter…  ⌘F"
            className="h-5 w-40 rounded border border-white/10 bg-white/5 px-2 font-mono text-[10px] text-zinc-200 placeholder:text-zinc-600 focus:border-primary/50 focus:outline-none"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="close-circle absolute right-1 top-1/2 -translate-y-1/2" style={{width:16,height:16,fontSize:8}}
            >
              ✕
            </button>
          )}
        </div>

        {/* Auto-tail */}
        <label className="flex cursor-pointer items-center gap-1 text-zinc-500 transition-colors hover:text-zinc-300">
          <input
            type="checkbox"
            className="h-3 w-3 accent-primary"
            checked={autoScroll}
            disabled={!!query}
            onChange={(e) => setAutoScroll(e.target.checked)}
          />
          auto-tail
        </label>
        <button
          onClick={async () => {
            try {
              const { save } = await import('@tauri-apps/plugin-dialog');
              const { writeTextFile } = await import('@tauri-apps/plugin-fs');
              const path = await save({ defaultPath: `${scriptName ?? 'log'}.log`, filters: [{ name: 'Log', extensions: ['log', 'txt'] }] });
              if (path) {
                const content = lines.map((l) => `[${l.stream}] ${l.text}`).join('\n');
                await writeTextFile(path, content);
              }
            } catch {}
          }}
          className="rounded px-1.5 py-0.5 text-zinc-500 transition-colors hover:bg-white/10 hover:text-zinc-200"
          title="Export logs"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M6 2v6M3 5l3 3 3-3M2 10h8"/></svg>
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-hidden">
        {filtered.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[11px] text-zinc-600">
            {lines.length === 0
              ? 'waiting for output…'
              : query
              ? `no matches for "${query}"`
              : 'all streams hidden'}
          </div>
        ) : (
          <List
            listRef={listRef}
            style={{ height: '100%', width: '100%' }}
            rowCount={filtered.length}
            rowHeight={ROW_HEIGHT}
            rowComponent={Row}
            rowProps={{ lines: filtered, query: query.toLowerCase() }}
            overscanCount={30}
          />
        )}
      </div>
    </div>
  );
}
