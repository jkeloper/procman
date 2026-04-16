import { useCallback, useEffect, useState } from 'react';
import { api, openStream, type ProcessSnapshot, type ProjectsPayload, type DeclaredPortStatus } from './api';
import { clearPair, loadPair } from './pair';
import { LogView } from './LogView';
import { PortsView } from './PortsView';
import { ArrowLeft, Menu, RefreshCw, Settings, WifiOff, Loader, ChevronRight, RotateCcw } from './icons';
import './mobile.css';

interface Props {
  onUnpair: () => void;
}

type Screen =
  | { name: 'list' }
  | { name: 'logs'; scriptId: string; scriptName: string }
  | { name: 'settings' }
  | { name: 'ports' };

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
  const [portStatuses, setPortStatuses] = useState<Record<string, DeclaredPortStatus[]>>({});

  const refresh = useCallback(async () => {
    try {
      const [cfg, procs] = await Promise.all([api.projects(), api.processes()]);
      setProjects(cfg.projects);
      setProcesses(procs);
      setLoadError(null);
      // Always collapse all projects on (re)connect so the user sees the list,
      // not a long stream of script rows.
      setCollapsed(new Set(cfg.projects.map((p: any) => p.id)));
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
            const row: ProcessSnapshot = { id: ev.id, pid: ev.pid ?? 0, status: 'running', started_at_ms: ev.ts_ms, command: idx >= 0 ? prev[idx].command : '', cpu_pct: null, rss_kb: null };
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

  // S2: poll port statuses for running scripts with declared ports
  useEffect(() => {
    const targets = projects
      .flatMap((p) => p.scripts)
      .filter((s) => processes.some((x) => x.id === s.id) && s.ports && s.ports.length > 0);
    if (targets.length === 0) { setPortStatuses({}); return; }
    let cancelled = false;
    async function tick() {
      const next: Record<string, DeclaredPortStatus[]> = {};
      await Promise.all(targets.map(async (s) => {
        try { next[s.id] = await api.portStatus(s.id); } catch {}
      }));
      if (!cancelled) setPortStatuses(next);
    }
    tick();
    const iv = setInterval(tick, 5000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [projects, processes]);

  const pair = loadPair();
  const filteredProjects = selectedProject ? projects.filter((p) => p.id === selectedProject) : projects;
  const totalRunning = processes.length;
  const selectedName = selectedProject ? (projects.find((p) => p.id === selectedProject)?.name ?? 'Project') : 'All projects';

  if (screen.name === 'logs') return <LogView scriptId={screen.scriptId} scriptName={screen.scriptName} onBack={() => setScreen({ name: 'list' })} />;
  if (screen.name === 'ports') return <PortsView onBack={() => setScreen({ name: 'list' })} />;

  if (screen.name === 'settings') return (
    <div className="page">
      <div className="topbar">
        <button className="btn-ghost" onClick={() => setScreen({ name: 'list' })}><ArrowLeft size={18} /> Back</button>
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
        <button className="btn-ghost" onClick={() => setDrawerOpen(true)}><Menu size={20} /></button>
        <div className={'dot ' + (connected ? 'dot-green' : 'dot-red')} />
        <span className="topbar-title">{selectedName}</span>
        <span className="topbar-sub">{totalRunning} running</span>
        <button className="btn-ghost" onClick={refresh}><RefreshCw size={18} /></button>
        <button className="btn-ghost" onClick={() => setScreen({ name: 'settings' })}><Settings size={18} /></button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', WebkitOverflowScrolling: 'touch' }}>
        {!connected && loadError ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 40, gap: 16, height: '60%' }}>
            <WifiOff size={48} strokeWidth={1.5} />
            <div style={{ fontSize: 18, fontWeight: 600 }}>Not connected</div>
            <div style={{ fontSize: 14, color: 'var(--fg3)', textAlign: 'center', maxWidth: 280, lineHeight: '1.5' }}>{loadError}</div>
            <button className="btn-start" style={{ marginTop: 8, padding: '12px 28px', fontSize: 16 }} onClick={refresh}>Retry</button>
          </div>
        ) : !connected && !loadError ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 40, gap: 12, height: '60%' }}>
            <Loader size={48} strokeWidth={1.5} className="animate-spin" style={{ animationDuration: '2s' }} />
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
                padding: '6px 14px', fontSize: 11, fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: 0.8,
                color: 'var(--fg2)',
                background: 'linear-gradient(180deg, rgba(25,48,34,0.55), rgba(15,28,20,0.40))',
                backdropFilter: 'blur(24px) saturate(170%)',
                WebkitBackdropFilter: 'blur(24px) saturate(170%)',
                borderTop: '1px solid var(--glass-stroke)',
                borderBottom: '1px solid rgba(255,255,255,0.04)',
                boxShadow: 'inset 0 1px 0 var(--glass-highlight)',
                position: 'sticky' as const, top: 0, zIndex: 10,
                display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none' as const, minHeight: 30,
              }}>
                <span style={{ transition: 'transform 0.2s', transform: isCollapsed ? 'rotate(0deg)' : 'rotate(90deg)', display: 'inline-flex' }}><ChevronRight size={12} /></span>
                <span style={{ flex: 1 }}>{proj.name}</span>
                <span style={{ fontSize: 11, fontFamily: 'var(--mono)' }}>{proj.scripts.length}</span>
                {runningCount > 0 && <span style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--green)', background: 'rgba(101,193,140,0.1)', padding: '1px 6px', borderRadius: 5 }}>{runningCount}</span>}
              </div>
              {!isCollapsed && proj.scripts.map((s) => {
                const proc = processes.find((x) => x.id === s.id);
                const isRunning = proc?.status === 'running';
                const isBusy = busy === s.id;
                return (
                  <div key={s.id} className="script-row" onClick={() => setScreen({ name: 'logs', scriptId: s.id, scriptName: proj.name + '/' + s.name })}>
                    <div className={'dot ' + (isRunning ? 'dot-green' : proc?.status === 'crashed' ? 'dot-red' : 'dot-gray')} />
                    <div className="script-info">
                      <div className="script-name">
                        {s.name}
                        {s.ports && s.ports.length > 0 && s.ports.map((p) => {
                          const st = portStatuses[s.id]?.find((x) => x.spec.number === p.number);
                          const dotColor = !isRunning ? 'var(--fg3)' : st?.reachable === true ? 'var(--green)' : st?.reachable === false ? 'var(--red)' : 'var(--fg3)';
                          return <span key={p.name} style={{ marginLeft: 6, fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--fg2)', background: 'rgba(255,255,255,0.06)', borderRadius: 4, padding: '1px 5px' }}>
                            <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', backgroundColor: dotColor, marginRight: 3, verticalAlign: 'middle' }} />
                            {p.name}:{p.number}
                          </span>;
                        })}
                      </div>
                      <div className="script-meta">
                        $ {s.command}
                        {isRunning && proc && (proc.cpu_pct != null || proc.rss_kb != null) && (
                          <span style={{ marginLeft: 8, color: 'var(--fg3)' }}>
                            {proc.cpu_pct != null && `${proc.cpu_pct.toFixed(1)}%`}
                            {proc.rss_kb != null && ` · ${(proc.rss_kb / 1024).toFixed(0)}MB`}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="script-actions" onClick={(e) => e.stopPropagation()}>
                      {isRunning ? (<><button className="btn-ghost" disabled={isBusy} onClick={() => act('restart', s.id)}><RotateCcw size={16} /></button><button className="btn-stop" disabled={isBusy} onClick={() => act('stop', s.id)}>Stop</button></>) : (
                        <button className="btn-start" disabled={isBusy} onClick={() => act('start', s.id)}>{isBusy ? '…' : 'Start'}</button>
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
          <div style={{ padding: '16px 20px 8px', fontSize: 22, fontWeight: 700 }}><img src='/icon-192.png' alt='' style={{width:28,height:28,borderRadius:6,marginRight:8,verticalAlign:'middle'}} />procman</div>
          <div className="drawer-section">Projects</div>
          <div className={'drawer-item ' + (selectedProject === null ? 'active' : '')} onClick={() => { setSelectedProject(null); setDrawerOpen(false); }}>All projects<span className="count">{projects.reduce((n, p) => n + p.scripts.length, 0)}</span></div>
          {projects.map((p) => {
            const running = p.scripts.filter((s) => processes.some((x) => x.id === s.id)).length;
            return (<div key={p.id} className={'drawer-item ' + (selectedProject === p.id ? 'active' : '')} onClick={() => { setSelectedProject(p.id); setDrawerOpen(false); }}>
              <div className={'dot ' + (running > 0 ? 'dot-green' : 'dot-gray')} style={{ width: 8, height: 8 }} />{p.name}<span className="count">{p.scripts.length}</span>
            </div>);
          })}
          <div style={{ flex: 1 }} />
          <div className="drawer-section">Tools</div>
          <div className="drawer-item" onClick={() => { setDrawerOpen(false); setScreen({ name: 'ports' }); }}>Ports</div>
          <div className="drawer-item" onClick={() => { setDrawerOpen(false); setScreen({ name: 'settings' }); }}><Settings size={18} /> Settings</div>
        </div>
      </>)}
    </div>
  );
}
