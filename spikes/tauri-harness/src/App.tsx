// S1.3 + S1.4 — Stress harness FE: seq gap detector + RSS CSV logger
import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';

interface LinePayload { eid: number; line: string }
interface Stats { total_lines: number; running: boolean }
interface EmitterState {
  received: number;
  lastSeq: number;
  gaps: number;
  firstGapAt: number | null;
}
interface RssSample { t: number; rssKb: number; totalLines: number }

const DEFAULT_SCRIPT =
  '/Users/jeonghwankim/projects/procman/spikes/s1-stdout/line-emitter.sh';

function parseSeq(line: string): number | null {
  const m = line.match(/^SEQ=(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

export default function App() {
  const [script, setScript] = useState(DEFAULT_SCRIPT);
  const [n, setN] = useState(10);
  const [rate, setRate] = useState(10000);
  const [dur, setDur] = useState(60);
  const [running, setRunning] = useState(false);
  const [stats, setStats] = useState<Stats>({ total_lines: 0, running: false });
  const [emitters, setEmitters] = useState<Record<number, EmitterState>>({});
  const [rssKb, setRssKb] = useState(0);
  const [peakRssKb, setPeakRssKb] = useState(0);
  const [samples, setSamples] = useState<RssSample[]>([]);
  const [status, setStatus] = useState('idle');

  const unlistenRefs = useRef<UnlistenFn[]>([]);
  const emittersRef = useRef<Record<number, EmitterState>>({});

  const totalGaps = Object.values(emitters).reduce((s, e) => s + e.gaps, 0);
  const totalReceived = Object.values(emitters).reduce((s, e) => s + e.received, 0);

  // Poll stats + RSS every 1s while running
  useEffect(() => {
    if (!running) return;
    const startTs = Date.now();
    const id = setInterval(async () => {
      try {
        const s = await invoke<Stats>('get_stats');
        const rss = await invoke<number>('get_rss_kb');
        setStats(s);
        setRssKb(rss);
        setPeakRssKb((p) => Math.max(p, rss));
        setSamples((prev) => [
          ...prev,
          { t: Date.now() - startTs, rssKb: rss, totalLines: s.total_lines },
        ]);
      } catch (e) {
        console.error('poll error', e);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [running]);

  async function start() {
    setEmitters({});
    emittersRef.current = {};
    setSamples([]);
    setPeakRssKb(0);
    setStatus('subscribing...');

    // Subscribe to per-eid line events
    const unlisteners: UnlistenFn[] = [];
    for (let eid = 0; eid < n; eid++) {
      const un = await listen<LinePayload>(`stress://line/${eid}`, (ev) => {
        const seq = parseSeq(ev.payload.line);
        if (seq == null) return;
        const cur = emittersRef.current[eid] ?? {
          received: 0, lastSeq: 0, gaps: 0, firstGapAt: null,
        };
        let gaps = cur.gaps;
        let firstGapAt = cur.firstGapAt;
        if (cur.lastSeq > 0 && seq !== cur.lastSeq + 1) {
          gaps += Math.max(0, seq - cur.lastSeq - 1);
          if (firstGapAt == null) firstGapAt = seq;
        }
        const next = {
          received: cur.received + 1,
          lastSeq: seq,
          gaps,
          firstGapAt,
        };
        emittersRef.current[eid] = next;
      });
      unlisteners.push(un);
    }
    unlistenRefs.current = unlisteners;

    // Force re-render of emitters state every 500ms
    const renderInt = setInterval(() => {
      setEmitters({ ...emittersRef.current });
    }, 500);
    (window as any).__renderInt = renderInt;

    setStatus('starting emitters...');
    try {
      const msg = await invoke<string>('start_stress', {
        emitterScript: script,
        nProcesses: n,
        ratePerSec: rate,
        durationSec: dur,
      });
      setStatus(msg);
      setRunning(true);
    } catch (e) {
      setStatus(`error: ${e}`);
    }
  }

  async function stop() {
    try {
      const s = await invoke<Stats>('stop_stress');
      setStats(s);
    } catch (e) {
      console.error(e);
    }
    for (const un of unlistenRefs.current) un();
    unlistenRefs.current = [];
    clearInterval((window as any).__renderInt);
    setRunning(false);
    setStatus('stopped');
  }

  function downloadCsv() {
    const header = 't_ms,rss_kb,total_lines\n';
    const rows = samples.map((s) => `${s.t},${s.rssKb},${s.totalLines}`).join('\n');
    const blob = new Blob([header + rows], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `s1-metrics-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const expectedTotal = n * rate * dur;
  const verdict =
    totalGaps === 0 && peakRssKb < 150 * 1024 ? '✅ GO' :
    totalGaps > 0 ? '❌ NO-GO (gaps)' :
    peakRssKb >= 150 * 1024 ? '❌ NO-GO (RSS≥150MB)' : '…';

  return (
    <div style={{ fontFamily: 'monospace', padding: 16, fontSize: 13 }}>
      <h2>S1 stdout stress harness</h2>
      <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 4, maxWidth: 700 }}>
        <label>emitter script:</label>
        <input value={script} onChange={(e) => setScript(e.target.value)} disabled={running} style={{ width: '100%' }} />
        <label>processes (N):</label>
        <input type="number" value={n} onChange={(e) => setN(+e.target.value)} disabled={running} />
        <label>rate (lines/s):</label>
        <input type="number" value={rate} onChange={(e) => setRate(+e.target.value)} disabled={running} />
        <label>duration (s):</label>
        <input type="number" value={dur} onChange={(e) => setDur(+e.target.value)} disabled={running} />
      </div>

      <div style={{ marginTop: 12 }}>
        <button onClick={start} disabled={running}>▶ Start</button>{' '}
        <button onClick={stop} disabled={!running}>■ Stop</button>{' '}
        <button onClick={downloadCsv} disabled={samples.length === 0}>⬇ CSV</button>
      </div>

      <hr />
      <div>
        <b>Status:</b> {status} | <b>Running:</b> {String(stats.running)}<br />
        <b>Expected:</b> {expectedTotal.toLocaleString()} lines |{' '}
        <b>Rust recv:</b> {stats.total_lines.toLocaleString()} |{' '}
        <b>FE recv:</b> {totalReceived.toLocaleString()}<br />
        <b>Gaps:</b> <span style={{ color: totalGaps > 0 ? 'red' : 'green' }}>{totalGaps}</span> |{' '}
        <b>RSS:</b> {(rssKb / 1024).toFixed(1)} MB |{' '}
        <b>Peak RSS:</b> {(peakRssKb / 1024).toFixed(1)} MB<br />
        <b>Verdict:</b> <span style={{ fontWeight: 'bold' }}>{verdict}</span>
      </div>

      <hr />
      <table cellPadding={4} style={{ borderCollapse: 'collapse' }}>
        <thead>
          <tr><th>eid</th><th>received</th><th>lastSeq</th><th>gaps</th><th>firstGapAt</th></tr>
        </thead>
        <tbody>
          {Array.from({ length: n }, (_, eid) => {
            const e = emitters[eid];
            return (
              <tr key={eid} style={{ borderTop: '1px solid #ccc' }}>
                <td>{eid}</td>
                <td>{e?.received ?? 0}</td>
                <td>{e?.lastSeq ?? 0}</td>
                <td style={{ color: (e?.gaps ?? 0) > 0 ? 'red' : 'inherit' }}>{e?.gaps ?? 0}</td>
                <td>{e?.firstGapAt ?? '-'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
