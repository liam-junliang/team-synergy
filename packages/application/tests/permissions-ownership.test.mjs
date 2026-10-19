import { test } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';
import { schema } from '@team-synergy/persistence';
import { createOwnershipUseCases, createMemberUseCases, createTeamUseCases } from '../dist/index.js';
import { useTestDb, insertUser, insertTeam, insertProject, addTeamMember, addProjectMember, insertFeature, insertTask } from './test-db.mjs';

const fixture = useTestDb(import.meta.url);

async function setup() {
  const db = fixture.db;
  const users = {};
  for (const key of ['owner', 'next', 'third', 'external', 'platform']) users[key] = await insertUser(db, { account: key, displayName: key, isSystemAdmin: key === 'platform' });
  const team = await insertTeam(db, { name: 'Team' });
  await db.update(schema.teams).set({ owner_principal_id: users.owner.id, created_by: users.owner.id }).where(eq(schema.teams.id, team.id));
  for (const key of ['owner', 'next', 'third']) await addTeamMember(db, { teamId: team.id, principalId: users[key].id, role: key === 'owner' ? 'admin' : 'member', displayName: key });
  const project = await insertProject(db, { teamId: team.id, name: 'Project' });
  await db.update(schema.projects).set({ owner_principal_id: users.owner.id, created_by: users.owner.id }).where(eq(schema.projects.id, project.id));
  await addProjectMember(db, { projectId: project.id, principalId: users.owner.id, role: 'admin', displayName: 'owner' });
  return { db, users, team, project, uc: createOwnershipUseCases(db) };
}

const request = (ctx, scope = 'project', overrides = {}) => ({ scope, scopeCode: ctx[scope].code, targetUserCode: ctx.users.next.code, actorPrincipalCode: ctx.users.owner.code, ...overrides });
const accept = (ctx, result, actor = 'next') => ctx.uc.acceptTransfer({ transferCode: result.data.code, actorPrincipalCode: ctx.users[actor].code });
const succeeded = result => assert.equal(result.ok, true, JSON.stringify(result));

test('ownership changes only after recipient acceptance, retains creator and makes previous owner admin', async () => {
  const ctx = await setup();
  await ctx.db.update(schema.projects).set({ status: 'archived' }).where(eq(schema.projects.id, ctx.project.id));
  const pending = await ctx.uc.requestTransfer(request(ctx));
  succeeded(pending);
  let [project] = await ctx.db.select().from(schema.projects).where(eq(schema.projects.id, ctx.project.id));
  assert.equal(project.owner_principal_id, ctx.users.owner.id);
  assert.equal((await accept(ctx, pending, 'owner')).error.code, 'ownership_recipient_required');
  succeeded(await accept(ctx, pending));
  [project] = await ctx.db.select().from(schema.projects).where(eq(schema.projects.id, ctx.project.id));
  assert.equal(project.owner_principal_id, ctx.users.next.id);
  assert.equal(project.created_by, ctx.users.owner.id);
  assert.equal(project.status, 'archived');
  const [team] = await ctx.db.select().from(schema.teams).where(eq(schema.teams.id, ctx.team.id));
  assert.equal(team.owner_principal_id, ctx.users.owner.id);
  const roster = await createMemberUseCases(ctx.db).listMembers(ctx.project.code, ctx.users.next.code);
  assert.equal(roster.find(member => member.user_code === ctx.users.owner.code).role, 'admin');
  assert.equal(roster.find(member => member.user_code === ctx.users.next.code).role, 'owner');
});

test('concurrent acceptance succeeds once and only one pending request exists per scope', async () => {
  const ctx = await setup();
  const pending = await ctx.uc.requestTransfer(request(ctx, 'team'));
  succeeded(pending);
  assert.equal((await ctx.uc.requestTransfer(request(ctx, 'team', { targetUserCode: ctx.users.third.code }))).error.code, 'ownership_transfer_pending');
  const results = await Promise.all([accept(ctx, pending), accept(ctx, pending)]);
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.equal(results.find(result => !result.ok).error.code, 'ownership_transfer_not_pending');
  const audits = await ctx.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, 'ownership.transfer_accepted'));
  assert.equal(audits.length, 1);
  assert.equal((await createTeamUseCases(ctx.db).listMembers(ctx.team.code, ctx.users.next.code)).data.filter(member => member.role === 'owner').length, 1);
});

test('cancelled and expired requests cannot change ownership; expiry permits a fresh request', async () => {
  const ctx = await setup();
  const cancelled = await ctx.uc.requestTransfer(request(ctx));
  succeeded(cancelled);
  assert.equal((await ctx.uc.cancelTransfer({ transferCode: cancelled.data.code, actorPrincipalCode: ctx.users.third.code })).error.code, 'ownership_forbidden');
  succeeded(await ctx.uc.cancelTransfer({ transferCode: cancelled.data.code, actorPrincipalCode: ctx.users.owner.code }));
  assert.equal((await accept(ctx, cancelled)).error.code, 'ownership_transfer_not_pending');
  const expired = await ctx.uc.requestTransfer(request(ctx));
  await ctx.db.update(schema.ownershipTransfers).set({ expires_at: '2000-01-01T00:00:00.000Z' }).where(eq(schema.ownershipTransfers.code, expired.data.code));
  assert.equal((await accept(ctx, expired)).error.code, 'ownership_transfer_expired');
  succeeded(await ctx.uc.requestTransfer(request(ctx, 'project', { targetUserCode: ctx.users.third.code })));
  const [project] = await ctx.db.select().from(schema.projects).where(eq(schema.projects.id, ctx.project.id));
  assert.equal(project.owner_principal_id, ctx.users.owner.id);
});

test('recipient eligibility is checked both on request and acceptance', async () => {
  const ctx = await setup();
  assert.equal((await ctx.uc.requestTransfer(request(ctx, 'project', { targetUserCode: ctx.users.external.code }))).error.code, 'ownership_recipient_not_team_member');
  const pending = await ctx.uc.requestTransfer(request(ctx));
  succeeded(pending);
  succeeded(await ctx.uc.beginClosure(ctx.users.next.code));
  assert.equal((await accept(ctx, pending)).error.code, 'account_pending_deletion');
  succeeded(await ctx.uc.cancelClosure(ctx.users.next.code));
  await ctx.db.delete(schema.teamMembers).where(and(eq(schema.teamMembers.team_id, ctx.team.id), eq(schema.teamMembers.principal_id, ctx.users.next.id)));
  assert.equal((await accept(ctx, pending)).error.code, 'ownership_recipient_not_team_member');
  assert.equal((await ctx.uc.listTransfers(ctx.users.third.code)).data.length, 0);
  assert.equal((await ctx.uc.listTransfers(ctx.users.owner.code)).data.length, 1);
  assert.equal((await ctx.uc.listTransfers(ctx.users.next.code)).data.length, 1);
});

test('project recovery requires disabled owner, team owner authority, a reason, and recipient acceptance', async () => {
  const ctx = await setup();
  await ctx.db.update(schema.projects).set({ owner_principal_id: ctx.users.third.id }).where(eq(schema.projects.id, ctx.project.id));
  assert.equal((await ctx.uc.requestTransfer(request(ctx, 'project', { recovery: true }))).error.code, 'ownership_recovery_reason_required');
  assert.equal((await ctx.uc.requestTransfer(request(ctx, 'project', { recovery: true, reason: 'Account compromised' }))).error.code, 'ownership_recovery_not_required');
  await ctx.db.update(schema.users).set({ status: 'disabled' }).where(eq(schema.users.id, ctx.users.third.id));
  assert.equal((await ctx.uc.requestTransfer(request(ctx, 'project', { recovery: true, reason: 'Account compromised', actorPrincipalCode: ctx.users.next.code }))).error.code, 'ownership_recovery_forbidden');
  const recovery = await ctx.uc.requestTransfer(request(ctx, 'project', { recovery: true, reason: 'Account compromised' }));
  succeeded(recovery);
  assert.equal(recovery.data.is_recovery, true);
  succeeded(await accept(ctx, recovery));
  const [event] = await ctx.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, 'ownership.recovery_accepted'));
  const payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
  assert.equal(payload.initiated_by_code, ctx.users.owner.code);
  assert.equal(payload.reason, 'Account compromised');
});

test('recovery authority and owner inactivity are revalidated when the recipient accepts', async () => {
  const ctx = await setup();
  await ctx.db.update(schema.projects).set({ owner_principal_id: ctx.users.third.id }).where(eq(schema.projects.id, ctx.project.id));
  await ctx.db.update(schema.users).set({ status: 'disabled' }).where(eq(schema.users.id, ctx.users.third.id));
  const recovery = await ctx.uc.requestTransfer(request(ctx, 'project', { recovery: true, reason: 'Disabled owner' }));
  succeeded(recovery);
  await ctx.db.update(schema.users).set({ status: 'active' }).where(eq(schema.users.id, ctx.users.third.id));
  assert.equal((await accept(ctx, recovery)).error.code, 'ownership_recovery_not_required');
  await ctx.db.update(schema.users).set({ status: 'disabled' }).where(eq(schema.users.id, ctx.users.third.id));
  await ctx.db.update(schema.teams).set({ owner_principal_id: ctx.users.next.id }).where(eq(schema.teams.id, ctx.team.id));
  assert.equal((await accept(ctx, recovery)).error.code, 'ownership_recovery_forbidden');
});

test('only platform admins initiate recovery for a team with an unavailable owner', async () => {
  const ctx = await setup();
  await ctx.db.update(schema.users).set({ status: 'disabled' }).where(eq(schema.users.id, ctx.users.owner.id));
  assert.equal((await ctx.uc.requestTransfer(request(ctx, 'team', { recovery: true, reason: 'Disabled owner', actorPrincipalCode: ctx.users.third.code }))).error.code, 'ownership_recovery_forbidden');
  const recovery = await ctx.uc.requestTransfer(request(ctx, 'team', { recovery: true, reason: 'Disabled owner', actorPrincipalCode: ctx.users.platform.code }));
  succeeded(recovery);
  succeeded(await accept(ctx, recovery));
  const [team] = await ctx.db.select().from(schema.teams).where(eq(schema.teams.id, ctx.team.id));
  assert.equal(team.owner_principal_id, ctx.users.next.id);
  assert.equal(team.created_by, ctx.users.owner.id);
});

test('legacy resolution requires an existing owner, preserves creator and converts other owners to admins', async () => {
  const ctx = await setup();
  await ctx.db.update(schema.projects).set({ owner_principal_id: null, created_by: null }).where(eq(schema.projects.id, ctx.project.id));
  await ctx.db.update(schema.members).set({ role: 'owner' }).where(eq(schema.members.project_id, ctx.project.id));
  await addProjectMember(ctx.db, { projectId: ctx.project.id, principalId: ctx.users.third.id, role: 'owner', displayName: 'third' });
  const resolve = overrides => ctx.uc.resolveOwnership({ scope: 'project', scopeCode: ctx.project.code, ownerUserCode: ctx.users.owner.code, actorPrincipalCode: ctx.users.owner.code, ...overrides });
  assert.equal((await resolve({ actorPrincipalCode: ctx.users.next.code })).error.code, 'ownership_forbidden');
  assert.equal((await resolve({ ownerUserCode: ctx.users.next.code })).error.code, 'ownership_resolution_target_invalid');
  succeeded(await resolve({}));
  const [project] = await ctx.db.select().from(schema.projects).where(eq(schema.projects.id, ctx.project.id));
  assert.equal(project.owner_principal_id, ctx.users.owner.id);
  assert.equal(project.created_by, null);
  assert.equal((await ctx.db.select().from(schema.members).where(eq(schema.members.project_id, ctx.project.id))).every(member => member.role === 'admin'), true);
  assert.equal((await resolve({})).error.code, 'ownership_already_resolved');
});

test('platform admin can resolve unavailable legacy owners solely to enable audited recovery', async () => {
  const ctx = await setup();
  await ctx.db.update(schema.teams).set({ owner_principal_id: ctx.users.next.id }).where(eq(schema.teams.id, ctx.team.id));
  await ctx.db.update(schema.projects).set({ owner_principal_id: null }).where(eq(schema.projects.id, ctx.project.id));
  await ctx.db.update(schema.members).set({ role: 'owner' }).where(eq(schema.members.project_id, ctx.project.id));
  await addProjectMember(ctx.db, { projectId: ctx.project.id, principalId: ctx.users.third.id, role: 'owner', displayName: 'third' });
  await ctx.db.update(schema.users).set({ status: 'disabled' }).where(eq(schema.users.id, ctx.users.third.id));
  const resolve = actor => ctx.uc.resolveOwnership({ scope: 'project', scopeCode: ctx.project.code, ownerUserCode: ctx.users.third.code, actorPrincipalCode: ctx.users[actor].code });
  assert.equal((await resolve('owner')).error.code, 'user_not_found');
  await ctx.db.update(schema.users).set({ status: 'disabled' }).where(eq(schema.users.id, ctx.users.owner.id));
  succeeded(await resolve('platform'));
  const [disabledOwner] = await ctx.db.select().from(schema.users).where(eq(schema.users.id, ctx.users.third.id));
  assert.equal(disabledOwner.status, 'disabled');
  const recovery = await ctx.uc.requestTransfer(request(ctx, 'project', { actorPrincipalCode: ctx.users.next.code, recovery: true, reason: 'Recover unavailable legacy owner' }));
  succeeded(recovery);
  succeeded(await accept(ctx, recovery));
  const [project] = await ctx.db.select().from(schema.projects).where(eq(schema.projects.id, ctx.project.id));
  assert.equal(project.owner_principal_id, ctx.users.next.id);
});

test('closure includes archived and unresolved legacy ownership and blocks until all responsibility is transferred', async () => {
  const ctx = await setup();
  await ctx.db.update(schema.projects).set({ status: 'archived' }).where(eq(schema.projects.id, ctx.project.id));
  const legacy = await insertProject(ctx.db, { teamId: ctx.team.id, name: 'Legacy' });
  await addProjectMember(ctx.db, { projectId: legacy.id, principalId: ctx.users.owner.id, role: 'owner', displayName: 'owner' });
  const status = await ctx.uc.closureStatus(ctx.users.owner.code);
  succeeded(status);
  assert.equal(status.data.teams.length, 1);
  assert.equal(status.data.projects.length, 2);
  assert.equal(status.data.projects.find(project => project.code === ctx.project.code).status, 'archived');
  assert.equal(status.data.projects.find(project => project.code === legacy.code).ownership_pending, true);
  succeeded(await ctx.uc.beginClosure(ctx.users.owner.code));
  assert.equal((await ctx.uc.completeClosure(ctx.users.owner.code)).error.code, 'account_closure_blocked');
  assert.equal((await createTeamUseCases(ctx.db).createTeam({ name: 'Blocked new team', principalCode: ctx.users.owner.code })).error.code, 'account_pending_deletion');
});

test('closure blocks open work, then revokes credentials and leases while preserving history', async () => {
  const ctx = await setup();
  const feature = await insertFeature(ctx.db, { projectId: ctx.project.id, title: 'Feature' });
  const task = await insertTask(ctx.db, { featureId: feature.id, title: 'Task', profile: 'builder', assigneePrincipalId: ctx.users.third.id, acceptance: [] });
  const [run] = await ctx.db.insert(schema.runs).values({ task_id: task.id, principal_id: ctx.users.third.id, profile: 'builder', workspace_id: 1n, status: 'active', base_snapshot: 0, started_at: 't0' }).returning();
  const [device] = await ctx.db.insert(schema.devices).values({ principal_id: ctx.users.third.id, credential_hash: 'test-hash', created_at: 't0' }).returning();
  const [lease] = await ctx.db.insert(schema.runLeases).values({ run_id: run.id, device_id: device.id, epoch: 0, token_hash: 'lease-hash', expires_at: '2099-01-01', created_at: 't0' }).returning();
  await ctx.db.update(schema.users).set({ bind_token_hash: 'bind-hash', bind_token_expires_at: '2099-01-01' }).where(eq(schema.users.id, ctx.users.third.id));
  succeeded(await ctx.uc.beginClosure(ctx.users.third.code));
  const blocked = await ctx.uc.completeClosure(ctx.users.third.code);
  assert.equal(blocked.error.code, 'account_closure_blocked');
  assert.equal(blocked.error.details.open_tasks.length, 1);
  assert.equal(blocked.error.details.active_runs.length, 1);
  await ctx.db.update(schema.tasks).set({ status: 'closed' }).where(eq(schema.tasks.id, task.id));
  await ctx.db.update(schema.runs).set({ status: 'completed' }).where(eq(schema.runs.id, run.id));
  succeeded(await ctx.uc.completeClosure(ctx.users.third.code));
  const [user] = await ctx.db.select().from(schema.users).where(eq(schema.users.id, ctx.users.third.id));
  assert.equal(user.status, 'disabled');
  assert.ok(user.deleted_at);
  assert.equal(user.bind_token_hash, null);
  const retainedDevices = await ctx.db.select().from(schema.devices).where(eq(schema.devices.principal_id, user.id));
  assert.equal(retainedDevices.length, 1);
  assert.ok(retainedDevices[0].revoked_at, 'account closure retains the installation history while revoking access');
  const [revoked] = await ctx.db.select().from(schema.runLeases).where(eq(schema.runLeases.id, lease.id));
  assert.ok(revoked.revoked_at);
  const [historicTask] = await ctx.db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id));
  assert.equal(historicTask.assignee_principal_id, user.id);
});

test('pending closure still permits outgoing transfers and former owners can close after separate team and project acceptance', async () => {
  const ctx = await setup();
  succeeded(await ctx.uc.beginClosure(ctx.users.owner.code));
  for (const scope of ['project', 'team']) {
    const transfer = await ctx.uc.requestTransfer(request(ctx, scope));
    succeeded(transfer);
    succeeded(await accept(ctx, transfer));
  }
  succeeded(await ctx.uc.completeClosure(ctx.users.owner.code));
  const [team] = await ctx.db.select().from(schema.teams).where(eq(schema.teams.id, ctx.team.id));
  const [project] = await ctx.db.select().from(schema.projects).where(eq(schema.projects.id, ctx.project.id));
  assert.equal(team.owner_principal_id, ctx.users.next.id);
  assert.equal(project.owner_principal_id, ctx.users.next.id);
  assert.equal(team.created_by, ctx.users.owner.id);
  assert.equal(project.created_by, ctx.users.owner.id);
});

test('concurrent recipient closure and transfer acceptance never create an orphan owner', async () => {
  const ctx = await setup();
  const pending = await ctx.uc.requestTransfer(request(ctx));
  succeeded(pending);
  const results = await Promise.all([ctx.uc.beginClosure(ctx.users.next.code), accept(ctx, pending)]);
  succeeded(results[0]);
  const closure = await ctx.uc.completeClosure(ctx.users.next.code);
  const [project] = await ctx.db.select().from(schema.projects).where(eq(schema.projects.id, ctx.project.id));
  const [user] = await ctx.db.select().from(schema.users).where(eq(schema.users.id, ctx.users.next.id));
  if (results[1].ok) {
    assert.equal(closure.error.code, 'account_closure_blocked');
    assert.equal(project.owner_principal_id, ctx.users.next.id);
    assert.equal(user.status, 'active');
  } else {
    assert.equal(results[1].error.code, 'account_pending_deletion');
    succeeded(closure);
    assert.equal(project.owner_principal_id, ctx.users.owner.id);
  }
});

test('concurrent platform administrator closures retain one active administrator', async () => {
  const ctx = await setup();
  await ctx.db.update(schema.users).set({ is_system_admin: true }).where(eq(schema.users.id, ctx.users.external.id));
  succeeded(await ctx.uc.beginClosure(ctx.users.platform.code));
  succeeded(await ctx.uc.beginClosure(ctx.users.external.code));
  const results = await Promise.all([ctx.uc.completeClosure(ctx.users.platform.code), ctx.uc.completeClosure(ctx.users.external.code)]);
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.equal(results.find(result => !result.ok).error.code, 'last_system_admin_protected');
  const active = await ctx.db.select().from(schema.users).where(and(eq(schema.users.is_system_admin, true), eq(schema.users.status, 'active')));
  assert.equal(active.length, 1);
});
