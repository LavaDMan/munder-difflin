'use strict';
/**
 * Runs the unit suite with HOME pointed at a throwaway directory.
 *
 * `ensureAgent` and the `install*Hooks` installers write agent config under
 * `os.homedir()`. A test that forgot to redirect HOME once rewrote a live floor's
 * ~/.gemini hooks files. Redirecting per test is still the right habit, but it is
 * no longer the only thing standing between a test and the developer's real
 * config: every file run through here gets a fresh HOME, and test/load-ts.cjs
 * refuses to load product code if HOME is still the real one.
 *
 *   node test/run-sandboxed.cjs                 # every test/*.test.cjs
 *   node test/run-sandboxed.cjs test/a.test.cjs # just these
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const realHome = os.homedir();
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'md-test-home-'));

const files = process.argv.length > 2
  ? process.argv.slice(2)
  : fs.readdirSync(__dirname)
    .filter((f) => f.endsWith('.test.cjs'))
    .sort()
    .map((f) => path.join('test', f));

const env = {
  ...process.env,
  HOME: sandbox,
  USERPROFILE: sandbox,
  // Read by load-ts.cjs where os.userInfo() is unavailable (no passwd entry).
  MUNDER_TEST_REAL_HOME: realHome,
};
// XDG dirs default under HOME; an inherited absolute one would point back at the
// real home and route around the sandbox.
for (const k of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME']) delete env[k];

let status = 1;
try {
  const r = spawnSync(process.execPath, ['--test', ...files], {
    cwd: path.resolve(__dirname, '..'),
    env,
    stdio: 'inherit',
  });
  if (r.error) throw r.error;
  status = r.status ?? 1;
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}
process.exit(status);
