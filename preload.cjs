// What the Plot page can ask the desktop app for.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('plotDesktop', {
  isDesktop: true,
  mcpPort: 7331,
  version: '1.0.0',
  connectClaude: () => ipcRenderer.invoke('plot:connect-claude'),
  info: () => ipcRenderer.invoke('plot:info'),
  retry: () => ipcRenderer.invoke('plot:retry'),
});
