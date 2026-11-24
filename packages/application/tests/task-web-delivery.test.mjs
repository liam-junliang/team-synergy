import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { schema } from '@team-synergy/persistence';
import { createVerificationUseCases } from '../dist/project-use-cases.js';
import { createTaskService } from '../dist/task-service.js';
import { createTaskWebDelivery } from '../dist/task-web-delivery.js';
import { insertFeature, insertTask, seedWorkspaceProject, useTestDb } from './test-db.mjs';

const fixture = useTestDb(import.meta.url);
const acceptance = [{ id: 'AC-1', text: 'First check' }, { id: 'AC-2', text: 'Second check' }];

async function setup(profile = 'builder') {
  const db = fixture.db;
  const { project, users } = await seedWorkspaceProject(db, {
    users: [
      { key: 'manager', account: 'manager', displayName: 'Manager', teamRole: 'owner', projectRole: 'owner' },
      { key: 'builder', account: 'builder', displayName: 'Builder' },
      { key: 'reviewer', account: 'reviewer', displayName: 'Reviewer' },
    ],
  });
  const feature = await insertFeature(db, { projectId: project.id, title: 'Delivery workflow' });
  const task = await insertTask(db, {
    featureId: feature.id, title: 'Deliver a fixed version', profile,
    status: 'assigned', assigneePrincipalId: users.builder.id, acceptance,
  });
  const currentSnapshot = async () => (await db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id)))[0].base_snapshot;
  const web = createTaskWebDelivery(db);
  return { db, task, project, users, currentSnapshot, tasks: createTaskService(db),
    inspect: user => web.inspect(task.code, users[user].code),
    apply: async (user, command) => web.apply(task.code, users[user].code, { base_snapshot: await currentSnapshot(), ...command }),
  };
}

const artifact = {
  artifact_uri: 'https://forge.example/development/commit/' + 'a'.repeat(40),
  content_hash: 'a'.repeat(40),
};
const selfTest = { ...artifact, action: 'record_delivery', summary: 'Checked the revision and verified the reproduced case', acceptance_refs: ['AC-1'] };

test('manual evidence, supplemental evidence and independent review stay tied to one delivery', async () => {
  const { db, task, tasks, users, inspect, apply, currentSnapshot } = await setup();
  const delivered = await apply('manager', selfTest);
  assert.equal(delivered.status, 'submitted');
  const initial = await inspect('reviewer');
  assert.equal(initial.submission_author_code, users.builder.code);
  assert.equal(initial.submission_registrar_code, users.manager.code);
  assert.equal((await db.select().from(schema.runs)).length, 0);
  await assert.rejects(apply('builder', { action: 'start_review' }), { code: 'task_review_self' });
  await apply('reviewer', { action: 'start_review' });
  const reserved = await tasks.claimTask({
    taskCode: task.code, principalCode: users.manager.code, profile: 'verifier', baseSnapshot: await currentSnapshot(),
    workspacePath: '/test/verify', gitBase: 'a'.repeat(40),
    runCode: '11111111111111111111', workspaceCode: '22222222222222222222',
  });
  assert.equal(reserved.error.code, 'task_review_assigned');
  const request = await apply('reviewer', { action: 'finish_review', result: 'request_evidence',
    submission_code: initial.submission_code, acceptance_refs: ['AC-2'], summary: 'Please attach the second check' });
  assert.equal(request.status, 'submitted');
  assert.equal((await inspect('builder')).review_status, 'needs_evidence');
  assert.equal((await inspect('builder')).can_record_delivery, true);
  await assert.rejects(apply('builder', { ...selfTest, content_hash: 'b'.repeat(40) }), { code: 'task_delivery_version_changed' });
  await apply('builder', { ...selfTest, acceptance_refs: ['AC-2'], summary: 'Additional verification of the same revision' });
  assert.equal((await inspect('reviewer')).submission_code, initial.submission_code);
  assert.equal((await inspect('reviewer')).review_status, 'waiting');
  await apply('reviewer', { action: 'start_review' });
  const passed = await apply('reviewer', { action: 'finish_review', result: 'pass', acceptance_refs: ['AC-1', 'AC-2'],
    submission_code: initial.submission_code, summary: 'Reviewed the exact submission', report_uri: 'https://forge.example/development/checks/a' });
  assert.equal(passed.status, 'verified');
  const evidence = await db.select().from(schema.evidences).where(eq(schema.evidences.task_id, task.id));
  assert.deepEqual(evidence.map(row => row.run_id), [null, null, null, null]);
  assert.equal(evidence.filter(row => row.type === 'self_test').length, 2);
  assert.equal(evidence.filter(row => row.type === 'verifier_review' && row.result === 'pass').length, 1);
  assert.equal((await db.select().from(schema.artifacts)).length, 1);
});

test('native verification of a web delivery requires a different person from the real author', async () => {
  const { db, task, tasks, users, apply, currentSnapshot } = await setup();
  await apply('manager', selfTest);
  const claim = async (user, runCode, workspaceCode) => tasks.claimTask({
    taskCode: task.code, principalCode: users[user].code, profile: 'verifier', baseSnapshot: await currentSnapshot(),
    workspacePath: '/test/verify', gitBase: 'a'.repeat(40), runCode, workspaceCode,
  });
  const rejected = await claim('builder', '11111111111111111111', '22222222222222222222');
  assert.equal(rejected.error.code, 'task_review_self');
  const runCode = '33333333333333333333';
  const allowed = await claim('reviewer', runCode, '44444444444444444444');
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  // Model a previously opened native attempt while exercising the submit-time guard independently.
  await db.update(schema.runs).set({ principal_id: users.builder.id }).where(eq(schema.runs.code, runCode));
  const verify = async actor => createVerificationUseCases(db).verifyTask({
    taskCode: task.code, runCode, principalCode: users[actor].code, baseSnapshot: await currentSnapshot(),
    evidence: { type: 'verifier_review', result: 'pass', acceptanceRefs: ['AC-1', 'AC-2'], summary: 'Checked recorded criteria' },
  });
  const self = await verify('builder');
  assert.equal(self.error.code, 'task_review_self');
  await db.update(schema.runs).set({ principal_id: users.reviewer.id }).where(eq(schema.runs.code, runCode));
  const passed = await verify('reviewer');
  assert.equal(passed.ok, true, JSON.stringify(passed));
  assert.equal(passed.data.status, 'verified');
});

test('Web review can find a native planner submission pinned by its audit event', async () => {
  const { task, tasks, users, inspect, currentSnapshot } = await setup('planner');
  const runCode = '11111111111111111111';
  const claim = await tasks.claimTask({
    taskCode: task.code, principalCode: users.builder.code, profile: 'planner', baseSnapshot: await currentSnapshot(),
    workspacePath: '/test/planner', gitBase: 'a'.repeat(40), runCode, workspaceCode: '22222222222222222222',
  });
  assert.equal(claim.ok, true, JSON.stringify(claim));
  const submitted = await tasks.submitTask({
    taskCode: task.code, runCode, principalCode: users.builder.code, baseSnapshot: await currentSnapshot(),
    artifact: { kind: 'commit', uri: artifact.artifact_uri, contentHash: artifact.content_hash },
    evidence: { type: 'self_test', result: 'pass', acceptanceRefs: ['AC-1'], summary: 'Verified the planning output' },
  });
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  assert.equal((await inspect('reviewer')).submission_code, submitted.data.artifact_code);
});

test('a legacy Agent submission keeps its artifact when a Web reviewer takes over an Agent review', async () => {
  const { db, task, tasks, project, users, inspect, apply, currentSnapshot } = await setup();
  const assign = (name, runCode, workspaceCode, profile) => currentSnapshot().then(baseSnapshot => tasks.claimTask({
    taskCode: task.code, principalCode: users[name].code, profile, baseSnapshot,
    workspacePath: '/test/legacy', gitBase: 'a'.repeat(40), runCode, workspaceCode,
  }));
  const builderRun = '11111111111111111111';
  const verifierRun = '33333333333333333333';
  assert.equal((await assign('builder', builderRun, '22222222222222222222', 'builder')).ok, true);
  const submitted = await tasks.submitTask({
    taskCode: task.code, runCode: builderRun, principalCode: users.builder.code, baseSnapshot: await currentSnapshot(),
    artifact: { kind: 'commit', uri: artifact.artifact_uri, contentHash: artifact.content_hash },
    evidence: { type: 'self_test', result: 'pass', acceptanceRefs: ['AC-1'], summary: 'Known working revision' },
  });
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  assert.equal((await inspect('reviewer')).submission_code, submitted.data.artifact_code);
  assert.equal((await assign('reviewer', verifierRun, '44444444444444444444', 'verifier')).ok, true);
  const active = await inspect('manager');
  assert.equal(active.review_status, 'in_progress');
  assert.equal(active.reviewer_code, users.reviewer.code);
  assert.equal(active.review_requires_confirmation, true);
  const takeover = { action: 'assign_review', reviewer_principal_code: users.manager.code };
  await assert.rejects(apply('manager', takeover), { code: 'task_review_replacement_confirmation_required' });
  await apply('manager', { ...takeover, reason: 'Original verifier is unavailable', confirm_active: true });
  const [oldRun] = await db.select().from(schema.runs).where(eq(schema.runs.code, verifierRun));
  assert.equal(oldRun.status, 'cancelled');
  const [work] = await db.select().from(schema.runs).where(eq(schema.runs.code, builderRun));
  await db.insert(schema.artifacts).values({ project_id: project.id, task_id: task.id, run_id: work.id,
    kind: 'report', uri: 'https://forge.example/development/later-report', content_hash: 'b'.repeat(64),
    published: true, published_at: '2099-01-01T00:00:00Z' });
  assert.equal((await inspect('manager')).submission_code, submitted.data.artifact_code);
  const staleRun = await createVerificationUseCases(db).verifyTask({
    taskCode: task.code, runCode: verifierRun, principalCode: users.reviewer.code, baseSnapshot: await currentSnapshot(),
    evidence: { type: 'verifier_review', result: 'pass', acceptanceRefs: ['AC-1', 'AC-2'] },
  });
  assert.equal(staleRun.error.code, 'verify_run_inactive');
  await apply('manager', { action: 'start_review' });
  const returned = await apply('manager', { action: 'finish_review', result: 'return',
    submission_code: submitted.data.artifact_code, acceptance_refs: ['AC-2'], summary: 'Second check fails on this revision' });
  assert.equal(returned.status, 'failed');
  const changed = await tasks.assignTask({
    taskCode: task.code, principalCode: users.manager.code, assigneePrincipalCode: users.builder.code,
    baseSnapshot: await currentSnapshot(),
  });
  assert.equal(changed.ok, true, JSON.stringify(changed));
  await apply('builder', { ...selfTest, artifact_uri: 'https://forge.example/development/commit/' + 'b'.repeat(40), content_hash: 'b'.repeat(40) });
  const latest = await inspect('manager');
  assert.equal(latest.reviewer_code, null);
  assert.notEqual(latest.submission_code, submitted.data.artifact_code);
  assert.equal(latest.base_snapshot, await currentSnapshot());
  await apply('manager', { action: 'start_review' });
  await assert.rejects(apply('manager', { action: 'finish_review', result: 'pass', acceptance_refs: ['AC-1', 'AC-2'],
    submission_code: submitted.data.artifact_code, summary: 'Prior result cannot pass new work' }), { code: 'task_review_submission_changed' });
});
