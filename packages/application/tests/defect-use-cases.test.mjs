import { test } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';
import { schema } from '@team-synergy/persistence';
import { createDefectUseCases, createProjectUseCases } from '../dist/index.js';
import { insertFeature, seedWorkspaceProject, useTestDb } from './test-db.mjs';

const fixture = useTestDb(import.meta.url);

async function seededDb() {
  const db = fixture.db;
  const seeded = await seedWorkspaceProject(db, {
    teamLegacyCode: 'TEAM-DEFECT',
    teamName: 'Defect Team',
    projectLegacyCode: 'PROJECT-A',
    projectName: 'acp',
    users: [
      { key: 'chen', legacyCode: 'user-chen', account: 'chen', displayName: 'chen', teamRole: 'owner', projectRole: 'owner' },
      { key: 'wang', legacyCode: 'user-wang', account: 'wang', displayName: 'wang', teamRole: 'member', projectRole: 'member' },
    ],
  });
  const feature = await insertFeature(db, { legacyCode: 'FEATURE-1', projectId: seeded.project.id, title: 'f', status: 'active' });
  return { db, ...seeded, feature };
}

test('Defect 闭环：上报（任何成员）→ 分诊（Owner）→ 绑定缺陷修复任务 → 回归 → 关闭', async () => {
  const ctx = await seededDb();
  const dc = createDefectUseCases(ctx.db);
  const uc = createProjectUseCases(ctx.db);

  const reported = await dc.reportDefect({
    featureCode: ctx.feature.code,
    title: '登录 500',
    severity: 'high',
    description: '特定字符密码触发 500',
    foundIn: 'v0.1',
    principalCode: ctx.users.wang.code,
  });
  assert.equal(reported.ok, true, JSON.stringify(reported));
  assert.equal(reported.data.status, 'reported');

  const bad = await dc.reportDefect({
    featureCode: ctx.feature.code,
    title: 'x',
    severity: 'catastrophic',
    description: 'x',
    principalCode: ctx.users.wang.code,
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'invalid_severity');

  const triageByMember = await dc.transitionDefect({ defectCode: reported.data.defect_code, to: 'triaged', principalCode: ctx.users.wang.code });
  assert.equal(triageByMember.ok, false);
  assert.equal(triageByMember.error.code, 'defect_forbidden');
  const triaged = await dc.transitionDefect({ defectCode: reported.data.defect_code, to: 'triaged', principalCode: ctx.users.chen.code });
  assert.equal(triaged.ok, true, JSON.stringify(triaged));

  const skip = await dc.transitionDefect({ defectCode: reported.data.defect_code, to: 'closed', principalCode: ctx.users.chen.code });
  assert.equal(skip.ok, false);
  assert.equal(skip.error.code, 'defect_transition_invalid');

  const noTask = await dc.transitionDefect({ defectCode: reported.data.defect_code, to: 'fixing', principalCode: ctx.users.wang.code });
  assert.equal(noTask.ok, false);
  assert.equal(noTask.error.code, 'fix_task_required');
  const unboundTask = await uc.createTask({
    featureCode: ctx.feature.code,
    title: '没有绑定缺陷的修复任务',
    profile: 'builder',
    source: 'defect-fix',
    acceptance: [{ id: 'AC-1', text: '复现用例通过' }],
    principalCode: ctx.users.chen.code,
  });
  assert.equal(unboundTask.ok, false);
  assert.equal(unboundTask.error.code, 'defect_required');
  const createdTask = await uc.createTask({
    featureCode: ctx.feature.code,
    title: '修复登录 500',
    profile: 'builder',
    source: 'defect-fix',
    defectCode: reported.data.defect_code,
    acceptance: [{ id: 'AC-1', text: '复现用例通过' }],
    principalCode: ctx.users.chen.code,
  });
  assert.equal(createdTask.ok, true, JSON.stringify(createdTask));
  const fixing = await dc.transitionDefect({
    defectCode: reported.data.defect_code,
    to: 'fixing',
    principalCode: ctx.users.wang.code,
    fixTaskCode: createdTask.data.task_code,
  });
  assert.equal(fixing.ok, true, JSON.stringify(fixing));

  const prematureRetest = await dc.transitionDefect({ defectCode: reported.data.defect_code, to: 'retest', principalCode: ctx.users.wang.code });
  assert.equal(prematureRetest.ok, false);
  assert.equal(prematureRetest.error.code, 'fix_task_not_completed');
  await ctx.db.update(schema.tasks).set({ status: 'verified' }).where(eq(schema.tasks.code, createdTask.data.task_code));
  const retest = await dc.transitionDefect({ defectCode: reported.data.defect_code, to: 'retest', principalCode: ctx.users.wang.code });
  assert.equal(retest.ok, true);
  const closed = await dc.transitionDefect({ defectCode: reported.data.defect_code, to: 'closed', principalCode: ctx.users.chen.code });
  assert.equal(closed.ok, true);

  const list = await dc.listDefects({ status: 'closed', principalCode: ctx.users.wang.code });
  assert.equal(list.length, 1);
  assert.equal(list[0].defect_code, reported.data.defect_code);
  assert.equal(list[0].description, '特定字符密码触发 500');
  assert.ok(list[0].reported_at);
  assert.equal(list[0].fix_tasks[0].task_code, createdTask.data.task_code);
  assert.equal(list[0].fix_tasks[0].status, 'verified');
  const [stored] = await ctx.db.select().from(schema.defects).where(eq(schema.defects.code, reported.data.defect_code)).limit(1);
  const [storedTask] = await ctx.db.select().from(schema.tasks).where(eq(schema.tasks.code, createdTask.data.task_code)).limit(1);
  assert.equal(storedTask.defect_id, stored.id);
  const history = await ctx.db.select().from(schema.auditEvents).where(and(
    eq(schema.auditEvents.entity_type, 'defect'),
    eq(schema.auditEvents.entity_id, stored.id),
  ));
  const actions = history.map((entry) => entry.action);
  for (const action of ['defect.reported', 'defect.triaged', 'defect.fixing', 'defect.retest', 'defect.closed']) {
    assert.ok(actions.includes(action), `审计应含 ${action}：${actions.join(',')}`);
  }
});

test('Defect 拒绝路径：rejected 为终态（rejected 不能再流转）', async () => {
  const ctx = await seededDb();
  const dc = createDefectUseCases(ctx.db);
  const reported = await dc.reportDefect({
    featureCode: ctx.feature.code,
    title: '重复',
    severity: 'low',
    description: '重复缺陷',
    principalCode: ctx.users.wang.code,
  });
  assert.equal(reported.ok, true, JSON.stringify(reported));
  const rejected = await dc.transitionDefect({ defectCode: reported.data.defect_code, to: 'rejected', principalCode: ctx.users.chen.code });
  assert.equal(rejected.ok, true, JSON.stringify(rejected));
  const again = await dc.transitionDefect({ defectCode: reported.data.defect_code, to: 'triaged', principalCode: ctx.users.chen.code });
  assert.equal(again.ok, false);
  assert.equal(again.error.code, 'defect_transition_invalid');
});
