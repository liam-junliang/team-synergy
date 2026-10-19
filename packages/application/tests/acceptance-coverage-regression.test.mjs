import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { schema } from '@team-synergy/persistence';
import { createTaskService, createVerificationUseCases } from '../dist/index.js';
import { insertFeature, insertTask, seedWorkspaceProject, useTestDb } from './test-db.mjs';

const fixture = useTestDb(import.meta.url);

function success(result, operation) {
  assert.equal(result.ok, true, `${operation}: ${JSON.stringify(result)}`);
  return result.data;
}

async function seededVerification() {
  const db = fixture.db;
  const seeded = await seedWorkspaceProject(db, {
    users: [
      { key: 'builder', account: 'builder', displayName: 'Builder', teamRole: 'owner', projectRole: 'owner' },
      { key: 'verifier', account: 'verifier', displayName: 'Verifier' },
    ],
  });
  const feature = await insertFeature(db, { projectId: seeded.project.id, title: 'Acceptance coverage' });
  const task = await insertTask(db, {
    featureId: feature.id,
    title: 'Require distinct coverage for each acceptance criterion',
    profile: 'builder',
    acceptance: [{ id: 'AC-1', text: 'First criterion' }, { id: 'AC-2', text: 'Second criterion' }],
  });
  const tasks = createTaskService(db);
  const assigned = success(await tasks.assignTask({ taskCode: task.code,
    assigneePrincipalCode: seeded.users.builder.code, principalCode: seeded.users.builder.code, baseSnapshot: 0 }), 'assign');
  const claimed = success(await tasks.claimTask({ taskCode: task.code,
    principalCode: seeded.users.builder.code, profile: 'builder', baseSnapshot: assigned.base_snapshot,
    workspacePath: '/builder/coverage', gitBase: 'a'.repeat(40),
    runCode: '11111111111111111111', workspaceCode: '22222222222222222222' }), 'builder claim');
  const [running] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id));
  const submitted = success(await tasks.submitTask({ taskCode: task.code, runCode: claimed.run_code,
    principalCode: seeded.users.builder.code, baseSnapshot: running.base_snapshot,
    artifact: { kind: 'commit', uri: `git:${'b'.repeat(40)}`, contentHash: 'c'.repeat(64) },
    evidence: { type: 'self_test', result: 'pass', acceptanceRefs: ['AC-1', 'AC-2'] } }), 'builder submit');
  const verifierRun = success(await tasks.claimTask({ taskCode: task.code,
    principalCode: seeded.users.verifier.code, profile: 'verifier', baseSnapshot: submitted.base_snapshot,
    workspacePath: '/verifier/coverage', gitBase: 'b'.repeat(40),
    runCode: '33333333333333333333', workspaceCode: '44444444444444444444' }), 'verifier claim');
  return { db, ...seeded, task, submitted, verifierRun, verification: createVerificationUseCases(db) };
}

test('verification: repeating AC-1 cannot substitute for covering AC-2 or mutate verification state', async () => {
  const ctx = await seededVerification();
  const command = { taskCode: ctx.task.code, runCode: ctx.verifierRun.run_code,
    principalCode: ctx.users.verifier.code, baseSnapshot: ctx.submitted.base_snapshot,
    evidence: { type: 'verifier_review', result: 'pass', acceptanceRefs: ['AC-1', 'AC-1'] } };
  const denied = await ctx.verification.verifyTask(command);
  assert.equal(denied.ok, false, JSON.stringify(denied));
  assert.equal(denied.error.code, 'acceptance_coverage_incomplete');
  const [unchangedTask] = await ctx.db.select().from(schema.tasks).where(eq(schema.tasks.id, ctx.task.id));
  const [unchangedRun] = await ctx.db.select().from(schema.runs).where(eq(schema.runs.code, ctx.verifierRun.run_code));
  assert.equal(unchangedTask.status, 'submitted');
  assert.equal(unchangedTask.base_snapshot, ctx.submitted.base_snapshot);
  assert.equal(unchangedRun.status, 'active');
  assert.equal((await ctx.db.select().from(schema.evidences).where(eq(schema.evidences.type, 'verifier_review'))).length, 0);

  const verified = success(await ctx.verification.verifyTask({ ...command,
    evidence: { ...command.evidence, acceptanceRefs: ['AC-1', 'AC-2'] } }), 'distinct full coverage');
  assert.equal(verified.status, 'verified');
  const [evidence] = await ctx.db.select().from(schema.evidences).where(eq(schema.evidences.type, 'verifier_review'));
  assert.deepEqual(JSON.parse(evidence.acceptance_refs), ['AC-1', 'AC-2']);
});
