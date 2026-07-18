import { randomBytes } from 'crypto';

export function getSidebarHtml(serverUrl: string, token: string): string {
  const nonce = randomBytes(16).toString('base64');
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src http: https: ws: wss:">
<style nonce="${nonce}">
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
  .row-info { flex: 1; min-width: 0; }
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
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const SERVER = ${jsonForScript(serverUrl)};
    const TOKEN = ${jsonForScript(token)};

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
        const box = element('div', 'no-token');
        box.append(document.createTextNode('Set procman.token in settings'), document.createElement('br'), document.createElement('br'));
        const link = element('a', '', 'Open Settings');
        link.tabIndex = 0;
        const configure = () => vscode.postMessage({ type: 'configure' });
        link.addEventListener('click', configure);
        link.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') configure();
        });
        box.append(link);
        root.replaceChildren(box);
        return;
      }
      const loading = element('div', '', 'connecting...');
      loading.id = 'loading';
      root.replaceChildren(loading);
      try {
        const [cfg, procs] = await Promise.all([req('/api/projects'), req('/api/processes')]);
        projects = cfg.projects || [];
        processes = procs || [];
        render();
        connectWS();
      } catch(e) {
        root.replaceChildren(element('div', 'error', 'Failed: ' + errorMessage(e)));
      }
    }

    function connectWS() {
      if (ws) ws.close();
      const wsUrl = SERVER.replace(/^http/, 'ws') + '/api/stream';
      // Server authenticates the WS handshake via the Sec-WebSocket-Protocol
      // header (see app/src-tauri/src/server/auth.rs extract_bearer): it strips
      // the 'procman-token.' prefix off each offered subprotocol. The token is
      // URL-safe base64 so it is safe to embed verbatim. Offer the stable
      // 'procman' protocol first so the server echoes THAT (not the token) in
      // the handshake response — otherwise the token would leak into response
      // headers (proxy/devtools logs).
      ws = new WebSocket(wsUrl, ['procman', 'procman-token.' + TOKEN]);
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
      const fragment = document.createDocumentFragment();
      const status = element('div', 'status');
      status.id = 'status-bar';
      fragment.append(status);
      for (const proj of projects) {
        fragment.append(element('div', 'section', String(proj.name || '')));
        for (const s of proj.scripts) {
          const proc = processes.find(p => p.id === s.id);
          const running = proc?.status === 'running';
          const row = element('div', 'row');
          row.tabIndex = 0;
          const open = () => openLog(String(s.id), String(proj.name || '') + '/' + String(s.name || ''));
          row.addEventListener('click', open);
          row.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && event.target === row) open();
          });
          row.append(element('div', 'dot ' + (running ? 'dot-ok' : 'dot-off')));
          const info = element('div', 'row-info');
          info.append(element('div', 'row-name', String(s.name || '')), element('div', 'row-cmd', '$ ' + String(s.command || '')));
          row.append(info);
          const actions = element('div', 'actions');
          if (running) {
            actions.append(actionButton('↻', 'btn-restart', 'restart', String(s.id)), actionButton('stop', 'btn-stop', 'stop', String(s.id)));
          } else {
            actions.append(actionButton('start', 'btn-start', 'start', String(s.id)));
          }
          row.append(actions);
          fragment.append(row);
        }
      }
      root.replaceChildren(fragment);
      renderStatus();
    }

    function renderStatus() {
      const el = document.getElementById('status-bar');
      if (!el) return;
      const running = processes.length;
      el.replaceChildren(element('div', 'dot ' + (connected ? 'dot-ok' : 'dot-err')), document.createTextNode(SERVER + ' · ' + running + ' running'));
    }

    function element(tag, className = '', text = '') {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text) node.textContent = text;
      return node;
    }

    function actionButton(label, className, action, id) {
      const button = element('button', 'btn ' + className, label);
      button.type = 'button';
      button.addEventListener('click', (event) => { event.stopPropagation(); act(action, id); });
      return button;
    }

    function errorMessage(error) { return error instanceof Error ? error.message : String(error); }

    async function act(action, id) {
      try {
        await req('/api/processes/' + id + '/' + action, { method: 'POST' });
        setTimeout(refresh, 300);
      } catch(e) {
        root.replaceChildren(element('div', 'error', action + ' failed: ' + errorMessage(e)));
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

export function getLogPanelHtml(
  scriptId: string,
  scriptName: string,
  serverUrl: string,
  token: string,
): string {
  const nonce = randomBytes(16).toString('base64');
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src http: https: ws: wss:">
<style nonce="${nonce}">
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
  .spacer { flex: 1; }
  .tail-label { font-size:10px; color:#777; display:flex; gap:3px; align-items:center; }
  .tail-input { accent-color:#65c18c; }
  .line-text { flex: 1; }
</style>
</head>
<body>
  <div class="bar">
    <span class="bar-name" id="script-name"></span>
    <span class="bar-count" id="count">0</span>
    <div class="spacer"></div>
    <input class="filter-input" id="filter" placeholder="filter..." />
    <div class="dot dot-off" id="dot"></div>
    <label class="tail-label">
      <input type="checkbox" id="tail" class="tail-input" checked /> tail
    </label>
  </div>
  <div id="lines"><div class="empty">waiting for output...</div></div>
  <script nonce="${nonce}">
    const SERVER = ${jsonForScript(serverUrl)};
    const TOKEN = ${jsonForScript(token)};
    const SCRIPT_ID = ${jsonForScript(scriptId)};
    const SCRIPT_NAME = ${jsonForScript(scriptName)};
    const MAX = 5000;

    let lines = [];
    let connected = false;
    const linesEl = document.getElementById('lines');
    const countEl = document.getElementById('count');
    const dotEl = document.getElementById('dot');
    const filterEl = document.getElementById('filter');
    const tailEl = document.getElementById('tail');
    document.getElementById('script-name').textContent = SCRIPT_NAME;

    // Load snapshot
    fetch(SERVER + '/api/logs/' + SCRIPT_ID, {
      headers: { 'Authorization': 'Bearer ' + TOKEN }
    })
    .then(r => r.json())
    .then(snap => { lines = snap; renderLines(); })
    .catch(() => {});

    // WebSocket
    function connectWS() {
      const url = SERVER.replace(/^http/, 'ws') + '/api/stream';
      // Authenticate via Sec-WebSocket-Protocol (see auth.rs extract_bearer);
      // query-string tokens are ignored by the server. Offer 'procman' first
      // so the server echoes that (not the token) in the handshake response.
      const ws = new WebSocket(url, ['procman', 'procman-token.' + TOKEN]);
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
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = lines.length === 0 ? 'waiting...' : 'no matches';
        linesEl.replaceChildren(empty);
        return;
      }
      // Only render last 500 visible for performance
      const visible = filtered.slice(-500);
      const fragment = document.createDocumentFragment();
      for (const l of visible) {
        const row = document.createElement('div');
        row.className = l.stream === 'stderr' ? 'line line-stderr' : 'line';
        const seq = document.createElement('span');
        seq.className = 'seq';
        seq.textContent = String(l.seq);
        const text = document.createElement('span');
        text.className = 'line-text';
        text.textContent = String(l.text || '');
        row.append(seq, text);
        fragment.append(row);
      }
      linesEl.replaceChildren(fragment);
      if (tailEl.checked) {
        linesEl.lastElementChild?.scrollIntoView({ block: 'end' });
      }
    }
  </script>
</body>
</html>`;
}

/** Serialize host-controlled values without allowing a closing script tag. */
export function jsonForScript(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
