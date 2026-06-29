import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type ProcessSnapshot, type ProjectsPayload } from './api';
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

  // Map a listening port number → the registered, *running* script that
  // declares it. Only running scripts are stoppable, and the lookup is keyed
  // on declared PortSpecs so we can't act on unregistered processes.
  const ownerByPort = useMemo(() => {
    const running = new Set(processes.filter((p) => p.status === 'running').map((p) => p.id));
    const map = new Map<number, { scriptId: string; label: string }>();
    for (const proj of projects) {
      for (const s of proj.scripts) {
        if (!running.has(s.id)) continue;
        for (const spec of s.ports ?? []) {
          if (!map.has(spec.number)) {
            map.set(spec.number, { scriptId: s.id, label: `${proj.name}/${s.name}` });
          }
        }
      }
    }
    return map;
  }, [projects, processes]);

  const reload = useCallback(async () => {
    try {
      const [p, a] = await Promise.all([
        api.ports(),
        api.portAliases().catch(() => ({})),
      ]);
      setPorts(p);
      setAliases(a ?? {});
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
            const owner = ownerByPort.get(p.port);
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
