'use strict';
/**
 * The web door compiles upstream's preload for the browser, so a new preload
 * METHOD reaches the browser with no work. A new `ipcRenderer.sendSync`
 * channel does not: sendSync cannot cross a WebSocket, so webBridge answers it
 * from a snapshot taken at connect, and a channel missing from that snapshot
 * silently returns null in the browser.
 *
 * This bit on the v0.4.6 intake: upstream added `config:homeSync`, which the
 * roster uses to decide whether localStorage belongs to the hive being opened.
 * Every other test stayed green.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

test('every preload sendSync channel is in the web door snapshot', () => {
  const preload = read('src/preload/index.ts');
  const used = [...preload.matchAll(/sendSync\(\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(used.length > 0, 'found no sendSync calls — the pattern no longer matches the preload');

  const bridge = read('src/main/webBridge.ts');
  const decl = /const SYNC_CHANNELS\s*=\s*\[([^\]]*)\]/.exec(bridge);
  assert.ok(decl, 'SYNC_CHANNELS declaration not found in webBridge.ts');
  const served = [...decl[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

  const missing = [...new Set(used)].filter((ch) => !served.includes(ch));
  assert.deepEqual(missing, [], `sendSync channels the browser would get null for: ${missing.join(', ')}`);
});
