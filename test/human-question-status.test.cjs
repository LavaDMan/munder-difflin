const test=require('node:test'); const assert=require('node:assert/strict'); const load=require('./load-ts.cjs');
const ledger=load('src/shared/taskLedger.ts');
test('withdrawn/superseded/FYI entries do not become fresh questions',()=>{
 for(const disposition of ['withdrawn','superseded','fyi']) assert.equal(ledger.isOpenHumanQuestion({q:'historical ask', disposition, decisionRef:'tasks/T1/humanQA/0'}),false);
 assert.equal(ledger.isOpenHumanQuestion({q:'pending'}),true);
 assert.equal(ledger.isOpenHumanQuestion({q:'answered',a:'yes'}),false);
 assert.equal(ledger.isOpenHumanQuestion({q:'dismissed',dismissedAt:'today'}),false);
 assert.equal(ledger.isOpenHumanQuestion({q:'still a question',disposition:'unrecognized'}),true);
});
