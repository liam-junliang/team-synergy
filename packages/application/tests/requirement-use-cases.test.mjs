import { test } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';
import { schema } from '@team-synergy/persistence';
import { createRequirementUseCases } from '../dist/index.js';
import { insertFeature, insertRequirementDocument, insertTask, seedWorkspaceProject, useTestDb } from './test-db.mjs';

const fixture = useTestDb(import.meta.url);

async function seededDb() {
  const db = fixture.db;
  const seeded = await seedWorkspaceProject(db, {
    teamLegacyCode: 'TEAM-REQ',
    teamName: 'Requirement Team',
    projectLegacyCode: 'PROJECT-A',
    projectName: 'acp',
    users: [
      { key: 'wang', legacyCode: 'user-wang', account: 'wang', displayName: 'wang', teamRole: 'member', projectRole: 'member' },
      { key: 'owner', legacyCode: 'owner', account: 'owner', displayName: 'owner', teamRole: 'owner', projectRole: 'owner' },
    ],
  });
  const feature = await insertFeature(db, { legacyCode: 'FEATURE-1', projectId: seeded.project.id, title: 'f', status: 'active' });
  return { db, ...seeded, feature };
}

test('需求用例：成员创建、列表投影、详情关联任务并写入审计', async () => {
  const ctx = await seededDb();
  const uc = createRequirementUseCases(ctx.db);

  const created = await uc.createRequirement({
    featureCode: ctx.feature.code,
    title: '需求录入闭环',
    body: '让成员从工作台录入需求。',
    acceptanceCriteria: [{ id: 'AC-1', text: '工作台可以保存需求草稿' }],
    openQuestions: ['是否需要批量导入？'],
    principalCode: ctx.users.wang.code,
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.data.status, 'draft');
  assert.equal(created.data.current_revision, 1);
  assert.deepEqual(created.data.acceptance_criteria, [{ id: 'AC-1', text: '工作台可以保存需求草稿' }]);
  assert.deepEqual(created.data.open_questions, ['是否需要批量导入？']);

  const [requirementRow] = await ctx.db.select().from(schema.requirements).where(eq(schema.requirements.code, created.data.requirement_code)).limit(1);
  await insertTask(ctx.db, {
    legacyCode: 'TASK-REQ-1',
    featureId: ctx.feature.id,
    requirementId: requirementRow.id,
    title: '实现需求 API',
    profile: 'builder',
    source: 'requirement',
    status: 'running',
    assigneePrincipalId: ctx.users.wang.id,
    acceptance: [{ id: 'AC-1', text: '接口可用' }],
    baseSnapshot: 1,
    createdAt: 't1',
  });

  const list = await uc.listRequirements(ctx.project.code, undefined, ctx.users.wang.code);
  assert.equal(list.length, 1);
  assert.deepEqual(list[0], { ...created.data, task_count: 1 });

  const detail = await uc.getRequirement(created.data.requirement_code, ctx.users.owner.code);
  assert.equal(detail.ok, true, JSON.stringify(detail));
  assert.deepEqual(detail.data.tasks, [{
    task_code: (await ctx.db.select().from(schema.tasks).where(eq(schema.tasks.requirement_id, requirementRow.id)).limit(1))[0].code,
    title: '实现需求 API',
    status: 'running',
    profile: 'builder',
    assignee_principal_code: ctx.users.wang.code,
  }]);

  const [audit] = await ctx.db.select().from(schema.auditEvents).where(and(
    eq(schema.auditEvents.entity_type, 'requirement'),
    eq(schema.auditEvents.entity_id, requirementRow.id),
  )).limit(1);
  assert.equal(audit.action, 'requirement.created');
  assert.equal(audit.principal_id, ctx.users.wang.id);
});

test('需求用例：只有项目成员可以录入', async () => {
  const ctx = await seededDb();
  const result = await createRequirementUseCases(ctx.db).createRequirement({
    featureCode: ctx.feature.code,
    title: '未授权需求',
    body: '不应落库',
    principalCode: '00000000000000000000',
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'user_not_found');
});

test('需求用例：可先绑定模块与文档，Feature 后续再补绑', async () => {
  const ctx = await seededDb();
  const [module] = await ctx.db.insert(schema.projectModules).values({
    project_id: ctx.project.id,
    name: 'AUTH',
    description: '身份模块',
    sort_order: 1,
    status: 'active',
    created_at: 't0',
    updated_at: 't0',
  }).returning();
  const document = await insertRequirementDocument(ctx.db, {
    legacyCode: 'DOC-AUTH',
    projectId: ctx.project.id,
    moduleId: module.id,
    moduleKey: 'AUTH',
    title: 'Auth Doc',
    ownerPrincipalId: ctx.users.owner.id,
  });

  const created = await createRequirementUseCases(ctx.db).createRequirement({
    moduleCode: module.code,
    documentCode: document.code,
    title: '待归类需求',
    body: '先记录需求，再补绑 Feature。',
    principalCode: ctx.users.owner.code,
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.data.feature_code, null);
  assert.equal(created.data.module_code, module.code);
  assert.equal(created.data.document_code, document.code);

  const rebound = await createRequirementUseCases(ctx.db).updateRequirement({
    requirementCode: created.data.requirement_code,
    featureCode: ctx.feature.code,
    principalCode: ctx.users.owner.code,
  });
  assert.equal(rebound.ok, true, JSON.stringify(rebound));
  assert.equal(rebound.data.feature_code, ctx.feature.code);
  assert.equal(rebound.data.module_code, module.code);
});

test('需求用例：仅 Owner 可修订结构化正文，每次编辑新增不可变 Revision', async () => {
  const ctx = await seededDb();
  const uc = createRequirementUseCases(ctx.db);
  const created = await uc.createRequirement({
    featureCode: ctx.feature.code,
    title: '原始标题',
    body: '原始正文',
    principalCode: ctx.users.wang.code,
  });
  assert.equal(created.ok, true, JSON.stringify(created));

  const denied = await uc.updateRequirement({
    requirementCode: created.data.requirement_code,
    title: '成员修改',
    body: '不应写入',
    principalCode: ctx.users.wang.code,
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'requirement_forbidden');

  const updated = await uc.updateRequirement({
    requirementCode: created.data.requirement_code,
    title: '更新后的标题',
    body: '更新后的正文',
    acceptanceCriteria: [{ id: 'AC-1', text: '新正文可阅读' }],
    openQuestions: ['是否补充原型？'],
    principalCode: ctx.users.owner.code,
  });
  assert.equal(updated.ok, true, JSON.stringify(updated));
  assert.equal(updated.data.title, '更新后的标题');
  assert.equal(updated.data.body, '更新后的正文');
  assert.equal(updated.data.current_revision, 2);
  assert.deepEqual(updated.data.acceptance_criteria, [{ id: 'AC-1', text: '新正文可阅读' }]);
  assert.deepEqual(updated.data.open_questions, ['是否补充原型？']);

  const detail = await uc.getRequirement(created.data.requirement_code, ctx.users.owner.code);
  assert.equal(detail.ok, true, JSON.stringify(detail));
  assert.equal(detail.data.title, '更新后的标题');
  assert.equal(detail.data.body, '更新后的正文');
  assert.equal(detail.data.current_revision, 2);
  assert.deepEqual(detail.data.revisions.map((revision) => revision.revision), [2, 1]);
  assert.equal(detail.data.revisions[1].body, '原始正文');

  const [requirementRow] = await ctx.db.select().from(schema.requirements).where(eq(schema.requirements.code, created.data.requirement_code)).limit(1);
  const audits = await ctx.db.select().from(schema.auditEvents).where(and(
    eq(schema.auditEvents.entity_type, 'requirement'),
    eq(schema.auditEvents.entity_id, requirementRow.id),
  ));
  assert.deepEqual(audits.map((audit) => audit.action), ['requirement.created', 'requirement.revised']);
  assert.equal(audits[1].principal_id, ctx.users.owner.id);
});

test('需求生命周期：Owner 按守卫推进，变更提议重新解锁文档', async () => {
  const ctx = await seededDb();
  const uc = createRequirementUseCases(ctx.db);
  const invalidInitial = await uc.createRequirement({
    featureCode: ctx.feature.code,
    title: '越级需求',
    body: '不应直接确认',
    status: 'confirmed',
    principalCode: ctx.users.owner.code,
  });
  assert.equal(invalidInitial.ok, false);
  assert.equal(invalidInitial.error.code, 'requirement_initial_status_invalid');

  const created = await uc.createRequirement({
    featureCode: ctx.feature.code,
    title: '需求生命周期',
    body: '让需求从草稿推进到交付。',
    openQuestions: ['验收口径是什么？'],
    principalCode: ctx.users.wang.code,
  });
  assert.equal(created.ok, true, JSON.stringify(created));

  const memberDenied = await uc.transitionRequirement({ requirementCode: created.data.requirement_code, to: 'clarifying', principalCode: ctx.users.wang.code });
  assert.equal(memberDenied.ok, false);
  assert.equal(memberDenied.error.code, 'requirement_forbidden');

  const missingAcceptance = await uc.transitionRequirement({ requirementCode: created.data.requirement_code, to: 'confirmed', principalCode: ctx.users.owner.code });
  assert.equal(missingAcceptance.ok, false);
  assert.equal(missingAcceptance.error.code, 'requirement_acceptance_required');

  const clarified = await uc.updateRequirement({
    requirementCode: created.data.requirement_code,
    title: '需求生命周期',
    body: '让需求从草稿推进到交付。',
    acceptanceCriteria: [{ id: 'AC-1', text: '完整生命周期可追踪' }],
    openQuestions: ['验收口径是什么？'],
    principalCode: ctx.users.owner.code,
  });
  assert.equal(clarified.ok, true, JSON.stringify(clarified));
  const unresolved = await uc.transitionRequirement({ requirementCode: created.data.requirement_code, to: 'confirmed', principalCode: ctx.users.owner.code });
  assert.equal(unresolved.ok, false);
  assert.equal(unresolved.error.code, 'requirement_questions_unresolved');

  const ready = await uc.updateRequirement({
    requirementCode: created.data.requirement_code,
    title: '需求生命周期',
    body: '让需求从草稿推进到交付。',
    acceptanceCriteria: [{ id: 'AC-1', text: '完整生命周期可追踪' }],
    openQuestions: [],
    principalCode: ctx.users.owner.code,
  });
  assert.equal(ready.ok, true, JSON.stringify(ready));
  const confirmed = await uc.transitionRequirement({ requirementCode: created.data.requirement_code, to: 'confirmed', principalCode: ctx.users.owner.code });
  assert.equal(confirmed.ok, true, JSON.stringify(confirmed));

  const locked = await uc.updateRequirement({
    requirementCode: created.data.requirement_code,
    title: '不应直接修改',
    body: '已确认版本锁定',
    principalCode: ctx.users.owner.code,
  });
  assert.equal(locked.ok, false);
  assert.equal(locked.error.code, 'requirement_revision_locked');

  const noTasks = await uc.transitionRequirement({ requirementCode: created.data.requirement_code, to: 'implementing', principalCode: ctx.users.owner.code });
  assert.equal(noTasks.ok, false);
  assert.equal(noTasks.error.code, 'requirement_tasks_required');
  const [requirementRow] = await ctx.db.select().from(schema.requirements).where(eq(schema.requirements.code, created.data.requirement_code)).limit(1);
  const task = await insertTask(ctx.db, {
    legacyCode: 'TASK-LIFECYCLE',
    featureId: ctx.feature.id,
    requirementId: requirementRow.id,
    title: '实现生命周期',
    profile: 'builder',
    source: 'requirement',
    status: 'running',
    acceptance: [{ id: 'AC-1', text: '生命周期通过' }],
    baseSnapshot: 1,
    createdAt: 't1',
  });
  const implementing = await uc.transitionRequirement({ requirementCode: created.data.requirement_code, to: 'implementing', principalCode: ctx.users.owner.code });
  assert.equal(implementing.ok, true, JSON.stringify(implementing));
  const incomplete = await uc.transitionRequirement({ requirementCode: created.data.requirement_code, to: 'delivered', principalCode: ctx.users.owner.code });
  assert.equal(incomplete.ok, false);
  assert.equal(incomplete.error.code, 'requirement_tasks_incomplete');
  await ctx.db.update(schema.tasks).set({ status: 'closed' }).where(eq(schema.tasks.id, task.id));
  const delivered = await uc.transitionRequirement({ requirementCode: created.data.requirement_code, to: 'delivered', principalCode: ctx.users.owner.code });
  assert.equal(delivered.ok, true, JSON.stringify(delivered));
  const changeProposed = await uc.transitionRequirement({ requirementCode: created.data.requirement_code, to: 'change_proposed', principalCode: ctx.users.owner.code });
  assert.equal(changeProposed.ok, true, JSON.stringify(changeProposed));

  const detail = await uc.getRequirement(created.data.requirement_code, ctx.users.owner.code);
  assert.equal(detail.ok, true, JSON.stringify(detail));
  assert.equal(detail.data.can_edit, true);
  assert.deepEqual(detail.data.available_transitions, ['clarifying', 'confirmed', 'deprecated']);
});
