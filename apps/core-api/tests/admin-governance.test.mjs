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

async function waitForProjectLock(db, blockerPid, settled) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { rows } = await db.$client.query(`select pid from pg_stat_activity
      where $1::integer = any(pg_blocking_pids(pid)) and query like '%"projects"%' and query ilike '%for update%'`, [blockerPid]);
    if (rows.length) return rows[0].pid;
    assert.equal(settled(), false, 'Project write must reach the lock barrier before completing');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Project write did not wait on the expected database lock');
}

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
      // The business operation has read snapshot 0 and is queued behind the
      // administrator. After waiting, it must increment the newly locked row.
      await waitForProjectLock(f.db, adminPid, () => businessSettled);
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
