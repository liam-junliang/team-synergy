import { test } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';
import { schema } from '@team-synergy/persistence';
import { createMemberUseCases, createProjectUseCasesProject, createProjectPolicyUseCases, createTeamUseCases, resolveProjectAccess } from '../dist/index.js';
import { useTestDb, insertUser, insertTeam, insertProject, addTeamMember, addProjectMember, insertFeature, insertTask } from './test-db.mjs';

const fixture = useTestDb(import.meta.url);

async function setup() {
  const db = fixture.db;
  const users = {};
  for (const key of ['owner', 'teamadmin', 'inherited', 'viewer', 'external', 'outsider', 'disabled']) users[key] = await insertUser(db, { account: key, displayName: key, status: key === 'disabled' ? 'disabled' : 'active' });
  const team = await insertTeam(db, { name: 'Policy team' });
  await db.update(schema.teams).set({ owner_principal_id: users.owner.id, created_by: users.owner.id }).where(eq(schema.teams.id, team.id));
  for (const key of ['owner', 'teamadmin', 'inherited', 'viewer', 'disabled']) await addTeamMember(db, { teamId: team.id, principalId: users[key].id, displayName: key, role: ['owner', 'teamadmin'].includes(key) ? 'admin' : 'member' });
  const project = await insertProject(db, { teamId: team.id, name: 'Policy project' });
  await db.update(schema.projects).set({ owner_principal_id: users.owner.id, created_by: users.owner.id }).where(eq(schema.projects.id, project.id));
  for (const [key, role] of [['owner', 'admin'], ['viewer', 'viewer'], ['external', 'admin'], ['disabled', 'member']]) await addProjectMember(db, { projectId: project.id, principalId: users[key].id, displayName: key, role });
  return { db, users, team, project, projects: createProjectUseCasesProject(db), members: createMemberUseCases(db) };
}

for (const policy of ['private', 'team_read', 'team_write']) {
  test(`${policy}: effective access follows owner, explicit grant, team default, then no access`, async () => {
    const ctx = await setup();
    await ctx.db.update(schema.projects).set({ member_policy: policy }).where(eq(schema.projects.id, ctx.project.id));
    const inheritedRole = policy === 'private' ? null : policy === 'team_read' ? 'viewer' : 'member';
    const expected = { owner: 'owner', teamadmin: inheritedRole, inherited: inheritedRole, viewer: 'viewer', external: 'admin', outsider: null, disabled: null };
    for (const [key, role] of Object.entries(expected)) {
      const access = await resolveProjectAccess(ctx.db, ctx.project.id, ctx.users[key].id);
      assert.equal(access?.role ?? null, role, `${key}: effective role`);
      const list = await ctx.projects.listProjects(ctx.users[key].code);
      assert.equal(list.length, role ? 1 : 0, `${key}: list visibility`);
      const detail = await ctx.projects.getProject(ctx.project.code, ctx.users[key].code);
      assert.equal(detail.ok, role !== null, `${key}: detail visibility`);
      if (role) {
        assert.equal(detail.data.effective_role, role);
        assert.equal(detail.data.is_external, key === 'external');
        assert.equal(detail.data.capabilities.write, role !== 'viewer');
        assert.equal(detail.data.capabilities.manage, role === 'owner' || role === 'admin');
        assert.equal(detail.data.members_count, policy === 'private' ? 3 : 5);
      }
    }
    const roster = await ctx.members.listMembers(ctx.project.code, ctx.users.viewer.code);
    assert.equal(roster.length, policy === 'private' ? 3 : 5);
    assert.equal(roster.find(member => member.user_code === ctx.users.viewer.code).access_source, 'explicit');
    assert.equal(roster.some(member => member.user_code === ctx.users.disabled.code), false);
    if (inheritedRole) assert.equal(roster.find(member => member.user_code === ctx.users.teamadmin.code).access_source, 'team');
  });
}

test('team manager may create a project with a visible team_read default and becomes its sole owner', async () => {
  const ctx = await setup();
  const created = await ctx.projects.createProject({ teamCode: ctx.team.code, name: 'Created by team admin', principalCode: ctx.users.teamadmin.code });
  assert.equal(created.ok, true, JSON.stringify(created));
  const [project] = await ctx.db.select().from(schema.projects).where(eq(schema.projects.code, created.data.project_code));
  assert.equal(project.member_policy, 'team_read');
  assert.equal(project.owner_principal_id, ctx.users.teamadmin.id);
  assert.equal(project.created_by, ctx.users.teamadmin.id);
  assert.equal((await ctx.projects.getProject(project.code, ctx.users.owner.code)).data.role, 'viewer');
  assert.equal((await ctx.projects.getProject(project.code, ctx.users.external.code)).ok, false);
  const rejected = await ctx.projects.createProject({ teamCode: ctx.team.code, name: 'Not allowed', principalCode: ctx.users.inherited.code });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, 'project_create_forbidden');
});

test('sorting inherited projects stores personal order without creating permission overrides', async () => {
  const ctx = await setup();
  await ctx.db.update(schema.projects).set({ member_policy: 'team_read' }).where(eq(schema.projects.id, ctx.project.id));
  const sibling = await insertProject(ctx.db, { teamId: ctx.team.id, name: 'Sibling' });
  await ctx.db.update(schema.projects).set({ member_policy: 'team_read' }).where(eq(schema.projects.id, sibling.id));
  const result = await ctx.projects.reorderProjects({ teamCode: ctx.team.code, projectCodes: [sibling.code, ctx.project.code], principalCode: ctx.users.inherited.code });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual((await ctx.projects.listProjects(ctx.users.inherited.code)).map(project => project.project_code), [sibling.code, ctx.project.code]);
  const explicit = await ctx.db.select().from(schema.members).where(eq(schema.members.principal_id, ctx.users.inherited.id));
  assert.equal(explicit.length, 0);
  await ctx.db.update(schema.projects).set({ member_policy: 'private' }).where(eq(schema.projects.id, ctx.project.id));
  assert.deepEqual((await ctx.projects.listProjects(ctx.users.inherited.code)).map(project => project.project_code), [sibling.code]);
});

test('leaving a team immediately removes inherited access while unrelated external grants remain', async () => {
  const ctx = await setup();
  await ctx.db.update(schema.projects).set({ member_policy: 'team_write' }).where(eq(schema.projects.id, ctx.project.id));
  const removed = await createTeamUseCases(ctx.db).removeMember({ teamCode: ctx.team.code, userCode: ctx.users.inherited.code, actorPrincipalCode: ctx.users.owner.code });
  assert.equal(removed.ok, true, JSON.stringify(removed));
  assert.equal(await resolveProjectAccess(ctx.db, ctx.project.id, ctx.users.inherited.id), null);
  assert.equal((await resolveProjectAccess(ctx.db, ctx.project.id, ctx.users.external.id)).role, 'admin');
  assert.equal((await ctx.db.select().from(schema.members).where(and(eq(schema.members.project_id, ctx.project.id), eq(schema.members.principal_id, ctx.users.external.id)))).length, 1);
});

test('policy preview is owner-only and counts inherited changes without overriding explicit exceptions', async () => {
  const ctx = await setup();
  const policies = createProjectPolicyUseCases(ctx.db);
  for (const key of ['teamadmin', 'inherited', 'viewer', 'external', 'outsider']) {
    const preview = await policies.previewPolicy(ctx.project.code, ctx.users[key].code, 'team_write');
    assert.equal(preview.ok, false, key);
    assert.equal(preview.error.code, 'project_forbidden');
    assert.equal((await policies.updatePolicy({ projectCode: ctx.project.code, principalCode: ctx.users[key].code, memberPolicy: 'team_write' })).ok, false, key);
  }
  const preview = await policies.previewPolicy(ctx.project.code, ctx.users.owner.code, 'team_write');
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.equal(preview.data.member_policy, 'private');
  assert.deepEqual(preview.data.impact, { gained_read: 2, gained_write: 2, lost_write: 0, lost_access: 0, explicit_exceptions: 3 });
  assert.deepEqual(new Set(preview.data.changes.map(change => change.user_code)), new Set([ctx.users.teamadmin.code, ctx.users.inherited.code]));
  assert.equal((await ctx.db.select().from(schema.projects).where(eq(schema.projects.id, ctx.project.id)))[0].member_policy, 'private');
});

test('policy changes immediately alter inherited access and leave explicit grants and history intact', async () => {
  const ctx = await setup();
  const policies = createProjectPolicyUseCases(ctx.db);
  const original = await ctx.db.select().from(schema.members).where(eq(schema.members.project_id, ctx.project.id));
  const update = memberPolicy => policies.updatePolicy({ projectCode: ctx.project.code, principalCode: ctx.users.owner.code, memberPolicy });
  assert.equal((await update('team_write')).ok, true);
  assert.equal((await resolveProjectAccess(ctx.db, ctx.project.id, ctx.users.inherited.id)).role, 'member');
  assert.equal((await resolveProjectAccess(ctx.db, ctx.project.id, ctx.users.viewer.id)).role, 'viewer');
  const readPreview = await policies.previewPolicy(ctx.project.code, ctx.users.owner.code, 'team_read');
  assert.deepEqual(readPreview.data.impact, { gained_read: 0, gained_write: 0, lost_write: 2, lost_access: 0, explicit_exceptions: 3 });
  const preview = await policies.previewPolicy(ctx.project.code, ctx.users.owner.code, 'private');
  assert.equal(preview.data.impact.lost_access, 2);
  assert.equal(preview.data.impact.lost_write, 2);
  assert.equal((await update('private')).ok, true);
  assert.equal(await resolveProjectAccess(ctx.db, ctx.project.id, ctx.users.inherited.id), null);
  assert.deepEqual(await ctx.db.select().from(schema.members).where(eq(schema.members.project_id, ctx.project.id)), original);
  const audits = await ctx.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, 'project.access_policy_changed'));
  assert.deepEqual(audits.map(event => JSON.parse(event.payload)), [{ from: 'private', to: 'team_write' }, { from: 'team_write', to: 'private' }]);
});

for (const nextPolicy of ['team_read', 'private']) {
  test(`team_write to ${nextPolicy} requires inherited writers to hand off unfinished tasks`, async () => {
    const ctx = await setup();
    await ctx.db.update(schema.projects).set({ member_policy: 'team_write' }).where(eq(schema.projects.id, ctx.project.id));
    const feature = await insertFeature(ctx.db, { projectId: ctx.project.id, title: 'In progress' });
    const task = await insertTask(ctx.db, { featureId: feature.id, title: 'Inherited task', profile: 'builder', assigneePrincipalId: ctx.users.inherited.id, acceptance: [] });
    const policies = createProjectPolicyUseCases(ctx.db);
    const update = () => policies.updatePolicy({ projectCode: ctx.project.code, principalCode: ctx.users.owner.code, memberPolicy: nextPolicy });

    const blocked = await update();
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error.code, 'member_has_open_tasks');
    assert.deepEqual(blocked.error.details.open_task_codes, [task.code]);
    assert.deepEqual(blocked.error.details.active_run_codes, []);
    assert.equal((await ctx.db.select().from(schema.projects).where(eq(schema.projects.id, ctx.project.id)))[0].member_policy, 'team_write');
    assert.equal((await ctx.db.select().from(schema.auditEvents)).length, 0);

    await ctx.db.update(schema.tasks).set({ status: 'closed' }).where(eq(schema.tasks.id, task.id));
    const changed = await update();
    assert.equal(changed.ok, true, JSON.stringify(changed));
    assert.equal((await resolveProjectAccess(ctx.db, ctx.project.id, ctx.users.inherited.id))?.role ?? null, nextPolicy === 'private' ? null : 'viewer');
  });

  for (const runStatus of ['active', 'preparing', 'suspended']) {
    test(`team_write to ${nextPolicy} blocks an inherited writer's ${runStatus} run independently of task assignment`, async () => {
      const ctx = await setup();
      await ctx.db.update(schema.projects).set({ member_policy: 'team_write' }).where(eq(schema.projects.id, ctx.project.id));
      const feature = await insertFeature(ctx.db, { projectId: ctx.project.id, title: 'Running work' });
      const task = await insertTask(ctx.db, { featureId: feature.id, title: 'Unassigned closed task', profile: 'builder', status: 'closed', acceptance: [] });
      const [run] = await ctx.db.insert(schema.runs).values({ task_id: task.id, principal_id: ctx.users.inherited.id, profile: 'builder', workspace_id: 1n, status: runStatus, base_snapshot: 0, started_at: 't0' }).returning();
      const policies = createProjectPolicyUseCases(ctx.db);
      const update = () => policies.updatePolicy({ projectCode: ctx.project.code, principalCode: ctx.users.owner.code, memberPolicy: nextPolicy });

      const blocked = await update();
      assert.equal(blocked.ok, false);
      assert.equal(blocked.error.code, 'member_has_open_tasks');
      assert.deepEqual(blocked.error.details.open_task_codes, []);
      assert.deepEqual(blocked.error.details.active_run_codes, [run.code]);
      assert.equal((await ctx.db.select().from(schema.projects).where(eq(schema.projects.id, ctx.project.id)))[0].member_policy, 'team_write');
      assert.equal((await ctx.db.select().from(schema.auditEvents)).length, 0);

      await ctx.db.update(schema.runs).set({ status: 'completed' }).where(eq(schema.runs.id, run.id));
      const changed = await update();
      assert.equal(changed.ok, true, JSON.stringify(changed));
    });
  }

  test(`team_write to ${nextPolicy} preserves owner and explicit writers without requiring unrelated handoffs`, async () => {
    const ctx = await setup();
    await ctx.db.update(schema.projects).set({ member_policy: 'team_write' }).where(eq(schema.projects.id, ctx.project.id));
    await addProjectMember(ctx.db, { projectId: ctx.project.id, principalId: ctx.users.inherited.id, displayName: 'Explicit member', role: 'member' });
    const feature = await insertFeature(ctx.db, { projectId: ctx.project.id, title: 'Explicit work' });
    for (const key of ['owner', 'inherited', 'external']) {
      const task = await insertTask(ctx.db, { featureId: feature.id, title: `${key} task`, profile: 'builder', assigneePrincipalId: ctx.users[key].id, acceptance: [] });
      await ctx.db.insert(schema.runs).values({ task_id: task.id, principal_id: ctx.users[key].id, profile: 'builder', workspace_id: 1n, status: 'active', base_snapshot: 0, started_at: 't0' });
    }
    const policies = createProjectPolicyUseCases(ctx.db);
    const preview = await policies.previewPolicy(ctx.project.code, ctx.users.owner.code, nextPolicy);
    assert.equal(preview.data.impact.lost_write, 1);
    assert.deepEqual(preview.data.changes.map(change => change.user_code), [ctx.users.teamadmin.code]);
    const changed = await policies.updatePolicy({ projectCode: ctx.project.code, principalCode: ctx.users.owner.code, memberPolicy: nextPolicy });
    assert.equal(changed.ok, true, JSON.stringify(changed));
    for (const [key, role] of [['owner', 'owner'], ['inherited', 'member'], ['external', 'admin']]) {
      assert.equal((await resolveProjectAccess(ctx.db, ctx.project.id, ctx.users[key].id)).role, role);
    }
  });
}

test('archived projects retain read access but reject policy, member, and content changes', async () => {
  const ctx = await setup();
  await ctx.db.update(schema.projects).set({ member_policy: 'team_read', status: 'archived' }).where(eq(schema.projects.id, ctx.project.id));
  const policies = createProjectPolicyUseCases(ctx.db);
  const detail = await ctx.projects.getProject(ctx.project.code, ctx.users.inherited.code);
  assert.equal(detail.ok, true);
  assert.equal(detail.data.capabilities.write, false);
  const policy = await policies.updatePolicy({ projectCode: ctx.project.code, principalCode: ctx.users.owner.code, memberPolicy: 'private' });
  assert.equal(policy.error.code, 'project_archived');
  const member = await ctx.members.updateMemberRole({ projectCode: ctx.project.code, actorPrincipalCode: ctx.users.owner.code, userCode: ctx.users.viewer.code, role: 'member' });
  assert.equal(member.error.code, 'project_archived');
  const content = await ctx.projects.updateProject({ projectCode: ctx.project.code, principalCode: ctx.users.owner.code, name: 'Changed' });
  assert.equal(content.error.code, 'project_archived');
  const [project] = await ctx.db.select().from(schema.projects).where(eq(schema.projects.id, ctx.project.id));
  assert.equal(project.member_policy, 'team_read');
  assert.equal(project.name, 'Policy project');
  assert.equal((await ctx.db.select().from(schema.auditEvents)).length, 0);
});
