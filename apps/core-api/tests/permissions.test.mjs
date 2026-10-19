import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@team-synergy/persistence';
import { buildServer } from '../dist/server.js';
import { closeTestDb, insertFeature, insertProject, insertProjectMember, insertTeam, insertTeamMember, insertUser, openTestDb } from './test-db.mjs';

const fixtures = [];
async function fixture() {
  const db = await openTestDb();
  const app = await buildServer({ db, logger: false });
  fixtures.push({ app, db });
  const created_at = '2026-10-16T00:00:00Z';
  const users = {};
  for (const name of ['owner', 'admin', 'peer', 'member', 'viewer', 'inherited', 'teamAdmin', 'outsider']) {
    const user = await insertUser(db, { account: `permissions.${name}`, display_name: name, status: 'active', created_at });
    const token = `permissions-${name}-token`;
    await db.insert(schema.devices).values({ principal_id: user.id, device_name: name,
      credential_hash: createHash('sha256').update(token).digest('hex'), created_at });
    users[name] = { ...user, headers: { authorization: `Bearer ${token}` } };
  }
  const team = await insertTeam(db, { name: 'Permission team', created_by: users.owner.id, owner_principal_id: users.owner.id, created_at });
  const project = await insertProject(db, { team_id: team.id, name: 'Private permission project', created_by: users.owner.id,
    owner_principal_id: users.owner.id, member_policy: 'private', created_at });
  for (const [name, user] of Object.entries(users)) {
    if (name !== 'outsider') await insertTeamMember(db, { team_id: team.id, principal_id: user.id,
      role: ['owner', 'admin', 'peer', 'teamAdmin'].includes(name) ? 'admin' : 'member', display_name: name, created_at });
    if (['owner', 'admin', 'peer', 'member', 'viewer'].includes(name)) await insertProjectMember(db, {
      project_id: project.id, principal_id: user.id, role: ['owner', 'admin', 'peer'].includes(name) ? 'admin' : name,
      display_name: name, created_at,
    });
  }
  const feature = await insertFeature(db, { project_id: project.id, title: 'Private feature', created_at });
  const [task] = await db.insert(schema.tasks).values({ feature_id: feature.id, title: 'Private task content', profile: 'builder',
    source: 'ad-hoc', status: 'draft', acceptance: '[]', base_snapshot: 0, created_at }).returning();
  return { app, db, users, team, project, feature, task, root: `/projects/${project.code}` };
}
afterEach(async () => { for (const { app, db } of fixtures.splice(0)) { await app.close(); await closeTestDb(db); } });

function request(ctx, user, method, url, payload) {
  return ctx.app.inject({ method, url, headers: user?.headers ?? {}, ...(payload === undefined ? {} : { payload }) });
}
function data(response) {
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().ok, true, response.body);
  return response.json().data;
}
function denied(response, status, code) {
  assert.equal(response.statusCode, status, response.body);
  assert.equal(response.json().ok, false, response.body);
  if (code) assert.equal(response.json().error.code, code, response.body);
}
const documentPayload = { kind: 'doc', title: 'Private document', content: '# Private document body' };

test('protected HTTP reads require authentication and query/body identity cannot impersonate a project member', async () => {
  const ctx = await fixture();
  const { owner, outsider } = ctx.users;
  const doc = data(await request(ctx, owner, 'POST', `${ctx.root}/handoff/documents`, documentPayload));
  for (const url of ['/projects', '/tasks', '/tasks/graph', '/features', '/requirements', '/defects', ctx.root,
    `${ctx.root}/home`, `${ctx.root}/members`, `${ctx.root}/modules`, `${ctx.root}/repositories`, `${ctx.root}/handoff`,
    `${ctx.root}/requirement-documents`, `${ctx.root}/architecture-documents`, `${ctx.root}/design-prototypes`,
    `${ctx.root}/access-policy`, `/tasks/${ctx.task.code}`, `/tasks/${ctx.task.code}/history`,
    `/handoff-documents/${doc.document_code}`, `/teams/${ctx.team.code}/members`, '/ownership-transfers', '/account/closure']) {
    denied(await request(ctx, null, 'GET', `${url}?principal_code=${owner.code}`), 401, 'unauthorized');
  }
  denied(await request(ctx, null, 'POST', `${ctx.root}/handoff/documents`, { ...documentPayload, principal_code: owner.code, user_code: owner.code }), 401, 'unauthorized');
  for (const url of ['/projects', '/tasks', '/requirements', '/defects']) {
    const rows = data(await request(ctx, outsider, 'GET', `${url}?project_code=${ctx.project.code}&principal_code=${owner.code}`));
    assert.deepEqual(rows, [], url);
  }
  denied(await request(ctx, outsider, 'GET', `/features?project_code=${ctx.project.code}&principal_code=${owner.code}`), 403, 'project_forbidden');
  denied(await request(ctx, outsider, 'GET', `${ctx.root}?principal_code=${owner.code}`), 403, 'project_forbidden');
  const leaked = await request(ctx, outsider, 'GET', `/handoff-documents/${doc.document_code}?principal_code=${owner.code}`);
  denied(leaked, 403);
  assert.doesNotMatch(leaked.body, /Private document body/);
});

test('Viewer writes are denied even with forged identities or authorship from an earlier role', async () => {
  const ctx = await fixture();
  const { owner, member, viewer } = ctx.users;
  const original = data(await request(ctx, member, 'POST', `${ctx.root}/handoff/documents`, documentPayload));
  data(await request(ctx, owner, 'PATCH', `${ctx.root}/members/${member.code}`, { role: 'viewer' }));
  const library = data(await request(ctx, viewer, 'GET', `${ctx.root}/handoff`));
  assert.equal(library.can_create, false);
  assert.ok(library.folders.every(folder => folder.can_create_folder === false));
  const forgedViewer = { headers: { ...viewer.headers, 'x-principal-code': owner.code } };
  for (const [url, payload] of [
    [`${ctx.root}/handoff/documents`, documentPayload],
    [`${ctx.root}/handoff/folders`, { name: 'Denied folder' }],
    [`${ctx.root}/architecture-documents`, { title: 'Denied diagram', content_kind: 'mermaid', source_content: 'flowchart LR\nA --> B' }],
    ['/features', { project_code: ctx.project.code, title: 'Denied feature' }],
    ['/defects', { feature_code: ctx.feature.code, title: 'Denied defect', severity: 'high', description: 'No write' }],
  ]) {
    denied(await request(ctx, forgedViewer, 'POST', url, { ...payload, principal_code: owner.code, user_code: owner.code }), 403);
  }
  denied(await request(ctx, member, 'PATCH', `/handoff-documents/${original.document_code}`, {
    ...documentPayload, content: 'Forbidden rewrite', change_summary: 'Former author', principal_code: owner.code,
  }), 403, 'project_document_forbidden');
  const unchanged = data(await request(ctx, owner, 'GET', `/handoff-documents/${original.document_code}`));
  assert.equal(unchanged.content, documentPayload.content);
  assert.equal(unchanged.current_revision, original.current_revision);
});

test('team and project Admins manage ordinary members but cannot edit peers, grant Admin, or replace Owner', async () => {
  const ctx = await fixture();
  const { owner, admin, peer, member, viewer, outsider, teamAdmin } = ctx.users;
  for (const [root, forbidden, protectedOwner] of [[ctx.root, 'member_forbidden', 'project_owner_protected'],
    [`/teams/${ctx.team.code}`, 'team_forbidden', 'team_owner_protected']]) {
    for (const method of ['PATCH', 'DELETE']) {
      denied(await request(ctx, admin, method, `${root}/members/${peer.code}`, method === 'PATCH' ? { role: 'member' } : undefined), 403, forbidden);
      denied(await request(ctx, admin, method, `${root}/members/${owner.code}`, method === 'PATCH' ? { role: 'member' } : undefined), 409, protectedOwner);
    }
    denied(await request(ctx, admin, 'PATCH', `${root}/members/${member.code}`, { role: 'admin', principal_code: owner.code }), 403, forbidden);
    denied(await request(ctx, owner, 'PATCH', `${root}/members/${member.code}`, { role: 'owner' }), 422, 'member_role_invalid');
    denied(await request(ctx, member, 'PATCH', `${root}/members/${viewer.code}`, { role: 'member', principal_code: owner.code }), 403, forbidden);
    data(await request(ctx, owner, 'PATCH', `${root}/members/${peer.code}`, { role: 'member' }));
    data(await request(ctx, admin, 'PATCH', `${root}/members/${peer.code}`, { role: 'member' }));
  }
  denied(await request(ctx, teamAdmin, 'GET', ctx.root), 403, 'project_forbidden');
  data(await request(ctx, admin, 'POST', `${ctx.root}/members`, { user_code: outsider.code, role: 'member' }));
  assert.equal(data(await request(ctx, outsider, 'GET', ctx.root)).is_external, true);
  denied(await request(ctx, outsider, 'GET', `/teams/${ctx.team.code}/members`), 403, 'team_forbidden');
  assert.deepEqual(data(await request(ctx, outsider, 'GET', '/teams')), []);
});

test('policy endpoints provide impact, inherit read/write access, and preserve explicit Viewer restrictions', async () => {
  const ctx = await fixture();
  const { owner, admin, inherited, viewer, outsider } = ctx.users;
  for (const actor of [admin, inherited, viewer, outsider]) {
    denied(await request(ctx, actor, 'GET', `${ctx.root}/access-policy?member_policy=team_write`), 403, 'project_forbidden');
    denied(await request(ctx, actor, 'PUT', `${ctx.root}/access-policy`, { member_policy: 'team_write', principal_code: owner.code }), 403, 'project_forbidden');
  }
  const preview = data(await request(ctx, owner, 'GET', `${ctx.root}/access-policy?member_policy=team_write`));
  assert.equal(preview.impact.gained_read, 2);
  assert.equal(preview.impact.gained_write, 2);
  assert.equal(preview.changes.find(row => row.user_code === inherited.code).after, 'member');
  data(await request(ctx, owner, 'PUT', `${ctx.root}/access-policy`, { member_policy: 'team_read' }));
  let access = data(await request(ctx, inherited, 'GET', ctx.root));
  assert.equal(access.role, 'viewer');
  assert.equal(access.access_source, 'team');
  denied(await request(ctx, inherited, 'POST', `${ctx.root}/handoff/documents`, documentPayload), 403, 'project_forbidden');
  data(await request(ctx, owner, 'PUT', `${ctx.root}/access-policy`, { member_policy: 'team_write' }));
  access = data(await request(ctx, inherited, 'GET', ctx.root));
  assert.equal(access.role, 'member');
  data(await request(ctx, inherited, 'POST', `${ctx.root}/handoff/documents`, documentPayload));
  assert.equal(data(await request(ctx, viewer, 'GET', ctx.root)).role, 'viewer');
  denied(await request(ctx, viewer, 'POST', `${ctx.root}/handoff/documents`, documentPayload), 403, 'project_forbidden');
  denied(await request(ctx, outsider, 'GET', ctx.root), 403, 'project_forbidden');
  data(await request(ctx, owner, 'PUT', `${ctx.root}/access-policy`, { member_policy: 'private' }));
  denied(await request(ctx, inherited, 'GET', ctx.root), 403, 'project_forbidden');
});

test('ownership transfers require the real owner and recipient, preserve creator history, and keep scopes independent', async () => {
  const ctx = await fixture();
  const { owner, admin, member, outsider } = ctx.users;
  const payload = { scope: 'project', scope_code: ctx.project.code, target_user_code: member.code };
  denied(await request(ctx, admin, 'POST', '/ownership-transfers', { ...payload, principal_code: owner.code }), 403, 'ownership_forbidden');
  denied(await request(ctx, owner, 'POST', '/ownership-transfers', { ...payload, target_user_code: outsider.code }), 422, 'ownership_recipient_not_team_member');
  const transfer = data(await request(ctx, owner, 'POST', '/ownership-transfers', payload));
  assert.equal(transfer.status, 'pending');
  assert.deepEqual(data(await request(ctx, outsider, 'GET', `/ownership-transfers?principal_code=${owner.code}`)), []);
  denied(await request(ctx, admin, 'POST', `/ownership-transfers/${transfer.code}/accept`, { principal_code: member.code, user_code: member.code }), 403, 'ownership_recipient_required');
  data(await request(ctx, member, 'POST', `/ownership-transfers/${transfer.code}/accept`));
  const project = data(await request(ctx, member, 'GET', ctx.root));
  assert.equal(project.role, 'owner');
  assert.equal(project.owner_code, member.code);
  assert.equal(project.created_by_code, owner.code);
  assert.equal(data(await request(ctx, owner, 'GET', ctx.root)).role, 'admin');
  const teams = data(await request(ctx, owner, 'GET', '/teams'));
  assert.equal(teams.find(team => team.team_code === ctx.team.code).role, 'owner');
  denied(await request(ctx, owner, 'PUT', `${ctx.root}/access-policy`, { member_policy: 'team_write' }), 403, 'project_forbidden');
  const cancelled = data(await request(ctx, member, 'POST', '/ownership-transfers', { ...payload, target_user_code: admin.code }));
  assert.equal(data(await request(ctx, member, 'POST', `/ownership-transfers/${cancelled.code}/cancel`)).status, 'cancelled');
});

test('account closure blocks owned archived projects, requires transfers in both scopes, and revokes Bearer credentials', async () => {
  const ctx = await fixture();
  const { owner, member } = ctx.users;
  await ctx.db.update(schema.projects).set({ status: 'archived' }).where(eq(schema.projects.id, ctx.project.id));
  const initial = data(await request(ctx, owner, 'GET', '/account/closure'));
  assert.equal(initial.projects[0].status, 'archived');
  assert.equal(initial.teams[0].code, ctx.team.code);
  denied(await request(ctx, owner, 'POST', '/account/closure/complete'), 409, 'account_closure_not_started');
  assert.equal(data(await request(ctx, owner, 'POST', '/account/closure/begin')).pending_deletion, true);
  denied(await request(ctx, owner, 'POST', '/account/closure/complete'), 409, 'account_closure_blocked');
  denied(await request(ctx, owner, 'POST', '/teams', { name: 'No new ownership' }), 409, 'account_pending_deletion');
  assert.equal(data(await request(ctx, owner, 'POST', '/account/closure/cancel')).pending_deletion, false);
  data(await request(ctx, owner, 'POST', '/account/closure/begin'));
  for (const [scope, scope_code] of [['project', ctx.project.code], ['team', ctx.team.code]]) {
    const transfer = data(await request(ctx, owner, 'POST', '/ownership-transfers', { scope, scope_code, target_user_code: member.code }));
    data(await request(ctx, member, 'POST', `/ownership-transfers/${transfer.code}/accept`));
    if (scope === 'project') denied(await request(ctx, owner, 'POST', '/account/closure/complete'), 409, 'account_closure_blocked');
  }
  assert.equal(data(await request(ctx, owner, 'POST', '/account/closure/complete')).closed, true);
  denied(await request(ctx, owner, 'GET', '/projects'), 401, 'unauthorized');
  denied(await request(ctx, owner, 'POST', `${ctx.root}/handoff/documents`, documentPayload), 401, 'unauthorized');
  const [closed] = await ctx.db.select().from(schema.users).where(eq(schema.users.id, owner.id));
  assert.equal(closed.status, 'disabled');
  assert.ok(closed.deleted_at);
  assert.equal(data(await request(ctx, member, 'GET', ctx.root)).created_by_code, owner.code);
  assert.equal(data(await request(ctx, member, 'GET', '/teams'))[0].created_by, owner.code);
});
