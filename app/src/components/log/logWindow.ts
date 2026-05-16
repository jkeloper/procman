import { WebviewWindow } from '@tauri-apps/api/webviewWindow';

interface DetachedLogWindowOptions {
  scriptId: string;
  scriptName: string;
}

export function getDetachedLogRoute(): DetachedLogWindowOptions | null {
  const params = new URLSearchParams(window.location.search);
  const scriptId = params.get('scriptId');
  if (params.get('view') !== 'log' || !scriptId) return null;
  return {
    scriptId,
    scriptName: params.get('scriptName') || scriptId,
  };
}

export async function openDetachedLogWindow({
  scriptId,
  scriptName,
}: DetachedLogWindowOptions): Promise<void> {
  const label = `log-${scriptId.replace(/[^a-zA-Z0-9\-/:_]/g, '_')}`;
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    await existing.unminimize().catch(() => {});
    await existing.show().catch(() => {});
    await existing.setFocus().catch(() => {});
    return;
  }

  const url =
    `index.html?view=log&scriptId=${encodeURIComponent(scriptId)}` +
    `&scriptName=${encodeURIComponent(scriptName)}`;
  const webview = new WebviewWindow(label, {
    url,
    title: `${scriptName} - procman logs`,
    width: 980,
    height: 640,
    minWidth: 640,
    minHeight: 360,
    center: true,
    resizable: true,
  });

  await new Promise<void>((resolve, reject) => {
    void webview.once('tauri://created', () => resolve());
    void webview.once('tauri://error', (event) => reject(event.payload));
  });
}
