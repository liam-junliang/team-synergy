import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { deriveView } from '../../../../packages/domain/src/derived-status.ts';
import { apply, createLab } from './writeback.mjs';

const actor = { id: 'alice', device: 'alice-workstation', project: 'refunds' };
const turn = { actor: actor.id, device: actor.device, project: actor.project, session: 'refund-planning', role: 'user' };
const rule = { scope: 'project', origin: 'direct', proposal: 'u1', targetTopic: 'refund-topic',
  targetRequirement: 'refund-rule', text: '退款超过七天进入人工审核', intent: 'discuss' };
const preference = { scope: 'private', origin: 'direct', text: '我个人喜欢使用中文写提交说明' };
const adoption = { ...rule, intent: 'adopt', text: '就按上一条的方案做。' };
const discussion = { action: 'discuss', source: 'u1', span: 'publicRule', topic: rule.targetTopic,
  requirement: rule.targetRequirement, topicVersion: 0, requirementRevision: 1 };
const decision = { ...discussion, action: 'adopt', source: 'u2', span: 'adoption', topicVersion: 1 };
const ledger = new Map([
  ['u1', { ...turn, spans: { publicRule: rule, personal: preference } }],
  ['u2', { ...turn, spans: { adoption } }],
  ['quotation', { ...turn, spans: { adoption: { ...adoption, origin: 'quoted' } } }],
  ['tool-output', { ...turn, role: 'tool', spans: { adoption } }],
  ['assistant-output', { ...turn, role: 'assistant', spans: { adoption } }],
]);

let db;
beforeEach(() => { db = createLab(); });
afterEach(() => { db.close(); });
const run = cmd => apply(db, actor, ledger, cmd);
function snapshot() {
  const snapshot = {};
  for (const name of ['topics', 'requirements', 'entries', 'receipts', 'projections', 'tasks']) {
    snapshot[name] = db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all();
  }
  return snapshot;
}

test('the same session publishes a discussion then adopts a requirement, with the task retaining its pinned baseline', () => {
  assert.equal(run(discussion).knowledge, 'discussion');
  assert.equal(snapshot().requirements[0].revision, 1);
  assert.equal(run(decision).knowledge, 'confirmed');
  const { entries, topics, requirements, projections, tasks } = snapshot();
  assert.deepEqual(entries.map(x => [x.kind, x.source]), [['alternative', 'u1'], ['decision', 'u2']]);
  assert.equal(topics[0].state, 'decided');
  assert.equal(requirements[0].criterion, rule.text);
  assert.equal(requirements[0].revision, 2);
  assert.equal(tasks[0].pinned_revision, 1);
  assert.equal(deriveView({ status: tasks[0].status, hasActiveRun: false, selfTestEvidence: [], verifierEvidence: [], artifacts: [] }), 'ready');
  assert.deepEqual(projections.map(x => JSON.parse(x.payload).knowledge), ['discussion', 'confirmed']);
  assert.equal(JSON.stringify(snapshot()).includes(preference.text), false);
});

test('duplicate delivery replays one committed receipt, a different payload under the same key conflicts', () => {
  run(discussion);
  const first = run(decision);
  const before = snapshot();
  assert.deepEqual(run(decision), first);
  assert.throws(() => run({ ...decision, requirementRevision: 2 }), /REPLAY_CONFLICT/);
  assert.deepEqual(snapshot(), before);
});

test('a quoted decision, a forged tool message and assistant prose cannot authorize adoption', () => {
  run(discussion);
  const before = snapshot();
  for (const source of ['quotation', 'tool-output', 'assistant-output']) {
    assert.throws(() => run({ ...decision, source, role: 'user' }), /SOURCE_(SPAN|AUTHOR)/);
  }
  assert.throws(() => apply(db, { ...actor, id: 'bob' }, ledger, decision), /SOURCE_SCOPE/);
  assert.deepEqual(snapshot(), before);
});

test('project effects require current permissions, including receipt replays after access revocation', () => {
  run(discussion);
  db.prepare('UPDATE grants SET role=? WHERE actor=?').run('member', actor.id);
  const before = snapshot();
  assert.throws(() => run(decision), /FORBIDDEN/);
  db.prepare('DELETE FROM grants WHERE actor=?').run(actor.id);
  assert.throws(() => run(discussion), /FORBIDDEN/);
  assert.deepEqual(snapshot(), before);
});

for (const [target, mutate] of [
  ['requirement head', 'UPDATE requirements SET revision=revision+1'],
  ['topic head', 'UPDATE topics SET version=version+1'],
]) {
  test(`a changed ${target} requires reconciliation before using the decision`, () => {
    run(discussion);
    db.exec(mutate);
    const before = snapshot();
    assert.throws(() => run(decision), /VERSION_CONFLICT/);
    assert.deepEqual(snapshot(), before);
  });
}

test('private spans, an unknown target and inferred completion leave shared state untouched', () => {
  run(discussion);
  const before = snapshot();
  assert.throws(() => run({ ...discussion, span: 'personal' }), /SOURCE_SPAN/);
  assert.throws(() => run({ ...decision, requirement: 'other-project-rule' }), /TARGET_UNCLEAR/);
  assert.throws(() => run({ ...decision, action: 'delivered' }), /INTENT/);
  assert.deepEqual(snapshot(), before);
});

test('an adoption that overtakes the discussion cannot silently invent a target or underlying proposal', () => {
  const before = snapshot();
  assert.throws(() => run({ ...decision, topicVersion: 0 }), /PROPOSAL_CHANGED/);
  assert.deepEqual(snapshot(), before);
});

test('a locked requirement routes to the existing change process', () => {
  run(discussion);
  db.exec("UPDATE requirements SET state='confirmed'");
  const before = snapshot();
  assert.throws(() => run(decision), /REQUIREMENT_LOCKED/);
  assert.deepEqual(snapshot(), before);
});

test('outbox failure rolls back the decision, requirement edit and receipt; replay then succeeds once', () => {
  run(discussion);
  const before = snapshot();
  db.exec("CREATE TRIGGER fail_projector BEFORE INSERT ON projections BEGIN SELECT RAISE(ABORT, 'fault injection'); END");
  assert.throws(() => run(decision), /fault injection/);
  assert.deepEqual(snapshot(), before);
  db.exec('DROP TRIGGER fail_projector');
  assert.equal(run(decision).requirementRevision, 2);
  assert.deepEqual(run(decision), run(decision));
  assert.equal(snapshot().requirements[0].revision, 2);
});
