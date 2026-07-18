import * as vscode from 'vscode';
import { getLogPanelHtml, getSidebarHtml } from './webview';

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
      } else if (msg.type === 'configure') {
        await vscode.commands.executeCommand('workbench.action.openSettings', 'procman');
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
