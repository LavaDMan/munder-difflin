'use strict';
/**
 * The unit suite must never run against the developer's real home directory.
 *
 * Product code finds agent config through `os.homedir()` (~/.gemini, ~/.codex,
 * ~/.claude, ...), and `ensureAgent` / the `install*Hooks` installers WRITE there.
 * A test that reached them without redirecting HOME once merged a hook group
 * pointing at its own temp dir into a live floor's ~/.gemini hooks files, and the
 * temp dir was then deleted. Per-test redirection is a convention; this file pins
 * the two mechanisms that make it a default:
 *
 *   (a) `npm run test:focused` (test/run-sandboxed.cjs) gives the whole suite a
 *       throwaway HOME, so a test that forgets still writes somewhere harmless;
 *   (b) test/load-ts.cjs refuses to load product code while HOME is the real one,
 *       so running a single file directly (`node --test test/x.test.cjs`) fails
 *       loudly before anything can write, instead of silently using ~/.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function realHome() {
  try {
    return os.userInfo().homedir;
  } catch {
    return process.env.MUNDER_TEST_REAL_HOME;
  }
}

test('the suite runs with HOME pointed away from the real home directory', () => {
  const real = realHome();
  assert.ok(real, 'cannot determine the real home directory to compare against');
  assert.notEqual(
    path.resolve(os.homedir()),
    path.resolve(real),
    `HOME is the real home (${real}); run the suite through \`npm run test:focused\``,
  );
});

test('load-ts refuses to load product code while HOME is the real home directory', () => {
  const real = realHome();
  assert.ok(real, 'cannot determine the real home directory to compare against');
  // A child with HOME set back to the real home, loading a module with no
  // import-time side effects, so this case is safe even if the guard is missing.
  const child = spawnSync(
    process.execPath,
    ['-e', "require('./test/load-ts.cjs')('src/main/fs.ts'); console.log('LOADED')"],
    {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, HOME: real, USERPROFILE: real },
      encoding: 'utf8',
    },
  );
  assert.notEqual(child.status, 0, `expected a refusal; child printed: ${child.stdout}`);
  assert.doesNotMatch(child.stdout, /LOADED/);
  assert.match(child.stderr, /real home directory/);
});
