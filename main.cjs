// Plot desktop: the Plot editor in its own window, plus a local MCP server so Claude
// Desktop / Claude Code (and other MCP clients) can design in the open file.

const { app, BrowserWindow, shell, ipcMain, Menu, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { createMcpServer } = require('./mcp-server.cjs');

const APP_URL = process.env.PLOT_URL || 'https://useplot.vercel.app';
const MCP_PORT = Number(process.env.PLOT_MCP_PORT || 7331);
const VERSION = app.getVersion();

let win = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(start);
}

function stdioScriptPath() {
  // Packaged: resources/mcp-stdio.cjs; in development: next to this file.
  const packaged = path.join(process.resourcesPath, 'mcp-stdio.cjs');
  return fs.existsSync(packaged) ? packaged : path.join(__dirname, 'mcp-stdio.cjs');
}

function claudeConfigPath() {
  const base = process.platform === 'win32' ? process.env.APPDATA : process.platform === 'darwin' ? path.join(app.getPath('home'), 'Library', 'Application Support') : path.join(app.getPath('home'), '.config');
  return path.join(base, 'Claude', 'claude_desktop_config.json');
}

/** Add Plot to Claude Desktop's MCP servers (keeps a backup of the old config). */
function connectClaude() {
  const file = claudeConfigPath();
  let cfg = {};
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8');
      cfg = raw.trim() ? JSON.parse(raw) : {};
      fs.writeFileSync(file + '.backup-before-plot', raw);
    } else fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch (e) {
    return { ok: false, message: `Couldn't read Claude's settings (${e.message}). Nothing was changed.` };
  }
  cfg.mcpServers = cfg.mcpServers || {};
  cfg.mcpServers.plot = {
    command: process.execPath,
    args: [stdioScriptPath()],
    env: { ELECTRON_RUN_AS_NODE: '1', PLOT_APP_PATH: process.execPath, PLOT_MCP_PORT: String(MCP_PORT) },
  };
  try {
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  } catch (e) {
    return { ok: false, message: `Couldn't save Claude's settings (${e.message}).` };
  }
  return { ok: true, message: `Plot was added to Claude Desktop. Quit Claude completely (${process.platform === 'darwin' ? 'Cmd+Q' : 'tray icon → Quit'}) and open it again, then ask Claude to design something in Plot.`, path: file };
}

async function start() {
  const mcp = createMcpServer({ port: MCP_PORT, getWindow: () => win, version: VERSION });
  const started = await mcp.start();

  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Plot',
    icon: path.join(__dirname, 'build', 'icon.png'),
    backgroundColor: '#0e0f12',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  // On a Mac, Cmd+C / V / X / Q only work through the menu. Undo and Select all stay out of it,
  // so those keys reach Plot's own commands instead of the browser's.
  Menu.setApplicationMenu(
    process.platform === 'darwin'
      ? Menu.buildFromTemplate([
          { role: 'appMenu' },
          { label: 'Edit', submenu: [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }] },
          { role: 'windowMenu' },
        ])
      : null,
  );

  // Links to other sites open in the normal browser; sign-in redirects stay in the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(APP_URL)) {
      void shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    const ok = url.startsWith(APP_URL) || url.startsWith('file:') || /supabase\.co\/auth/.test(url) || /accounts\.google\.com|appleid\.apple\.com/.test(url);
    if (!ok) {
      e.preventDefault();
      void shell.openExternal(url);
    }
  });
  win.webContents.on('did-fail-load', (_e, code, _desc, url, isMain) => {
    if (isMain && code !== -3) void win.loadFile(path.join(__dirname, 'offline.html'), { query: { url: APP_URL } });
  });
  win.on('closed', () => (win = null));

  ipcMain.handle('plot:connect-claude', () => connectClaude());
  ipcMain.handle('plot:retry', () => win && win.loadURL(APP_URL));
  ipcMain.handle('plot:info', () => ({ version: VERSION, mcpPort: MCP_PORT, mcpRunning: started.ok, configPath: claudeConfigPath() }));

  await win.loadURL(APP_URL);

  if (!started.ok) {
    void dialog.showMessageBox(win, {
      type: 'warning',
      message: 'The AI connection (MCP) couldn’t start',
      detail: `Port ${MCP_PORT} is in use, maybe by another copy of Plot. Plot works normally, but Claude can't reach it until you close the other program and restart Plot.`,
    });
  }
}

app.on('window-all-closed', () => app.quit());
