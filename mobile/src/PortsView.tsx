import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type DeclaredPortStatus, type ProcessSnapshot, type ProjectsPayload } from './api';
import { ArrowLeft, RefreshCw } from './icons';
import './mobile.css';

interface PortEntry {
  port: number;
  pid: number;
  process_name: string;
}

interface Props {
  onBack: () => void;
  // WS8: registered scripts + live processes, used to resolve which listening
  // ports are owned by a registered (and currently running) script. The Stop
  // button only ever targets such scripts — never an arbitrary lsof PID — so
  // the remote security boundary (actions limited to registered scripts) holds.
  projects: ProjectsPayload['projects'];
  processes: ProcessSnapshot[];
}

export function PortsView({ onBack, projects, processes }: Props) {
  const [ports, setPorts] = useState<PortEntry[]>([]);
  const [aliases, setAliases] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [stopping, setStopping] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<Record<string, DeclaredPortStatus[]>>({});

  // Map a listening (pid, port) pair → the registered, running script the
  // BACKEND confirms owns that listener. We key on the actual holder PID +
  // `owned_by_script` (not a mere declared-number match) so a foreign process
  // that happens to sit on a declared port is NOT mislabelled as ours and does
  // NOT get a Stop button that would kill the wrong script. The Stop button
  // still only ever targets a registered script id, never an arbitrary PID.
  const ownerByPort = useMemo(() => {
    const labelOf = (scriptId: string) => {
      for (const proj of projects) {
        const s = proj.scripts.find((x) => x.id === scriptId);
        if (s) return `${proj.name}/${s.name}`;
      }
      return scriptId;
    };
    const map = new Map<string, { scriptId: string; label: string }>();
    for (const [scriptId, sts] of Object.entries(statuses)) {
      for (const st of sts) {
        if (st.owned_by_script && st.state === 'listening_managed' && st.holder_pid != null) {
          map.set(`${st.holder_pid}:${st.spec.number}`, { scriptId, label: labelOf(scriptId) });
        }
      }
    }
    return map;
  }, [projects, statuses]);

  // Keep the latest projects/processes in a ref so `reload` can stay stable
  // (empty deps). Otherwise `reload` would change identity on every WS status
  // event (each hands `processes` a fresh array ref), tearing down and
  // re-firing the 3s interval — and an extra lsof/ps-heavy portStatusBatch —
  // on every status change while this view is open.
  const dataRef = useRef({ projects, processes });
  dataRef.current = { projects, processes };

  const reload = useCallback(async () => {
    const { projects, processes } = dataRef.current;
    const targets = projects
      .flatMap((p) => p.scripts)
      .filter(
        (s) =>
          processes.some((x) => x.id === s.id && x.status === 'running') &&
          s.ports &&
          s.ports.length > 0,
      );
    try {
      const [p, a, statusRows] = await Promise.all([
        api.ports(),
        api.portAliases().catch(() => ({})),
        targets.length
          ? api
              .portStatusBatch(targets.map((s) => s.id))
              .catch(() => [] as Array<[string, DeclaredPortStatus[]]>)
          : Promise.resolve([] as Array<[string, DeclaredPortStatus[]]>),
      ]);
      setPorts(p);
      setAliases(a ?? {});
      const sm: Record<string, DeclaredPortStatus[]> = {};
      for (const [id, st] of statusRows) sm[id] = st;
      setStatuses(sm);
    } catch {
      // Leave the previous snapshot visible when a poll fails.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
    const id = setInterval(reload, 3000);
    return () => clearInterval(id);
  }, [reload]);

  async function saveAlias(port: number, alias: string) {
    try {
      await api.setPortAlias(port, alias);
      setAliases((prev) => {
        const next = { ...prev };
        if (alias.trim()) next[String(port)] = alias.trim();
        else delete next[String(port)];
        return next;
      });
    } catch {
      // Inline alias edits are optimistic; keep the current value on failure.
    }
    setEditing(null);
  }

  async function stopOwner(scriptId: string, label: string) {
    if (!window.confirm(`Stop "${label}"?`)) return;
    setStopping(scriptId);
    try {
      await api.stop(scriptId);
      // The status poll in MainView will refresh ownership; reload the lsof
      // snapshot so the port disappears once the process releases it.
      setTimeout(reload, 400);
    } catch (e: unknown) {
      alert(`stop: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setStopping(null);
    }
  }

  return (
    <div className="page">
      <div className="topbar">
        <button className="btn-ghost" onClick={onBack}><ArrowLeft size={18} /></button>
        <span className="topbar-title">Ports</span>
        <span className="topbar-sub">{ports.length} listening</span>
        <button className="btn-ghost" onClick={reload}><RefreshCw size={18} /></button>
      </div>

      <div style={{ flex: 1, overflow: 'auto' }}>
        {loading ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--fg3)', fontSize: 14 }}>Loading...</div>
        ) : ports.length === 0 ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--fg3)', fontSize: 14 }}>No listening ports.</div>
        ) : (
          ports.map((p) => {
            const alias = aliases[String(p.port)] ?? '';
            const isEditing = editing === p.port;
            const owner = ownerByPort.get(`${p.pid}:${p.port}`);
            return (
              <div key={`${p.pid}-${p.port}`} className="script-row" style={{ minHeight: 56 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{
                      fontFamily: 'var(--mono)', fontSize: 15, fontWeight: 600,
                      color: 'var(--green)', background: 'rgba(101,193,140,0.1)',
                      padding: '2px 8px', borderRadius: 6,
                    }}>
                      :{p.port}
                    </span>
                    {isEditing ? (
                      <input
                        autoFocus
                        style={{
                          height: 28, width: 120, borderRadius: 6,
                          border: '1px solid var(--border)', background: 'var(--bg2)',
                          padding: '0 8px', fontSize: 13, color: 'var(--fg)',
                        }}
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={() => saveAlias(p.port, draft)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') saveAlias(p.port, draft);
                          if (e.key === 'Escape') setEditing(null);
                        }}
                      />
                    ) : (
                      <span
                        onClick={() => { setEditing(p.port); setDraft(alias); }}
                        style={{
                          fontSize: 13, color: alias ? 'var(--fg)' : 'var(--fg3)',
                          fontStyle: alias ? 'normal' : 'italic',
                          cursor: 'pointer',
                        }}
                      >
                        {alias || 'Set alias'}
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--fg3)', fontFamily: 'var(--mono)' }}>
                    pid {p.pid} · {p.process_name}
                    {owner && <span style={{ marginLeft: 6, color: 'var(--green)' }}>· {owner.label}</span>}
                  </div>
                </div>
                {owner && (
                  <div className="script-actions">
                    <button
                      className="btn-stop"
                      disabled={stopping === owner.scriptId}
                      onClick={() => stopOwner(owner.scriptId, owner.label)}
                    >
                      {stopping === owner.scriptId ? '…' : 'Stop'}
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
