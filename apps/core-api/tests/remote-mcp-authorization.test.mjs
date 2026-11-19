import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { and, eq } from 'drizzle-orm';
import { hashPassword, hashToken } from '@team-synergy/application';
import { schema } from '@team-synergy/persistence';
import { registerAuthMiddleware } from '../dist/auth.js';
import { registerAuthRoutes } from '../dist/routes/auth.js';
import { registerRemoteMcpGrantRoutes, resolveRemoteMcpGrant } from '../dist/remote-mcp-authorization.js';
import { closeTestDb, insertProject, insertProjectMember, insertTeam, insertUser, openTestDb } from './test-db.mjs';

const endpoint = '/account/mcp-connections';
const origin = 'http://localhost:8080';
const browserHeaders = { host: 'localhost:8080', origin };
const password = 'McpFixturePassword123!';

async function fixture(t) {
  const db = await openTestDb();
  const app = Fastify({ logger: false });
  t.after(async () => {
    await app.close();
    await closeTestDb(db);
  });

  registerAuthMiddleware(app, db);
  registerAuthRoutes(app, db);
  registerRemoteMcpGrantRoutes(app, db);

  const created_at = new Date().toISOString();
  const password_hash = await hashPassword(password);
  const actor = await insertUser(db, { account: 'mcp.fixture', display_name: 'MCP fixture', password_hash, created_at });
  const outsider = await insertUser(db, { account: 'mcp.outsider', display_name: 'MCP outsider', password_hash, created_at });
  const team = await insertTeam(db, { name: 'MCP Test', created_by: outsider.id, owner_principal_id: outsider.id, created_at });
  const project = await insertProject(db, { name: 'Shared project', team_id: team.id, member_policy: 'private', owner_principal_id: outsider.id, created_by: outsider.id, created_at });
  const hidden = await insertProject(db, { name: 'Private project', team_id: team.id, member_policy: 'private', owner_principal_id: outsider.id, created_by: outsider.id, created_at });
  await insertProjectMember(db, { project_id: project.id, principal_id: actor.id, role: 'viewer', display_name: actor.display_name, created_at });

  async function login(user) {
    const response = await app.inject({
      method: 'POST', url: '/auth/web/login', headers: browserHeaders,
      payload: { account: user.account, password, device_name: 'test browser' },
    });
    assert.equal(response.statusCode, 200);
    const cookie = response.headers['set-cookie'].map(value => value.split(';', 1)[0]).join('; ');
    return { ...browserHeaders, cookie, 'x-csrf-token': response.json().data.csrf_token };
  }

  return { app, db, actor, outsider, project, hidden, login };
}

test('connection grants use web cookies and CSRF, show the token once, and cannot authenticate ordinary API requests', async t => {
  const { app, db, actor, project, login } = await fixture(t);
  const headers = await login(actor);
  const payload = { name: '  Review agent  ', projectCode: project.code };
  const { 'x-csrf-token': csrf, ...withoutCsrf } = headers;

  assert.equal((await app.inject({ method: 'GET', url: endpoint })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: endpoint, headers: withoutCsrf, payload })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: endpoint, headers: { ...headers, origin: 'https://unexpected.test' }, payload })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: endpoint, headers, payload: { ...payload, allowPersonalMemory: 'true' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: endpoint, headers, payload: { ...payload, principalCode: actor.code } })).statusCode, 400);

  const normalSession = /(?:^|; )tsp_session=([a-f0-9]{64})(?:;|$)/.exec(headers.cookie)?.[1];
  assert.ok(normalSession);
  const normalBearer = { authorization: 'Bearer ' + normalSession };
  assert.equal((await app.inject({ method: 'GET', url: '/auth/whoami', headers: normalBearer })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: endpoint, headers: normalBearer })).statusCode, 401);
  assert.equal(await resolveRemoteMcpGrant(db, normalSession), null);

  const response = await app.inject({ method: 'POST', url: endpoint, headers: { ...withoutCsrf, 'x-csrf-token': csrf }, payload });
  assert.equal(response.statusCode, 201);
  assert.equal(response.headers['cache-control'], 'no-store');
  const { connection, token } = response.json().data;
  assert.match(token, /^tsp_mcp_[a-f0-9]{64}$/);
  assert.equal(connection.name, 'Review agent');
  assert.equal(connection.projectCode, project.code);
  assert.equal(connection.allowPersonalMemory, false);
  assert.equal(connection.allowTaskWrite, false);
  assert.equal(connection.revokedAt, null);

  const [saved] = await db.select().from(schema.remoteMcpGrants);
  assert.equal(saved.token_hash, hashToken(token));
  assert.equal(saved.expires_at.getTime() - saved.created_at.getTime(), 7 * 24 * 60 * 60 * 1000);
  assert.equal(saved.expires_at.toISOString(), connection.expiresAt);
  assert.deepEqual(await resolveRemoteMcpGrant(db, token), { connectionCode: connection.code, principalCode: actor.code, projectCode: project.code, allowPersonalMemory: false, allowTaskWrite: false });

  const list = await app.inject({ method: 'GET', url: endpoint, headers });
  assert.equal(list.headers['cache-control'], 'no-store');
  assert.deepEqual(list.json().data, [connection]);
  assert.equal(list.body.includes(token), false);
  assert.equal(list.body.includes(saved.token_hash), false);
  assert.equal((await app.inject({ method: 'GET', url: '/auth/whoami', headers: { authorization: 'Bearer ' + token } })).statusCode, 401);
});

test('grant issuance and revocation stay with the grant owner, even for a project owner', async t => {
  const { app, db, actor, outsider, project, hidden, login } = await fixture(t);
  const headers = await login(actor);
  const outsiderHeaders = await login(outsider);
  const payload = { name: 'Research agent', projectCode: project.code, allowPersonalMemory: true };

  const blocked = await app.inject({ method: 'POST', url: endpoint, headers, payload: { ...payload, projectCode: hidden.code } });
  assert.equal(blocked.statusCode, 403);
  const issued = await app.inject({ method: 'POST', url: endpoint, headers, payload });
  assert.equal(issued.statusCode, 201);
  const { connection, token } = issued.json().data;
  assert.deepEqual(await resolveRemoteMcpGrant(db, token), { connectionCode: connection.code, principalCode: actor.code, projectCode: project.code, allowPersonalMemory: true, allowTaskWrite: false });

  const url = endpoint + '/' + connection.code;
  const list = await app.inject({ method: 'GET', url: endpoint, headers: outsiderHeaders });
  assert.deepEqual(list.json().data, []);
  assert.equal((await app.inject({ method: 'DELETE', url, headers: outsiderHeaders })).statusCode, 404);
  assert.equal((await app.inject({ method: 'DELETE', url, headers: { ...headers, 'x-csrf-token': 'forged' } })).statusCode, 403);
  assert.ok(await resolveRemoteMcpGrant(db, token));

  for (const _attempt of [1, 2]) {
    const response = await app.inject({ method: 'DELETE', url, headers });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().data, { code: connection.code });
  }
  assert.equal(await resolveRemoteMcpGrant(db, token), null);

  const ownerList = (await app.inject({ method: 'GET', url: endpoint, headers })).json().data;
  assert.deepEqual(ownerList, [{ ...connection, revokedAt: ownerList[0].revokedAt }]);
  assert.equal(typeof ownerList[0].revokedAt, 'string');
  const audit = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.entity_type, 'remote_mcp_connection'));
  assert.deepEqual(audit.map(row => row.action).sort(), ['remote_mcp.connection_created', 'remote_mcp.connection_revoked']);
  assert.ok(audit.every(row => !row.payload.includes(token) && !row.payload.includes(hashToken(token))));
});

test('grants recheck project availability, membership, account state and expiry', async t => {
  const { app, db, actor, project, login } = await fixture(t);
  const headers = await login(actor);
  async function createGrant() {
    const response = await app.inject({
      method: 'POST', url: endpoint, headers, payload: { name: 'Temporary connection', projectCode: project.code },
    });
    assert.equal(response.statusCode, 201);
    return response.json().data.token;
  }
  const token = await createGrant();

  await db.update(schema.projects).set({ status: 'archived' }).where(eq(schema.projects.id, project.id));
  assert.equal(await resolveRemoteMcpGrant(db, token), null);
  assert.equal((await app.inject({
    method: 'POST', url: endpoint, headers, payload: { name: 'Archived connection', projectCode: project.code },
  })).statusCode, 403);
  await db.update(schema.projects).set({ status: 'active' }).where(eq(schema.projects.id, project.id));

  await db.update(schema.users).set({ pending_deletion: true }).where(eq(schema.users.id, actor.id));
  assert.equal(await resolveRemoteMcpGrant(db, token), null);
  await db.update(schema.users).set({ pending_deletion: false }).where(eq(schema.users.id, actor.id));

  const expired = await createGrant();
  const now = Date.now();
  await db.update(schema.remoteMcpGrants).set({
    created_at: new Date(now - 2 * 24 * 60 * 60 * 1000),
    expires_at: new Date(now - 60_000),
  }).where(eq(schema.remoteMcpGrants.token_hash, hashToken(expired)));
  assert.equal(await resolveRemoteMcpGrant(db, expired), null);
  assert.ok(await resolveRemoteMcpGrant(db, token));

  await db.delete(schema.members).where(and(eq(schema.members.principal_id, actor.id), eq(schema.members.project_id, project.id)));
  assert.equal(await resolveRemoteMcpGrant(db, token), null);
  assert.equal((await app.inject({ method: 'GET', url: endpoint, headers })).json().data.length, 2);
});


test('task write permission is opt-in and reflects the current project role', async t => {
  const { app, db, actor, project, login } = await fixture(t);
  const headers = await login(actor);
  const payload = { name: 'Task collaboration', projectCode: project.code, allowTaskWrite: true };
  const membership = and(eq(schema.members.principal_id, actor.id), eq(schema.members.project_id, project.id));

  assert.equal((await app.inject({
    method: 'POST', url: endpoint, headers, payload: { ...payload, allowTaskWrite: 'true' },
  })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: endpoint, headers, payload })).statusCode, 403);

  await db.update(schema.members).set({ role: 'member' }).where(membership);
  const response = await app.inject({ method: 'POST', url: endpoint, headers, payload });
  assert.equal(response.statusCode, 201);
  const { connection, token } = response.json().data;
  assert.equal(connection.allowTaskWrite, true);
  assert.equal(connection.allowPersonalMemory, false);
  assert.deepEqual(await resolveRemoteMcpGrant(db, token), {
    connectionCode: connection.code, principalCode: actor.code, projectCode: project.code, allowPersonalMemory: false, allowTaskWrite: true,
  });

  await db.update(schema.members).set({ role: 'viewer' }).where(membership);
  assert.deepEqual(await resolveRemoteMcpGrant(db, token), {
    connectionCode: connection.code, principalCode: actor.code, projectCode: project.code, allowPersonalMemory: false, allowTaskWrite: false,
  });
  const list = await app.inject({ method: 'GET', url: endpoint, headers });
  assert.equal(list.json().data[0].allowTaskWrite, true);
});

test('account-scoped manual credentials survive project changes and are still revocable by their owner', async t => {
  const { app, db, actor, project, hidden, login } = await fixture(t);
  const headers = await login(actor);
  const malformed = await app.inject({ method: 'POST', url: endpoint, headers, payload: { name: 'Invalid project', projectCode: '' } });
  assert.equal(malformed.statusCode, 400);

  const issued = await app.inject({ method: 'POST', url: endpoint, headers, payload: { name: 'All account projects', allowTaskWrite: true } });
  assert.equal(issued.statusCode, 201, issued.body);
  const { connection, token } = issued.json().data;
  assert.equal(connection.projectCode, null);
  const granted = { connectionCode: connection.code, principalCode: actor.code, projectCode: null, allowPersonalMemory: false, allowTaskWrite: true };
  assert.deepEqual(await resolveRemoteMcpGrant(db, token), granted);

  await db.update(schema.projects).set({ status: 'archived' }).where(eq(schema.projects.id, project.id));
  await db.delete(schema.projects).where(eq(schema.projects.id, hidden.id));
  assert.deepEqual(await resolveRemoteMcpGrant(db, token), granted);
  assert.deepEqual((await app.inject({ url: endpoint, headers })).json().data, [connection]);

  assert.equal((await app.inject({ method: 'DELETE', url: `${endpoint}/${connection.code}`, headers })).statusCode, 200);
  assert.equal(await resolveRemoteMcpGrant(db, token), null);
});
