import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { ArrowLeft, RefreshCw } from './icons';
import './mobile.css';

interface PortEntry {
  port: number;
  pid: number;
  process_name: string;
}

interface Props {
  onBack: () => void;
}

export function PortsView({ onBack }: Props) {
  const [ports, setPorts] = useState<PortEntry[]>([]);
  const [aliases, setAliases] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');

  const reload = useCallback(async () => {
    try {
      const [p, a] = await Promise.all([
        api.ports(),
        api.portAliases().catch(() => ({})),
      ]);
      setPorts(p);
      setAliases(a ?? {});
    } catch {} finally {
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
    } catch {}
    setEditing(null);
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
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
