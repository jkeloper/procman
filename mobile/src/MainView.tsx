import { useCallback, useEffect, useState } from 'react';
import { api, openStream, type ProcessSnapshot, type ProjectsPayload } from './api';
import { clearPair, loadPair } from './pair';
import { LogView } from './LogView';
import './mobile.css';

interface Props {
  onUnpair: () => void;
}

type Screen =
  | { name: 'list' }
  | { name: 'logs'; scriptId: string; scriptName: string }
  | { name: 'settings' };

export function MainView({ onUnpair }: Props) {
  const [screen, setScreen] = useState<Screen>({ name: 'list' });
  const [projects, setProjects] = useState<ProjectsPayload['projects']>([]);
  const [processes, setProcesses] = useState<ProcessSnapshot[]>([]);
  const [connected, setConnected] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set('__init__'));
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [cfg, procs] = await Promise.all([api.projects(), api.processes()]);
      setProjects(cfg.projects);
      setProcesses(procs);
      setLoadError(null);
      setCollapsed((prev) => {
        if (prev.has('__init__')) {
          return new Set(cfg.projects.map((p: any) => p.id));
        }
        return prev;
      });
    } catch (e: any) {
      setLoadError(e?.message ?? 'Connection failed');
    }
  }, []);

  useEffect(() => {
    refresh();
    const stop = openStream((ev) => {
      if (ev.type === 'status') {
        setProcesses((prev) => {
          if (ev.status === 'running') {
            const idx = prev.findIndex((p) => p.id === ev.id);
            const row: ProcessSnapshot = { id: ev.id, pid: ev.pid ?? 0, status: 'running', started_at_ms: ev.ts_ms, command: idx >= 0 ? prev[idx].command : '' };
            return idx >= 0 ? prev.map((p, i) => (i === idx ? row : p)) : [...prev, row];
          }
          return prev.filter((p) => p.id !== ev.id);
        });
      }
    }, (c) => {
      setConnected(c);
      if (c) refresh();
    });
    return stop;
  }, [refresh]);

  function toggleCollapse(pid: string) {
    setCollapsed((prev) => { const n = new Set(prev); if (n.has(pid)) n.delete(pid); else n.add(pid); return n; });
  }

  async function act(action: 'start' | 'stop' | 'restart', scriptId: string) {
    setBusy(scriptId);
    try {
      if (action === 'start') await api.start(scriptId);
      else if (action === 'stop') await api.stop(scriptId);
      else await api.restart(scriptId);
      setTimeout(refresh, 300);
    } catch (e: any) { alert(action + ': ' + (e?.message ?? e)); }
    finally { setBusy(null); }
  }

  const pair = loadPair();
  const filteredProjects = selectedProject ? projects.filter((p) => p.id === selectedProject) : projects;
  const totalRunning = processes.length;
  const selectedName = selectedProject ? (projects.find((p) => p.id === selectedProject)?.name ?? 'Project') : 'All projects';

  if (screen.name === 'logs') return <LogView scriptId={screen.scriptId} scriptName={screen.scriptName} onBack={() => setScreen({ name: 'list' })} />;

  if (screen.name === 'settings') return (
    <div className="page">
      <div className="topbar">
        <button className="btn-ghost" onClick={() => setScreen({ name: 'list' })}>← Back</button>
        <span className="topbar-title">Settings</span>
      </div>
      <div className="settings-group">
        <div className="settings-row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
          <span style={{ fontSize: 13, color: 'var(--fg3)' }}>Server</span>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 15, wordBreak: 'break-all' as const }}>{pair?.host}:{pair?.port}</span>
        </div>
        <div className="settings-row"><span>Connection</span><span style={{ color: connected ? 'var(--green)' : 'var(--red)' }}>{connected ? 'Connected' : 'Disconnected'}</span></div>
        <div className="settings-row"><span>Projects</span><span>{projects.length}</span></div>
        <div className="settings-row"><span>Running</span><span>{totalRunning}</span></div>
      </div>
      <div style={{ padding: '0 20px' }}>
        <button className="btn-outline" style={{ width: '100%', padding: 16, marginTop: 24, color: 'var(--red)', fontSize: 16, minHeight: 52 }}
          onClick={() => { if (window.confirm('Disconnect?')) { clearPair(); onUnpair(); } }}>Disconnect & log out</button>
      </div>
    </div>
  );

  return (
    <div className="page">
      <div className="topbar">
        <button className="btn-ghost" onClick={() => setDrawerOpen(true)}>☰</button>
        <div className={'dot ' + (connected ? 'dot-green' : 'dot-red')} />
        <span className="topbar-title">{selectedName}</span>
        <span className="topbar-sub">{totalRunning} running</span>
        <button className="btn-ghost" onClick={refresh}>↻</button>
        <button className="btn-ghost" onClick={() => setScreen({ name: 'settings' })}>⚙</button>
      </div>

      <div style={{ flex: 1, overflow: 'auto' }}>
        {!connected && loadError ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 40, gap: 16, height: '60%' }}>
            <div style={{ fontSize: 48 }}>🔌</div>
            <div style={{ fontSize: 18, fontWeight: 600 }}>Not connected</div>
            <div style={{ fontSize: 14, color: 'var(--fg3)', textAlign: 'center', maxWidth: 280, lineHeight: '1.5' }}>{loadError}</div>
            <button className="btn-start" style={{ marginTop: 8, padding: '12px 28px', fontSize: 16 }} onClick={refresh}>Retry</button>
          </div>
        ) : !connected && !loadError ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 40, gap: 12, height: '60%' }}>
            <div style={{ fontSize: 48 }}>⏳</div>
            <div style={{ fontSize: 16, color: 'var(--fg3)' }}>Connecting...</div>
          </div>
        ) : filteredProjects.length === 0 ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--fg3)', fontSize: 15 }}>No scripts found.</div>
        ) : filteredProjects.map((proj) => {
          const isCollapsed = collapsed.has(proj.id);
          const runningCount = proj.scripts.filter((s) => processes.some((x) => x.id === s.id)).length;
          return (
            <div key={proj.id}>
              <div onClick={() => toggleCollapse(proj.id)} style={{
                padding: '12px 16px', fontSize: 13, fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: 1,
                color: 'var(--fg3)', background: 'var(--bg2)', position: 'sticky' as const, top: 0, zIndex: 10,
                display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none' as const, minHeight: 44,
              }}>
                <span style={{ transition: 'transform 0.2s', transform: isCollapsed ? 'rotate(0deg)' : 'rotate(90deg)', fontSize: 14 }}>▶</span>
                <span style={{ flex: 1 }}>{proj.name}</span>
                <span style={{ fontSize: 12, fontFamily: 'var(--mono)' }}>{proj.scripts.length}</span>
                {runningCount > 0 && <span style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--green)', background: 'rgba(101,193,140,0.1)', padding: '2px 8px', borderRadius: 6 }}>{runningCount} running</span>}
              </div>
              {!isCollapsed && proj.scripts.map((s) => {
                const proc = processes.find((x) => x.id === s.id);
                const isRunning = proc?.status === 'running';
                const isBusy = busy === s.id;
                return (
                  <div key={s.id} className="script-row" onClick={() => setScreen({ name: 'logs', scriptId: s.id, scriptName: proj.name + '/' + s.name })}>
                    <div className={'dot ' + (isRunning ? 'dot-green' : proc?.status === 'crashed' ? 'dot-red' : 'dot-gray')} />
                    <div className="script-info"><div className="script-name">{s.name}</div><div className="script-meta">$ {s.command}</div></div>
                    <div className="script-actions" onClick={(e) => e.stopPropagation()}>
                      {isRunning ? (<><button className="btn-ghost" disabled={isBusy} onClick={() => act('restart', s.id)}>↻</button><button className="btn-stop" disabled={isBusy} onClick={() => act('stop', s.id)}>stop</button></>) : (
                        <button className="btn-start" disabled={isBusy} onClick={() => act('start', s.id)}>{isBusy ? '…' : 'start'}</button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      {drawerOpen && (<>
        <div className="drawer-overlay" onClick={() => setDrawerOpen(false)} />
        <div className="drawer">
          <div style={{ padding: '16px 20px 8px', fontSize: 22, fontWeight: 700 }}>🐸 procman</div>
          <div className="drawer-section">Projects</div>
          <div className={'drawer-item ' + (selectedProject === null ? 'active' : '')} onClick={() => { setSelectedProject(null); setDrawerOpen(false); }}>All projects<span className="count">{projects.reduce((n, p) => n + p.scripts.length, 0)}</span></div>
          {projects.map((p) => {
            const running = p.scripts.filter((s) => processes.some((x) => x.id === s.id)).length;
            return (<div key={p.id} className={'drawer-item ' + (selectedProject === p.id ? 'active' : '')} onClick={() => { setSelectedProject(p.id); setDrawerOpen(false); }}>
              <div className={'dot ' + (running > 0 ? 'dot-green' : 'dot-gray')} style={{ width: 8, height: 8 }} />{p.name}<span className="count">{p.scripts.length}</span>
            </div>);
          })}
          <div style={{ flex: 1 }} />
          <div className="drawer-section">Settings</div>
          <div className="drawer-item" onClick={() => { setDrawerOpen(false); setScreen({ name: 'settings' }); }}>⚙ Settings</div>
        </div>
      </>)}
    </div>
  );
}
