import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { RotateCcw, Square } from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { api, type PtyDataEvent, type PtyExitEvent, type PtySession } from '@/api/tauri';

interface Props {
  projectId?: string | null;
  scriptId: string;
  scriptName?: string;
}

export function TerminalPanel({ projectId, scriptId, scriptName }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const [session, setSession] = useState<PtySession | null>(null);
  const [status, setStatus] = useState<'idle' | 'starting' | 'running' | 'exited'>('idle');
  const [err, setErr] = useState<string | null>(null);

  const resizeBackend = useCallback(() => {
    const term = termRef.current;
    const sessionId = sessionIdRef.current;
    if (!term || !sessionId) return;
    void api.resizePty(sessionId, term.cols, term.rows).catch(() => {});
  }, []);

  const start = useCallback(async () => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!projectId || !term || !fit) return;
    setErr(null);
    setStatus('starting');
    try {
      fit.fit();
      const next = await api.startPtySession(projectId, scriptId, term.cols, term.rows);
      sessionIdRef.current = next.id;
      setSession(next);
      setStatus('running');
      resizeBackend();
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      setErr(message);
      setStatus('idle');
      term.writeln(`\r\n\x1b[31mPTY start failed:\x1b[0m ${message}`);
    }
  }, [projectId, resizeBackend, scriptId]);

  const stop = useCallback(async () => {
    const id = sessionIdRef.current;
    if (!id) return;
    await api.killPty(id).catch(() => {});
    sessionIdRef.current = null;
    setSession(null);
    setStatus('exited');
  }, []);

  const restart = useCallback(async () => {
    await stop();
    termRef.current?.reset();
    await start();
  }, [start, stop]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const term = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 12,
      lineHeight: 1.2,
      scrollback: 5000,
      theme: {
        background: '#07110b',
        foreground: '#c8ccc9',
        cursor: '#9fe870',
        black: '#07110b',
        brightBlack: '#4a5a50',
        red: '#ff6b6b',
        brightRed: '#ff8f8f',
        green: '#9fe870',
        brightGreen: '#c6ff9c',
        yellow: '#ffd166',
        brightYellow: '#ffe08a',
        blue: '#70a5ff',
        brightBlue: '#9fc0ff',
        magenta: '#d8a1ff',
        brightMagenta: '#e6c2ff',
        cyan: '#79e0d4',
        brightCyan: '#a5f3eb',
        white: '#d8dfd9',
        brightWhite: '#ffffff',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    termRef.current = term;
    fitRef.current = fit;

    const dataDisposable = term.onData((data) => {
      const id = sessionIdRef.current;
      if (id) void api.writePty(id, data).catch(() => {});
    });
    const resizeDisposable = term.onResize(() => resizeBackend());

    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
        resizeBackend();
      } catch {}
    });
    observer.observe(el);
    window.setTimeout(() => {
      try {
        fit.fit();
      } catch {}
    }, 0);

    return () => {
      observer.disconnect();
      dataDisposable.dispose();
      resizeDisposable.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [resizeBackend]);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    const unsubs: Array<Promise<() => void>> = [
      listen<PtyDataEvent>('pty://data', (ev) => {
        if (cancelled || ev.payload.id !== sessionIdRef.current) return;
        termRef.current?.write(ev.payload.data);
      }),
      listen<PtyExitEvent>('pty://exit', (ev) => {
        if (cancelled || ev.payload.id !== sessionIdRef.current) return;
        setStatus('exited');
        setSession(null);
        sessionIdRef.current = null;
        const code = ev.payload.exit_code;
        termRef.current?.writeln(`\r\n\x1b[90m[process exited with code ${code}]\x1b[0m`);
      }),
    ];
    void start();
    return () => {
      cancelled = true;
      unsubs.forEach((un) => un.then((fn) => fn()));
    };
  }, [projectId, start]);

  if (!projectId) {
    return (
      <div className="flex h-full items-center justify-center bg-log-bg text-[12px] text-log-muted/60">
        Terminal is available from a project log panel.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-log-bg">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-log-border px-3 text-[11px] text-log-muted">
        <span className="font-medium text-log-fg">{scriptName ?? scriptId}</span>
        <span className="font-mono">
          {status}
          {session?.pid ? ` · pid ${session.pid}` : ''}
        </span>
        {err && <span className="truncate text-red-400">{err}</span>}
        <div className="flex-1" />
        <button
          onClick={() => void restart()}
          className="flex h-5 w-5 items-center justify-center rounded text-log-muted transition-colors hover:bg-foreground/10 hover:text-log-fg"
          title="Restart terminal"
          aria-label="Restart terminal"
        >
          <RotateCcw size={12} />
        </button>
        <button
          onClick={() => void stop()}
          className="flex h-5 w-5 items-center justify-center rounded text-log-muted transition-colors hover:bg-foreground/10 hover:text-log-fg"
          title="Stop terminal"
          aria-label="Stop terminal"
        >
          <Square size={11} />
        </button>
      </div>
      <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden bg-log-bg" />
    </div>
  );
}
