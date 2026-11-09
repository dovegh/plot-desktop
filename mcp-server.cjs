// Local MCP server (Streamable HTTP, JSON responses) on 127.0.0.1.
// Tools run inside the open Plot window through window.__plotAgent.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml' };
const MAX_IMAGE = 40 * 1024 * 1024;

/** add_image with a file path or a web address: read it here (the page can't read files, and
 *  many sites block downloads from a page), and hand the page the bytes. */
async function resolveImage(args) {
  if (!args || args.data) return args;
  if (args.path) {
    let p = String(args.path).trim().replace(/^file:\/\//i, '');
    if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1));
    p = path.resolve(p);
    const ext = path.extname(p).toLowerCase();
    if (!IMAGE_TYPES[ext]) throw new Error(`Not an image file Plot can place (PNG, JPEG, WebP, GIF or SVG): ${p}`);
    let st;
    try { st = fs.statSync(p); } catch { throw new Error(`No file at ${p}`); }
    if (!st.isFile()) throw new Error(`Not a file: ${p}`);
    if (st.size > MAX_IMAGE) throw new Error(`The image is too big (${Math.round(st.size / 1048576)} MB; the limit is 40 MB).`);
    const { path: _p, ...rest } = args;
    return { ...rest, data: fs.readFileSync(p).toString('base64'), mime: args.mime || IMAGE_TYPES[ext], name: args.name || path.basename(p, ext) };
  }
  if (args.url && /^https?:\/\//i.test(String(args.url))) {
    const res = await fetch(String(args.url), { redirect: 'follow' }).catch(() => null);
    if (!res || !res.ok) throw new Error(`Couldn't download the image from ${args.url}`);
    const type = (res.headers.get('content-type') || '').split(';')[0];
    if (!type.startsWith('image/')) throw new Error(`That address isn't an image (it's ${type || 'unknown'}).`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_IMAGE) throw new Error('The image is too big (the limit is 40 MB).');
    const { url, ...rest } = args;
    return { ...rest, data: buf.toString('base64'), mime: args.mime || type, name: args.name || String(url).split(/[?#]/)[0].split('/').pop() };
  }
  return args;
}

const PROTOCOL = '2025-06-18';

function createMcpServer({ port, getWindow, version }) {
  async function inPage(code) {
    const win = getWindow();
    if (!win || win.isDestroyed()) throw new Error('Plot isn’t open. Start the Plot app and try again.');
    return win.webContents.executeJavaScript(code, true);
  }

  async function listTools() {
    const tools = await inPage('window.__plotAgent ? window.__plotAgent.list() : null');
    if (!tools) throw new Error('Plot is still loading. Try again in a moment.');
    return tools;
  }

  async function callTool(name, args) {
    const ready = await inPage('!!window.__plotAgent');
    if (!ready) throw new Error('Plot is still loading. Try again in a moment.');
    if (name === 'add_image') args = await resolveImage(args);
    const code = `window.__plotAgent.call(${JSON.stringify(String(name))}, ${JSON.stringify(args ?? {})}).then(r => ({ ok: true, r }), e => ({ ok: false, e: String(e && e.message || e) }))`;
    const res = await inPage(code);
    if (!res.ok) return { content: [{ type: 'text', text: res.e }], isError: true };
    const content = [];
    if (res.r.text) content.push({ type: 'text', text: res.r.text });
    if (res.r.image) content.push({ type: 'image', data: res.r.image.data, mimeType: res.r.image.mimeType });
    if (!content.length) content.push({ type: 'text', text: 'Done.' });
    return { content };
  }

  async function handle(msg) {
    const { id, method, params } = msg;
    const reply = (result) => ({ jsonrpc: '2.0', id, result });
    const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
    try {
      switch (method) {
        case 'initialize':
          return reply({
            protocolVersion: params?.protocolVersion || PROTOCOL,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'plot', title: 'Plot', version },
            instructions: 'Plot is a design, illustration and motion editor. Call get_document first to see the open file and layer ids, then create or change layers. Use export_png to look at the result.',
          });
        case 'ping':
          return reply({});
        case 'tools/list':
          return reply({ tools: await listTools() });
        case 'tools/call':
          return reply(await callTool(params?.name, params?.arguments));
        default:
          if (id === undefined) return null; // notification
          return fail(-32601, `Method not found: ${method}`);
      }
    } catch (e) {
      if (method === 'tools/call') return reply({ content: [{ type: 'text', text: String(e.message || e) }], isError: true });
      return fail(-32603, String(e.message || e));
    }
  }

  const server = http.createServer((req, res) => {
    // Only this computer, and never a web page (blocks DNS-rebinding / cross-site calls).
    const host = String(req.headers.host || '');
    const origin = req.headers.origin;
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host) || (origin && !/^(null|https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?)$/.test(origin))) {
      res.writeHead(403).end();
      return;
    }
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, app: 'plot', version }));
      return;
    }
    if (!req.url.startsWith('/mcp')) {
      res.writeHead(404).end();
      return;
    }
    if (req.method === 'GET') {
      // No server-initiated stream; clients fall back to plain request/response.
      res.writeHead(405, { allow: 'POST' }).end();
      return;
    }
    if (req.method === 'DELETE') {
      res.writeHead(200).end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 20e6) req.destroy();
    });
    req.on('end', async () => {
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
        return;
      }
      const batch = Array.isArray(msg);
      const out = (await Promise.all((batch ? msg : [msg]).map(handle))).filter(Boolean);
      if (!out.length) {
        res.writeHead(202).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-protocol-version': PROTOCOL });
      res.end(JSON.stringify(batch ? out : out[0]));
    });
  });

  return {
    start: () =>
      new Promise((resolve) => {
        server.once('error', (e) => resolve({ ok: false, error: e }));
        server.listen(port, '127.0.0.1', () => resolve({ ok: true }));
      }),
    stop: () => server.close(),
  };
}

module.exports = { createMcpServer };
