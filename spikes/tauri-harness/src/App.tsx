// S1.5 Auto-run mode — runs 3 measurements sequentially, saves each as JSON, then quits.
import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { UnlistenFn } from '@tauri-apps/api/event';

interface LinePayload { eid: number; line: string }
interface Stats { total_lines: number; running: boolean }
interface EmitterState { received: number; lastSeq: number; gaps: number; firstGapAt: number | null }
interface RssSample { t: number; rssKb: number; totalLines: number }
interface RunReport {
  run_idx: number;
  params: { n: number; rate: number; duration: number };
  start_ts: number;
  end_ts: number;
  wall_sec: number;
  expected_total: number;
  rust_total_lines: number;
  fe_total_received: number;
  total_gaps: number;
  per_eid: Array<{ eid: number; received: number; lastSeq: number; gaps: number; firstGapAt: number | null }>;
  peak_rss_kb: number;
  samples: RssSample[];
  verdict: 'GO' | 'NO-GO';
  no_go_reasons: string[];
}

const SCRIPT = '/Users/jeonghwankim/projects/procman/spikes/s1-stdout/line-emitter';
const N = 10;
const RATE = 10000;
const DURATION = 60;
const GAP_BETWEEN_RUNS_SEC = 8;
const TOTAL_RUNS = 3;

function parseSeq(line: string): number | null {
  const m = line.match(/^SEQ=(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

async function runOne(idx: number, onProgress: (msg: string) => void): Promise<RunReport> {
  const params = { n: N, rate: RATE, duration: DURATION };
  const expected_total = N * RATE * DURATION;
  const emitters: Record<number, EmitterState> = {};
  const samples: RssSample[] = [];
  let peakRssKb = 0;

  // Subscribe to per-eid events
  const unlisteners: UnlistenFn[] = [];
  for (let eid = 0; eid < N; eid++) {
    const un = await listen<LinePayload>(`stress://line/${eid}`, (ev) => {
      const seq = parseSeq(ev.payload.line);
      if (seq == null) return;
      const cur = emitters[eid] ?? { received: 0, lastSeq: 0, gaps: 0, firstGapAt: null };
      let gaps = cur.gaps;
      let firstGapAt = cur.firstGapAt;
      if (cur.lastSeq > 0 && seq !== cur.lastSeq + 1) {
        gaps += Math.max(0, seq - cur.lastSeq - 1);
        if (firstGapAt == null) firstGapAt = seq;
      }
      emitters[eid] = { received: cur.received + 1, lastSeq: seq, gaps, firstGapAt };
    });
    unlisteners.push(un);
  }

  onProgress(`run ${idx}: starting ${N} emitters × ${RATE}/s × ${DURATION}s`);
  const start_ts = Date.now();
  await invoke<string>('start_stress', {
    emitterScript: SCRIPT, nProcesses: N, ratePerSec: RATE, durationSec: DURATION,
  });

  // Poll stats + RSS every 1s
  const pollInterval = setInterval(async () => {
    const rss = await invoke<number>('get_rss_kb');
    const s = await invoke<Stats>('get_stats');
    peakRssKb = Math.max(peakRssKb, rss);
    samples.push({ t: Date.now() - start_ts, rssKb: rss, totalLines: s.total_lines });
    onProgress(`run ${idx}: t=${Math.round((Date.now() - start_ts) / 1000)}s  rss=${(rss/1024).toFixed(0)}MB  lines=${s.total_lines}`);
  }, 1000);

  // Wait for duration + grace
  await new Promise((r) => setTimeout(r, (DURATION + 3) * 1000));
  clearInterval(pollInterval);
  const finalStats = await invoke<Stats>('stop_stress');
  const end_ts = Date.now();
  for (const un of unlisteners) un();

  // Build report
  const per_eid = Array.from({ length: N }, (_, eid) => ({
    eid,
    received: emitters[eid]?.received ?? 0,
    lastSeq: emitters[eid]?.lastSeq ?? 0,
    gaps: emitters[eid]?.gaps ?? 0,
    firstGapAt: emitters[eid]?.firstGapAt ?? null,
  }));
  const total_gaps = per_eid.reduce((s, e) => s + e.gaps, 0);
  const fe_total_received = per_eid.reduce((s, e) => s + e.received, 0);
  const no_go_reasons: string[] = [];
  if (total_gaps > 0) no_go_reasons.push(`${total_gaps} seq gaps`);
  if (peakRssKb >= 150 * 1024) no_go_reasons.push(`peak RSS ${(peakRssKb/1024).toFixed(1)}MB ≥ 150MB`);
  const verdict: 'GO' | 'NO-GO' = no_go_reasons.length === 0 ? 'GO' : 'NO-GO';

  return {
    run_idx: idx, params, start_ts, end_ts,
    wall_sec: (end_ts - start_ts) / 1000,
    expected_total,
    rust_total_lines: finalStats.total_lines,
    fe_total_received,
    total_gaps, per_eid,
    peak_rss_kb: peakRssKb, samples,
    verdict, no_go_reasons,
  };
}

export default function App() {
  const [status, setStatus] = useState('initializing...');
  const [reports, setReports] = useState<RunReport[]>([]);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    (async () => {
      const allReports: RunReport[] = [];
      for (let i = 1; i <= TOTAL_RUNS; i++) {
        try {
          const rep = await runOne(i, setStatus);
          allReports.push(rep);
          setReports([...allReports]);
          const saved = await invoke<string>('save_report', {
            filename: `run-${i}.json`,
            content: JSON.stringify(rep, null, 2),
          });
          setStatus(`run ${i} done → ${saved} (verdict: ${rep.verdict})`);
          if (i < TOTAL_RUNS) {
            setStatus(`sleeping ${GAP_BETWEEN_RUNS_SEC}s before run ${i + 1}...`);
            await new Promise((r) => setTimeout(r, GAP_BETWEEN_RUNS_SEC * 1000));
          }
        } catch (e) {
          setStatus(`run ${i} ERROR: ${e}`);
          return;
        }
      }
      // Save combined summary
      const combined = {
        completed_at: new Date().toISOString(),
        runs: allReports,
        overall_verdict: allReports.every((r) => r.verdict === 'GO') ? 'GO' : 'NO-GO',
      };
      await invoke<string>('save_report', {
        filename: 'combined.json',
        content: JSON.stringify(combined, null, 2),
      });
      setStatus(`ALL DONE. Overall verdict: ${combined.overall_verdict}. You can close this window.`);
    })();
  }, []);

  return (
    <div style={{ fontFamily: 'monospace', padding: 16, fontSize: 13 }}>
      <h2>S1.5 Auto-run ({TOTAL_RUNS}× measurement)</h2>
      <p>Params: <b>{N}</b> procs × <b>{RATE}</b> lines/s × <b>{DURATION}</b>s per run</p>
      <p>Expected per run: <b>{(N * RATE * DURATION).toLocaleString()}</b> lines</p>
      <hr />
      <div style={{ background: '#222', color: '#0f0', padding: 8 }}>{status}</div>
      <hr />
      <table cellPadding={6} style={{ borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th>run</th><th>verdict</th><th>Rust lines</th><th>FE recv</th>
            <th>expected</th><th>gaps</th><th>peak RSS</th><th>wall</th>
          </tr>
        </thead>
        <tbody>
          {reports.map((r) => (
            <tr key={r.run_idx} style={{ borderTop: '1px solid #666' }}>
              <td>{r.run_idx}</td>
              <td style={{ color: r.verdict === 'GO' ? 'green' : 'red', fontWeight: 'bold' }}>{r.verdict}</td>
              <td>{r.rust_total_lines.toLocaleString()}</td>
              <td>{r.fe_total_received.toLocaleString()}</td>
              <td>{r.expected_total.toLocaleString()}</td>
              <td style={{ color: r.total_gaps > 0 ? 'red' : 'inherit' }}>{r.total_gaps}</td>
              <td>{(r.peak_rss_kb / 1024).toFixed(1)} MB</td>
              <td>{r.wall_sec.toFixed(1)}s</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
