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

/**
 * Every settings file Claude Desktop may read. Claude from the Microsoft Store keeps its own copy
 * inside its app package (LocalCache), which hides the normal one once it exists: update both.
 */
function claudeConfigPaths() {
  const out = [claudeConfigPath()];
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const pkgs = path.join(process.env.LOCALAPPDATA, 'Packages');
    try {
      for (const d of fs.readdirSync(pkgs)) {
        if (!/^(AnthropicPBC\.)?Claude_/i.test(d)) continue;
        // Only a copy Claude already made: a new one would hide the person's other settings.
        const f = path.join(pkgs, d, 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json');
        if (fs.existsSync(f)) out.push(f);
      }
    } catch {
      // No Store apps folder.
    }
  }
  return out;
}

function addPlotTo(file, entry) {
  let cfg = {};
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf8');
    cfg = raw.trim() ? JSON.parse(raw) : {};
    fs.writeFileSync(file + '.backup-before-plot', raw);
  } else fs.mkdirSync(path.dirname(file), { recursive: true });
  cfg.mcpServers = cfg.mcpServers || {};
  cfg.mcpServers.plot = entry;
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
}

/** Add Plot to Claude Desktop's MCP servers (keeps a backup of each old settings file). */
function connectClaude() {
  const entry = {
    command: process.execPath,
    args: [stdioScriptPath()],
    env: { ELECTRON_RUN_AS_NODE: '1', PLOT_APP_PATH: process.execPath, PLOT_MCP_PORT: String(MCP_PORT) },
  };
  const done = [];
  const errors = [];
  for (const file of claudeConfigPaths()) {
    try {
      addPlotTo(file, entry);
      done.push(file);
    } catch (e) {
      errors.push(`${file}: ${e.message}`);
    }
  }
  if (!done.length) return { ok: false, message: `Couldn't save Claude's settings (${errors.join('; ')}). Nothing was changed.` };
  return { ok: true, message: `Plot was added to Claude Desktop. Quit Claude completely (${process.platform === 'darwin' ? 'Cmd+Q' : 'right-click its icon by the clock → Quit'}) and open it again, then ask Claude to design something in Plot.`, path: done[0] };
}

// Plot's menus in the Mac menu bar. Shortcuts are shown but not taken over (registerAccelerator:
// false): the keys still reach the page, so typing in a text box keeps its own Cmd+Z, Cmd+A…
// Cut, Copy and Paste stay the system's, which is what makes those keys work in text boxes.
const ROLES = { 'edit.cut': 'cut', 'edit.copy': 'copy', 'edit.paste': 'paste' };
function macMenu(menus) {
  const send = (id) => win && win.webContents.send('plot:menu', id);
  const plot = Array.isArray(menus)
    ? menus.map((m) => ({
        label: String(m.label),
        submenu: (m.items || []).map((it) => {
          if (it === 'sep') return { type: 'separator' };
          if (ROLES[it.id]) return { role: ROLES[it.id], label: String(it.label) };
          const item = { label: String(it.label), enabled: it.enabled !== false, click: () => send(String(it.id)) };
          if (it.accel) Object.assign(item, { accelerator: String(it.accel), registerAccelerator: false });
          if (typeof it.checked === 'boolean') Object.assign(item, { type: 'checkbox', checked: it.checked });
          return item;
        }),
      }))
    : [{ label: 'Edit', submenu: [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }] }];
  const win2 = plot.findIndex((m) => m.label === 'Window');
  if (win2 >= 0) plot[win2].submenu.push({ type: 'separator' }, { role: 'minimize' }, { role: 'zoom' }, { role: 'togglefullscreen' }, { type: 'separator' }, { role: 'front' });
  else plot.push({ role: 'windowMenu' });
  return Menu.buildFromTemplate([{ role: 'appMenu' }, ...plot]);
}

/** After Effects on this computer (newest first), or null. */
function findAfterEffects() {
  if (process.platform === 'win32') {
    const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean).map((p) => path.join(p, 'Adobe'));
    const found = [];
    for (const root of roots) {
      try {
        for (const d of fs.readdirSync(root)) {
          const exe = path.join(root, d, 'Support Files', 'AfterFX.exe');
          if (/^Adobe After Effects/i.test(d) && fs.existsSync(exe)) found.push(exe);
        }
      } catch {
        // No Adobe folder here.
      }
    }
    return found.sort().reverse()[0] ?? null;
  }
  if (process.platform === 'darwin') {
    try {
      const apps = fs.readdirSync('/Applications').filter((d) => /^Adobe After Effects/i.test(d)).sort().reverse();
      return apps[0] ? apps[0] : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Run a script Plot made in After Effects (it opens if it isn't running). */
function runAfterEffects(script, name) {
  const ae = findAfterEffects();
  if (!ae) return { ok: false, message: "After Effects isn't installed on this computer, so the script was downloaded instead." };
  const file = path.join(app.getPath('temp'), `plot-${Date.now()}-${name.replace(/[^\w-]+/g, '_').slice(0, 40)}.jsx`);
  fs.writeFileSync(file, script, 'utf8');
  const { spawn } = require('child_process');
  if (process.platform === 'win32') {
    spawn(ae, ['-r', file], { detached: true, stdio: 'ignore' }).unref();
  } else {
    const appName = ae.replace(/\.app$/, '');
    spawn('osascript', ['-e', `tell application "${appName}" to activate`, '-e', `tell application "${appName}" to DoScriptFile "${file}"`], { detached: true, stdio: 'ignore' }).unref();
  }
  return { ok: true };
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
  // On a Mac, Plot's menus fill the menu bar (sent by the page); until they arrive, a basic one.
  // Elsewhere Plot shows the same menus from its own logo button.
  Menu.setApplicationMenu(process.platform === 'darwin' ? macMenu(null) : null);

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
  // Downloads (exports, After Effects scripts) go straight to the Downloads folder, and the page
  // says where; without this a download could wait on a dialog the user never saw.
  win.webContents.session.on('will-download', (_e, item) => {
    const dir = app.getPath('downloads');
    const ext = path.extname(item.getFilename());
    const base = path.basename(item.getFilename(), ext);
    let file = path.join(dir, item.getFilename());
    for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, `${base} (${i})${ext}`);
    item.setSavePath(file);
    item.once('done', (_ev, state) => {
      if (win && !win.isDestroyed()) win.webContents.send('plot:downloaded', { name: path.basename(file), ok: state === 'completed' });
    });
  });
  win.on('closed', () => (win = null));

  ipcMain.handle('plot:connect-claude', () => connectClaude());
  ipcMain.handle('plot:run-ae', (e, script, name) => (win && e.sender === win.webContents ? runAfterEffects(String(script ?? ''), String(name ?? 'Plot')) : { ok: false }));
  ipcMain.on('plot:set-menu', (e, menus) => {
    if (process.platform === 'darwin' && win && e.sender === win.webContents) Menu.setApplicationMenu(macMenu(menus));
  });
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
