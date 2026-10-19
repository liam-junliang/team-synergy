import { test } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';
import { schema } from '@team-synergy/persistence';
import { createProjectUseCases, createRequirementBaselineUseCases, createTaskService } from '../dist/index.js';
import { insertFeature, insertProject, insertRequirement, seedWorkspaceProject, useTestDb } from './test-db.mjs';

const fixture = useTestDb(import.meta.url);

async function seeded() {
  const db = fixture.db;
  const context = await seedWorkspaceProject(db, { users: [
    { key: 'owner', account: 'baseline-owner', displayName: 'Owner', teamRole: 'owner', projectRole: 'owner' },
    { key: 'member', account: 'baseline-member', displayName: 'Member' },
  ] });
  const feature = await insertFeature(db, { projectId: context.project.id, title: '交接' });
  const requirement = await insertRequirement(db, { featureId: feature.id, title: '冻结的需求标题', ownerPrincipalId: context.users.owner.id });
  const [revision] = await db.insert(schema.requirementRevisions).values({ requirement_id: requirement.id, revision: 1,
    summary: '按已确认的交接规则执行', acceptance_criteria: JSON.stringify([{ id: 'AC-1', text: '旧版本验收' }]), open_questions: '[]', created_at: 't0' }).returning();
  const created = await createRequirementBaselineUseCases(db).create({ projectCode: context.project.code,
    principalCode: context.users.owner.code, name: '交接 V1', scope: 'release/1.0', reason: '确认首版需求',
    requirements: [{ requirement_code: requirement.code, revision: 1 }] });
  assert.equal(created.ok, true, JSON.stringify(created));
  return { db, ...context, feature, requirement, revision, baseline: created.data };
}

function command(context, overrides = {}) {
  return { featureCode: context.feature.code, title: '按基线执行', profile: 'builder', source: 'requirement',
    principalCode: context.users.owner.code, requirementCode: context.requirement.code,
    requirementBaselineCode: context.baseline.baseline_code, acceptance: [{ id: 'AC-1', text: '完成任务' }], ...overrides };
}

test('task create: an older baseline pins its exact revision and frozen metadata after the requirement advances', async () => {
  const context = await seeded();
  await context.db.insert(schema.requirementRevisions).values({ requirement_id: context.requirement.id, revision: 2,
    summary: '尚未纳入基线的新规则', acceptance_criteria: '[{"id":"AC-2","text":"新版本验收"}]', open_questions: '[]', created_at: 't1' });
  await context.db.update(schema.requirements).set({ current_revision: 2, title: '最新草稿标题' }).where(eq(schema.requirements.id, context.requirement.id));
  const created = await createProjectUseCases(context.db).createTask(command(context));
  assert.equal(created.ok, true, JSON.stringify(created));
  const [stored] = await context.db.select().from(schema.tasks).where(eq(schema.tasks.code, created.data.task_code));
  assert.equal(stored.source_requirement_revision_id, context.revision.id);
  assert.notEqual(stored.requirement_baseline_id, null);
  const detail = await createTaskService(context.db).getTaskStatus(created.data.task_code, context.users.owner.code);
  assert.equal(detail.ok, true, JSON.stringify(detail));
  assert.equal(detail.data.requirement_title, '冻结的需求标题');
  assert.equal(detail.data.requirement_body, '按已确认的交接规则执行');
  assert.equal(detail.data.requirement_baseline.baseline_code, context.baseline.baseline_code);
  const [audit] = await context.db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.entity_type, 'task'), eq(schema.auditEvents.entity_id, stored.id)));
  assert.equal(JSON.parse(audit.payload).requirement_baseline_code, context.baseline.baseline_code);
});

test('task create: baselines from another project are rejected without creating a task', async () => {
  const context = await seeded();
  const otherProject = await insertProject(context.db, { teamId: context.team.id, name: 'Other' });
  const otherFeature = await insertFeature(context.db, { projectId: otherProject.id, title: 'Other feature' });
  const result = await createProjectUseCases(context.db).createTask(command(context, { featureCode: otherFeature.code }));
  assert.equal(result.ok, false);
  // The actor must first have permission for the target project.
  assert.equal(result.error.code, 'create_task_forbidden');
  await context.db.insert(schema.members).values({ principal_id: context.users.owner.id, project_id: otherProject.id, role: 'owner', display_name: 'Owner', created_at: 't0' });
  const foreign = await createProjectUseCases(context.db).createTask(command(context, { featureCode: otherFeature.code, requirementCode: undefined }));
  assert.equal(foreign.ok, false);
  assert.equal(foreign.error.code, 'baseline_not_found');
  assert.equal((await context.db.select().from(schema.tasks)).length, 0);
});

test('task create: a linked requirement must occur in the selected baseline', async () => {
  const context = await seeded();
  const missing = await insertRequirement(context.db, { featureId: context.feature.id, title: '未入基线', ownerPrincipalId: context.users.owner.id });
  const result = await createProjectUseCases(context.db).createTask(command(context, { requirementCode: missing.code }));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'baseline_requirement_missing');
  assert.equal((await context.db.select().from(schema.tasks)).length, 0);
});

test('task create: members may propose ad-hoc tasks but cannot assert an Owner-approved baseline binding', async () => {
  const context = await seeded();
  const result = await createProjectUseCases(context.db).createTask(command(context, { source: 'ad-hoc', principalCode: context.users.member.code }));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'baseline_forbidden');
  assert.equal((await context.db.select().from(schema.tasks)).length, 0);
});

test('task create: a module-only requirement moved to another project cannot reuse its old baseline', async () => {
  const context = await seeded();
  const [module] = await context.db.insert(schema.projectModules).values({ project_id: context.project.id, name: '模块需求', status: 'active', sort_order: 0, created_at: 't0', updated_at: 't0' }).returning();
  await context.db.update(schema.requirements).set({ feature_id: null, module_id: module.id }).where(eq(schema.requirements.id, context.requirement.id));
  const otherProject = await insertProject(context.db, { teamId: context.team.id, name: 'Moved scope' });
  await context.db.update(schema.projectModules).set({ project_id: otherProject.id }).where(eq(schema.projectModules.id, module.id));
  const result = await createProjectUseCases(context.db).createTask(command(context));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'requirement_cross_project');
  assert.equal((await context.db.select().from(schema.tasks)).length, 0);
});
