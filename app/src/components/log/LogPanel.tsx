import { useEffect, useMemo, useRef, useState } from 'react';
import { List, type ListImperativeAPI, type RowComponentProps } from 'react-window';
import AnsiToHtml from 'ansi-to-html';
import { useLogStream } from '@/hooks/useLogStream';
import type { LogLine } from '@/api/tauri';

const ansi = new AnsiToHtml({
  fg: '#c8ccc9',
  bg: '#252b26',
  newline: false,
  escapeXML: true,
});

interface Props {
  scriptId: string | null;
  scriptName?: string;
}

const ROW_HEIGHT = 20;

type RowProps = { lines: LogLine[]; query: string };

// W1: Log-level keyword patterns and their highlight classes.
const LOG_LEVEL_PATTERNS: Array<[RegExp, string]> = [
  [/\b(ERROR|FATAL|PANIC|EXCEPTION)\b/gi, 'text-red-400 font-semibold'],
  [/\b(WARN(?:ING)?)\b/gi, 'text-amber-400'],
  [/\b(INFO)\b/gi, 'text-sky-400'],
  [/\b(DEBUG|TRACE)\b/gi, 'text-zinc-500'],
];

function applyLevelHighlight(html: string): string {
  let result = html;
  for (const [pattern, cls] of LOG_LEVEL_PATTERNS) {
    result = result.replace(pattern, (m) => `<span class="${cls}">${m}</span>`);
  }
  return result;
}

function highlight(text: string, query: string): string {
  // Escape HTML-special chars in text first (ansi.toHtml already does that),
  // then wrap matches in <mark>. query is already lower-cased.
  if (!query) return applyLevelHighlight(ansi.toHtml(text));
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
  return applyLevelHighlight(out);
}

type RowPropsWithCache = RowProps & { cache: Map<number, string> };

function Row({ index, style, lines, query, cache }: RowComponentProps<RowPropsWithCache>) {
  const line = lines[index];
  if (!line) return null;
  const isErr = line.stream === 'stderr';
  let html = cache.get(line.seq);
  if (html === undefined) {
    html = highlight(line.text, query);
    cache.set(line.seq, html);
  }
  return (
    <div
      style={style}
      className={`flex items-center gap-2 px-4 font-mono text-[12px] leading-[20px] ${
        isErr ? 'bg-red-500/5 text-red-400' : 'text-log-fg'
      } hover:bg-foreground/5`}
    >
      <span className="w-[52px] shrink-0 select-none text-right text-[11px] text-log-muted/60 tabular-nums">
        {line.seq}
      </span>
      <span
        className="min-w-0 flex-1 truncate"
        title={line.text}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

export function LogPanel({ scriptId, scriptName }: Props) {
  const { lines, clear } = useLogStream(scriptId);
  const listRef = useRef<ListImperativeAPI>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [query, setQuery] = useState('');
  const [showStdout, setShowStdout] = useState(true);
  const [showStderr, setShowStderr] = useState(true);
  // Per-instance HTML cache — scoped to this LogPanel so lines from
  // different scripts never share cached HTML by seq collision.
  // Cleared whenever the filter query changes (because highlight depends
  // on query).
  const htmlCacheRef = useRef<Map<number, string>>(new Map());
  useEffect(() => {
    htmlCacheRef.current.clear();
  }, [query]);

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

  // Auto-detect when the user scrolls away from the bottom and
  // disable auto-tail. Re-enable when they scroll back to the bottom.
  // Without this, every new log line snaps the view to the bottom,
  // making it impossible to read older output while the process runs.
  useEffect(() => {
    const el = listRef.current?.element;
    if (!el) return;
    const onScroll = () => {
      const atBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight < ROW_HEIGHT * 2;
      setAutoScroll(atBottom);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [listRef.current?.element]);

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
      <div className="flex h-full items-center justify-center text-[12px] text-log-muted">
        Select a process to view its logs.
      </div>
    );
  }

  const lowerQuery = useMemo(() => query.toLowerCase(), [query]);
  const rowPropsMemo = useMemo(
    () => ({ lines: filtered, query: lowerQuery, cache: htmlCacheRef.current }),
    [filtered, lowerQuery],
  );
  const hiddenCount = lines.length - filtered.length;

  return (
    <div className="flex h-full flex-col bg-log-bg">
      {/* Toolbar */}
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-log-border px-3 text-[11px]">
        <span className="font-medium text-log-fg">{scriptName ?? scriptId}</span>
        <span className="font-mono text-log-muted">
          {filtered.length}
          {hiddenCount > 0 && <span className="text-log-muted/60"> / {lines.length}</span>}
        </span>
        <div className="flex-1" />

        {/* Stream toggles */}
        <button
          onClick={() => setShowStdout(!showStdout)}
          className={`rounded px-2 py-1 text-[12px] transition-colors ${
            showStdout ? 'text-log-fg' : 'text-log-muted/60 line-through'
          } hover:bg-foreground/5`}
          title="Toggle stdout"
          aria-pressed={showStdout}
        >
          stdout
        </button>
        <button
          onClick={() => setShowStderr(!showStderr)}
          className={`rounded px-2 py-1 text-[12px] transition-colors ${
            showStderr ? 'text-red-400' : 'text-log-muted/60 line-through'
          } hover:bg-foreground/5`}
          title="Toggle stderr"
          aria-pressed={showStderr}
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
            className="h-5 w-40 rounded border border-log-border bg-foreground/5 px-2 font-mono text-[11px] text-log-fg placeholder:text-log-muted/60 focus:border-primary/50 focus:outline-none"
          />
          {query && (
            <button
              aria-label="Clear filter"
              onClick={() => setQuery('')}
              className="close-circle absolute right-1 top-1/2 -translate-y-1/2"
              style={{ width: 16, height: 16 }}
            />
          )}
        </div>

        {/* Auto-tail */}
        <label className="flex cursor-pointer items-center gap-1 text-log-muted transition-colors hover:text-log-fg">
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
          onClick={clear}
          className="rounded px-1.5 py-0.5 text-log-muted transition-colors hover:bg-foreground/10 hover:text-log-fg"
          title="Clear log"
          aria-label="Clear log"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 3h8M4 3V2h4v1M4.5 5v4M7.5 5v4M3 3v7a1 1 0 001 1h4a1 1 0 001-1V3" />
          </svg>
        </button>
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
          className="rounded px-1.5 py-0.5 text-log-muted transition-colors hover:bg-foreground/10 hover:text-log-fg"
          title="Export logs"
          aria-label="Export logs"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M6 2v6M3 5l3 3 3-3M2 10h8"/></svg>
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-hidden">
        {filtered.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[12px] text-log-muted/60">
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
            rowProps={rowPropsMemo}
            overscanCount={30}
          />
        )}
      </div>
    </div>
  );
}
