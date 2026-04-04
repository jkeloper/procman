import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('procman', {
  ping: (payload: unknown) => ipcRenderer.invoke('ping', payload),
});
