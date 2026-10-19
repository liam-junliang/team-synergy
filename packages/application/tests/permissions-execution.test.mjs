import { test } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';
import { schema } from '@team-synergy/persistence';
import { createTaskService, createProjectUseCases, createProjectUseCasesProject, createVerificationUseCases, createDefectUseCases, createPublicCode, createOwnershipUseCases } from '../dist/index.js';
import { assertExecutionWrite } from '../dist/execution-guard.js';
import { createExecutionUseCases } from '../dist/execution-use-cases.js';
import { addTeamMember, insertFeature, insertTask, insertUser, insertProject, insertRequirement, insertRequirementDocument, seedWorkspaceProject, useTestDb } from './test-db.mjs';

const fixture = useTestDb(import.meta.url);
const acceptance = [{ id: 'AC-1', text: 'Works' }];

test('assignment racing account closure cannot leave work assigned to a closed account', async () => {
  const ctx = await setup();
  const ownership = createOwnershipUseCases(ctx.db);
  assert.equal((await ownership.beginClosure(ctx.users.member.code)).ok, true);
  const [assignment, closure] = await Promise.all([
    ctx.tasks.assignTask({ taskCode: ctx.task.code, principalCode: ctx.users.owner.code, assigneePrincipalCode: ctx.users.member.code, baseSnapshot: 0 }),
    ownership.completeClosure(ctx.users.member.code),
  ]);
  const [user] = await ctx.db.select().from(schema.users).where(eq(schema.users.id, ctx.users.member.id));
  const [task] = await ctx.db.select().from(schema.tasks).where(eq(schema.tasks.id, ctx.task.id));
  if (closure.ok) {
    assert.equal(assignment.ok, false);
    assert.equal(user.status, 'disabled');
    assert.equal(task.assignee_principal_id, null);
  } else {
    assert.equal(assignment.ok, true, JSON.stringify(assignment));
    assert.equal(closure.error.code, 'account_closure_blocked');
    assert.equal(user.status, 'active');
    assert.equal(task.assignee_principal_id, user.id);
  }
});

async function setup(policy = 'private') {
  const db = fixture.db;
  const seeded = await seedWorkspaceProject(db, { users: [
    { key: 'owner', account: 'owner', displayName: 'Owner', teamRole: 'owner', projectRole: 'owner' },
    { key: 'admin', account: 'admin-member', displayName: 'Admin', projectRole: 'admin' },
    { key: 'member', account: 'member', displayName: 'Member', projectRole: 'member' },
    { key: 'viewer', account: 'viewer', displayName: 'Viewer', projectRole: 'viewer' },
  ] });
  await db.update(schema.projects).set({ member_policy: policy, owner_principal_id: seeded.users.owner.id }).where(eq(schema.projects.id, seeded.project.id));
  const inherited = await insertUser(db, { account: 'inherited', displayName: 'Inherited' });
  await addTeamMember(db, { teamId: seeded.team.id, principalId: inherited.id, role: 'member', displayName: inherited.display_name });
  const outsider = await insertUser(db, { account: 'outsider', displayName: 'Outsider' });
  const feature = await insertFeature(db, { projectId: seeded.project.id, title: 'Feature' });
  const task = await insertTask(db, { featureId: feature.id, title: 'Task', profile: 'builder', acceptance });
  return { db, ...seeded, inherited, outsider, feature, task, tasks: createTaskService(db), projects: createProjectUseCases(db), defects: createDefectUseCases(db) };
}

function claim(ctx, principal, overrides = {}) {
  return ctx.tasks.claimTask({ taskCode: ctx.task.code, principalCode: principal.code, runCode: createPublicCode(), workspaceCode: createPublicCode(),
    profile: 'builder', baseSnapshot: 1, workspacePath: '/workspace/task', gitBase: 'abc123', ...overrides });
}

async function blockedQuery(db, blockerPid, table, settled) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { rows } = await db.$client.query(`
      select pid from pg_stat_activity
      where $1::integer = any(pg_blocking_pids(pid))
        and query like $2 and query ilike '%for update%'
    `, [blockerPid, `%"${table}"%`]);
    if (rows.length) return rows[0].pid;
    assert.equal(settled(), false, `${table} operation finished before the database lock barrier`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`PostgreSQL did not report the ${table} operation waiting on its lock`);
}

for (const operation of ['assign', 'claim']) {
  test(`${operation} retains project permission locks while waiting for a task and serializes concurrent archive`, async () => {
    const ctx = await setup();
    if (operation === 'claim') assert.equal((await ctx.tasks.assignTask({ taskCode: ctx.task.code,
      principalCode: ctx.users.admin.code, assigneePrincipalCode: ctx.users.member.code, baseSnapshot: 0 })).ok, true);
    const blocker = await ctx.db.$client.connect();
    let taskWrite;
    let archive;
    let blocked = false;
    try {
      await blocker.query('begin');
      blocked = true;
      await blocker.query('select id from tasks where id = $1 for update', [ctx.task.id.toString()]);
      const blockerPid = (await blocker.query('select pg_backend_pid() as pid')).rows[0].pid;
      let taskSettled = false;
      taskWrite = (operation === 'claim' ? claim(ctx, ctx.users.member) : ctx.tasks.assignTask({ taskCode: ctx.task.code,
        principalCode: ctx.users.admin.code, assigneePrincipalCode: ctx.users.member.code, baseSnapshot: 0 }))
        .then(result => { taskSettled = true; return result; });
      const taskPid = await blockedQuery(ctx.db, blockerPid, 'tasks', () => taskSettled);

      let archiveSettled = false;
      archive = createProjectUseCasesProject(ctx.db).updateProjectStatus({ projectCode: ctx.project.code,
        principalCode: ctx.users.owner.code, status: 'archived' }).then(result => { archiveSettled = true; return result; });
      await blockedQuery(ctx.db, taskPid, 'projects', () => archiveSettled);
      assert.equal(archiveSettled, false, 'archive must wait until the authorized task write commits');
      const [before] = await ctx.db.select().from(schema.projects).where(eq(schema.projects.id, ctx.project.id));
      assert.equal(before.status, 'active');

      await blocker.query('commit');
      blocked = false;
      const result = await taskWrite;
      assert.equal(result.ok, true, JSON.stringify(result));
      const archived = await archive;
      assert.equal(archived.ok, true, JSON.stringify(archived));
      assert.equal(archived.data.status, 'archived');
      const [after] = await ctx.db.select().from(schema.tasks).where(eq(schema.tasks.id, ctx.task.id));
      assert.equal(after.status, operation === 'claim' ? 'running' : 'assigned');
      const denied = await claim(ctx, ctx.users.member, { baseSnapshot: after.base_snapshot });
      assert.equal(denied.ok, false);
      assert.equal(denied.error.code, 'project_archived');
    } finally {
      // Release the database barrier even if an assertion fails, before waiting
      // for service transactions; this prevents leaking blocked pool clients.
      if (blocked) await blocker.query('rollback');
      await Promise.allSettled([taskWrite, archive].filter(Boolean));
      blocker.release();
    }
  });
}

test('task and defect reads require caller access; inherited Viewer can read without explicit membership', async () => {
  const ctx = await setup('team_read');
  const report = await ctx.defects.reportDefect({ featureCode: ctx.feature.code, principalCode: ctx.users.member.code, title: 'Bug', severity: 'low', description: 'Details' });
  assert.equal(report.ok, true);
  for (const principalCode of [undefined, ctx.outsider.code]) {
    assert.deepEqual(await ctx.tasks.listTasks({ principalCode }), []);
    assert.equal((await ctx.tasks.getTaskStatus(ctx.task.code, principalCode)).ok, false);
    assert.deepEqual(await createVerificationUseCases(ctx.db).taskHistory(ctx.task.code, principalCode), []);
    assert.deepEqual(await ctx.defects.listDefects({ principalCode }), []);
  }
  assert.equal((await ctx.tasks.listTasks({ principalCode: ctx.inherited.code })).length, 1);
  assert.equal((await ctx.tasks.getTaskStatus(ctx.task.code, ctx.inherited.code)).ok, true);
  assert.equal((await ctx.defects.listDefects({ principalCode: ctx.inherited.code })).length, 1);
});

test('global task lists and defect feature filters exclude inaccessible sibling projects', async () => {
  const ctx = await setup();
  const secret = await insertProject(ctx.db, { teamId: ctx.team.id, name: 'Private sibling' });
  const feature = await insertFeature(ctx.db, { projectId: secret.id, title: 'Secret feature' });
  await insertTask(ctx.db, { featureId: feature.id, title: 'Secret task', profile: 'builder', acceptance });
  await ctx.db.insert(schema.defects).values({ feature_id: feature.id, title: 'Secret defect', severity: 'low', reported_by: ctx.outsider.id, description: 'Secret', status: 'reported' });
  const tasks = await ctx.tasks.listTasks({ principalCode: ctx.users.member.code });
  assert.deepEqual(tasks.map(task => task.task_code), [ctx.task.code]);
  assert.deepEqual(await ctx.defects.listDefects({ featureCode: feature.code, principalCode: ctx.users.member.code }), []);
});

test('Admin assigns inherited collaborators, while explicit Viewer overrides team_write', async () => {
  const ctx = await setup('team_write');
  const denied = await ctx.tasks.assignTask({ taskCode: ctx.task.code, principalCode: ctx.users.admin.code, assigneePrincipalCode: ctx.users.viewer.code, baseSnapshot: 0 });
  assert.equal(denied.ok, false);
  const assigned = await ctx.tasks.assignTask({ taskCode: ctx.task.code, principalCode: ctx.users.admin.code, assigneePrincipalCode: ctx.inherited.code, baseSnapshot: 0 });
  assert.equal(assigned.ok, true, JSON.stringify(assigned));
  assert.equal((await claim(ctx, ctx.inherited)).ok, true);
  assert.equal((await ctx.projects.createTask({ featureCode: ctx.feature.code, principalCode: ctx.users.viewer.code, title: 'Denied', profile: 'builder', source: 'ad-hoc', acceptance })).ok, false);
  assert.equal((await ctx.defects.reportDefect({ featureCode: ctx.feature.code, principalCode: ctx.users.viewer.code, title: 'Denied', severity: 'low', description: 'Denied' })).ok, false);
});

test('Viewer and outsiders cannot claim verifier Runs on submitted tasks', async () => {
  const ctx = await setup('team_write');
  await ctx.db.update(schema.tasks).set({ status: 'submitted' }).where(eq(schema.tasks.id, ctx.task.id));
  for (const user of [ctx.users.viewer, ctx.outsider]) {
    const result = await claim(ctx, user, { profile: 'verifier', baseSnapshot: 0 });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'project_forbidden');
  }
  assert.equal((await claim(ctx, ctx.inherited, { profile: 'verifier', baseSnapshot: 0 })).ok, true);
});

test('legacy epoch-zero Run loses write and lease rights immediately when downgraded to Viewer', async () => {
  const ctx = await setup('team_write');
  assert.equal((await ctx.tasks.assignTask({ taskCode: ctx.task.code, principalCode: ctx.users.owner.code, assigneePrincipalCode: ctx.users.member.code, baseSnapshot: 0 })).ok, true);
  const result = await claim(ctx, ctx.users.member);
  assert.equal(result.ok, true);
  const [run] = await ctx.db.select().from(schema.runs).where(eq(schema.runs.code, result.data.run_code));
  assert.equal(run.execution_epoch, 0);
  await ctx.db.update(schema.members).set({ role: 'viewer' }).where(and(eq(schema.members.project_id, ctx.project.id), eq(schema.members.principal_id, ctx.users.member.id)));
  await assert.rejects(assertExecutionWrite(ctx.db, { taskId: ctx.task.id, runId: run.id, principalId: ctx.users.member.id }), { code: 'project_forbidden' });
  const [device] = await ctx.db.insert(schema.devices).values({ code: createPublicCode(), principal_id: ctx.users.member.id, device_name: 'Device', credential_hash: 'test-credential', created_at: 't0' }).returning();
  await assert.rejects(createExecutionUseCases(ctx.db).lease(run.code, { principalId: ctx.users.member.id, deviceId: device.id }), { code: 'project_forbidden' });
  const submitted = await ctx.tasks.submitTask({ taskCode: ctx.task.code, runCode: run.code, principalCode: ctx.users.member.code, baseSnapshot: 2,
    artifact: { kind: 'code', uri: 'git:abc', contentHash: 'abc' }, evidence: { type: 'self_test', result: 'pass', acceptanceRefs: ['AC-1'] } });
  assert.equal(submitted.ok, false);
  assert.equal(submitted.error.code, 'project_forbidden');
});

test('inherited execution loses write rights immediately after team membership is revoked', async () => {
  const ctx = await setup('team_write');
  assert.equal((await ctx.tasks.assignTask({ taskCode: ctx.task.code, principalCode: ctx.users.owner.code, assigneePrincipalCode: ctx.inherited.code, baseSnapshot: 0 })).ok, true);
  const result = await claim(ctx, ctx.inherited);
  assert.equal(result.ok, true);
  const [run] = await ctx.db.select().from(schema.runs).where(eq(schema.runs.code, result.data.run_code));
  await ctx.db.delete(schema.teamMembers).where(and(eq(schema.teamMembers.team_id, ctx.team.id), eq(schema.teamMembers.principal_id, ctx.inherited.id)));
  await assert.rejects(assertExecutionWrite(ctx.db, { taskId: ctx.task.id, runId: run.id, principalId: ctx.inherited.id }), { code: 'project_forbidden' });
});

test('archived projects retain task reads but reject task, feature and defect writes', async () => {
  const ctx = await setup();
  await ctx.db.update(schema.projects).set({ status: 'archived' }).where(eq(schema.projects.id, ctx.project.id));
  assert.equal((await ctx.tasks.getTaskStatus(ctx.task.code, ctx.users.viewer.code)).ok, true);
  assert.equal((await ctx.projects.createFeature({ projectCode: ctx.project.code, principalCode: ctx.users.admin.code, title: 'Blocked' })).error.code, 'project_archived');
  assert.equal((await ctx.tasks.assignTask({ taskCode: ctx.task.code, principalCode: ctx.users.admin.code, assigneePrincipalCode: ctx.users.member.code, baseSnapshot: 0 })).error.code, 'project_archived');
  assert.equal((await ctx.defects.reportDefect({ featureCode: ctx.feature.code, principalCode: ctx.users.member.code, title: 'Blocked', severity: 'low', description: 'Blocked' })).error.code, 'project_archived');
});

test('module/document-only requirements cannot be bound across projects by tasks or defects', async () => {
  const ctx = await setup();
  const secret = await insertProject(ctx.db, { teamId: ctx.team.id, name: 'Private sibling' });
  const document = await insertRequirementDocument(ctx.db, { projectId: secret.id, moduleKey: 'SECRET', title: 'Secret', ownerPrincipalId: ctx.outsider.id });
  const requirement = await insertRequirement(ctx.db, { documentId: document.id, title: 'Secret requirement', ownerPrincipalId: ctx.outsider.id });
  const task = await ctx.projects.createTask({ featureCode: ctx.feature.code, principalCode: ctx.users.admin.code, title: 'Invalid link', profile: 'builder', source: 'requirement', requirementCode: requirement.code, acceptance });
  assert.equal(task.ok, false);
  assert.equal(task.error.code, 'requirement_cross_project');
  const defect = await ctx.defects.reportDefect({ featureCode: ctx.feature.code, principalCode: ctx.users.member.code, title: 'Invalid link', severity: 'low', description: 'Invalid', relatedRequirementCode: requirement.code });
  assert.equal(defect.ok, false);
  assert.equal(defect.error.code, 'requirement_cross_project');
});
