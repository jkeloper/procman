// Runs directly on Node.js without loading the VS Code extension host.
import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import {
  getLogPanelHtml,
  getSidebarHtml,
  jsonForScript,
} from './webview.ts';

interface FetchCall {
  url: string;
  init?: RequestInit;
}

class MockWebSocket {
  readonly url: string;
  readonly protocols: string | string[] | undefined;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string | URL, protocols?: string | string[]) {
    this.url = String(url);
    this.protocols = protocols;
  }

  close() {
    this.onclose?.();
  }
}

interface WebviewHarness {
  dom: JSDOM;
  fetchCalls: FetchCall[];
  messages: unknown[];
  sockets: MockWebSocket[];
  timers: Array<{ callback: TimerHandler; delay: number }>;
}

function executeWebview(
  html: string,
  respond: (url: string, init?: RequestInit) => unknown,
): WebviewHarness {
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    url: 'https://webview.test/',
  });
  const fetchCalls: FetchCall[] = [];
  const messages: unknown[] = [];
  const sockets: MockWebSocket[] = [];
  const timers: Array<{ callback: TimerHandler; delay: number }> = [];

  Object.defineProperty(dom.window, 'acquireVsCodeApi', {
    configurable: true,
    value: () => ({
      // VS Code crosses a structured-clone boundary here. Normalize the
      // jsdom-realm object so Node's strict assertions compare its data rather
      // than the foreign Object prototype.
      postMessage: (message: unknown) =>
        messages.push(JSON.parse(JSON.stringify(message))),
    }),
  });
  Object.defineProperty(dom.window, 'fetch', {
    configurable: true,
    value: async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push({ url, init });
      const data = respond(url, init);
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: {
          get: (name: string) =>
            name.toLowerCase() === 'content-type' ? 'application/json' : null,
        },
        json: async () => data,
      };
    },
  });
  Object.defineProperty(dom.window, 'WebSocket', {
    configurable: true,
    value: class extends MockWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        sockets.push(this);
      }
    },
  });
  Object.defineProperty(dom.window, 'setTimeout', {
    configurable: true,
    value: (callback: TimerHandler, delay = 0) => {
      timers.push({ callback, delay });
      return timers.length;
    },
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: () => {},
  });

  const script = dom.window.document.querySelector('script');
  assert.ok(script?.textContent, 'generated Webview script must be present');
  const source = script.textContent;
  script.remove();
  dom.window.eval(source);

  return { dom, fetchCalls, messages, sockets, timers };
}

async function settleWebview() {
  await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

function click(dom: JSDOM, element: Element) {
  element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
}

function pressEnter(dom: JSDOM, element: Element) {
  element.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
  );
}

function assertLockedDownDocument(html: string): string {
  const csp = html.match(
    /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/,
  )?.[1];
  assert.ok(csp, 'a Content Security Policy must be present');
  assert.match(csp, /(?:^|;)\s*default-src 'none'(?:;|$)/);
  assert.doesNotMatch(csp, /'unsafe-(?:inline|eval)'/);

  const scriptNonce = html.match(/<script nonce="([^"]+)">/)?.[1];
  const styleNonce = html.match(/<style nonce="([^"]+)">/)?.[1];
  assert.ok(scriptNonce, 'the script must have a nonce');
  assert.match(scriptNonce, /^[A-Za-z0-9+/]{22}==$/);
  assert.equal(styleNonce, scriptNonce, 'style and script nonces must match');
  assert.ok(csp.includes(`script-src 'nonce-${scriptNonce}'`));
  assert.ok(csp.includes(`style-src 'nonce-${scriptNonce}'`));

  assert.equal((html.match(/<script\b/gi) ?? []).length, 1);
  assert.equal((html.match(/<style\b/gi) ?? []).length, 1);
  assert.doesNotMatch(html, /\s(?:on[a-z]+)\s*=\s*["']/i);
  assert.doesNotMatch(
    html,
    /\.innerHTML\s*=|insertAdjacentHTML|document\.write\s*\(/,
  );
  assert.match(html, /\.textContent\s*=/);
  assert.match(html, /\.replaceChildren\s*\(/);
  return scriptNonce;
}

function embeddedConstant(html: string, name: string): unknown {
  const prefix = `const ${name} = `;
  const start = html.indexOf(prefix);
  assert.notEqual(start, -1, `${name} must be embedded`);
  const valueStart = start + prefix.length;
  const end = html.indexOf(';\n', valueStart);
  assert.notEqual(end, -1, `${name} must end with a semicolon`);
  return JSON.parse(html.slice(valueStart, end));
}

test('jsonForScript round-trips hostile text without executable HTML', () => {
  const hostile =
    '</ScRiPt><script>globalThis.pwned = true</script><!--&>\u2028\u2029';
  const serialized = jsonForScript(hostile);

  assert.equal(JSON.parse(serialized), hostile);
  assert.doesNotMatch(serialized, /[<>&\u2028\u2029]/u);
  assert.doesNotMatch(serialized, /<\/script/i);
});

test('sidebar HTML locks scripts to a fresh nonce and safely embeds config', () => {
  const serverUrl =
    'https://host.invalid/</script><script>globalThis.urlAttack=true</script>';
  const token = 'token"</script><img/src=x>&\u2028\u2029';
  const html = getSidebarHtml(serverUrl, token);

  const nonce = assertLockedDownDocument(html);
  assert.equal(embeddedConstant(html, 'SERVER'), serverUrl);
  assert.equal(embeddedConstant(html, 'TOKEN'), token);
  assert.doesNotMatch(html, /<img\/src=/i);
  assert.equal((html.match(/<\/script>/gi) ?? []).length, 1);

  const nextNonce = assertLockedDownDocument(getSidebarHtml(serverUrl, token));
  assert.notEqual(nextNonce, nonce, 'each document must use a fresh nonce');
});

test('log panel safely embeds every host-controlled value', () => {
  const scriptId = 'id</script><script>globalThis.idAttack=true</script>';
  const scriptName = 'name</script><svg/onload=globalThis.nameAttack=true>';
  const serverUrl = 'https://host.invalid/</script><script>urlAttack()</script>';
  const token = 'token</script><script>tokenAttack()</script>&\u2028\u2029';
  const html = getLogPanelHtml(scriptId, scriptName, serverUrl, token);

  assertLockedDownDocument(html);
  assert.equal(embeddedConstant(html, 'SCRIPT_ID'), scriptId);
  assert.equal(embeddedConstant(html, 'SCRIPT_NAME'), scriptName);
  assert.equal(embeddedConstant(html, 'SERVER'), serverUrl);
  assert.equal(embeddedConstant(html, 'TOKEN'), token);
  assert.doesNotMatch(html, /<svg\/onload=/i);
  assert.equal((html.match(/<\/script>/gi) ?? []).length, 1);
  assert.match(html, /getElementById\('script-name'\)\.textContent = SCRIPT_NAME/);
});

test('sidebar renders hostile API data as text and wires every action safely', async () => {
  const projectName = '<img src=x onerror="globalThis.sidebarAttack=true">';
  const stoppedName = '<svg onload="globalThis.sidebarAttack=true">Stopped</svg>';
  const runningName = '</div><script>globalThis.sidebarAttack=true</script>';
  const command = '<iframe srcdoc="<script>globalThis.sidebarAttack=true</script>">';
  const projects = {
    projects: [
      {
        name: projectName,
        scripts: [
          { id: 'stopped-id', name: stoppedName, command },
          { id: 'running-id', name: runningName, command },
        ],
      },
    ],
  };
  const processes = [{ id: 'running-id', status: 'running' }];
  const harness = executeWebview(
    getSidebarHtml('https://desktop.test', 'secret-token'),
    (url) => {
      const path = new URL(url).pathname;
      if (path === '/api/projects') return projects;
      if (path === '/api/processes') return processes;
      return null;
    },
  );

  try {
    await settleWebview();
    const { document } = harness.dom.window;
    assert.equal(document.querySelector('.section')?.textContent, projectName);
    assert.deepEqual(
      [...document.querySelectorAll('.row-name')].map((node) => node.textContent),
      [stoppedName, runningName],
    );
    assert.deepEqual(
      [...document.querySelectorAll('.row-cmd')].map((node) => node.textContent),
      [`$ ${command}`, `$ ${command}`],
    );
    assert.equal(document.querySelector('img, svg, iframe, script'), null);
    assert.equal(
      (harness.dom.window as unknown as { sidebarAttack?: boolean }).sidebarAttack,
      undefined,
    );

    const start = document.querySelector<HTMLButtonElement>('.btn-start');
    const restart = document.querySelector<HTMLButtonElement>('.btn-restart');
    const stop = document.querySelector<HTMLButtonElement>('.btn-stop');
    assert.ok(start && restart && stop, 'all process actions must render');

    click(harness.dom, start);
    click(harness.dom, restart);
    click(harness.dom, stop);
    await settleWebview();
    assert.deepEqual(
      harness.fetchCalls
        .filter((call) => call.init?.method === 'POST')
        .map((call) => new URL(call.url).pathname),
      [
        '/api/processes/stopped-id/start',
        '/api/processes/running-id/restart',
        '/api/processes/running-id/stop',
      ],
    );
    assert.deepEqual(harness.messages, [], 'button clicks must not open logs');

    pressEnter(harness.dom, start);
    assert.deepEqual(
      harness.messages,
      [],
      'an Enter keydown bubbling from an action button must not open logs',
    );

    const stoppedRow = start.closest('.row');
    assert.ok(stoppedRow);
    pressEnter(harness.dom, stoppedRow);
    click(harness.dom, stoppedRow);
    assert.deepEqual(harness.messages, [
      { type: 'openLog', scriptId: 'stopped-id', scriptName: `${projectName}/${stoppedName}` },
      { type: 'openLog', scriptId: 'stopped-id', scriptName: `${projectName}/${stoppedName}` },
    ]);
  } finally {
    harness.dom.window.close();
  }
});

test('sidebar configure action runs in the generated Webview', async () => {
  const harness = executeWebview(getSidebarHtml('https://desktop.test', ''), () => {
    throw new Error('an unpaired sidebar must not fetch');
  });

  try {
    await settleWebview();
    const link = harness.dom.window.document.querySelector('a');
    assert.ok(link);
    click(harness.dom, link);
    assert.deepEqual(harness.messages, [{ type: 'configure' }]);
    assert.deepEqual(harness.fetchCalls, []);
    assert.deepEqual(harness.sockets, []);
  } finally {
    harness.dom.window.close();
  }
});

test('log panel renders hostile snapshot and stream lines as text', async () => {
  const scriptName = '<svg onload="globalThis.logAttack=true">Worker</svg>';
  const snapshotText = '<img src=x onerror="globalThis.logAttack=true">snapshot';
  const streamText = '</span><script>globalThis.logAttack=true</script>stream';
  const harness = executeWebview(
    getLogPanelHtml('worker-id', scriptName, 'https://desktop.test', 'secret-token'),
    (url) => {
      assert.equal(new URL(url).pathname, '/api/logs/worker-id');
      return [{ seq: 1, stream: 'stderr', text: snapshotText }];
    },
  );

  try {
    await settleWebview();
    const { document } = harness.dom.window;
    assert.equal(document.querySelector('#script-name')?.textContent, scriptName);
    assert.deepEqual(
      [...document.querySelectorAll('.line-text')].map((node) => node.textContent),
      [snapshotText],
    );
    assert.equal(document.querySelector('img, svg, script'), null);

    assert.equal(harness.sockets.length, 1);
    assert.equal(harness.sockets[0].url, 'wss://desktop.test/api/stream');
    assert.deepEqual(Array.from(harness.sockets[0].protocols ?? []), [
      'procman',
      'procman-token.secret-token',
    ]);
    harness.sockets[0].onmessage?.({
      data: JSON.stringify({
        type: 'log',
        script_id: 'worker-id',
        line: { seq: 2, stream: 'stdout', text: streamText },
      }),
    });
    assert.deepEqual(
      [...document.querySelectorAll('.line-text')].map((node) => node.textContent),
      [snapshotText, streamText],
    );
    assert.equal(document.querySelector('img, svg, script'), null);
    assert.equal(
      (harness.dom.window as unknown as { logAttack?: boolean }).logAttack,
      undefined,
    );
  } finally {
    harness.dom.window.close();
  }
});
