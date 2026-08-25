/**
 * Serve the existing renderer to a browser, over the existing IPC contract.
 *
 * Munder's renderer is already pure browser code — `index.ts` creates its window
 * with `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, and
 * the renderer imports no node builtins. It talks to exactly one injected
 * object, `window.cth`, and nothing else. So the only thing standing between it
 * and a browser tab is the transport underneath that object.
 *
 * This module supplies that transport:
 *
 *   browser  ──HTTP──►  out/renderer (unchanged) + out/web/cth-bridge.js
 *            ──WS────►  invoke(channel, args)  ──►  the same ipcMain handler
 *            ◄──WS───   webContents.send(...)  ◄──  teed from the real window
 *
 * Electron still runs and still owns everything — PTYs, the hive, git, memory.
 * This is NOT a rewrite; it is a second door onto the process that already
 * exists. The Electron window keeps working exactly as before.
 *
 * SECURITY POSTURE — read before changing the bind address.
 * Electron never needed authentication because the OS session was the boundary.
 * A browser door has no such boundary, and this host has NO packet filter
 * (`iptables -S` shows `-P INPUT ACCEPT`, no ufw, no VPN), while agents run with
 * bypass-permissions authority over the repo tree and can reach the Docker
 * socket. So: loopback only, and a bearer token. Reach it from another machine
 * through an SSH tunnel, never by binding 0.0.0.0.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ipcMain, type WebContents } from 'electron';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';

// ─── the handler registry ────────────────────────────────────────────────────
// `ipcMain` has no public "call this channel" API, so the bridge cannot reach
// the 162 handlers the app registers. Rather than duplicate them, we tap the
// registration itself: patch `ipcMain.handle`/`.on` once, at import time, and
// remember what goes by. This module MUST therefore be imported before any
// handler registers — see the import at the top of index.ts.

type InvokeHandler = (event: unknown, ...args: unknown[]) => unknown;
const invokeHandlers = new Map<string, InvokeHandler>();
const sendHandlers = new Map<string, InvokeHandler>();

let tapped = false;
export function installHandlerTap(): void {
  if (tapped) return;
  tapped = true;
  const realHandle = ipcMain.handle.bind(ipcMain);
  const realOn = ipcMain.on.bind(ipcMain);

  (ipcMain as unknown as { handle: typeof ipcMain.handle }).handle = ((
    channel: string, listener: InvokeHandler
  ) => {
    invokeHandlers.set(channel, listener);
    return realHandle(channel, listener as Parameters<typeof realHandle>[1]);
  }) as typeof ipcMain.handle;

  (ipcMain as unknown as { on: typeof ipcMain.on }).on = ((
    channel: string, listener: InvokeHandler
  ) => {
    sendHandlers.set(channel, listener);
    return realOn(channel, listener as Parameters<typeof realOn>[1]);
  }) as typeof ipcMain.on;
}
// Tap on import, before index.ts registers anything.
installHandlerTap();

// ─── connected browsers ──────────────────────────────────────────────────────
interface Client { send(data: string): void; close(): void }
const clients = new Set<Client>();

/** Fan an event out to every browser. Called from the tee below. */
function broadcast(channel: string, args: unknown[]): void {
  if (clients.size === 0) return;
  let payload: string;
  try {
    payload = JSON.stringify({ t: 'event', channel, args });
  } catch {
    return; // an unserialisable payload is dropped rather than killing the send
  }
  for (const c of clients) {
    try { c.send(payload); } catch { /* a dead socket is reaped on close */ }
  }
}

/**
 * Mirror everything the real window is told to every browser.
 *
 * Wrapping the window's own `send` rather than hunting down call sites is
 * deliberate: main pushes on 27 channels from five files, and `pty.ts` routes
 * per-session through `session.owner`, which IS this webContents. One wrapper
 * catches all of it, including anything added later.
 */
export function teeWebContents(wc: WebContents): void {
  const w = wc as unknown as { send: (c: string, ...a: unknown[]) => void; __cthTeed?: boolean };
  if (w.__cthTeed) return;
  w.__cthTeed = true;
  const real = w.send.bind(wc);
  w.send = (channel: string, ...args: unknown[]) => {
    try { broadcast(channel, args); } catch { /* never break the real send */ }
    return real(channel, ...args);
  };
}

// ─── the sendSync snapshot ───────────────────────────────────────────────────
// Two preload methods use ipcRenderer.sendSync, which cannot cross a socket.
// Both already degrade (readClipboardSync -> '', rosterReadSync -> null, after
// which the caller falls back to localStorage), so we do better than the
// fallback: run those handlers server-side at connect and ship the values.
const SYNC_CHANNELS = ['app:readClipboardSync', 'roster:readSync'];

function syncSnapshot(sender: WebContents | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const ch of SYNC_CHANNELS) {
    const fn = sendHandlers.get(ch);
    if (!fn) continue;
    // ipcMain.on handlers answer by assigning event.returnValue.
    const evt: { returnValue?: unknown; sender: WebContents | null } = { sender };
    try { fn(evt); out[ch] = evt.returnValue ?? null; } catch { out[ch] = null; }
  }
  return out;
}

// ─── static assets ───────────────────────────────────────────────────────────
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf'
};

/**
 * Serve index.html with two changes, both required and both minimal:
 *
 *  1. Inject the bridge as a CLASSIC script in <head>. It must define
 *     `window.cth` before the renderer's module bundle runs; a classic script
 *     executes immediately, a module would be deferred alongside it.
 *  2. Widen `connect-src` to allow the WebSocket. The shipped CSP is
 *     `connect-src 'self' …openai…`, which does not cover ws:. Everything else
 *     in the policy is left exactly as upstream wrote it — in particular
 *     `script-src 'self'` still holds, which is why the bridge is a real file
 *     and not an inline blob.
 */
function renderIndex(html: string): string {
  let out = html.replace(
    /(<meta http-equiv="Content-Security-Policy" content=")([^"]*)(")/,
    (_m, a: string, policy: string, b: string) => {
      const widened = policy.includes('connect-src')
        ? policy.replace(/connect-src ([^;]*)/, "connect-src $1 ws: wss:")
        : `${policy}; connect-src 'self' ws: wss:`;
      return a + widened + b;
    }
  );
  // Two scripts, in order, both real files because `script-src 'self'` forbids
  // inline. __cth-host.js first: the preload reads `process.platform`/`arch` at
  // module scope, which does not exist in a browser, and those values describe
  // the SERVER (where agents actually run) rather than the viewer's machine.
  out = out.replace(
    /<script type="module"/,
    '<script src="/__cth-host.js"></script>\n    <script src="/__cth-bridge.js"></script>\n    <script type="module"'
  );
  return out;
}

// ─── server ──────────────────────────────────────────────────────────────────
export interface WebBridgeOptions {
  /** Directory holding the built renderer (out/renderer). */
  rendererDir: string;
  /** Path to the built browser bridge (out/web/cth-bridge.js). */
  bridgeFile: string;
  port: number;
  /** ALWAYS loopback unless you have read the security note at the top. */
  host?: string;
  /** Bearer token; generated if absent. */
  token?: string;
  /** The real window, so its pushes reach browsers too. */
  webContents: WebContents | null;
}

export interface WebBridgeHandle {
  url: string;
  token: string;
  close(): Promise<void>;
  clientCount(): number;
}

let server: Server | null = null;

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a); const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export async function startWebBridge(opts: WebBridgeOptions): Promise<WebBridgeHandle> {
  if (server) throw new Error('web bridge already running');
  const host = opts.host ?? '127.0.0.1';
  const token = opts.token ?? randomBytes(24).toString('hex');
  if (opts.webContents) teeWebContents(opts.webContents);

  const authed = (req: IncomingMessage): boolean => {
    const url = new URL(req.url ?? '/', 'http://x');
    const q = url.searchParams.get('t');
    if (q && constantTimeEqual(q, token)) return true;
    const cookie = req.headers.cookie ?? '';
    const m = /(?:^|;\s*)cthweb=([^;]+)/.exec(cookie);
    return !!m && constantTimeEqual(decodeURIComponent(m[1]), token);
  };

  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x');
    let path = decodeURIComponent(url.pathname);

    if (!authed(req)) {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Unauthorized — open the URL printed by the app, including its ?t= token.\n');
      return;
    }
    // First hit carries the token in the query; park it in a cookie so the
    // asset requests that follow do not each need it in the URL.
    if (url.searchParams.get('t')) {
      // Persist for 30 days so the token URL is needed ONCE per browser, not
      // once per browser session. HttpOnly keeps it out of reach of page
      // scripts; SameSite=Strict means another site cannot cause a request
      // that carries it.
      res.setHeader('set-cookie',
        `cthweb=${encodeURIComponent(token)}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Strict`);
    }

    if (path === '/__cth-host.js') {
      // Minimal `process` stand-in carrying the SERVER's identity. Generated
      // live rather than baked at build time so it cannot go stale or describe
      // the wrong machine.
      // Also flags web mode, so the renderer can offer a SERVER-side file
      // picker where a native Electron dialog would render on the server's
      // display and be invisible to the person in the browser.
      const body = `globalThis.process = Object.assign(globalThis.process || {}, `
        + JSON.stringify({ platform: process.platform, arch: process.arch })
        + `);\nglobalThis.__CTH_WEB__ = true;\n`;
      res.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'no-store' });
      res.end(body);
      return;
    }

    if (path === '/__cth-bridge.js' || path === '/__cth-bridge.js.map') {
      const f = path.endsWith('.map') ? `${opts.bridgeFile}.map` : opts.bridgeFile;
      if (!existsSync(f)) { res.writeHead(404).end('bridge not built'); return; }
      res.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'no-store' });
      res.end(readFileSync(f));
      return;
    }

    if (path === '/') path = '/index.html';
    // Contain the path INSIDE rendererDir: normalize first, then verify the
    // resolved file still starts with the root. Without this, `..%2f` walks out.
    const target = normalize(join(opts.rendererDir, path));
    if (!target.startsWith(normalize(opts.rendererDir))) {
      res.writeHead(403).end('forbidden'); return;
    }
    if (!existsSync(target)) { res.writeHead(404).end('not found'); return; }

    const ext = extname(target).toLowerCase();
    if (ext === '.html') {
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
      res.end(renderIndex(readFileSync(target, 'utf8')));
      return;
    }
    res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream' });
    res.end(readFileSync(target));
  });

  // `ws` is a DIRECT dependency, and it has to be. Reached transitively it gets
  // bundled into the main chunk by rollup (externalizeDepsPlugin only
  // externalises declared dependencies), which breaks its optional `bufferutil`
  // binding: server->client frames still work, but every masked client->server
  // frame dies in `Receiver.getData` with "bu.unmask is not a function" and the
  // socket goes quiet in one direction only. Declared, it stays external and
  // resolves its own optional deps at runtime.
  const { WebSocketServer } = await import('ws');
  const wss = new WebSocketServer({ noServer: true });

  http.on('upgrade', (req, socket, head) => {
    if (new URL(req.url ?? '/', 'http://x').pathname !== '/__cth' || !authed(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return;
    }
    wss.handleUpgrade(req, socket as never, head, (ws) => {
      const client: Client = { send: (d) => ws.send(d), close: () => ws.close() };
      clients.add(client);
      try {
        ws.send(JSON.stringify({ t: 'hello', sync: syncSnapshot(opts.webContents) }));
      } catch { /* client vanished during handshake */ }

      ws.on('message', async (raw: unknown) => {
        let msg: { t?: string; id?: number; channel?: string; args?: unknown[] };
        try { msg = JSON.parse(String(raw)); } catch { return; }

        if (msg.t === 'send' && msg.channel) {
          const fn = sendHandlers.get(msg.channel);
          if (fn) { try { fn({ sender: opts.webContents }, ...(msg.args ?? [])); } catch { /* ignore */ } }
          return;
        }
        if (msg.t !== 'invoke' || !msg.channel || typeof msg.id !== 'number') return;

        const fn = invokeHandlers.get(msg.channel);
        if (!fn) {
          ws.send(JSON.stringify({ t: 'reply', id: msg.id, ok: false, error: `no handler: ${msg.channel}` }));
          return;
        }
        try {
          // The handler expects an IpcMainInvokeEvent. Only `.sender` is read by
          // the handlers that care (they route output back to a window), so the
          // real window's webContents is the honest thing to hand them.
          const value = await fn({ sender: opts.webContents }, ...(msg.args ?? []));
          ws.send(JSON.stringify({ t: 'reply', id: msg.id, ok: true, value: value ?? null }));
        } catch (e) {
          ws.send(JSON.stringify({
            t: 'reply', id: msg.id, ok: false,
            error: e instanceof Error ? e.message : String(e)
          }));
        }
      });

      ws.on('close', () => { clients.delete(client); });
      ws.on('error', () => { clients.delete(client); });
    });
  });

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(opts.port, host, () => { http.removeListener('error', reject); resolve(); });
  });
  server = http;

  return {
    url: `http://${host}:${opts.port}/?t=${token}`,
    token,
    clientCount: () => clients.size,
    close: () => new Promise<void>((resolve) => {
      for (const c of clients) { try { c.close(); } catch { /* already gone */ } }
      clients.clear();
      http.close(() => { server = null; resolve(); });
    })
  };
}

/** Test seam: the channels the tap has seen. */
export function tappedChannels(): { invoke: string[]; send: string[] } {
  return { invoke: [...invokeHandlers.keys()], send: [...sendHandlers.keys()] };
}
