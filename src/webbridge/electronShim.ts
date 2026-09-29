/**
 * A browser-side stand-in for the three `electron` APIs the preload imports.
 *
 * WHY THIS EXISTS, AND WHY IT IS SHAPED THIS WAY
 * ----------------------------------------------
 * `src/preload/index.ts` is 1,398 lines and ~191 methods, and it is the ENTIRE
 * contract between the renderer and main. Re-implementing it for the browser
 * would mean maintaining a second copy of that contract forever, and it would
 * silently rot the moment upstream adds a method.
 *
 * So we do not re-implement it. The web build compiles THE SAME
 * `src/preload/index.ts`, with the `electron` import aliased to this file (see
 * `vite.web.config.ts`). Every method the preload exposes therefore exists in
 * the browser automatically, and stays in lockstep with upstream for free.
 *
 * The renderer is already pure browser code — `index.ts:2226` sets
 * `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, and it
 * imports no node builtins — so it cannot tell the difference.
 */

type Listener = (event: unknown, ...args: unknown[]) => void;

const WS_PATH = '/__cth';

/** Wire protocol. Deliberately tiny; see src/main/webBridge.ts for the server. */
type ServerMsg =
  | { t: 'hello'; sync: Record<string, unknown> }
  | { t: 'reply'; id: number; ok: true; value: unknown }
  | { t: 'reply'; id: number; ok: false; error: string }
  | { t: 'event'; channel: string; args: unknown[] };

let sock: WebSocket | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const listeners = new Map<string, Set<Listener>>();

/**
 * Values for the two `sendSync` channels, pushed by the server at connect.
 *
 * `sendSync` is synchronous by definition and a WebSocket is not, so it cannot
 * be forwarded. Both call sites in the preload already degrade gracefully
 * (`readClipboardSync` catches to `''`, `rosterReadSync` to `null`, after which
 * the caller falls back to localStorage), so returning a slightly stale cached
 * value is strictly better than the fallback they were written for.
 */
const syncCache: Record<string, unknown> = {};

/** Resolves once the socket is open, so a call made during boot simply waits. */
let ready: Promise<void>;
let markReady: () => void;
function resetReady(): void {
  ready = new Promise<void>((res) => { markReady = res; });
}
resetReady();

function connect(): void {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}${WS_PATH}`);
  sock = ws;

  ws.onmessage = (ev) => {
    let msg: ServerMsg;
    try { msg = JSON.parse(String(ev.data)) as ServerMsg; } catch { return; }

    if (msg.t === 'hello') {
      Object.assign(syncCache, msg.sync);
      markReady();
      return;
    }
    if (msg.t === 'reply') {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.value);
      else p.reject(new Error(msg.error));
      return;
    }
    if (msg.t === 'event') {
      const set = listeners.get(msg.channel);
      if (!set) return;
      // Same shape the renderer already sees: (event, ...args). Nothing in the
      // renderer reads the event object, but the signature must match.
      for (const fn of [...set]) {
        try { fn({}, ...msg.args); } catch { /* one bad listener must not kill the rest */ }
      }
    }
  };

  ws.onclose = () => {
    sock = null;
    resetReady();
    // Fail every in-flight call rather than leaving the UI waiting on promises
    // that can never settle.
    for (const [, p] of pending) p.reject(new Error('bridge disconnected'));
    pending.clear();
    setTimeout(connect, 1000);
  };

  ws.onerror = () => { try { ws.close(); } catch { /* already closing */ } };
}
connect();

export const ipcRenderer = {
  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    await ready;
    const s = sock;
    if (!s || s.readyState !== WebSocket.OPEN) throw new Error('bridge not connected');
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      s.send(JSON.stringify({ t: 'invoke', id, channel, args }));
    });
  },

  send(channel: string, ...args: unknown[]): void {
    void ready.then(() => {
      if (sock?.readyState === WebSocket.OPEN) {
        sock.send(JSON.stringify({ t: 'send', channel, args }));
      }
    });
  },

  /** See syncCache above: cannot cross a WebSocket, served from the snapshot. */
  sendSync(channel: string): unknown {
    return channel in syncCache ? syncCache[channel] : null;
  },

  on(channel: string, fn: Listener): typeof ipcRenderer {
    let set = listeners.get(channel);
    if (!set) { set = new Set(); listeners.set(channel, set); }
    set.add(fn);
    return ipcRenderer;
  },

  removeListener(channel: string, fn: Listener): typeof ipcRenderer {
    listeners.get(channel)?.delete(fn);
    return ipcRenderer;
  },

  off(channel: string, fn: Listener): typeof ipcRenderer {
    return ipcRenderer.removeListener(channel, fn);
  },

  removeAllListeners(channel: string): typeof ipcRenderer {
    listeners.delete(channel);
    return ipcRenderer;
  }
};

export const contextBridge = {
  /** In the browser there is no isolated world to bridge into — the shim IS the
   *  boundary — so exposing means assigning onto window. */
  exposeInMainWorld(key: string, api: unknown): void {
    (window as unknown as Record<string, unknown>)[key] = api;
  }
};

export const webUtils = {
  /** Electron-only: it maps a DOM File back to an absolute path on disk. A
   *  browser deliberately withholds that, so drag-and-drop of a file PATH
   *  cannot work over the web bridge. Returns '' so callers take their
   *  "no path" branch instead of receiving something plausible and wrong. */
  getPathForFile(_file: unknown): string { return ''; }
};

export type IpcRendererEvent = unknown;
export default { ipcRenderer, contextBridge, webUtils };
