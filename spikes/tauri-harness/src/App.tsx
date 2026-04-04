// S2 PTY Auto-test Harness — runs 4 scenarios sequentially, saves report.
import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { UnlistenFn } from '@tauri-apps/api/event';

interface DataEvent { sid: number; data: string }
interface ExitEvent { sid: number; status: number | null }

interface Scenario {
  name: string;
  command: string;
  args: string[];
  steps: Array<{ delay_ms: number; input: string; label: string }>;
  timeout_ms: number;
  expect_any: string[];            // any of these strings present in output
  expect_all?: string[];           // all these strings present
  expect_regex?: RegExp;           // optional regex check
  check_ansi?: boolean;            // check for ESC[ sequences
}

interface TestResult {
  name: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  reason: string;
  output_len: number;
  output_preview: string;
  ansi_found: boolean;
  duration_ms: number;
  exit_status: number | null;
}

const SCENARIOS: Scenario[] = [
  {
    name: 'T1_zsh_baseline',
    command: '/bin/zsh',
    args: ['-i'],
    steps: [
      { delay_ms: 500, input: 'echo HELLO_PTY && echo TERM=$TERM\r', label: 'echo' },
      { delay_ms: 800, input: 'exit\r', label: 'exit' },
    ],
    timeout_ms: 5000,
    expect_all: ['HELLO_PTY', 'TERM=xterm-256color'],
    check_ansi: false,
  },
  {
    name: 'T2_python_repl',
    command: '/opt/anaconda3/bin/python3',
    args: ['-i', '-q'],
    steps: [
      { delay_ms: 800, input: 'print(2 + 40)\r', label: 'arithmetic' },
      { delay_ms: 500, input: 'import sys; print(sys.version_info[0])\r', label: 'version' },
      { delay_ms: 500, input: 'exit()\r', label: 'exit' },
    ],
    timeout_ms: 6000,
    expect_all: ['42'],
    expect_any: ['3'],
  },
  {
    name: 'T3_ansi_colors',
    command: '/bin/zsh',
    args: ['-i'],
    steps: [
      { delay_ms: 500, input: 'printf "\\033[31mRED\\033[0m\\n\\033[1;32mBOLDGREEN\\033[0m\\n"\r', label: 'ansi' },
      { delay_ms: 500, input: 'exit\r', label: 'exit' },
    ],
    timeout_ms: 5000,
    expect_all: ['RED', 'BOLDGREEN'],
    check_ansi: true,
  },
  {
    name: 'T4_docker_exec',
    command: '/usr/local/bin/docker',
    args: ['run', '-i', '--rm', 'alpine', 'sh', '-c', 'echo DOCKER_PTY_OK && uname -a'],
    steps: [],
    timeout_ms: 20000,
    expect_all: ['DOCKER_PTY_OK', 'Linux'],
  },
  {
    name: 'T5_ssh_localhost',
    command: '/usr/bin/ssh',
    args: ['-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=3', '-o', 'BatchMode=yes',
           'localhost', 'echo SSH_PTY_OK && uname -s'],
    steps: [],
    timeout_ms: 6000,
    expect_all: ['SSH_PTY_OK', 'Darwin'],
  },
];

async function runScenario(sc: Scenario, onLog: (s: string) => void): Promise<TestResult> {
  const start = Date.now();
  let accumulated = '';
  let exit_status: number | null = null;
  let exited = false;
  let sid: number;

  try {
    sid = await invoke<number>('pty_spawn', {
      command: sc.command, args: sc.args, cols: 120, rows: 30,
    });
  } catch (e) {
    return {
      name: sc.name, status: 'SKIP', reason: `spawn failed: ${e}`,
      output_len: 0, output_preview: '', ansi_found: false,
      duration_ms: Date.now() - start, exit_status: null,
    };
  }

  const unlisten: UnlistenFn[] = [];
  unlisten.push(await listen<DataEvent>(`pty://data/${sid}`, (ev) => {
    accumulated += ev.payload.data;
  }));
  unlisten.push(await listen<ExitEvent>(`pty://exit/${sid}`, (ev) => {
    exit_status = ev.payload.status;
    exited = true;
  }));

  // Execute steps
  for (const step of sc.steps) {
    await new Promise((r) => setTimeout(r, step.delay_ms));
    if (exited) break;
    try {
      await invoke('pty_write', { sid, data: step.input });
    } catch (e) {
      onLog(`${sc.name}: write error on ${step.label}: ${e}`);
    }
  }

  // Wait for exit or timeout
  const deadline = start + sc.timeout_ms;
  while (!exited && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }

  if (!exited) {
    try { await invoke('pty_kill', { sid }); } catch {}
  }
  for (const un of unlisten) un();

  const duration_ms = Date.now() - start;
  const ansi_found = /\x1b\[/.test(accumulated);

  // Check expectations
  const reasons: string[] = [];
  if (!exited) reasons.push('timeout');
  if (sc.expect_all) {
    for (const s of sc.expect_all) {
      if (!accumulated.includes(s)) reasons.push(`missing "${s}"`);
    }
  }
  if (sc.expect_any && sc.expect_any.length > 0) {
    if (!sc.expect_any.some((s) => accumulated.includes(s))) {
      reasons.push(`none of [${sc.expect_any.join(',')}]`);
    }
  }
  if (sc.check_ansi && !ansi_found) reasons.push('no ANSI ESC[ sequence');

  const status = reasons.length === 0 ? 'PASS' : 'FAIL';
  const preview = accumulated.length > 300
    ? accumulated.slice(0, 150) + '…' + accumulated.slice(-150)
    : accumulated;

  return {
    name: sc.name, status,
    reason: reasons.join('; ') || 'all checks passed',
    output_len: accumulated.length,
    output_preview: preview.replace(/\r/g, '\\r').replace(/\x1b/g, '\\e'),
    ansi_found, duration_ms, exit_status,
  };
}

export default function App() {
  const [log, setLog] = useState<string[]>(['initializing...']);
  const [results, setResults] = useState<TestResult[]>([]);
  const [done, setDone] = useState(false);
  const startedRef = useRef(false);

  const appendLog = (s: string) =>
    setLog((prev) => [...prev, `[${new Date().toISOString().slice(11, 19)}] ${s}`]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    (async () => {
      const all: TestResult[] = [];
      for (const sc of SCENARIOS) {
        appendLog(`▶ running ${sc.name}...`);
        const r = await runScenario(sc, appendLog);
        all.push(r);
        setResults([...all]);
        appendLog(`${r.status === 'PASS' ? '✅' : r.status === 'SKIP' ? '⚠️' : '❌'} ${sc.name}: ${r.status} (${r.reason}, ${r.duration_ms}ms, ${r.output_len}B)`);
        await new Promise((r) => setTimeout(r, 500));
      }

      const pass = all.filter((r) => r.status === 'PASS').length;
      const fail = all.filter((r) => r.status === 'FAIL').length;
      const skip = all.filter((r) => r.status === 'SKIP').length;
      const required_core = ['T1_zsh_baseline', 'T2_python_repl', 'T3_ansi_colors'];
      const core_pass = required_core.every((n) =>
        all.find((r) => r.name === n)?.status === 'PASS'
      );
      const verdict = core_pass ? 'GO' : 'NO-GO';

      const report = {
        completed_at: new Date().toISOString(),
        overall: { pass, fail, skip, total: all.length },
        core_3_pass: core_pass,
        verdict,
        results: all,
      };

      try {
        const path = await invoke<string>('save_report', {
          filename: '../../s2-pty/results/combined.json',
          content: JSON.stringify(report, null, 2),
        });
        appendLog(`💾 saved ${path}`);
      } catch (e) {
        appendLog(`save failed: ${e}`);
      }
      appendLog(`🏁 ALL DONE — verdict: ${verdict} (core 3 pass=${core_pass})`);
      setDone(true);
    })();
  }, []);

  return (
    <div style={{ fontFamily: 'monospace', padding: 16, fontSize: 12 }}>
      <h2>S2 PTY auto-test ({SCENARIOS.length} scenarios)</h2>
      <table cellPadding={4} style={{ borderCollapse: 'collapse', marginBottom: 12 }}>
        <thead>
          <tr><th>#</th><th>name</th><th>status</th><th>reason</th><th>bytes</th><th>ms</th><th>ANSI</th></tr>
        </thead>
        <tbody>
          {results.map((r, i) => (
            <tr key={i} style={{ borderTop: '1px solid #ccc' }}>
              <td>{i + 1}</td>
              <td>{r.name}</td>
              <td style={{ color: r.status === 'PASS' ? 'green' : r.status === 'SKIP' ? 'orange' : 'red', fontWeight: 'bold' }}>{r.status}</td>
              <td>{r.reason}</td>
              <td>{r.output_len}</td>
              <td>{r.duration_ms}</td>
              <td>{r.ansi_found ? '✓' : '·'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {done && <p style={{ fontWeight: 'bold' }}>You can close this window.</p>}
      <pre style={{ background: '#111', color: '#0f0', padding: 8, maxHeight: 300, overflow: 'auto' }}>
        {log.join('\n')}
      </pre>
    </div>
  );
}
