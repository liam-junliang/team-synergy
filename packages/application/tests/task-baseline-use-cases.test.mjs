import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { schema } from '@team-synergy/persistence';
import { createRequirementBaselineUseCases, createTaskBaselineUseCases, createTaskService } from '../dist/index.js';
import { insertFeature, insertRequirement, insertTask, seedWorkspaceProject, useTestDb } from './test-db.mjs';

const fixture = useTestDb(import.meta.url);
const success = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.data; };
async function seeded() {
  const db = fixture.db;
  const ctx = await seedWorkspaceProject(db, { users: [
    { key: 'owner', account: 'baseline-owner', displayName: 'Owner', projectRole: 'owner', teamRole: 'owner' },
    { key: 'member', account: 'baseline-member', displayName: 'Member' },
  ] });
  const feature = await insertFeature(db, { projectId: ctx.project.id, title: 'Baseline feature' });
  const requirement = await insertRequirement(db, { featureId: feature.id, title: 'Frozen target', ownerPrincipalId: ctx.users.owner.id });
  const [revision] = await db.insert(schema.requirementRevisions).values({ requirement_id: requirement.id, revision: 1,
    summary: 'Frozen requirement body', acceptance_criteria: '[{"id":"AC-1","text":"Frozen acceptance"}]', created_at: '2026-10-14T00:00:00Z' }).returning();
  const baseline = success(await createRequirementBaselineUseCases(db).create({ projectCode: ctx.project.code, principalCode: ctx.users.owner.code,
    name: 'Approved V1', scope: 'Release 1', reason: 'Confirm delivery scope', requirements: [{ requirement_code: requirement.code, revision: 1 }] }));
  const task = await insertTask(db, { featureId: feature.id, requirementId: requirement.id, title: 'Implement target', profile: 'builder',
    acceptance: [{ id: 'AC-1', text: 'Frozen acceptance' }] });
  const uc = createTaskBaselineUseCases(db);
  const command = { taskCode: task.code, baselineCode: baseline.baseline_code, principalCode: ctx.users.owner.code, baseSnapshot: 0 };
  return { db, ...ctx, feature, requirement, revision, baseline, task, uc, command };
}

test('task baseline: binds exact revision, increments concurrency version and records audit once', async () => {
  const ctx = await seeded();
  const bound = success(await ctx.uc.bind(ctx.command));
  assert.equal(bound.base_snapshot, 1);
  const [task] = await ctx.db.select().from(schema.tasks).where(eq(schema.tasks.id, ctx.task.id));
  assert.equal(task.source_requirement_revision_id, ctx.revision.id);
  assert.ok(task.requirement_baseline_id);
  const detail = success(await createTaskService(ctx.db).getTaskStatus(task.code, ctx.users.member.code));
  assert.deepEqual(detail.requirement_baseline, ctx.baseline);
  await ctx.db.update(schema.requirementRevisions).set({ summary: 'Maintenance changed the original row',
    acceptance_criteria: '[{"id":"OTHER","text":"Unexpected criterion"}]', open_questions: '["Unexpected question"]' }).where(eq(schema.requirementRevisions.id, ctx.revision.id));
  const unchanged = success(await createTaskService(ctx.db).getTaskStatus(task.code, ctx.users.member.code));
  assert.equal(unchanged.requirement_body, ctx.baseline.requirements[0].body);
  assert.deepEqual(unchanged.requirement_acceptance_criteria, ctx.baseline.requirements[0].acceptance_criteria);
  assert.deepEqual(unchanged.requirement_open_questions, ctx.baseline.requirements[0].open_questions);
  assert.equal((await ctx.uc.bind(ctx.command)).error.code, 'base_snapshot_mismatch');
  success(await ctx.uc.bind({ ...ctx.command, baseSnapshot: 1 }));
  const audit = await ctx.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, 'task.baseline_bound'));
  assert.equal(audit.length, 1);
});

test('task baseline: project members cannot bind and foreign project baselines are rejected', async () => {
  const ctx = await seeded();
  assert.equal((await ctx.uc.bind({ ...ctx.command, principalCode: ctx.users.member.code })).error.code, 'baseline_forbidden');
  const [other] = await ctx.db.insert(schema.projects).values({ team_id: ctx.team.id, name: 'Other project', created_at: 't0' }).returning();
  const otherFeature = await insertFeature(ctx.db, { projectId: other.id, title: 'Other feature' });
  const otherTask = await insertTask(ctx.db, { featureId: otherFeature.id, title: 'Other task', source: 'ad-hoc', profile: 'builder', acceptance: [{ id: 'AC-1', text: 'Other' }] });
  await ctx.db.insert(schema.members).values({ project_id: other.id, principal_id: ctx.users.owner.id, role: 'owner', display_name: 'Owner', created_at: 't0' });
  assert.equal((await ctx.uc.bind({ ...ctx.command, taskCode: otherTask.code })).error.code, 'baseline_not_found');
  assert.equal((await ctx.db.select().from(schema.tasks).where(eq(schema.tasks.id, otherTask.id)))[0].requirement_baseline_id, null);
});

test('task baseline: cannot substitute a different pinned revision or omit task requirement', async () => {
  const ctx = await seeded();
  const [newRevision] = await ctx.db.insert(schema.requirementRevisions).values({ requirement_id: ctx.requirement.id, revision: 2,
    summary: 'Future version', acceptance_criteria: '[]', created_at: 't1' }).returning();
  await ctx.db.update(schema.tasks).set({ source_requirement_revision_id: newRevision.id }).where(eq(schema.tasks.id, ctx.task.id));
  assert.equal((await ctx.uc.bind(ctx.command)).error.code, 'baseline_revision_mismatch');
  const otherRequirement = await insertRequirement(ctx.db, { featureId: ctx.feature.id, title: 'Outside baseline', ownerPrincipalId: ctx.users.owner.id });
  await ctx.db.update(schema.tasks).set({ requirement_id: otherRequirement.id, source_requirement_revision_id: null }).where(eq(schema.tasks.id, ctx.task.id));
  assert.equal((await ctx.uc.bind(ctx.command)).error.code, 'baseline_requirement_missing');
});

test('task baseline: any prior Run prevents baseline replacement even when task is reset to assigned', async () => {
  const ctx = await seeded();
  success(await ctx.uc.bind(ctx.command));
  const tasks = createTaskService(ctx.db);
  const assigned = success(await tasks.assignTask({ taskCode: ctx.task.code, principalCode: ctx.users.owner.code,
    assigneePrincipalCode: ctx.users.member.code, baseSnapshot: 1 }));
  const claimed = success(await tasks.claimTask({ taskCode: ctx.task.code, principalCode: ctx.users.member.code, profile: 'builder',
    runCode: '11111111111111111111', workspaceCode: '22222222222222222222', baseSnapshot: assigned.base_snapshot,
    workspacePath: '/independent/computer', gitBase: 'a'.repeat(40) }));
  const [running] = await ctx.db.select().from(schema.tasks).where(eq(schema.tasks.id, ctx.task.id));
  assert.equal((await ctx.uc.bind({ ...ctx.command, baseSnapshot: running.base_snapshot })).error.code, 'baseline_task_started');
  await ctx.db.update(schema.runs).set({ status: 'completed' }).where(eq(schema.runs.code, claimed.run_code));
  await ctx.db.update(schema.tasks).set({ status: 'assigned' }).where(eq(schema.tasks.id, ctx.task.id));
  assert.equal((await ctx.uc.bind({ ...ctx.command, baseSnapshot: running.base_snapshot })).error.code, 'baseline_task_started');
});
