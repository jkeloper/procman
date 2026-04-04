// Plan B skeleton — Electron main process
// Purpose: minimal IPC ping-pong + node-pty placeholder for fast-transition scenario.
// This file is NOT a functional PTY implementation yet — skeleton only.

import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';

let mainWindow: BrowserWindow | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'index.html'));
}

// IPC ping-pong handler — proves round-trip works
ipcMain.handle('ping', async (_event, payload: unknown) => {
  return { pong: true, echo: payload, ts: Date.now() };
});

// node-pty integration placeholder (activated only if we switch to Plan B)
// Currently dormant to avoid native build during Week 0 skeleton phase.
// import * as pty from 'node-pty';

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
