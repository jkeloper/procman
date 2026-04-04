// S3 xterm.js on WKWebView — 100k line dump benchmark + PTY integration.
import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';

interface DataEvent { sid: number; data: string }

interface BenchResult {
  test: string;
  lines: number;
  wall_ms: number;
  effective_lps: number;      // lines per second throughput to xterm
  fps_avg: number;
  fps_p5: number;
  fps_min: number;
  fps_max: number;
  frames: number;
  samples: number;            // number of FPS samples
  renderer: string;           // "webgl" | "canvas"
  verdict: 'GO' | 'NO-GO';
  no_go_reasons: string[];
}

const BENCH_LINES = 100_000;
const BENCH_CHUNK = 200;          // smaller chunks for finer FPS resolution
const BENCH_CHUNK_DELAY_MS = 2;   // small delay so rAF has time to tick between chunks

// rAF-based FPS meter
class FpsMeter {
  samples: number[] = [];
  private running = false;
  private lastTime = 0;
  private frameCount = 0;
  private bucketStart = 0;
  start() {
    this.running = true;
    this.lastTime = performance.now();
    this.bucketStart = this.lastTime;
    this.frameCount = 0;
    this.samples = [];
    const tick = (t: number) => {
      if (!this.running) return;
      this.frameCount++;
      if (t - this.bucketStart >= 100) {
        const fps = (this.frameCount * 1000) / (t - this.bucketStart);
        this.samples.push(fps);
        this.bucketStart = t;
        this.frameCount = 0;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
  stop() { this.running = false; }
  summary() {
    if (this.samples.length === 0) return { avg: 0, p5: 0, min: 0, max: 0, count: 0 };
    const sorted = [...this.samples].sort((a, b) => a - b);
    const avg = this.samples.reduce((s, v) => s + v, 0) / this.samples.length;
    return {
      avg,
      p5: sorted[Math.floor(sorted.length * 0.05)],
      min: sorted[0],
      max: sorted[sorted.length - 1],
      count: this.samples.length,
    };
  }
}

function genLine(i: number): string {
  // ~100-byte line with some ANSI color variation
  const hue = i % 7;
  const color = 31 + hue; // 31..37 = red..white
  const ts = new Date().toISOString();
  return `\x1b[${color}m[${ts}]\x1b[0m lineno=${i.toString().padStart(6, '0')} payload=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\r\n`;
}

export default function App() {
  const termRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [renderer, setRenderer] = useState<'webgl' | 'canvas'>('canvas');
  const [rendererMsg, setRendererMsg] = useState('');
  const [log, setLog] = useState<string[]>([]);
  const [bench, setBench] = useState<BenchResult | null>(null);
  const [ptySid, setPtySid] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const appendLog = (s: string) =>
    setLog((p) => [...p, `[${new Date().toISOString().slice(11, 19)}] ${s}`]);

  // xterm init
  useEffect(() => {
    if (!termRef.current || xtermRef.current) return;
    const term = new Terminal({
      fontFamily: 'Menlo, monospace',
      fontSize: 12,
      theme: { background: '#000', foreground: '#eee' },
      scrollback: 50000,
      convertEol: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(termRef.current);
    fit.fit();

    // Probe raw WebGL2 availability first (independent of xterm addon)
    const probe = document.createElement('canvas');
    const gl2 = probe.getContext('webgl2');
    const gl1 = probe.getContext('webgl');
    const rendererInfo = gl2
      ? 'webgl2 available'
      : gl1
      ? 'webgl1 only'
      : 'no webgl';

    // Try WebGL addon
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        setRendererMsg('WebGL context lost — reverting to canvas');
        webgl.dispose();
        setRenderer('canvas');
      });
      term.loadAddon(webgl);
      setRenderer('webgl');
      setRendererMsg(`WebGL addon OK (${rendererInfo})`);
    } catch (e: any) {
      setRenderer('canvas');
      setRendererMsg(`addon throw: ${e?.message || e} | probe: ${rendererInfo}`);
    }

    xtermRef.current = term;
    fitRef.current = fit;

    const onResize = () => fit.fit();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      term.dispose();
      xtermRef.current = null;
    };
  }, []);

  const runBenchmark = async () => {
    if (!xtermRef.current || running) return;
    setRunning(true);
    const term = xtermRef.current;
    term.clear();
    appendLog(`▶ benchmark: dumping ${BENCH_LINES} lines in chunks of ${BENCH_CHUNK}`);

    const fps = new FpsMeter();
    fps.start();
    const start = performance.now();

    let i = 0;
    while (i < BENCH_LINES) {
      const end = Math.min(i + BENCH_CHUNK, BENCH_LINES);
      let chunk = '';
      for (let j = i; j < end; j++) chunk += genLine(j);
      term.write(chunk);
      i = end;
      if (BENCH_CHUNK_DELAY_MS > 0) {
        await new Promise((r) => setTimeout(r, BENCH_CHUNK_DELAY_MS));
      } else {
        // Yield to allow rAF to fire
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    // Wait for final render
    await new Promise<void>((r) => term.write('', () => r()));
    await new Promise((r) => setTimeout(r, 200));
    fps.stop();
    const wall_ms = performance.now() - start;
    const sum = fps.summary();

    const no_go: string[] = [];
    if (sum.avg < 60) no_go.push(`avg fps ${sum.avg.toFixed(1)} < 60`);
    if (sum.p5 < 30) no_go.push(`p5 fps ${sum.p5.toFixed(1)} < 30`);
    const verdict: 'GO' | 'NO-GO' = no_go.length === 0 ? 'GO' : 'NO-GO';

    const result: BenchResult = {
      test: '100k-line-dump',
      lines: BENCH_LINES,
      wall_ms: Math.round(wall_ms),
      effective_lps: Math.round((BENCH_LINES * 1000) / wall_ms),
      fps_avg: +sum.avg.toFixed(1),
      fps_p5: +sum.p5.toFixed(1),
      fps_min: +sum.min.toFixed(1),
      fps_max: +sum.max.toFixed(1),
      frames: sum.count,
      samples: sum.count,
      renderer,
      verdict,
      no_go_reasons: no_go,
    };
    setBench(result);
    appendLog(`🏁 done in ${wall_ms.toFixed(0)}ms, fps avg=${sum.avg.toFixed(1)} p5=${sum.p5.toFixed(1)} min=${sum.min.toFixed(1)}`);
    appendLog(`verdict: ${verdict}${no_go.length ? ' (' + no_go.join(', ') + ')' : ''}`);

    try {
      const path = await invoke<string>('save_report', {
        filename: '../../s3-xterm/results/bench.json',
        content: JSON.stringify(result, null, 2),
      });
      appendLog(`💾 saved ${path}`);
    } catch (e) {
      appendLog(`save failed: ${e}`);
    }
    setRunning(false);
  };

  const spawnPty = async () => {
    if (ptySid != null) return;
    const term = xtermRef.current;
    if (!term) return;
    const cols = term.cols;
    const rows = term.rows;
    const sid = await invoke<number>('pty_spawn', {
      command: '/bin/zsh', args: ['-i'], cols, rows,
    });
    setPtySid(sid);
    appendLog(`PTY spawned sid=${sid} (${cols}×${rows})`);

    const un1: UnlistenFn = await listen<DataEvent>(`pty://data/${sid}`, (ev) => {
      term.write(ev.payload.data);
    });
    const onData = term.onData((data: string) => {
      invoke('pty_write', { sid, data });
    });
    const un2 = await listen(`pty://exit/${sid}`, () => {
      appendLog(`PTY exited`);
      un1();
      onData.dispose();
      setPtySid(null);
    });
    (window as any).__ptyUnlisteners = [un1, un2];
  };

  // Auto-run benchmark on mount (wait for renderer detection to stabilize)
  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (autoStartedRef.current) return;
    if (!xtermRef.current) return;
    if (!rendererMsg) return; // wait until renderer probe logged
    autoStartedRef.current = true;
    setTimeout(() => runBenchmark(), 800);
  }, [rendererMsg]);

  return (
    <div style={{ fontFamily: 'monospace', padding: 12, fontSize: 12 }}>
      <h3>S3 xterm.js WKWebView bench</h3>
      <div>
        Renderer: <b style={{ color: renderer === 'webgl' ? 'green' : 'orange' }}>{renderer}</b> — {rendererMsg}
      </div>
      <div style={{ marginTop: 8, marginBottom: 8 }}>
        <button onClick={runBenchmark} disabled={running}>▶ Re-run 100k dump</button>{' '}
        <button onClick={spawnPty} disabled={ptySid != null}>Spawn zsh PTY</button>
      </div>
      {bench && (
        <div style={{ background: '#f0f0f0', padding: 8, marginBottom: 8 }}>
          <b>Verdict: <span style={{ color: bench.verdict === 'GO' ? 'green' : 'red' }}>{bench.verdict}</span></b>
          {' | '}renderer={bench.renderer} | lines={bench.lines.toLocaleString()} |
          wall={bench.wall_ms}ms | lps={bench.effective_lps.toLocaleString()} |
          fps avg={bench.fps_avg} p5={bench.fps_p5} min={bench.fps_min} max={bench.fps_max}
          {bench.no_go_reasons.length > 0 && <div style={{ color: 'red' }}>No-Go: {bench.no_go_reasons.join(', ')}</div>}
        </div>
      )}
      <div ref={termRef} style={{ width: '100%', height: 420, background: '#000' }} />
      <pre style={{ background: '#111', color: '#0f0', padding: 6, marginTop: 8, maxHeight: 150, overflow: 'auto', fontSize: 11 }}>
        {log.join('\n')}
      </pre>
    </div>
  );
}
