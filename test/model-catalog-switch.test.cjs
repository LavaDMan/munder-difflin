'use strict';
/**
 * remoteModelCatalog: false must mean NO request — not "a request whose result
 * is ignored". getText is replaced with a recorder; the loader reads it through
 * the module object at call time, so the recorder sees every fetch it makes.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const fetchText = loadTs('src/main/fetchText.ts');
const { loadModelCatalog } = loadTs('src/main/modelCatalog.ts');
const baked = require('../src/shared/modelCatalog.json');

const fetched = [];
fetchText.getText = async (url) => { fetched.push(url); throw new Error('offline (test)'); };

function tmpCache(t, payload) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'munder-catalog-switch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'model-catalog.json');
  if (payload) fs.writeFileSync(file, JSON.stringify(payload));
  return file;
}

test('switched off with no cache: no request, null catalog (baked one applies)', async (t) => {
  fetched.length = 0;
  const r = await loadModelCatalog(tmpCache(t), { remote: false });
  assert.deepEqual(fetched, []);
  assert.equal(r.catalog, null);
});

test('switched off with a stale cache: no request, the cached copy is served', async (t) => {
  fetched.length = 0;
  const file = tmpCache(t, { catalog: baked, fetchedAt: 1 });
  const r = await loadModelCatalog(file, { remote: false, force: true });
  assert.deepEqual(fetched, []);
  assert.ok(r.catalog, 'cached catalog returned');
  assert.equal(r.stale, true);
});

test('default (switch absent) still fetches — the recorder is wired', async (t) => {
  fetched.length = 0;
  await loadModelCatalog(tmpCache(t));
  assert.equal(fetched.length, 1);
});
