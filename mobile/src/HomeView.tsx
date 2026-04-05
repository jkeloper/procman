import { useCallback, useEffect, useState } from 'react';
import { api, openStream, type ProcessSnapshot, type ProjectsPayload } from './api';
import { clearPair, loadPair } from './pair';

interface Props {
  onUnpair: () => void;
  onOpenLogs: (scriptId: string, scriptName: string) => void;
}

interface Row {
  script_id: string;
  project_id: string;
  project: string;
  name: string;
  command: string;
  status: 'running' | 'stopped' | 'crashed';
  pid: number | null;
  expected_port: number | null;
}

export function HomeView({ onUnpair, onOpenLogs }: Props) {
  const [projects, setProjects] = useState<ProjectsPayload['projects']>([]);
  const [processes, setProcesses] = useState<ProcessSnapshot[]>([]);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [cfg, procs] = await Promise.all([api.projects(), api.processes()]);
      setProjects(cfg.projects);
      setProcesses(procs);
      setErr(null);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
    const stop = openStream((ev) => {
      if (ev.type === 'status') {
        setProcesses((prev) => {
          const idx = prev.findIndex((p) => p.id === ev.id);
          if (ev.status === 'running') {
            const row: ProcessSnapshot = {
              id: ev.id,
              pid: ev.pid ?? 0,
              status: 'running',
              started_at_ms: ev.ts_ms,
              command: idx >= 0 ? prev[idx].command : '',
            };
            if (idx >= 0) {
              const next = [...prev];
              next[idx] = row;
              return next;
            }
            return [...prev, row];
          }
          // non-running → remove from active list
          return prev.filter((p) => p.id !== ev.id);
        });
      }
    }, setConnected);
    return stop;
  }, [refresh]);

  const rows: Row[] = [];
  for (const p of projects) {
    for (const s of p.scripts) {
      const proc = processes.find((x) => x.id === s.id);
      rows.push({
        script_id: s.id,
        project_id: p.id,
        project: p.name,
        name: s.name,
        command: s.command,
        status: (proc?.status as Row['status']) ?? 'stopped',
        pid: proc?.pid ?? null,
        expected_port: s.expected_port,
      });
    }
  }
  const running = rows.filter((r) => r.status === 'running').length;

  async function act(action: 'start' | 'stop' | 'restart', scriptId: string) {
    setBusy(scriptId);
    try {
      if (action === 'start') await api.start(scriptId);
      else if (action === 'stop') await api.stop(scriptId);
      else await api.restart(scriptId);
      setTimeout(refresh, 200);
    } catch (e: any) {
      alert(`${action} failed: ${e?.message ?? e}`);
    } finally {
      setBusy(null);
    }
  }

  function unpair() {
    if (!window.confirm('Unpair this device?')) return;
    clearPair();
    onUnpair();
  }

  const pair = loadPair();

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        paddingTop: 'env(safe-area-inset-top, 0px)',
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '12px 16px 10px',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
        }}
      >
        <span style={{ fontSize: 11, color: connected ? '#65C18C' : '#f87171' }}>●</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>procman remote</div>
          <div style={{ fontSize: 10, color: '#9bb5a4', fontFamily: 'ui-monospace, monospace' }}>
            {pair?.host}:{pair?.port} · {running} running
          </div>
        </div>
        <button
          onClick={refresh}
          style={{ ...btnGhost, fontSize: 14 }}
          title="Refresh"
        >
          ↻
        </button>
        <button onClick={unpair} style={btnGhost}>
          unpair
        </button>
      </header>

      {err && (
        <div style={{ padding: '10px 16px', background: 'rgba(255,100,100,0.1)', fontSize: 12, color: '#ff8a8a' }}>
          {err}
        </div>
      )}

      <div style={{ flex: 1, overflow: 'auto' }}>
        {rows.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: '#666', fontSize: 13 }}>
            No scripts on this procman instance.
          </div>
        ) : (
          <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
            {rows.map((r) => (
              <li
                key={r.script_id}
                onClick={() => onOpenLogs(r.script_id, `${r.project}/${r.name}`)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '14px 16px',
                  borderBottom: '1px solid rgba(255,255,255,0.04)',
                  cursor: 'pointer',
                }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 4,
                    background:
                      r.status === 'running'
                        ? '#65C18C'
                        : r.status === 'crashed'
                        ? '#f87171'
                        : '#3a4a3f',
                    flexShrink: 0,
                  }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                    <span style={{ fontSize: 11, color: '#9bb5a4' }}>{r.project}/</span>
                    <span style={{ fontSize: 14, fontWeight: 500, color: '#e4efe7' }}>{r.name}</span>
                    {r.expected_port && (
                      <span
                        style={{
                          fontSize: 10,
                          fontFamily: 'ui-monospace, monospace',
                          color: '#9bb5a4',
                          background: 'rgba(255,255,255,0.05)',
                          padding: '1px 6px',
                          borderRadius: 4,
                        }}
                      >
                        :{r.expected_port}
                      </span>
                    )}
                    {r.pid != null && (
                      <span
                        style={{
                          fontSize: 10,
                          color: '#666',
                          fontFamily: 'ui-monospace, monospace',
                        }}
                      >
                        pid {r.pid}
                      </span>
                    )}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      fontFamily: 'ui-monospace, monospace',
                      color: '#666',
                      marginTop: 2,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    $ {r.command}
                  </div>
                </div>
                <div
                  style={{ display: 'flex', gap: 6 }}
                  onClick={(e) => e.stopPropagation()}
                >
                  {r.status === 'running' ? (
                    <>
                      <button
                        onClick={() => act('restart', r.script_id)}
                        disabled={busy === r.script_id}
                        style={btnGhost}
                        title="Restart"
                      >
                        ↻
                      </button>
                      <button
                        onClick={() => act('stop', r.script_id)}
                        disabled={busy === r.script_id}
                        style={btnOutline}
                      >
                        stop
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => act('start', r.script_id)}
                      disabled={busy === r.script_id}
                      style={btnPrimary}
                    >
                      {busy === r.script_id ? '…' : 'start'}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

const btnBase: React.CSSProperties = {
  border: 'none',
  borderRadius: 6,
  padding: '6px 12px',
  fontSize: 12,
  fontWeight: 500,
  cursor: 'pointer',
};
const btnPrimary: React.CSSProperties = {
  ...btnBase,
  background: '#65C18C',
  color: '#0d1a12',
};
const btnOutline: React.CSSProperties = {
  ...btnBase,
  background: 'transparent',
  border: '1px solid rgba(255,255,255,0.15)',
  color: '#e4efe7',
};
const btnGhost: React.CSSProperties = {
  ...btnBase,
  background: 'transparent',
  color: '#9bb5a4',
  padding: '6px 8px',
};
