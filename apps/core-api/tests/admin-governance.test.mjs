import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@team-synergy/persistence';
import { createAdminGovernanceUseCases, createProjectUseCasesProject } from '@team-synergy/application';
import { buildServer } from '../dist/server.js';
import { closeTestDb, insertFeature, insertProject, insertProjectMember, insertTeam, insertTeamMember, insertUser, openTestDb } from './test-db.mjs';

const fixtures = [];
const createdAt = '2026-10-18T00:00:00Z';
async function fixture() {
  const db = await openTestDb();
  const app = await buildServer({ db, logger: false });
  fixtures.push({ app, db });
  const users = {};
  for (const account of ['system', 'owner', 'member', 'disabled']) {
    const user = await insertUser(db, { account: `governance.${account}`, display_name: account,
      status: account === 'disabled' ? 'disabled' : 'active', is_system_admin: account === 'system', created_at: createdAt });
    const token = `governance-${account}-token`;
    await db.insert(schema.devices).values({ principal_id: user.id, device_name: account,
      credential_hash: createHash('sha256').update(token).digest('hex'), created_at: createdAt });
    users[account] = { ...user, headers: { authorization: `Bearer ${token}` } };
  }
  const team = await insertTeam(db, { name: 'Admin-visible team', created_by: users.owner.id, owner_principal_id: users.owner.id, created_at: createdAt });
  for (const name of ['owner', 'member', 'disabled']) {
    await insertTeamMember(db, { team_id: team.id, principal_id: users[name].id, role: name === 'owner' ? 'admin' : 'member', display_name: name, created_at: createdAt });
  }
  const project = await insertProject(db, { team_id: team.id, name: 'Private project', description: 'Metadata only', created_by: users.owner.id,
    owner_principal_id: users.owner.id, member_policy: 'private', created_at: createdAt });
  await insertProjectMember(db, { project_id: project.id, principal_id: users.owner.id, role: 'admin', display_name: 'owner', created_at: createdAt });
  await insertProjectMember(db, { project_id: project.id, principal_id: users.disabled.id, role: 'member', display_name: 'disabled', created_at: createdAt });
  return { app, db, users, team, project };
}
afterEach(async () => { for (const { app, db } of fixtures.splice(0)) { await app.close(); await closeTestDb(db); } });

test('system administrators see global metadata without becoming team or project members', async () => {
  const f = await fixture();
  const teams = await f.app.inject({ method: 'GET', url: '/admin/teams', headers: f.users.system.headers });
  assert.equal(teams.statusCode, 200, teams.body);
  assert.deepEqual(teams.json().data.items.map(row => row.team_code), [f.team.code]);
  assert.equal(teams.json().data.items[0].owner_code, f.users.owner.code);
  assert.equal(teams.json().data.items[0].members_count, 3);
  assert.equal(teams.json().data.items[0].projects_count, 1);
  const projects = await f.app.inject({ method: 'GET', url: '/admin/projects', headers: f.users.system.headers });
  assert.equal(projects.statusCode, 200, projects.body);
  assert.equal(projects.json().data.items[0].members_count, 1);
  assert.equal(projects.json().data.items[0].owner_name, 'owner');
  for (const row of [...teams.json().data.items, ...projects.json().data.items]) {
    assert.ok(!('id' in row));
    assert.ok(!('password_hash' in row));
    assert.ok(!('role' in row));
  }
  const businessList = await f.app.inject({ method: 'GET', url: '/projects', headers: f.users.system.headers });
  assert.deepEqual(businessList.json().data, []);
  const businessProject = await f.app.inject({ method: 'GET', url: `/projects/${f.project.code}`, headers: f.users.system.headers });
  assert.equal(businessProject.json().error.code, 'project_forbidden');
  assert.equal((await f.db.select().from(schema.members).where(eq(schema.members.principal_id, f.users.system.id))).length, 0);
  assert.equal((await f.db.select().from(schema.teamMembers).where(eq(schema.teamMembers.principal_id, f.users.system.id))).length, 0);
});

test('governance rejects business owners, legacy identity, anonymous, stale or disabled administrator authority', async () => {
  const f = await fixture();
  for (const url of ['/admin/teams', '/admin/projects']) {
    const owner = await f.app.inject({ method: 'GET', url, headers: f.users.owner.headers });
    assert.equal(owner.statusCode, 403);
    assert.equal(owner.json().error.code, 'admin_forbidden');
    assert.equal((await f.app.inject({ method: 'GET', url, headers: { 'x-principal-code': f.users.system.code } })).statusCode, 401);
    assert.equal((await f.app.inject({ method: 'GET', url })).statusCode, 401);
  }
  const forbiddenEdit = await f.app.inject({ method: 'PATCH', url: `/admin/teams/${f.team.code}`, headers: f.users.owner.headers, payload: { name: 'No', reason: 'Owner is not sysadmin' } });
  assert.equal(forbiddenEdit.statusCode, 403);
  await f.db.update(schema.users).set({ is_system_admin: false }).where(eq(schema.users.id, f.users.system.id));
  assert.equal((await f.app.inject({ method: 'GET', url: '/admin/teams', headers: f.users.system.headers })).statusCode, 403);
  await f.db.update(schema.users).set({ is_system_admin: true, status: 'disabled' }).where(eq(schema.users.id, f.users.system.id));
  assert.equal((await createAdminGovernanceUseCases(f.db).listTeams(f.users.system.code)).error.code, 'admin_forbidden');
});

test('governance search and pagination preserve filters and count effective inherited membership', async () => {
  const f = await fixture();
  const second = await insertProject(f.db, { team_id: f.team.id, name: 'Literal % project', status: 'archived', member_policy: 'team_read', created_at: createdAt });
  const headers = f.users.system.headers;
  const first = (await f.app.inject({ method: 'GET', url: '/admin/projects?limit=1', headers })).json().data;
  assert.equal(first.total, 2);
  assert.equal(first.items.length, 1);
  assert.ok(first.next_cursor);
  const next = (await f.app.inject({ method: 'GET', url: `/admin/projects?limit=1&cursor=${first.next_cursor}`, headers })).json().data;
  assert.equal(next.total, 2);
  assert.equal(next.items.length, 1);
  assert.equal(next.next_cursor, null);
  assert.notEqual(next.items[0].project_code, first.items[0].project_code);
  const filtered = (await f.app.inject({ method: 'GET', url: `/admin/projects?team_code=${f.team.code}&status=archived&q=%25`, headers })).json().data;
  assert.deepEqual(filtered.items.map(row => row.project_code), [second.code]);
  assert.equal(filtered.items[0].members_count, 2);
  for (const query of ['limit=201', 'limit=0', 'limit=nan', 'cursor=invalid', 'status=deleted']) {
    assert.equal((await f.app.inject({ method: 'GET', url: `/admin/projects?${query}`, headers })).statusCode, 400);
  }
});

test('archived projects leave daily discovery and ordering until restored in system administration', async () => {
  const f = await fixture();
  const active = await insertProject(f.db, { team_id: f.team.id, owner_principal_id: f.users.owner.id,
    name: 'Active collaboration', member_policy: 'team_read', created_at: createdAt });
  await insertProjectMember(f.db, { project_id: f.project.id, principal_id: f.users.member.id,
    role: 'member', display_name: 'member', created_at: createdAt });
  const owner = f.users.owner.headers;
  const member = f.users.member.headers;
  const system = f.users.system.headers;
  const statusUrl = `/projects/${f.project.code}/status`;
  const adminUrl = `/admin/projects/${f.project.code}`;
  const listUrl = `/projects?team_code=${f.team.code}`;
  const teamGovernanceUrl = `/teams/${f.team.code}/projects-governance`;
  const feature = await insertFeature(f.db, { project_id: f.project.id, title: 'Historical feature' });
  await f.db.insert(schema.requirements).values({
    feature_id: feature.id, title: 'Historical requirement', owner_principal_id: f.users.owner.id,
  });
  await f.db.insert(schema.defects).values({
    feature_id: feature.id, title: 'Historical defect', severity: 'low', description: 'Historical evidence', reported_by: f.users.owner.id,
  });

  const archived = await f.app.inject({ method: 'PATCH', url: statusUrl, headers: owner, payload: { status: 'archived' } });
  assert.equal(archived.statusCode, 200, archived.body);
  for (const headers of [owner, member]) {
    for (const url of ['/projects', listUrl]) {
      const result = await f.app.inject({ method: 'GET', url, headers });
      assert.equal(result.statusCode, 200, result.body);
      assert.deepEqual(result.json().data.map(project => project.project_code), [active.code]);
    }
    const teams = await f.app.inject({ method: 'GET', url: '/teams', headers });
    assert.equal(teams.json().data.find(team => team.team_code === f.team.code)?.projects_count, 1);
  }
  const teamGovernance = await f.app.inject({ method: 'GET', url: teamGovernanceUrl, headers: owner });
  assert.deepEqual(teamGovernance.json().data.map(project => project.project_code), [active.code]);
  const staleOrder = await f.app.inject({ method: 'PUT', url: '/projects/order', headers: owner,
    payload: { team_code: f.team.code, project_codes: [f.project.code, active.code] } });
  assert.equal(staleOrder.json().error.code, 'project_order_invalid');
  const order = await f.app.inject({ method: 'PUT', url: '/projects/order', headers: owner,
    payload: { team_code: f.team.code, project_codes: [active.code] } });
  assert.equal(order.statusCode, 200, order.body);
  const historical = await f.app.inject({ method: 'GET', url: `/projects/${f.project.code}`, headers: member });
  assert.equal(historical.statusCode, 200, historical.body);
  assert.equal(historical.json().data.status, 'archived');
  assert.equal(historical.json().data.capabilities.write, false);
  for (const endpoint of ['/requirements', '/defects']) {
    const defaultList = await f.app.inject({ method: 'GET', url: endpoint, headers: member });
    assert.deepEqual(defaultList.json().data, []);
    const scopedList = await f.app.inject({ method: 'GET', url: `${endpoint}?project_code=${f.project.code}`, headers: member });
    assert.equal(scopedList.json().data.length, 1);
  }

  const archivedProjects = await f.app.inject({ method: 'GET', url: '/admin/projects?status=archived', headers: system });
  assert.deepEqual(archivedProjects.json().data.items.map(project => project.project_code), [f.project.code]);
  const restore = { status: 'active', reason: 'Reopen this project', base_snapshot: archived.json().data.current_snapshot };
  const ownerDenied = await f.app.inject({ method: 'PATCH', url: adminUrl, headers: owner, payload: restore });
  assert.equal(ownerDenied.statusCode, 403, ownerDenied.body);
  const restored = await f.app.inject({ method: 'PATCH', url: adminUrl, headers: system, payload: restore });
  assert.equal(restored.statusCode, 200, restored.body);
  assert.equal(restored.json().data.status, 'active');
  const rediscovered = await f.app.inject({ method: 'GET', url: listUrl, headers: member });
  assert.deepEqual(rediscovered.json().data.map(project => project.project_code).sort(), [active.code, f.project.code].sort());
});

test('metadata edits require reason, audit old/new values and preserve owners and membership', async () => {
  const f = await fixture();
  const headers = f.users.system.headers;
  const originalMembership = await f.db.select().from(schema.members);
  const rejected = await f.app.inject({ method: 'PATCH', url: `/admin/teams/${f.team.code}`, headers, payload: { name: 'Renamed team' } });
  assert.equal(rejected.statusCode, 400);
  for (const [url, payload] of [
    [`/admin/teams/${f.team.code}`, { name: 'Renamed team', reason: 'Takeover', owner_code: f.users.system.code }],
    [`/admin/projects/${f.project.code}`, { reason: 'Takeover', owner_code: f.users.system.code }],
  ]) assert.equal((await f.app.inject({ method: 'PATCH', url, headers, payload })).statusCode, 400);
  const renamed = await f.app.inject({ method: 'PATCH', url: `/admin/teams/${f.team.code}`, headers, payload: { name: 'Renamed team', reason: 'Naming policy correction' } });
  assert.equal(renamed.statusCode, 200, renamed.body);
  const changed = await f.app.inject({ method: 'PATCH', url: `/admin/projects/${f.project.code}`, headers, payload: { base_snapshot: 0, name: 'Renamed project', description: 'Corrected metadata', status: 'archived', reason: 'Completed project' } });
  assert.equal(changed.statusCode, 200, changed.body);
  assert.equal(changed.json().data.current_snapshot, 1);
  const [project] = await f.db.select().from(schema.projects).where(eq(schema.projects.id, f.project.id));
  assert.equal(project.owner_principal_id, f.users.owner.id);
  assert.equal(project.created_by, f.users.owner.id);
  assert.equal(project.member_policy, 'private');
  assert.deepEqual(await f.db.select().from(schema.members), originalMembership);
  const [team] = await f.db.select().from(schema.teams).where(eq(schema.teams.id, f.team.id));
  assert.equal(team.owner_principal_id, f.users.owner.id);
  const audits = await f.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.principal_id, f.users.system.id));
  assert.deepEqual(audits.map(row => row.action).sort(), ['admin.project.updated', 'admin.team.updated']);
  const projectAudit = JSON.parse(audits.find(row => row.action === 'admin.project.updated').payload);
  assert.equal(projectAudit.reason, 'Completed project');
  assert.deepEqual(projectAudit.status, { from: 'active', to: 'archived' });
  const restored = await f.app.inject({ method: 'PATCH', url: `/admin/projects/${f.project.code}`, headers, payload: { base_snapshot: 1, status: 'active', reason: 'Reopened project' } });
  assert.equal(restored.json().data.current_snapshot, 2);
  assert.equal((await f.app.inject({ method: 'GET', url: `/projects/${f.project.code}`, headers })).json().error.code, 'project_forbidden');
});

test('admin archival guards all execution and handover run states without changing running work', async () => {
  const f = await fixture();
  const feature = await insertFeature(f.db, { project_id: f.project.id, title: 'Execution' });
  const [task] = await f.db.insert(schema.tasks).values({ feature_id: feature.id, title: 'Running task', profile: 'builder', source: 'ad-hoc', status: 'running', acceptance: '[]', base_snapshot: 0, created_at: createdAt }).returning();
  const [run] = await f.db.insert(schema.runs).values({ task_id: task.id, principal_id: f.users.owner.id, profile: 'builder', workspace_id: 1n, status: 'active', base_snapshot: 0, started_at: createdAt }).returning();
  for (const status of ['active', 'preparing', 'suspended']) {
    await f.db.update(schema.runs).set({ status }).where(eq(schema.runs.id, run.id));
    const response = await f.app.inject({ method: 'PATCH', url: `/admin/projects/${f.project.code}`, headers: f.users.system.headers, payload: { base_snapshot: 0, status: 'archived', reason: 'Attempt while running' } });
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().error.code, 'project_has_active_runs');
  }
  assert.equal((await f.db.select().from(schema.projects).where(eq(schema.projects.id, f.project.id)))[0].status, 'active');
  assert.equal((await f.db.select().from(schema.auditEvents)).length, 0);
  await f.db.update(schema.runs).set({ status: 'completed' }).where(eq(schema.runs.id, run.id));
  assert.equal((await f.app.inject({ method: 'PATCH', url: `/admin/projects/${f.project.code}`, headers: f.users.system.headers, payload: { base_snapshot: 0, status: 'archived', reason: 'Execution completed' } })).statusCode, 200);
});


test('only a system administrator can force archive and fence project execution without losing evidence', async () => {
  const f = await fixture();
  const projectUrl = `/admin/projects/${f.project.code}`;
  const [device] = await f.db.select().from(schema.devices).where(eq(schema.devices.principal_id, f.users.owner.id));
  const feature = await insertFeature(f.db, { project_id: f.project.id, title: 'Force archive execution' });
  const neighbor = await insertProject(f.db, { team_id: f.team.id, name: 'Neighbor', created_at: createdAt });
  const neighborFeature = await insertFeature(f.db, { project_id: neighbor.id, title: 'Unaffected execution' });
  const taskWithRun = async ({ at = feature, status = 'running', runStatus = 'active', profile = 'builder' } = {}) => {
    const [task] = await f.db.insert(schema.tasks).values({ feature_id: at.id, title: 'Task for archival', profile: 'builder',
      source: 'ad-hoc', status, assignee_principal_id: f.users.owner.id, acceptance: JSON.stringify([{ id: 'AC-1', text: 'Test' }]),
      base_snapshot: 8, execution_epoch: 3, created_at: createdAt }).returning();
    const [run] = await f.db.insert(schema.runs).values({ task_id: task.id, principal_id: f.users.owner.id,
      profile, workspace_id: 1n, status: runStatus, base_snapshot: task.base_snapshot, execution_epoch: task.execution_epoch,
      started_at: createdAt }).returning();
    return { task, run };
  };
  const running = await taskWithRun();
  const moving = await taskWithRun({ runStatus: 'suspended' });
  const verifying = await taskWithRun({ status: 'submitted', profile: 'verifier' });
  const selfTested = await taskWithRun({ status: 'self_tested' });
  const failed = await taskWithRun({ status: 'failed' });
  const previous = await taskWithRun({ status: 'verified', runStatus: 'completed' });
  const [leftoverSession] = await f.db.insert(schema.agentSessions).values({ run_id: previous.run.id, device_id: device.id,
    execution_epoch: 3, start_key: 'terminal-run', agent_command: 'test worker', launch_kind: 'custom', status: 'running',
    started_at: createdAt, last_output: 'previous output' }).returning();
  const [leftoverLease] = await f.db.insert(schema.runLeases).values({ run_id: previous.run.id, device_id: device.id,
    epoch: 3, token_hash: 'older run lease', expires_at: '2099-10-18T00:00:00Z', created_at: createdAt }).returning();
  const outside = await taskWithRun({ at: neighborFeature });
  const [candidate] = await f.db.insert(schema.runs).values({ task_id: moving.task.id, principal_id: f.users.member.id,
    profile: 'builder', workspace_id: 1n, status: 'preparing', base_snapshot: 8, execution_epoch: 3, started_at: createdAt }).returning();
  const [handover] = await f.db.insert(schema.taskHandovers).values({ task_id: moving.task.id, source_run_id: moving.run.id,
    target_principal_id: f.users.member.id, source_device_id: device.id, target_run_id: candidate.id, status: 'ready',
    version: 4, source_epoch: 3, preparation_grant_hash: 'preserve hash', preparation_expires_at: '2099-10-18T00:00:00Z',
    workspace_manifest: '{"snapshot":"preserved"}', created_at: createdAt, updated_at: createdAt, expires_at: '2099-10-18T00:00:00Z' }).returning();
  const [evidence] = await f.db.insert(schema.evidences).values({ task_id: verifying.task.id, run_id: verifying.run.id,
    type: 'manual', result: 'pass', summary: 'Retained before archive', recorded_at: createdAt }).returning();

  const owner = f.users.owner.headers;
  const admin = f.users.system.headers;
  const route = suffix => `/runs/${running.run.code}/${suffix}`;
  const leaseResult = await f.app.inject({ method: 'POST', url: route('lease'), headers: owner, payload: { execution_epoch: 3 } });
  assert.equal(leaseResult.statusCode, 200, leaseResult.body);
  const { lease_token, execution_epoch } = leaseResult.json().data;
  const opened = await f.app.inject({ method: 'POST', url: route('sessions'), headers: owner,
    payload: { lease_token, execution_epoch, start_key: 'force-archive', agent_command: 'test command' } });
  assert.equal(opened.statusCode, 200, opened.body);
  const read = async (table, id) => (await f.db.select().from(table).where(eq(table.id, id)))[0];
  const [started] = await f.db.select().from(schema.agentSessions).where(eq(schema.agentSessions.code, opened.json().data.session_code));
  const sessionId = started.id;
  const change = (headers, payload) => f.app.inject({ method: 'PATCH', url: projectUrl, headers, payload });
  const request = { status: 'archived', reason: 'No further execution', base_snapshot: 0, force_archive: true };
  assert.equal((await change(owner, request)).statusCode, 403);
  assert.equal((await f.app.inject({ method: 'PATCH', url: `/projects/${f.project.code}/status`,
    headers: owner, payload: { status: 'archived', force_archive: true } })).statusCode, 403);
  for (const patch of [{ force_archive: 'true' }, { force_archive: false }, { status: 'active' }, { reason: '  ' }]) {
    const result = await change(admin, { ...request, ...patch });
    assert.equal(result.statusCode, 400, result.body);
  }
  assert.equal((await change(admin, { ...request, base_snapshot: 1 })).statusCode, 409);
  assert.equal((await read(schema.runs, running.run.id)).status, 'active');
  assert.equal((await read(schema.agentSessions, sessionId)).status, 'starting');
  assert.equal((await read(schema.projects, f.project.id)).status, 'active');
  assert.equal((await f.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, 'admin.project.updated'))).length, 0);

  const forced = await change(admin, request);
  assert.equal(forced.statusCode, 200, forced.body);
  assert.deepEqual(forced.json().data.force_archive, {
    cancelled_runs: 6, cancelled_handovers: 1, cancelled_sessions: 2, reset_tasks: 3,
  });
  assert.equal(forced.json().data.current_snapshot, 1);
  assert.equal((await read(schema.projects, f.project.id)).status, 'archived');
  for (const row of [running.run, moving.run, candidate, verifying.run, selfTested.run, failed.run]) {
    const ended = await read(schema.runs, row.id);
    assert.equal(ended.status, 'cancelled');
    assert.ok(ended.finished_at);
  }
  for (const row of [running.task, moving.task, selfTested.task]) {
    const reset = await read(schema.tasks, row.id);
    assert.equal(reset.status, 'assigned');
    assert.equal(reset.assignee_principal_id, f.users.owner.id);
    assert.equal(reset.base_snapshot, 9);
    assert.equal(reset.execution_epoch, 4);
  }
  assert.equal((await read(schema.tasks, verifying.task.id)).status, 'submitted');
  assert.equal((await read(schema.tasks, verifying.task.id)).execution_epoch, 4);
  assert.equal((await read(schema.tasks, failed.task.id)).status, 'failed');
  assert.deepEqual(await read(schema.tasks, previous.task.id), previous.task);
  assert.deepEqual(await read(schema.runs, previous.run.id), previous.run);
  assert.equal((await read(schema.agentSessions, leftoverSession.id)).status, 'cancelled');
  assert.equal((await read(schema.agentSessions, leftoverSession.id)).last_output, 'previous output');
  assert.ok((await read(schema.runLeases, leftoverLease.id)).revoked_at);
  assert.deepEqual(await read(schema.runs, outside.run.id), outside.run);
  assert.deepEqual(await read(schema.tasks, outside.task.id), outside.task);
  assert.deepEqual(await read(schema.evidences, evidence.id), evidence);
  const session = await read(schema.agentSessions, sessionId);
  assert.equal(session.status, 'cancelled');
  assert.ok(session.finished_at);
  const [revoked] = await f.db.select().from(schema.runLeases).where(eq(schema.runLeases.run_id, running.run.id));
  assert.ok(revoked.revoked_at);
  const cancelled = await read(schema.taskHandovers, handover.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.version, 5);
  assert.equal(cancelled.workspace_manifest, handover.workspace_manifest);
  assert.equal(cancelled.preparation_expires_at, revoked.revoked_at);
  const [audit] = await f.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, 'admin.project.updated'));
  assert.equal(audit.principal_id, f.users.system.id);
  assert.equal(JSON.parse(audit.payload).reason, request.reason);
  assert.deepEqual(JSON.parse(audit.payload).force_archive, forced.json().data.force_archive);

  const renew = () => f.app.inject({ method: 'POST', url: route('lease/renew'), headers: owner, payload: { lease_token, execution_epoch } });
  assert.equal((await renew()).json().error.code, 'run_inactive');
  const restored = await change(admin, { status: 'active', reason: 'Resume project', base_snapshot: 1 });
  assert.equal(restored.statusCode, 200, restored.body);
  assert.equal((await renew()).json().error.code, 'run_inactive');
  const reassign = await f.app.inject({ method: 'POST', url: `/tasks/${failed.task.code}/assign`, headers: owner,
    payload: { assignee_principal_code: f.users.owner.code, base_snapshot: 9 } });
  assert.equal(reassign.statusCode, 200, reassign.body);
  assert.equal(reassign.json().data.status, 'assigned');
  assert.equal((await f.app.inject({ method: 'POST', url: `/runs/${running.run.code}/resume`, headers: owner, payload: {} })).json().ok, false);
  const claim = await f.app.inject({ method: 'POST', url: `/tasks/${running.task.code}/claim`, headers: owner,
    payload: { profile: 'builder', base_snapshot: 9, workspace_path: 'C:/fixture/new-worktree', git_base: 'a'.repeat(40),
      run_code: '00000000000000001001', workspace_code: '00000000000000001002' } });
  assert.equal(claim.statusCode, 200, claim.body);
  assert.notEqual(claim.json().data.run_code, running.run.code);
  const [freshRun] = await f.db.select().from(schema.runs).where(eq(schema.runs.code, claim.json().data.run_code));
  assert.equal(freshRun.execution_epoch, 4);
});

test('stale administrator edits cannot restore an archived project or overwrite newer metadata', async () => {
  const f = await fixture();
  const headers = f.users.system.headers;
  const url = `/admin/projects/${f.project.code}`;
  const page = (await f.app.inject({ method: 'GET', url: '/admin/projects', headers })).json().data;
  const original = page.items[0];
  assert.equal(original.current_snapshot, 0);
  assert.equal(original.status, 'active');
  for (const base_snapshot of [undefined, '0', -1, 0.5]) {
    const invalid = await f.app.inject({ method: 'PATCH', url, headers, payload: { base_snapshot, name: 'Invalid revision', reason: 'Needs revision' } });
    assert.equal(invalid.statusCode, 400);
  }
  const archived = await f.app.inject({ method: 'PATCH', url, headers, payload: { base_snapshot: 0, status: 'archived', description: 'New archive decision', reason: 'Retired project' } });
  assert.equal(archived.statusCode, 200, archived.body);
  for (const fields of [{ name: 'Old dialog rename', status: original.status, description: original.description }, { name: 'Old partial edit' }]) {
    const stale = await f.app.inject({ method: 'PATCH', url, headers, payload: { base_snapshot: original.current_snapshot, ...fields, reason: 'Stale dialog save' } });
    assert.equal(stale.statusCode, 409, stale.body);
    assert.equal(stale.json().error.code, 'admin_revision_conflict');
    assert.equal(stale.json().error.details.current_snapshot, 1);
  }
  const [project] = await f.db.select().from(schema.projects).where(eq(schema.projects.id, f.project.id));
  assert.equal(project.status, 'archived');
  assert.equal(project.name, original.name);
  assert.equal(project.description, 'New archive decision');
  assert.equal(project.current_snapshot, 1);
  assert.equal((await f.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, 'admin.project.updated'))).length, 1);
});

async function waitForProjectLock(db, blockerPid, settled, stage = 'row') {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { rows } = await db.$client.query(`select pid from pg_stat_activity
      where $1::integer = any(pg_blocking_pids(pid))
        and (($2 = 'row' and query like '%"projects"%' and query ilike '%for update%')
          or ($2 = 'task' and query like '%"tasks"%' and query ilike '%for update%')
          or ($2 = 'fence' and query ilike '%pg_advisory_xact_lock%'))`, [blockerPid, stage]);
    if (rows.length) return rows[0].pid;
    assert.equal(settled(), false, 'Project write must reach the lock barrier before completing');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Project write did not wait on the expected database lock');
}


test('force archive waits for an in-flight task write and leaves the completed submission intact', async () => {
  const f = await fixture();
  const feature = await insertFeature(f.db, { project_id: f.project.id, title: 'Task write in progress' });
  const [task] = await f.db.insert(schema.tasks).values({ feature_id: feature.id, title: 'Task submission in flight',
    profile: 'builder', source: 'ad-hoc', status: 'running', acceptance: '[]', base_snapshot: 2, created_at: createdAt }).returning();
  const [run] = await f.db.insert(schema.runs).values({ task_id: task.id, principal_id: f.users.owner.id,
    profile: 'builder', workspace_id: 1n, status: 'active', base_snapshot: 2, started_at: createdAt }).returning();
  const blocker = await f.db.$client.connect();
  const owner = f.users.owner.headers;
  const lease = await f.app.inject({ method: 'POST', url: `/runs/${run.code}/lease`, headers: owner, payload: {} });
  assert.equal(lease.statusCode, 200, lease.body);
  let archiving;
  let starting;
  let creating;
  try {
    await blocker.query('begin');
    await blocker.query('select id from tasks where id=$1 for update', [task.id]);
    const pid = (await blocker.query('select pg_backend_pid() as pid')).rows[0].pid;
    let settled = false;
    archiving = f.app.inject({ method: 'PATCH', url: `/admin/projects/${f.project.code}`,
      headers: f.users.system.headers, payload: { status: 'archived', reason: 'Stop remaining activity', base_snapshot: 0, force_archive: true } })
      .then(result => { settled = true; return result; });
    const archivePid = await waitForProjectLock(f.db, pid, () => settled, 'task');
    let startSettled = false;
    starting = f.app.inject({ method: 'POST', url: `/runs/${run.code}/sessions`, headers: owner,
      payload: { ...lease.json().data, start_key: 'wait for archive fence', agent_command: 'test command' } })
      .then(result => { startSettled = true; return result; });
    await waitForProjectLock(f.db, archivePid, () => startSettled, 'fence');
    let createSettled = false;
    creating = f.app.inject({ method: 'POST', url: '/tasks', headers: owner,
      payload: { feature_code: feature.code, title: 'Do not save after archive', profile: 'builder', source: 'ad-hoc',
        acceptance: [{ id: 'AC-1', text: 'Test' }] } })
      .then(result => { createSettled = true; return result; });
    await waitForProjectLock(f.db, archivePid, () => createSettled, 'fence');
    await blocker.query("update tasks set status='submitted',base_snapshot=3 where id=$1", [task.id]);
    await blocker.query("update runs set status='completed',finished_at=$2 where id=$1", [run.id, createdAt]);
    await blocker.query(`insert into evidences(task_id,run_id,type,result,summary,recorded_at)
      values ($1,$2,'self_test','pass','Completed before archive',$3)`, [task.id, run.id, createdAt]);
    await blocker.query('commit');
    const archived = await archiving;
    assert.equal(archived.statusCode, 200, archived.body);
    assert.equal((await starting).json().error.code, 'run_inactive');
    assert.equal((await creating).json().error.code, 'project_archived');
    assert.equal((await f.db.select().from(schema.tasks).where(eq(schema.tasks.feature_id, feature.id))).length, 1);
    assert.deepEqual(archived.json().data.force_archive, {
      cancelled_runs: 0, cancelled_handovers: 0, cancelled_sessions: 0, reset_tasks: 0,
    });
    const [submitted] = await f.db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id));
    assert.equal(submitted.status, 'submitted');
    assert.equal(submitted.base_snapshot, 3);
    const [completed] = await f.db.select().from(schema.runs).where(eq(schema.runs.id, run.id));
    assert.equal(completed.status, 'completed');
    assert.equal((await f.db.select().from(schema.evidences).where(eq(schema.evidences.task_id, task.id)))[0].summary,
      'Completed before archive');
  } finally {
    await blocker.query('rollback');
    blocker.release();
    await Promise.allSettled([archiving, starting, creating]);
  }
});

for (const operation of ['rename', 'archive', 'repository-create', 'repository-update']) {
  test(`normal ${operation} racing an administrator edit keeps project snapshots monotonic`, async () => {
    const f = await fixture();
    const projects = createProjectUseCasesProject(f.db);
    let repository;
    if (operation === 'repository-update') {
      [repository] = await f.db.insert(schema.projectRepositories).values({ project_id: f.project.id,
        name: 'Existing repo', remote_url: 'https://example.com/existing.git', created_by: f.users.owner.id,
        created_at: createdAt, updated_at: createdAt }).returning();
    }
    const blocker = await f.db.$client.connect();
    let blocking = false;
    let administratorWrite;
    let businessWrite;
    try {
      await blocker.query('begin');
      blocking = true;
      await blocker.query('select id from projects where id = $1 for update', [f.project.id.toString()]);
      const blockerPid = (await blocker.query('select pg_backend_pid() as pid')).rows[0].pid;
      let adminSettled = false;
      administratorWrite = createAdminGovernanceUseCases(f.db).updateProject({ principalCode: f.users.system.code,
        projectCode: f.project.code, baseSnapshot: 0, name: 'Admin revised project', description: 'Admin concurrent description',
        reason: 'Concurrent administrative correction' }).then(result => { adminSettled = true; return result; });
      const adminPid = await waitForProjectLock(f.db, blockerPid, () => adminSettled);
      const command = { principalCode: f.users.owner.code, projectCode: f.project.code };
      let businessSettled = false;
      businessWrite = (operation === 'rename' ? projects.updateProject({ ...command, name: 'Owner revised project' })
        : operation === 'archive' ? projects.updateProjectStatus({ ...command, status: 'archived' })
          : operation === 'repository-create' ? projects.createProjectRepository({ ...command, name: 'New repo', remoteUrl: 'https://example.com/new.git' })
            : projects.updateProjectRepository({ principalCode: command.principalCode, repositoryCode: repository.code, name: 'Changed repo' }))
        .then(result => { businessSettled = true; return result; });
      // The business operation has read snapshot 0 and waits on the project fence
      // before any row locks. It must then increment the newly locked row.
      await waitForProjectLock(f.db, adminPid, () => businessSettled, 'fence');
      await blocker.query('commit');
      blocking = false;
      const adminResult = await administratorWrite;
      assert.equal(adminResult.ok, true, JSON.stringify(adminResult));
      assert.equal(adminResult.data.current_snapshot, 1);
      const businessResult = await businessWrite;
      assert.equal(businessResult.ok, true, JSON.stringify(businessResult));
      const [project] = await f.db.select().from(schema.projects).where(eq(schema.projects.id, f.project.id));
      assert.equal(project.current_snapshot, 2, 'Normal writes must not reset snapshot 2 to the pre-lock snapshot 1');
      assert.equal(project.description, 'Admin concurrent description', 'Unspecified metadata must retain the locked current value');
      const auditAction = { rename: 'project.updated', archive: 'project.archived',
        'repository-create': 'project.repository_created', 'repository-update': 'project.repository_updated' }[operation];
      const [audit] = await f.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, auditAction));
      assert.equal(audit.base_snapshot, 1);
      if (operation === 'rename') assert.equal(JSON.parse(audit.payload).name.from, 'Admin revised project');
      const staleAdmin = await createAdminGovernanceUseCases(f.db).updateProject({ principalCode: f.users.system.code,
        projectCode: f.project.code, baseSnapshot: 1, name: 'Stale admin save', status: 'active', reason: 'Old dialog' });
      assert.equal(staleAdmin.ok, false);
      assert.equal(staleAdmin.error.code, 'admin_revision_conflict');
    } finally {
      if (blocking) await blocker.query('rollback');
      await Promise.allSettled([administratorWrite, businessWrite].filter(Boolean));
      blocker.release();
    }
  });
}

test('reenabling normal users is audited, refuses deletion, and cannot revive old device credentials', async () => {
  const f = await fixture();
  const endpoint = `/users/${f.users.disabled.code}/enable`;
  assert.equal((await f.app.inject({ method: 'POST', url: endpoint, headers: f.users.owner.headers })).json().error.code, 'user_forbidden');
  const result = await f.app.inject({ method: 'POST', url: endpoint, headers: f.users.system.headers });
  assert.equal(result.json().ok, true, result.body);
  assert.equal((await f.db.select().from(schema.users).where(eq(schema.users.id, f.users.disabled.id)))[0].status, 'active');
  assert.equal((await f.app.inject({ method: 'GET', url: '/auth/whoami', headers: f.users.disabled.headers })).statusCode, 401);
  assert.equal((await f.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, 'user.enabled'))).length, 1);
  await f.db.update(schema.users).set({ status: 'disabled', deleted_at: createdAt }).where(eq(schema.users.id, f.users.disabled.id));
  assert.equal((await f.app.inject({ method: 'POST', url: endpoint, headers: f.users.system.headers })).json().error.code, 'user_deleted');
  assert.equal((await f.app.inject({ method: 'POST', url: `/users/${f.users.system.code}/enable`, headers: f.users.system.headers })).json().error.code, 'user_system_admin_protected');
});
