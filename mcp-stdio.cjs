// stdio ↔ HTTP bridge so Claude Desktop (which starts MCP servers as commands) can talk
// to the Plot app's local MCP server. Runs with ELECTRON_RUN_AS_NODE=1 — no dependencies.
// If Plot isn't running yet, it starts it and waits.

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const PORT = Number(process.env.PLOT_MCP_PORT || 7331);
const APP = process.env.PLOT_APP_PATH || process.execPath;

function post(body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/mcp', method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function healthy() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/health', timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

let starting = null;
async function ensureApp() {
  if (await healthy()) return;
  if (!starting) {
    starting = (async () => {
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      spawn(APP, [], { detached: true, stdio: 'ignore', env, cwd: path.dirname(APP) }).unref();
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 500));
        if (await healthy()) return;
      }
      throw new Error('Plot didn’t start. Open the Plot app, then try again.');
    })().finally(() => (starting = null));
  }
  return starting;
}

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function forward(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  try {
    await ensureApp();
    const r = await post(line);
    if (r.status === 202 || !r.data) return;
    write(JSON.parse(r.data));
  } catch (e) {
    if (msg && msg.id !== undefined) write({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(e.message || e) } });
  }
}

let buf = '';
const pending = new Set();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const p = forward(line).finally(() => pending.delete(p));
    pending.add(p);
  }
});
// The client closed the pipe: answer what's in flight, then stop.
process.stdin.on('end', async () => {
  await Promise.allSettled([...pending]);
  process.exit(0);
});
