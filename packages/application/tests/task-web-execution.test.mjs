import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { schema } from '@team-synergy/persistence';
import { createTaskService } from '../dist/task-service.js';
import { createTaskWebExecution } from '../dist/task-web-execution.js';
import { insertFeature, insertTask, seedWorkspaceProject, useTestDb } from './test-db.mjs';

const fixture = useTestDb(import.meta.url);
const acceptance = [{ id: 'AC-1', text: 'Reproduce and verify' }];

async function setup() {
  const db = fixture.db;
  const { users, project } = await seedWorkspaceProject(db, {
    users: [
      { key: 'manager', account: 'manager', displayName: 'Manager', teamRole: 'owner', projectRole: 'owner' },
      { key: 'original', account: 'original', displayName: 'Original execution member' },
      { key: 'next', account: 'next', displayName: 'Replacement execution member' },
    ],
  });
  const feature = await insertFeature(db, { projectId: project.id, title: 'Web task recovery' });
  return { db, users, project, feature, tasks: createTaskService(db), web: createTaskWebExecution(db) };
}

test('web recovery revokes the previous execution atomically and preserves its evidence', async () => {
  const { db, users, project, feature, tasks, web } = await setup();
  const task = await insertTask(db, {
    featureId: feature.id, title: 'Recover an interrupted task', profile: 'builder',
    status: 'assigned', assigneePrincipalId: users.original.id, acceptance,
  });
  const claim = await tasks.claimTask({
    taskCode: task.code, principalCode: users.original.code, profile: 'builder', baseSnapshot: 0,
    workspacePath: '/test/builder', gitBase: 'a'.repeat(40),
    runCode: '11111111111111111111', workspaceCode: '22222222222222222222',
  });
  assert.ok(claim.ok, JSON.stringify(claim));
  const [run] = await db.select().from(schema.runs).where(eq(schema.runs.code, claim.data.run_code));
  const time = new Date().toISOString();
  const [device] = await db.insert(schema.devices).values({
    principal_id: users.original.id, device_name: 'Original device', credential_hash: '1'.repeat(64), created_at: time,
  }).returning();
  await db.insert(schema.runLeases).values({
    run_id: run.id, device_id: device.id, epoch: run.execution_epoch, token_hash: '2'.repeat(64),
    expires_at: new Date(Date.now() + 600_000).toISOString(), created_at: time,
  });
  await db.insert(schema.agentSessions).values({
    run_id: run.id, device_id: device.id, agent_command: 'test', launch_kind: 'default',
    status: 'running', started_at: time,
  });
  await db.insert(schema.artifacts).values({
    project_id: project.id, task_id: task.id, run_id: run.id, kind: 'commit',
    uri: 'https://example.invalid/test/commit/a', content_hash: 'a'.repeat(40),
  });
  await db.insert(schema.evidences).values({
    task_id: task.id, run_id: run.id, type: 'self_test', result: 'pass', acceptance_refs: '["AC-1"]', recorded_at: time,
  });

  const action = {
    action: 'recover_execution', base_snapshot: 1, assignee_principal_code: users.next.code,
    reason: 'Original member unavailable',
  };
  const before = await web.inspect(task.code, users.manager.code);
  assert.equal(before.execution_health, 'active');
  assert.equal(before.git_base, 'a'.repeat(40));
  assert.equal(before.recovery_requires_confirmation, true);
  assert.equal((await web.inspect(task.code, users.original.code)).can_recover, false);
  await assert.rejects(web.apply(task.code, users.original.code, action), { code: 'project_forbidden' });
  await assert.rejects(web.apply(task.code, users.manager.code, action), { code: 'task_execution_confirmation_required' });

  const confirmed = { ...action, confirm_active: true, idempotency_key: 'recover-example' };
  const recovered = await web.apply(task.code, users.manager.code, confirmed);
  assert.deepEqual(recovered, {
    task_code: task.code, status: 'assigned', base_snapshot: 2, assignee_principal_code: users.next.code,
    execution_epoch: 1, stopped_run_codes: [run.code],
  });
  assert.deepEqual(await web.apply(task.code, users.manager.code, confirmed), recovered);
  await assert.rejects(web.apply(task.code, users.manager.code, { ...confirmed, reason: 'Another reason' }), { code: 'idempotency_conflict' });
  assert.equal((await db.select().from(schema.runs).where(eq(schema.runs.id, run.id)))[0].status, 'cancelled');
  assert.ok((await db.select().from(schema.runLeases).where(eq(schema.runLeases.run_id, run.id)))[0].revoked_at);
  assert.equal((await db.select().from(schema.agentSessions).where(eq(schema.agentSessions.run_id, run.id)))[0].status, 'cancelled');
  assert.equal((await db.select().from(schema.artifacts).where(eq(schema.artifacts.run_id, run.id))).length, 1);
  assert.equal((await db.select().from(schema.evidences).where(eq(schema.evidences.run_id, run.id))).length, 1);
  const [event] = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, 'task.execution_recovered'));
  assert.equal(event.principal_id, users.manager.id);
  assert.equal(JSON.parse(event.payload).previous_assignee_code, users.original.code);
  assert.equal(JSON.parse(event.payload).reason, action.reason);

  const denied = await tasks.submitTask({
    taskCode: task.code, runCode: run.code, principalCode: users.original.code, baseSnapshot: recovered.base_snapshot,
    artifact: { kind: 'commit', uri: 'https://example.invalid/test/commit/b', contentHash: 'b'.repeat(40) },
    evidence: { type: 'self_test', result: 'pass', acceptanceRefs: ['AC-1'] },
  });
  assert.equal(denied.ok, false, JSON.stringify(denied));
  assert.equal(denied.error.code, 'run_inactive');
  const nextClaim = await tasks.claimTask({
    taskCode: task.code, principalCode: users.next.code, profile: 'builder', baseSnapshot: recovered.base_snapshot,
    workspacePath: '/test/replacement', gitBase: 'a'.repeat(40),
    runCode: '33333333333333333333', workspaceCode: '44444444444444444444',
  });
  assert.ok(nextClaim.ok, JSON.stringify(nextClaim));
  const [newRun] = await db.select().from(schema.runs).where(eq(schema.runs.code, nextClaim.data.run_code));
  assert.equal(newRun.execution_epoch, 1);
});

test('releasing an unclaimed assignment preserves its execution epoch', async () => {
  const { users, feature, db, web } = await setup();
  const task = await insertTask(db, {
    featureId: feature.id, title: 'Recover an unclaimed assignment', profile: 'builder',
    status: 'assigned', assigneePrincipalId: users.original.id, acceptance,
  });
  const action = { action: 'release_assignment', base_snapshot: 0, reason: 'Replan' };
  assert.equal((await web.inspect(task.code, users.manager.code)).can_release, true);
  await assert.rejects(web.apply(task.code, users.manager.code, { ...action, base_snapshot: 1 }), { code: 'base_snapshot_mismatch' });
  const recovered = await web.apply(task.code, users.manager.code, action);
  assert.equal(recovered.status, 'ready');
  assert.equal(recovered.execution_epoch, 0);
  assert.equal(recovered.assignee_principal_code, null);
});
