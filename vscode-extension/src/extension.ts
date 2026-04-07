import * as vscode from 'vscode';

let panel: ProcmanPanel | undefined;

export function activate(context: vscode.ExtensionContext) {
  // Register webview provider for sidebar
  const provider = new ProcmanViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('procman.panel', provider),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('procman.configure', () => {
      vscode.commands.executeCommand('workbench.action.openSettings', 'procman');
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('procman.refresh', () => {
      provider.refresh();
    }),
  );
}

export function deactivate() {}

class ProcmanViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
    };
    this._updateHtml();

    // Listen for config changes
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('procman')) {
        this._updateHtml();
      }
    });

    // Handle messages from webview
    webviewView.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === 'openLog') {
        // Open a new webview panel for logs
        showLogPanel(msg.scriptId, msg.scriptName, this._getConfig());
      }
    });
  }

  refresh() {
    if (this._view) {
      this._updateHtml();
    }
  }

  private _getConfig() {
    const cfg = vscode.workspace.getConfiguration('procman');
    return {
      url: cfg.get<string>('serverUrl') || 'http://127.0.0.1:7777',
      token: cfg.get<string>('token') || '',
    };
  }

  private _updateHtml() {
    if (!this._view) return;
    const { url, token } = this._getConfig();
    this._view.webview.html = getSidebarHtml(url, token);
  }
}

function showLogPanel(
  scriptId: string,
  scriptName: string,
  config: { url: string; token: string },
) {
  const column = vscode.ViewColumn.Beside;
  const p = vscode.window.createWebviewPanel(
    'procman.logs',
    `Logs: ${scriptName}`,
    column,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  p.webview.html = getLogPanelHtml(scriptId, scriptName, config.url, config.token);
}

function getSidebarHtml(serverUrl: string, token: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family);
    font-size: 12px;
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
    padding: 8px;
  }
  .status { display: flex; align-items: center; gap: 6px; padding: 6px 0; font-size: 11px; color: var(--vscode-descriptionForeground); }
  .dot { width: 6px; height: 6px; border-radius: 3px; }
  .dot-ok { background: #65c18c; }
  .dot-err { background: #f87171; }
  .dot-off { background: var(--vscode-descriptionForeground); opacity: 0.3; }
  .error { color: #f87171; font-size: 11px; padding: 8px; }
  .no-token { text-align: center; padding: 20px 8px; color: var(--vscode-descriptionForeground); font-size: 11px; }
  .no-token a { color: var(--vscode-textLink-foreground); cursor: pointer; }
  .section { font-size: 10px; text-transform: uppercase; letter-spacing: 0.8px; color: var(--vscode-descriptionForeground); padding: 12px 0 4px; font-weight: 600; }
  .row {
    display: flex; align-items: center; gap: 6px;
    padding: 5px 4px; border-radius: 4px; cursor: pointer;
  }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .row-name { flex: 1; min-width: 0; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .row-cmd { font-size: 10px; color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px; }
  .btn {
    border: none; border-radius: 4px; padding: 3px 8px; font-size: 10px;
    cursor: pointer; font-weight: 500;
  }
  .btn-start { background: #4a9d6b; color: #fff; }
  .btn-stop { background: transparent; border: 1px solid var(--vscode-button-secondaryBorder, rgba(255,255,255,0.1)); color: var(--vscode-foreground); }
  .btn-restart { background: transparent; color: var(--vscode-descriptionForeground); }
  .actions { display: flex; gap: 3px; flex-shrink: 0; }
  #loading { text-align: center; padding: 20px; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
  <div id="root"></div>
  <script>
    const vscode = acquireVsCodeApi();
    const SERVER = ${JSON.stringify(serverUrl)};
    const TOKEN = ${JSON.stringify(token)};

    const root = document.getElementById('root');
    let projects = [];
    let processes = [];
    let ws = null;
    let connected = false;

    async function req(path, opts) {
      const res = await fetch(SERVER + path, {
        ...opts,
        headers: { 'Authorization': 'Bearer ' + TOKEN, ...(opts?.headers || {}) }
      });
      if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
      const ct = res.headers.get('content-type') || '';
      return ct.includes('json') ? res.json() : null;
    }

    async function refresh() {
      if (!TOKEN) {
        root.innerHTML = '<div class="no-token">Set procman.token in settings<br><br><a onclick="vscode.postMessage({type:\\'configure\\'})">Open Settings</a></div>';
        return;
      }
      root.innerHTML = '<div id="loading">connecting...</div>';
      try {
        const [cfg, procs] = await Promise.all([req('/api/projects'), req('/api/processes')]);
        projects = cfg.projects || [];
        processes = procs || [];
        render();
        connectWS();
      } catch(e) {
        root.innerHTML = '<div class="error">Failed: ' + e.message + '</div>';
      }
    }

    function connectWS() {
      if (ws) ws.close();
      const wsUrl = SERVER.replace(/^http/, 'ws') + '/api/stream?token=' + encodeURIComponent(TOKEN);
      ws = new WebSocket(wsUrl);
      ws.onopen = () => { connected = true; renderStatus(); };
      ws.onclose = () => { connected = false; renderStatus(); setTimeout(connectWS, 3000); };
      ws.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data.type === 'status') {
            if (data.status === 'running') {
              const idx = processes.findIndex(p => p.id === data.id);
              const row = { id: data.id, pid: data.pid || 0, status: 'running', command: '', started_at_ms: data.ts_ms };
              if (idx >= 0) processes[idx] = row;
              else processes.push(row);
            } else {
              processes = processes.filter(p => p.id !== data.id);
            }
            render();
          }
        } catch {}
      };
    }

    function render() {
      let html = '';
      html += '<div class="status" id="status-bar"></div>';
      for (const proj of projects) {
        html += '<div class="section">' + esc(proj.name) + '</div>';
        for (const s of proj.scripts) {
          const proc = processes.find(p => p.id === s.id);
          const running = proc?.status === 'running';
          const dotCls = running ? 'dot-ok' : 'dot-off';
          html += '<div class="row" onclick="openLog(\\''+s.id+'\\',\\''+esc(proj.name+'/'+s.name)+'\\')"><div class="dot '+dotCls+'"></div><div style="flex:1;min-width:0"><div class="row-name">'+esc(s.name)+'</div><div class="row-cmd">$ '+esc(s.command)+'</div></div><div class="actions">';
          if (running) {
            html += '<button class="btn btn-restart" onclick="event.stopPropagation();act(\\'restart\\',\\''+s.id+'\\')">↻</button>';
            html += '<button class="btn btn-stop" onclick="event.stopPropagation();act(\\'stop\\',\\''+s.id+'\\')">stop</button>';
          } else {
            html += '<button class="btn btn-start" onclick="event.stopPropagation();act(\\'start\\',\\''+s.id+'\\')">start</button>';
          }
          html += '</div></div>';
        }
      }
      root.innerHTML = html;
      renderStatus();
    }

    function renderStatus() {
      const el = document.getElementById('status-bar');
      if (!el) return;
      const running = processes.length;
      el.innerHTML = '<div class="dot '+(connected?'dot-ok':'dot-err')+'"></div>' + SERVER + ' · ' + running + ' running';
    }

    function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

    async function act(action, id) {
      try {
        await req('/api/processes/' + id + '/' + action, { method: 'POST' });
        setTimeout(refresh, 300);
      } catch(e) {
        root.innerHTML = '<div class="error">' + action + ' failed: ' + e.message + '</div>';
      }
    }

    function openLog(scriptId, scriptName) {
      vscode.postMessage({ type: 'openLog', scriptId, scriptName });
    }

    refresh();
  </script>
</body>
</html>`;
}

function getLogPanelHtml(
  scriptId: string,
  scriptName: string,
  serverUrl: string,
  token: string,
): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-editor-font-family, 'JetBrains Mono', monospace);
    font-size: 12px;
    color: var(--vscode-editor-foreground);
    background: var(--vscode-editor-background);
  }
  .bar {
    position: sticky; top: 0; z-index: 10;
    display: flex; align-items: center; gap: 8px;
    padding: 6px 12px;
    background: var(--vscode-editor-background);
    border-bottom: 1px solid var(--vscode-panel-border);
    font-size: 11px;
  }
  .bar-name { font-weight: 600; }
  .bar-count { color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family); }
  .dot { width: 6px; height: 6px; border-radius: 3px; }
  .dot-ok { background: #65c18c; }
  .dot-off { background: #555; }
  .filter-input {
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border);
    color: var(--vscode-input-foreground);
    border-radius: 3px;
    padding: 2px 6px;
    font-size: 11px;
    font-family: var(--vscode-editor-font-family);
    width: 140px;
  }
  #lines { padding: 4px 0; }
  .line {
    display: flex; gap: 8px; padding: 0 12px;
    font-size: 12px; line-height: 18px;
    white-space: pre-wrap; word-break: break-all;
  }
  .line:hover { background: rgba(255,255,255,0.03); }
  .line-stderr { color: #f87171; background: rgba(255,0,0,0.03); }
  .seq { width: 44px; text-align: right; color: #555; flex-shrink: 0; user-select: none; }
  .empty { padding: 20px; text-align: center; color: #555; }
</style>
</head>
<body>
  <div class="bar">
    <span class="bar-name">${scriptName.replace(/'/g, '&#39;')}</span>
    <span class="bar-count" id="count">0</span>
    <div style="flex:1"></div>
    <input class="filter-input" id="filter" placeholder="filter..." />
    <div class="dot dot-off" id="dot"></div>
    <label style="font-size:10px;color:#777;display:flex;gap:3px;align-items:center">
      <input type="checkbox" id="tail" checked style="accent-color:#65c18c" /> tail
    </label>
  </div>
  <div id="lines"><div class="empty">waiting for output...</div></div>
  <script>
    const SERVER = ${JSON.stringify(serverUrl)};
    const TOKEN = ${JSON.stringify(token)};
    const SCRIPT_ID = ${JSON.stringify(scriptId)};
    const MAX = 5000;

    let lines = [];
    let connected = false;
    const linesEl = document.getElementById('lines');
    const countEl = document.getElementById('count');
    const dotEl = document.getElementById('dot');
    const filterEl = document.getElementById('filter');
    const tailEl = document.getElementById('tail');

    // Load snapshot
    fetch(SERVER + '/api/logs/' + SCRIPT_ID, {
      headers: { 'Authorization': 'Bearer ' + TOKEN }
    })
    .then(r => r.json())
    .then(snap => { lines = snap; renderLines(); })
    .catch(() => {});

    // WebSocket
    function connectWS() {
      const url = SERVER.replace(/^http/, 'ws') + '/api/stream?token=' + encodeURIComponent(TOKEN);
      const ws = new WebSocket(url);
      ws.onopen = () => { connected = true; dotEl.className = 'dot dot-ok'; };
      ws.onclose = () => { connected = false; dotEl.className = 'dot dot-off'; setTimeout(connectWS, 3000); };
      ws.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data.type === 'log' && data.script_id === SCRIPT_ID) {
            lines.push(data.line);
            if (lines.length > MAX) lines.splice(0, lines.length - MAX);
            renderLines();
          }
        } catch {}
      };
    }
    connectWS();

    filterEl.addEventListener('input', renderLines);

    function renderLines() {
      const q = filterEl.value.toLowerCase();
      const filtered = q ? lines.filter(l => l.text.toLowerCase().includes(q)) : lines;
      countEl.textContent = (q ? filtered.length + '/' : '') + lines.length;
      if (filtered.length === 0) {
        linesEl.innerHTML = '<div class="empty">' + (lines.length === 0 ? 'waiting...' : 'no matches') + '</div>';
        return;
      }
      // Only render last 500 visible for performance
      const visible = filtered.slice(-500);
      let html = '';
      for (const l of visible) {
        const cls = l.stream === 'stderr' ? 'line line-stderr' : 'line';
        html += '<div class="'+cls+'"><span class="seq">'+l.seq+'</span><span style="flex:1">'+esc(l.text)+'</span></div>';
      }
      linesEl.innerHTML = html;
      if (tailEl.checked) {
        linesEl.lastElementChild?.scrollIntoView({ block: 'end' });
      }
    }

    function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  </script>
</body>
</html>`;
}
