import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { schema } from '@team-synergy/persistence';
import { createTaskService } from '../dist/index.js';
import {
  addProjectMember,
  insertFeature,
  insertTask,
  seedWorkspaceProject,
  useTestDb,
} from './test-db.mjs';

const fixture = useTestDb(import.meta.url);

async function seededDb() {
  const db = fixture.db;
  const seeded = await seedWorkspaceProject(db, {
    teamLegacyCode: 'TEAM-TASKS',
    teamName: 'Task Team',
    projectLegacyCode: 'PROJECT-A',
    projectName: 'acp',
    users: [
      { key: 'chen', legacyCode: 'user-chen', account: 'chen', displayName: 'chen', teamRole: 'owner', projectRole: 'owner' },
      { key: 'wang', legacyCode: 'user-wang', account: 'wang', displayName: 'wang', teamRole: 'member', projectRole: 'member' },
    ],
  });
  seeded.users.li = await (async () => {
    const user = await db.insert(schema.users).values({
      legacy_code: 'user-li',
      account: 'li',
      display_name: 'li',
      status: 'active',
      created_at: 't0',
    }).returning().then((rows) => rows[0]);
    await addProjectMember(db, {
      principalId: user.id,
      projectId: seeded.project.id,
      role: 'member',
      displayName: user.display_name,
    });
    return user;
  })();
  const feature = await insertFeature(db, { legacyCode: 'FEATURE-12', projectId: seeded.project.id, title: '用户登录' });

  const mkTask = async (legacyCode, extra = {}) => insertTask(db, {
    legacyCode,
    featureId: feature.id,
    title: `任务 ${legacyCode}`,
    profile: 'builder',
    status: 'draft',
    acceptance: [{ id: 'AC-1', text: '验收标准' }, { id: 'AC-2', text: '第二条' }],
    baseSnapshot: 0,
    createdAt: 't0',
    ...extra,
  });

  const tasks = {
    task301: await mkTask('TASK-301'),
    task302: await mkTask('TASK-302', { profile: 'verifier' }),
    task303: await mkTask('TASK-303', { status: 'closed', assigneePrincipalId: seeded.users.wang.id }),
    task304: await mkTask('TASK-304', { status: 'running', assigneePrincipalId: seeded.users.wang.id }),
    task305: await mkTask('TASK-305'),
    task306: await mkTask('TASK-306'),
  };
  await db.insert(schema.taskDependencies).values([
    { task_id: tasks.task305.id, depends_on_task_id: tasks.task303.id },
    { task_id: tasks.task305.id, depends_on_task_id: tasks.task304.id },
  ]);
  return { db, ...seeded, feature, tasks };
}

async function assignAndClaim(svc, ctx, task = ctx.tasks.task301, principal = ctx.users.chen, overrides = {}) {
  const assigned = await svc.assignTask({
    taskCode: task.code,
    assigneePrincipalCode: principal.code,
    principalCode: ctx.users.chen.code,
    baseSnapshot: 0,
  });
  assert.equal(assigned.ok, true, `assign 应成功：${JSON.stringify(assigned)}`);
  const claimed = await svc.claimTask({
    taskCode: task.code,
    principalCode: principal.code,
    profile: 'builder',
    baseSnapshot: assigned.data.base_snapshot,
    workspacePath: `/ws/runs/${task.code}`,
    gitBase: 'abc123',
    runCode: `00000000000000000${String(task.id).padStart(3, '0')}`.slice(-20),
    workspaceCode: `11111111111111111${String(task.id).padStart(3, '0')}`.slice(-20),
    ...overrides,
  });
  assert.equal(claimed.ok, true, `claim 应成功：${JSON.stringify(claimed)}`);
  return { assigned, claimed };
}

test('assign：非 Owner 分派被拒绝（assign_forbidden）', async () => {
  const ctx = await seededDb();
  const svc = createTaskService(ctx.db);
  const r = await svc.assignTask({
    taskCode: ctx.tasks.task301.code,
    assigneePrincipalCode: ctx.users.wang.code,
    principalCode: ctx.users.wang.code,
    baseSnapshot: 0,
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'assign_forbidden');
});

test('assign：被分派人不是成员被拒绝（assignee_not_member）', async () => {
  const ctx = await seededDb();
  const svc = createTaskService(ctx.db);
  const r = await svc.assignTask({
    taskCode: ctx.tasks.task301.code,
    assigneePrincipalCode: '00000000000000000000',
    principalCode: ctx.users.chen.code,
    baseSnapshot: 0,
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'user_not_found');
});

test('assign 成功：assigned + 审计 + 快照推进（ready → assigned 由分派负责）', async () => {
  const ctx = await seededDb();
  const svc = createTaskService(ctx.db);
  const r = await svc.assignTask({
    taskCode: ctx.tasks.task301.code,
    assigneePrincipalCode: ctx.users.wang.code,
    principalCode: ctx.users.chen.code,
    baseSnapshot: 0,
  });
  assert.equal(r.ok, true);
  assert.equal(r.data.status, 'assigned');
  assert.equal(r.data.base_snapshot, 1);
  const [task] = await ctx.db.select().from(schema.tasks).where(eq(schema.tasks.id, ctx.tasks.task301.id)).limit(1);
  assert.equal(task.status, 'assigned');
  assert.equal(task.assignee_principal_id, ctx.users.wang.id);
  const audits = await ctx.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, 'task.assigned'));
  assert.equal(audits.length, 1);
});

test('claim：未分派（draft）拒绝（claim_not_assigned）——分派与领取分离', async () => {
  const ctx = await seededDb();
  const svc = createTaskService(ctx.db);
  const r = await svc.claimTask({
    taskCode: ctx.tasks.task301.code,
    principalCode: ctx.users.chen.code,
    profile: 'builder',
    baseSnapshot: 0,
    workspacePath: '/ws',
    gitBase: 'b',
    runCode: '22222222222222222222',
    workspaceCode: '33333333333333333333',
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'claim_not_assigned');
});

test('claim：非 Assignee 被拒绝（claim_assignee_mismatch）', async () => {
  const ctx = await seededDb();
  const svc = createTaskService(ctx.db);
  await svc.assignTask({ taskCode: ctx.tasks.task301.code, assigneePrincipalCode: ctx.users.wang.code, principalCode: ctx.users.chen.code, baseSnapshot: 0 });
  const r = await svc.claimTask({
    taskCode: ctx.tasks.task301.code,
    principalCode: ctx.users.li.code,
    profile: 'builder',
    baseSnapshot: 1,
    workspacePath: '/ws',
    gitBase: 'b',
    runCode: '44444444444444444444',
    workspaceCode: '55555555555555555555',
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'claim_assignee_mismatch');
});

test('claim：依赖未全部 closed 被拒绝（claim_dependencies_unsatisfied）', async () => {
  const ctx = await seededDb();
  const svc = createTaskService(ctx.db);
  await svc.assignTask({ taskCode: ctx.tasks.task305.code, assigneePrincipalCode: ctx.users.chen.code, principalCode: ctx.users.chen.code, baseSnapshot: 0 });
  const r = await svc.claimTask({
    taskCode: ctx.tasks.task305.code,
    principalCode: ctx.users.chen.code,
    profile: 'builder',
    baseSnapshot: 1,
    workspacePath: '/ws',
    gitBase: 'b',
    runCode: '66666666666666666666',
    workspaceCode: '77777777777777777777',
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'claim_dependencies_unsatisfied');
});

test('claim：Profile 不匹配被拒绝（claim_profile_mismatch）', async () => {
  const ctx = await seededDb();
  const svc = createTaskService(ctx.db);
  await svc.assignTask({ taskCode: ctx.tasks.task302.code, assigneePrincipalCode: ctx.users.chen.code, principalCode: ctx.users.chen.code, baseSnapshot: 0 });
  const r = await svc.claimTask({
    taskCode: ctx.tasks.task302.code,
    principalCode: ctx.users.chen.code,
    profile: 'builder',
    baseSnapshot: 1,
    workspacePath: '/ws',
    gitBase: 'b',
    runCode: '88888888888888888888',
    workspaceCode: '99999999999999999999',
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'claim_profile_mismatch');
});

test('claim 成功：assigned → running + Run 绑定 principal + 审计 + 快照推进', async () => {
  const ctx = await seededDb();
  const svc = createTaskService(ctx.db);
  const { assigned, claimed } = await assignAndClaim(svc, ctx);
  assert.equal(claimed.data.status, 'running');
  const [task] = await ctx.db.select().from(schema.tasks).where(eq(schema.tasks.id, ctx.tasks.task301.id)).limit(1);
  assert.equal(task.status, 'running');
  assert.equal(task.base_snapshot, assigned.data.base_snapshot + 1);
  const [run] = await ctx.db.select().from(schema.runs).where(eq(schema.runs.code, claimed.data.run_code)).limit(1);
  assert.equal(run.principal_id, ctx.users.chen.id);
  assert.equal(run.status, 'active');
  const [workspace] = await ctx.db.select().from(schema.workspaces).where(eq(schema.workspaces.code, claimed.data.workspace_code)).limit(1);
  assert.equal(run.workspace_id, workspace.id);
  const audits = await ctx.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, 'task.claimed'));
  assert.equal(audits.length, 1);
});

test('claim：同一任务双领取被拒绝（claim_run_conflict）', async () => {
  const ctx = await seededDb();
  const svc = createTaskService(ctx.db);
  const { assigned } = await assignAndClaim(svc, ctx);
  const second = await svc.claimTask({
    taskCode: ctx.tasks.task301.code,
    principalCode: ctx.users.chen.code,
    profile: 'builder',
    baseSnapshot: assigned.data.base_snapshot,
    workspacePath: '/ws2',
    gitBase: 'b',
    runCode: '12121212121212121212',
    workspaceCode: '34343434343434343434',
  });
  assert.equal(second.ok, false);
  assert.equal(second.error.code, 'claim_run_conflict');
});

test('claim：base_snapshot 不匹配被拒绝（乐观并发）', async () => {
  const ctx = await seededDb();
  const svc = createTaskService(ctx.db);
  await svc.assignTask({ taskCode: ctx.tasks.task301.code, assigneePrincipalCode: ctx.users.chen.code, principalCode: ctx.users.chen.code, baseSnapshot: 0 });
  const r = await svc.claimTask({
    taskCode: ctx.tasks.task301.code,
    principalCode: ctx.users.chen.code,
    profile: 'builder',
    baseSnapshot: 99,
    workspacePath: '/ws',
    gitBase: 'b',
    runCode: '56565656565656565656',
    workspaceCode: '78787878787878787878',
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'base_snapshot_mismatch');
});

test('submit：Run 身份冒用被拒绝（submit_identity_mismatch，review 阻断 2）', async () => {
  const ctx = await seededDb();
  const svc = createTaskService(ctx.db);
  const { assigned, claimed } = await assignAndClaim(svc, ctx);
  const r = await svc.submitTask({
    taskCode: ctx.tasks.task301.code,
    runCode: claimed.data.run_code,
    principalCode: ctx.users.wang.code,
    baseSnapshot: assigned.data.base_snapshot + 1,
    artifact: { kind: 'commit', uri: 'git:x', contentHash: 'h' },
    evidence: { type: 'self_test', result: 'pass', acceptanceRefs: ['AC-1'] },
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'submit_identity_mismatch');
});

test('submit：Evidence 非 pass 被拒绝（evidence_not_passing，review 重要项 1）', async () => {
  const ctx = await seededDb();
  const svc = createTaskService(ctx.db);
  const { assigned, claimed } = await assignAndClaim(svc, ctx);
  const r = await svc.submitTask({
    taskCode: ctx.tasks.task301.code,
    runCode: claimed.data.run_code,
    principalCode: ctx.users.chen.code,
    baseSnapshot: assigned.data.base_snapshot + 1,
    artifact: { kind: 'commit', uri: 'git:x', contentHash: 'h' },
    evidence: { type: 'self_test', result: 'fail', acceptanceRefs: ['AC-1'] },
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'evidence_not_passing');
});

test('submit：引用不存在的验收标准被拒绝（acceptance_refs_unknown）', async () => {
  const ctx = await seededDb();
  const svc = createTaskService(ctx.db);
  const { assigned, claimed } = await assignAndClaim(svc, ctx);
  const r = await svc.submitTask({
    taskCode: ctx.tasks.task301.code,
    runCode: claimed.data.run_code,
    principalCode: ctx.users.chen.code,
    baseSnapshot: assigned.data.base_snapshot + 1,
    artifact: { kind: 'commit', uri: 'git:x', contentHash: 'h' },
    evidence: { type: 'self_test', result: 'pass', acceptanceRefs: ['AC-NOPE'] },
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'acceptance_refs_unknown');
});

test('全链路：assign → claim → submit 走用例边界，两段审计 + 快照推进（review 阻断 1/重要 1）', async () => {
  const ctx = await seededDb();
  const svc = createTaskService(ctx.db);
  const { assigned, claimed } = await assignAndClaim(svc, ctx);

  const submitted = await svc.submitTask({
    taskCode: ctx.tasks.task301.code,
    runCode: claimed.data.run_code,
    principalCode: ctx.users.chen.code,
    baseSnapshot: assigned.data.base_snapshot + 1,
    artifact: { kind: 'commit', uri: 'git:a92f81c', contentHash: 'h1' },
    evidence: {
      type: 'self_test',
      result: 'pass',
      acceptanceRefs: ['AC-1', 'AC-2'],
      command: 'pnpm test',
      summary: '全部通过',
    },
  });
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  assert.equal(submitted.data.status, 'submitted');
  assert.equal(submitted.data.base_snapshot, assigned.data.base_snapshot + 2);

  const [task] = await ctx.db.select().from(schema.tasks).where(eq(schema.tasks.id, ctx.tasks.task301.id)).limit(1);
  assert.equal(task.status, 'submitted');
  const [run] = await ctx.db.select().from(schema.runs).where(eq(schema.runs.code, claimed.data.run_code)).limit(1);
  assert.equal(run.status, 'completed');
  const [artifact] = await ctx.db.select().from(schema.artifacts).where(eq(schema.artifacts.task_id, ctx.tasks.task301.id)).limit(1);
  assert.equal(artifact.published, true);
  const [evidence] = await ctx.db.select().from(schema.evidences).where(eq(schema.evidences.task_id, ctx.tasks.task301.id)).limit(1);
  assert.deepEqual(JSON.parse(evidence.acceptance_refs), ['AC-1', 'AC-2']);

  const selfTestedAudits = await ctx.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, 'task.self_tested'));
  const submittedAudits = await ctx.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, 'task.submitted'));
  assert.equal(selfTestedAudits.length, 1);
  assert.equal(selfTestedAudits[0].from_state, 'running');
  assert.equal(selfTestedAudits[0].to_state, 'self_tested');
  assert.equal(submittedAudits.length, 1);
  assert.equal(submittedAudits[0].from_state, 'self_tested');
  assert.equal(submittedAudits[0].to_state, 'submitted');
});

test('status：派生视图 working（有 active Run）', async () => {
  const ctx = await seededDb();
  const svc = createTaskService(ctx.db);
  await assignAndClaim(svc, ctx);
  const r = await svc.getTaskStatus(ctx.tasks.task301.code, ctx.users.chen.code);
  assert.equal(r.ok, true);
  assert.equal(r.data.feature_name, '用户登录');
  assert.equal(r.data.module_code, null);
  assert.equal(r.data.module_name, null);
  assert.equal(r.data.milestone_code, null);
  assert.equal(r.data.milestone_name, null);
  assert.equal(r.data.phase_code, null);
  assert.equal(r.data.phase_name, null);
  assert.equal(r.data.derived_view, 'working');
  assert.equal(r.data.runs[0].principal_code, ctx.users.chen.code);
});

test('status：返回 Feature/模块/里程碑/阶段的公开 code 与业务名称', async () => {
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
  const [phase] = await ctx.db.insert(schema.projectPhases).values({
    project_id: ctx.project.id,
    name: 'Foundation',
    goal: 'Lay project groundwork',
    sort_order: 1,
    start_date: null,
    end_date: null,
    status: 'active',
    created_at: 't0',
    updated_at: 't0',
  }).returning();
  const [milestone] = await ctx.db.insert(schema.projectMilestones).values({
    project_id: ctx.project.id,
    phase_id: phase.id,
    name: 'Password Gate',
    goal: 'Task pack exposes structure names',
    target_date: null,
    sort_order: 1,
    status: 'active',
    owner_principal_id: null,
    created_at: 't0',
    updated_at: 't0',
  }).returning();
  await ctx.db.update(schema.features).set({
    module_id: module.id,
    milestone_id: milestone.id,
  }).where(eq(schema.features.id, ctx.feature.id));

  const svc = createTaskService(ctx.db);
  const r = await svc.getTaskStatus(ctx.tasks.task301.code, ctx.users.chen.code);
  assert.equal(r.ok, true);
  assert.equal(r.data.feature_code, ctx.feature.code);
  assert.equal(r.data.feature_name, '用户登录');
  assert.equal(r.data.module_code, module.code);
  assert.equal(r.data.module_name, 'AUTH');
  assert.equal(r.data.milestone_code, milestone.code);
  assert.equal(r.data.milestone_name, 'Password Gate');
  assert.equal(r.data.phase_code, phase.code);
  assert.equal(r.data.phase_name, 'Foundation');
  assert.equal(Object.hasOwn(r.data, 'feature_id'), false);
  assert.equal(Object.hasOwn(r.data, 'module_id'), false);
  assert.equal(Object.hasOwn(r.data, 'milestone_id'), false);
  assert.equal(Object.hasOwn(r.data, 'phase_id'), false);
});

test('list：--assigned-to 与 --status 过滤', async () => {
  const ctx = await seededDb();
  await ctx.db.insert(schema.auditEvents).values({
    timestamp: '2026-08-17T12:30:00.000Z',
    principal_id: ctx.users.wang.id,
    action: 'task.closed',
    entity_type: 'task',
    entity_id: ctx.tasks.task303.id,
    base_snapshot: 0,
    from_state: 'verified',
    to_state: 'closed',
  });
  const svc = createTaskService(ctx.db);
  const mine = await svc.listTasks({ assignedTo: ctx.users.wang.code, principalCode: ctx.users.wang.code });
  assert.ok(mine.length >= 2);
  assert.ok(mine.every((task) => task.assignee_principal_code === ctx.users.wang.code));
  const closed = await svc.listTasks({ status: 'closed', principalCode: ctx.users.wang.code });
  assert.deepEqual(closed.map((task) => task.task_code), [ctx.tasks.task303.code]);
  assert.equal(closed[0].created_at, 't0');
  assert.equal(closed[0].completed_at, '2026-08-17T12:30:00.000Z');
});

test('cancel：Owner 可取消未执行任务并记录审计，执行中任务保持锁定', async () => {
  const ctx = await seededDb();
  const svc = createTaskService(ctx.db);
  const cancelled = await svc.cancelTask({
    taskCode: ctx.tasks.task301.code,
    principalCode: ctx.users.chen.code,
    baseSnapshot: 0,
    reason: '需求不再进入本期',
  });
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.data.status, 'cancelled');
  assert.equal(cancelled.data.base_snapshot, 1);
  const [audit] = await ctx.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, 'task.cancelled'));
  assert.equal(audit.entity_id, ctx.tasks.task301.id);
  assert.match(audit.payload, /需求不再进入本期/);

  const locked = await svc.cancelTask({
    taskCode: ctx.tasks.task304.code,
    principalCode: ctx.users.chen.code,
    baseSnapshot: 0,
  });
  assert.equal(locked.ok, false);
  assert.equal(locked.error.code, 'task_cancel_locked');
});

test('cancel：普通成员不能取消任务', async () => {
  const ctx = await seededDb();
  const svc = createTaskService(ctx.db);
  const result = await svc.cancelTask({
    taskCode: ctx.tasks.task301.code,
    principalCode: ctx.users.wang.code,
    baseSnapshot: 0,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'task_cancel_forbidden');
});
