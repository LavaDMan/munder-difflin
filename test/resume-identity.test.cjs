'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const loadTs = require('./load-ts.cjs');
const root = process.env.MUNDER_TEST_SOURCE_ROOT || path.resolve(__dirname, '..');
const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true,
  exports: { Notification: class { static isSupported() { return false; } } } };
const { HiveManager } = loadTs(path.join(root, 'src/main/hive.ts'));
const { HookServer } = loadTs(path.join(root, 'src/main/hooks.ts'));
const { TelemetryCollector } = loadTs(path.join(root, 'src/main/telemetry.ts'));

// Execute the real production beat, without booting Electron or a live floor.
// Extract a named AST node, not a duplicate of the code being tested.
function breakerBeat(bindings) {
  const file = process.env.MUNDER_TEST_MAIN_BUNDLE || path.join(root, 'src/main/index.ts');
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const fn = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'runBreakerBeat');
  assert.ok(fn, 'production breaker beat exists');
  const js = ts.transpileModule(fn.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(bindings), `${js}; return runBreakerBeat;`)(...Object.values(bindings));
}
function metric(sessionId, name = 'claude_code.session.count', value = 1) {
  return { resourceMetrics: [{ resource: { attributes: [{ key: 'agent.id', value: { stringValue: 'builder' } }] },
    scopeMetrics: [{ metrics: [{ name, sum: { dataPoints: [{ asInt: value, attributes: [
      { key: 'session.id', value: { stringValue: sessionId } },
      { key: 'type', value: { stringValue: 'output' } }
    ] }] } }] }] }] };
}
async function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'munder-resume-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'builder', name: 'Synthetic builder', provider: 'claude', cwd: home });
  const hooks = new HookServer(hive, () => null, () => ({ notifications: false }));
  const telemetry = new TelemetryCollector({ resolveCwd: () => home, resolveSessionId: () => hive.lastSession('builder') });
  const inputs = [];
  const beat = breakerBeat({ hive, usageProvider: telemetry, telemetry,
    ptyForAgent: () => 'synthetic-pty', lastCoordinationAt: () => Date.now(),
    breaker: { tick: rows => { inputs.push(...rows); return []; } } });
  return { home, hive, hooks, telemetry, beat, inputs };
}

test('startup telemetry cannot replace the resumed parent key, including after a hive restart', async t => {
  const { home, hive, hooks, telemetry, beat, inputs } = await fixture(t);
  hooks.handle({ agent_id: 'builder', hook_event_name: 'SessionStart', source: 'resume', session_id: 'parent-resumed' });
  telemetry.ingestMetrics(metric('bootstrap-session'));
  const sample = telemetry.getAgentUsage('builder');
  assert.equal(sample.sessionId, 'bootstrap-session');
  assert.equal(sample.output, 0);
  assert.equal(sample.model, '');
  beat(30000);
  assert.equal(inputs.length, 1, 'valid breaker input is still evaluated');
  assert.equal(hive.lastSession('builder'), 'parent-resumed', 'accounting attribution must not replace the resume key');
  assert.equal(new HiveManager(() => home).lastSession('builder'), 'parent-resumed');
});

test('auxiliary usage remains accounted without becoming the parent resume key', async t => {
  const { hive, hooks, telemetry, beat } = await fixture(t);
  hooks.handle({ agent_id: 'builder', hook_event_name: 'SessionStart', source: 'resume', session_id: 'parent' });
  telemetry.ingestMetrics(metric('auxiliary', 'claude_code.token.usage', 17));
  beat(30000);
  assert.equal(telemetry.getAgentUsage('builder').output, 17, 'preserve auxiliary accounting');
  assert.equal(hive.lastSession('builder'), 'parent');
  // A real lifecycle event can still establish a replacement parent (/clear).
  hooks.handle({ agent_id: 'builder', hook_event_name: 'SessionStart', source: 'clear', session_id: 'new-parent' });
  beat(30000);
  assert.equal(hive.lastSession('builder'), 'new-parent');
});

test('unattributed telemetry cannot manufacture a resumable session before hooks arrive', async t => {
  const { hive, telemetry, beat } = await fixture(t);
  telemetry.ingestMetrics(metric('bootstrap-only'));
  beat(30000);
  assert.equal(hive.lastSession('builder'), undefined);
});

test('synthetic cost hooks cannot replace a provider session identity', async t => {
  const { hive, hooks } = await fixture(t);
  hooks.handle({ agent_id: 'builder', hook_event_name: 'SessionStart', session_id: 'parent' });
  hooks.handle({ agent_id: 'builder', hook_event_name: 'CostSample', session_id: 'billing-only', output: 5 });
  assert.equal(hive.lastSession('builder'), 'parent');
});
