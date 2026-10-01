'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  codexRemoteAliasPath,
  codexRemoteEndpoint,
  codexRemoteSocketFits,
  withCodexRemoteArgs,
  CODEX_REMOTE_SOCKET_MAX,
  CODEX_REMOTE_SOCKET_RELATIVE
} = loadTs(process.env.MUNDER_TEST_SOURCE_ROOT ? require('node:path').join(process.env.MUNDER_TEST_SOURCE_ROOT, 'src/shared/codexRemote.ts') : 'src/shared/codexRemote.ts');

test('Codex remote uses a short stable per-agent home alias', {
  skip: process.platform === 'win32' ? 'Codex remote uses Unix sockets and is disabled on Windows' : false
}, () => {
  const first = codexRemoteAliasPath('/very/long/hive/agent/.codex', 'dev-1', '/tmp');
  const again = codexRemoteAliasPath('/very/long/hive/agent/.codex', 'dev-1', '/tmp');
  const other = codexRemoteAliasPath('/very/long/hive/agent/.codex', 'dev-2', '/tmp');
  assert.equal(first, again);
  assert.notEqual(first, other);
  assert.ok(first.length < 80);
  assert.match(codexRemoteEndpoint(first), /^unix:\/\/\/tmp\//);
});

test('the default alias root yields a socket within sun_path', () => {
  // The real hive home that failed with "path must be shorter than SUN_LEN".
  const realHome =
    '/Users/vyapakgoyal/Documents/HarnessAgents/hive/agents/dev2-mrxb3l43/.codex';
  const socket =
    codexRemoteAliasPath(realHome, 'dev2-mrxb3l43') + '/' + CODEX_REMOTE_SOCKET_RELATIVE;
  assert.ok(
    socket.length < CODEX_REMOTE_SOCKET_MAX,
    `socket path is ${socket.length} bytes: ${socket}`
  );
  // …and shorter than the home it replaces, which the $TMPDIR version was not.
  assert.ok(socket.length < (realHome + '/' + CODEX_REMOTE_SOCKET_RELATIVE).length);
});

test('an over-long alias root is rejected instead of failing at bind time', () => {
  const tmpdirStyle = '/var/folders/v6/9f10q5d148z7bxdzhr22xl7r0000gn/T/munder-codex';
  assert.equal(codexRemoteSocketFits(codexRemoteAliasPath('/h/.codex', 'a', tmpdirStyle)), false);
  assert.equal(codexRemoteSocketFits(codexRemoteAliasPath('/h/.codex', 'a')), true);
});

test('remote endpoint precedes both fresh and resumed Codex invocations', () => {
  const endpoint = 'unix:///tmp/munder-codex/a/app-server-control/app-server-control.sock';
  assert.deepEqual(
    withCodexRemoteArgs(['--model', 'gpt-5.6-sol', 'hello'], endpoint),
    ['--remote', endpoint, '--model', 'gpt-5.6-sol', 'hello']
  );
  assert.deepEqual(
    withCodexRemoteArgs(['resume', 'session-id', '--model', 'gpt-5.6-sol'], endpoint),
    ['--remote', endpoint, 'resume', 'session-id', '--model', 'gpt-5.6-sol']
  );
  assert.deepEqual(
    withCodexRemoteArgs(['--remote', endpoint, 'resume'], endpoint),
    ['--remote', endpoint, 'resume']
  );
});

test('remote fresh and resumed sessions carry the requested working root explicitly', () => {
  const endpoint = 'unix:///tmp/disposable/server.sock';
  const cwd = '/tmp/disposable/requested checkout';
  for (const args of [[], ['resume', 'saved-session']]) {
    assert.deepEqual(withCodexRemoteArgs(args, endpoint, cwd),
      ['--remote', endpoint, '--cd', cwd, ...args]);
  }
});

test('an existing remote endpoint still receives the requested cwd; explicit CLI cwd is preserved', () => {
  const endpoint = 'unix:///tmp/disposable/server.sock';
  assert.deepEqual(withCodexRemoteArgs(['--remote', endpoint, 'resume', 'saved'], endpoint, '/work'),
    ['--cd', '/work', '--remote', endpoint, 'resume', 'saved']);
  for (const cd of [['--cd', '/explicit'], ['-C', '/explicit'], ['--cd=/explicit'], ['-C/explicit']]) {
    const args = [...cd, 'resume', 'saved'];
    assert.deepEqual(withCodexRemoteArgs(args, endpoint, '/default'), ['--remote', endpoint, ...args]);
  }
});

for (const resumed of [false, true]) {
  test(`spawn wiring forwards the requested cwd (${resumed ? 'resume' : 'new'})`, async t => {
    const fs = require('node:fs');
    const path = require('node:path');
    const ts = require('typescript');
    const root = process.env.MUNDER_TEST_SOURCE_ROOT || path.resolve(__dirname, '..');
    const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'md-cwd-wiring-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const home = path.join(dir, 'home'); fs.mkdirSync(home);
    const file = path.join(root, 'src/main/index.ts');
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const fn = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'enableCodexRemoteForSpawn');
    const js = ts.transpileModule(fn.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const bindings = { process, console, dirname: path.dirname, join: path.join, resolve: path.resolve,
      mkdirSync: fs.mkdirSync, existsSync: fs.existsSync, lstatSync: fs.lstatSync, readlinkSync: fs.readlinkSync,
      symlinkSync: fs.symlinkSync, codexRemoteAliasPath: () => path.join(dir, 'alias'),
      codexRemoteSocketFits: () => true, CODEX_REMOTE_SOCKET_RELATIVE, codexRemoteEndpoint, withCodexRemoteArgs,
      resolveCliCommand: x => x,
      runCodexDaemonCommand: async (_exe, _args, env) => {
        const socket = path.join(env.CODEX_HOME, CODEX_REMOTE_SOCKET_RELATIVE);
        fs.mkdirSync(path.dirname(socket), { recursive: true }); fs.writeFileSync(socket, '');
        return { ok: true };
      } };
    const enable = new Function(...Object.keys(bindings), `${js}; return enableCodexRemoteForSpawn;`)(...Object.values(bindings));
    const opts = { command: 'codex', cwd: path.join(dir, 'requested'), env: { CODEX_HOME: home },
      args: resumed ? ['resume', 'saved-parent'] : [] };
    assert.equal(await enable(opts, 'synthetic-builder'), true);
    assert.equal(opts.args[opts.args.indexOf('--cd') + 1], opts.cwd, 'production spawn must pass cwd to remote arguments');
    if (resumed) assert.ok(opts.args.indexOf('--cd') < opts.args.indexOf('resume'));
  });
}
