// What the Plot page can ask the desktop app for.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('plotDesktop', {
  isDesktop: true,
  mcpPort: 7331,
  version: '1.0.8',
  connectClaude: () => ipcRenderer.invoke('plot:connect-claude'),
  info: () => ipcRenderer.invoke('plot:info'),
  retry: () => ipcRenderer.invoke('plot:retry'),
  // Run a script Plot made in After Effects (Push to After Effects).
  runAfterEffects: (script, name) => ipcRenderer.invoke('plot:run-ae', script, name),
  // A download finished (saved to the Downloads folder).
  onDownloaded: (cb) => ipcRenderer.on('plot:downloaded', (_e, info) => cb(info)),
  // The menu bar: Plot sends its menus; clicks come back as item ids.
  setMenu: (menus) => ipcRenderer.send('plot:set-menu', menus),
  onMenu: (cb) => ipcRenderer.on('plot:menu', (_e, id) => cb(id)),
});
