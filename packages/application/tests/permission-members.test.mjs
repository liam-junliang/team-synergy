import { test } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';
import { schema } from '@team-synergy/persistence';
import { createMemberUseCases, createTeamUseCases } from '../dist/index.js';
import { useTestDb, insertUser, insertTeam, insertProject, addTeamMember, addProjectMember, insertFeature, insertTask } from './test-db.mjs';

const fixture = useTestDb(import.meta.url);

async function setup() {
  const db = fixture.db;
  const users = {};
  for (const key of ['owner', 'admin', 'peer', 'member', 'viewer', 'external', 'stranger']) {
    users[key] = await insertUser(db, { account: key, displayName: key });
  }
  const team = await insertTeam(db, { name: 'Main team' });
  await db.update(schema.teams).set({ owner_principal_id: users.owner.id, created_by: users.owner.id }).where(eq(schema.teams.id, team.id));
  for (const key of ['owner', 'admin', 'peer', 'member', 'viewer']) {
    await addTeamMember(db, { teamId: team.id, principalId: users[key].id, displayName: key, role: ['owner', 'admin', 'peer'].includes(key) ? 'admin' : 'member' });
  }
  const project = await insertProject(db, { teamId: team.id, name: 'Private project' });
  await db.update(schema.projects).set({ owner_principal_id: users.owner.id, created_by: users.owner.id }).where(eq(schema.projects.id, project.id));
  for (const key of ['owner', 'admin', 'peer', 'member', 'viewer', 'external']) {
    await addProjectMember(db, { projectId: project.id, principalId: users[key].id, displayName: key, role: ['owner', 'admin', 'peer'].includes(key) ? 'admin' : key === 'viewer' ? 'viewer' : 'member' });
  }
  return { db, users, team, project, teams: createTeamUseCases(db), members: createMemberUseCases(db) };
}

function command(ctx, actor, user, role) {
  return { teamCode: ctx.team.code, projectCode: ctx.project.code, actorPrincipalCode: ctx.users[actor].code, userCode: ctx.users[user].code, ...(role ? { role } : {}) };
}

test('new team records immutable creator and unique owner while storing an admin membership', async () => {
  const db = fixture.db;
  const creator = await insertUser(db, { account: 'creator', displayName: 'Creator' });
  const teams = createTeamUseCases(db);
  const result = await teams.createTeam({ name: 'New team', principalCode: creator.code });
  assert.equal(result.ok, true, JSON.stringify(result));
  const [team] = await db.select().from(schema.teams).where(eq(schema.teams.code, result.data.team_code));
  assert.equal(team.created_by, creator.id);
  assert.equal(team.owner_principal_id, creator.id);
  const [membership] = await db.select().from(schema.teamMembers).where(eq(schema.teamMembers.team_id, team.id));
  assert.equal(membership.role, 'admin');
  assert.equal((await teams.listMembers(team.code, creator.code)).data[0].role, 'owner');
  await db.update(schema.users).set({ pending_deletion: true }).where(eq(schema.users.id, creator.id));
  assert.equal((await teams.createTeam({ name: 'Blocked', principalCode: creator.code })).error.code, 'account_pending_deletion');
});

test('team and project admins manage ordinary members but cannot change peers, owners, or themselves', async () => {
  const ctx = await setup();
  for (const uc of [ctx.teams, ctx.members]) {
    assert.equal((await uc.updateMemberRole(command(ctx, 'admin', 'peer', 'member'))).error.code.endsWith('forbidden'), true);
    assert.equal((await uc.updateMemberRole(command(ctx, 'admin', 'admin', 'member'))).error.code.endsWith('forbidden'), true);
    assert.equal((await uc.updateMemberRole(command(ctx, 'admin', 'owner', 'member'))).error.code.endsWith('owner_protected'), true);
    assert.equal((await uc.updateMemberRole(command(ctx, 'owner', 'member', 'owner'))).error.code, 'member_role_invalid');
    assert.equal((await uc.updateMemberRole(command(ctx, 'admin', 'member', 'admin'))).error.code.endsWith('forbidden'), true);
    assert.equal((await uc.updateMemberRole(command(ctx, 'owner', 'member', 'admin'))).ok, true);
    assert.equal((await uc.updateMemberRole(command(ctx, 'owner', 'member', 'member'))).ok, true);
  }
  assert.equal((await ctx.teams.updateMemberRole(command(ctx, 'owner', 'member', 'viewer'))).error.code, 'member_role_invalid');
  assert.equal((await ctx.members.updateMemberRole(command(ctx, 'admin', 'member', 'viewer'))).ok, true);
  assert.equal((await ctx.teams.renameTeam({ teamCode: ctx.team.code, name: 'Renamed by admin', actorPrincipalCode: ctx.users.admin.code })).ok, true);
  assert.equal((await ctx.teams.renameTeam({ teamCode: ctx.team.code, name: 'Rejected', actorPrincipalCode: ctx.users.member.code })).error.code, 'team_forbidden');
});

test('effective roster includes inherited team members and explicit viewers override team_write', async () => {
  const ctx = await setup();
  await ctx.db.delete(schema.members).where(and(eq(schema.members.project_id, ctx.project.id), eq(schema.members.principal_id, ctx.users.member.id)));
  await ctx.db.update(schema.projects).set({ member_policy: 'team_write' }).where(eq(schema.projects.id, ctx.project.id));
  const rows = await ctx.members.listMembers(ctx.project.code, ctx.users.external.code);
  assert.equal(rows.find(row => row.user_code === ctx.users.owner.code).role, 'owner');
  assert.equal(rows.find(row => row.user_code === ctx.users.member.code).access_source, 'team');
  assert.equal(rows.find(row => row.user_code === ctx.users.member.code).role, 'member');
  assert.equal(rows.find(row => row.user_code === ctx.users.viewer.code).role, 'viewer');
  assert.equal(rows.find(row => row.user_code === ctx.users.viewer.code).capabilities.write, false);
  assert.equal(rows.find(row => row.user_code === ctx.users.external.code).is_external, true);
  assert.deepEqual(await ctx.members.listMembers(ctx.project.code, ctx.users.stranger.code), []);
  assert.deepEqual(await ctx.members.listMembers(), []);
  assert.equal((await ctx.teams.listMembers(ctx.team.code, ctx.users.external.code)).error.code, 'team_forbidden');
  // Team-only management does not imply permission to manage a private project.
  await ctx.db.delete(schema.members).where(and(eq(schema.members.project_id, ctx.project.id), eq(schema.members.principal_id, ctx.users.peer.id)));
  assert.equal((await ctx.members.updateMemberRole(command(ctx, 'peer', 'external', 'viewer'))).error.code, 'member_forbidden');
});

test('removing an explicit role reports restored team access; external access is fully revoked', async () => {
  const ctx = await setup();
  await ctx.db.update(schema.projects).set({ member_policy: 'team_write' }).where(eq(schema.projects.id, ctx.project.id));
  const restored = await ctx.members.removeMember(command(ctx, 'admin', 'viewer'));
  assert.equal(restored.ok, true, JSON.stringify(restored));
  assert.equal(restored.data.effective_role, 'member');
  assert.equal(restored.data.access_source, 'team');
  const removed = await ctx.members.removeMember(command(ctx, 'admin', 'external'));
  assert.equal(removed.ok, true);
  assert.equal(removed.data.effective_role, null);
  assert.deepEqual(await ctx.members.listMembers(ctx.project.code, ctx.users.external.code), []);
  assert.equal((await ctx.members.addMember(command(ctx, 'admin', 'external', 'viewer'))).ok, true);
  assert.equal((await ctx.members.addMember(command(ctx, 'member', 'stranger', 'member'))).error.code, 'member_forbidden');
});

test('removing a team member revokes this team project grants and preserves unrelated external collaboration', async () => {
  const ctx = await setup();
  const otherTeam = await insertTeam(ctx.db, { name: 'Other team' });
  const otherProject = await insertProject(ctx.db, { teamId: otherTeam.id, name: 'External project' });
  await addProjectMember(ctx.db, { projectId: otherProject.id, principalId: ctx.users.member.id, displayName: 'member', role: 'admin' });
  const impact = await ctx.teams.memberRemovalImpact(command(ctx, 'admin', 'member'));
  assert.equal(impact.ok, true, JSON.stringify(impact));
  assert.deepEqual(impact.data.projects.map(project => project.project_code), [ctx.project.code]);
  assert.deepEqual(impact.data.blocked_owned_projects, []);
  assert.equal((await ctx.teams.memberRemovalImpact(command(ctx, 'external', 'member'))).error.code, 'team_forbidden');
  const result = await ctx.teams.removeMember(command(ctx, 'admin', 'member'));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.data.revoked_project_codes, [ctx.project.code]);
  assert.equal((await ctx.db.select().from(schema.members).where(eq(schema.members.principal_id, ctx.users.member.id))).length, 1);
  assert.equal((await ctx.teams.addMember(command(ctx, 'admin', 'member', 'member'))).ok, true);
  assert.equal((await ctx.db.select().from(schema.members).where(and(eq(schema.members.project_id, ctx.project.id), eq(schema.members.principal_id, ctx.users.member.id)))).length, 0);
  assert.equal((await ctx.teams.removeMember(command(ctx, 'owner', 'external'))).error.code, 'team_member_not_found');
  assert.equal((await ctx.members.listMembers(ctx.project.code, ctx.users.external.code)).length > 0, true);
});

test('team removal protects any project owner and project role changes protect even a disabled owner', async () => {
  const ctx = await setup();
  await ctx.db.update(schema.projects).set({ owner_principal_id: ctx.users.member.id }).where(eq(schema.projects.id, ctx.project.id));
  assert.deepEqual((await ctx.teams.memberRemovalImpact(command(ctx, 'owner', 'member'))).data.blocked_owned_projects.map(project => project.project_code), [ctx.project.code]);
  assert.equal((await ctx.teams.removeMember(command(ctx, 'owner', 'member'))).error.code, 'project_owner_protected');
  await ctx.db.update(schema.users).set({ status: 'disabled' }).where(eq(schema.users.id, ctx.users.member.id));
  assert.equal((await ctx.members.removeMember(command(ctx, 'admin', 'member'))).error.code, 'project_owner_protected');
  const [project] = await ctx.db.select().from(schema.projects).where(eq(schema.projects.id, ctx.project.id));
  assert.equal(project.owner_principal_id, ctx.users.member.id);
});

test('open work blocks readonly downgrades and removals atomically', async () => {
  const ctx = await setup();
  const feature = await insertFeature(ctx.db, { projectId: ctx.project.id, title: 'Feature' });
  const task = await insertTask(ctx.db, { featureId: feature.id, title: 'Task', profile: 'builder', assigneePrincipalId: ctx.users.member.id, acceptance: [] });
  for (const result of [await ctx.members.updateMemberRole(command(ctx, 'admin', 'member', 'viewer')), await ctx.members.removeMember(command(ctx, 'admin', 'member')), await ctx.teams.removeMember(command(ctx, 'admin', 'member'))]) {
    assert.equal(result.ok, false);
    assert.equal(result.error.code.endsWith('has_open_tasks'), true);
    assert.deepEqual(result.error.details.open_task_codes, [task.code]);
  }
  const [row] = await ctx.db.select().from(schema.members).where(and(eq(schema.members.project_id, ctx.project.id), eq(schema.members.principal_id, ctx.users.member.id)));
  assert.equal(row.role, 'member');
  const audit = await ctx.db.select().from(schema.auditEvents);
  assert.equal(audit.length, 0);
});

test('ordinary team members see only authorized project counts while managers retain governance counts', async () => {
  const ctx = await setup();
  await insertProject(ctx.db, { teamId: ctx.team.id, name: 'Private sibling' });
  const inherited = await insertProject(ctx.db, { teamId: ctx.team.id, name: 'Shared sibling' });
  await ctx.db.update(schema.projects).set({ member_policy: 'team_read' }).where(eq(schema.projects.id, inherited.id));
  assert.equal((await ctx.teams.listTeams(ctx.users.member.code))[0].projects_count, 2);
  assert.equal((await ctx.teams.listTeams(ctx.users.admin.code))[0].projects_count, 3);
  assert.deepEqual(await ctx.teams.listTeams(ctx.users.external.code), []);
});

test('team governance exposes project responsibility metadata to team managers without granting private content access', async () => {
  const ctx = await setup();
  const privateProject = await insertProject(ctx.db, { teamId: ctx.team.id, name: 'Admin private project' });
  await ctx.db.update(schema.projects).set({ owner_principal_id: ctx.users.admin.id, description: 'Private description', status: 'archived' }).where(eq(schema.projects.id, privateProject.id));
  await addProjectMember(ctx.db, { projectId: privateProject.id, principalId: ctx.users.admin.id, displayName: 'admin', role: 'admin' });
  const governance = await ctx.teams.listProjectGovernance(ctx.team.code, ctx.users.owner.code);
  assert.equal(governance.ok, true, JSON.stringify(governance));
  assert.equal(governance.data.length, 2);
  const privateMetadata = governance.data.find(project => project.project_code === privateProject.code);
  assert.deepEqual(privateMetadata, { project_code: privateProject.code, name: 'Admin private project', status: 'archived', owner_user_code: ctx.users.admin.code, owner_name: 'admin', ownership_pending: false, can_access: false });
  assert.equal((await ctx.teams.listProjectGovernance(ctx.team.code, ctx.users.admin.code)).data.find(project => project.project_code === privateProject.code).can_access, true);
  assert.equal((await ctx.teams.listProjectGovernance(ctx.team.code, ctx.users.member.code)).error.code, 'team_forbidden');
  assert.equal((await ctx.teams.listProjectGovernance(ctx.team.code, ctx.users.external.code)).error.code, 'team_forbidden');
  assert.deepEqual(await ctx.members.listMembers(privateProject.code, ctx.users.owner.code), []);
});
