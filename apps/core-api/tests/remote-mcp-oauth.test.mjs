import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { eq } from 'drizzle-orm';
import { hashPassword, hashToken, resetLocalAdminPassword } from '@team-synergy/application';
import { schema } from '@team-synergy/persistence';
import { registerAuthMiddleware } from '../dist/auth.js';
import { registerAuthRoutes } from '../dist/routes/auth.js';
import { registerUserRoutes } from '../dist/routes/users.js';
import { registerRemoteMcpGrantRoutes, resolveRemoteMcpGrant } from '../dist/remote-mcp-authorization.js';
import { registerRemoteMcpOAuthRoutes, remoteMcpResourceMetadataUrl } from '../dist/remote-mcp-oauth.js';
import { closeTestDb, insertProject, insertProjectMember, insertTeam, insertUser, openTestDb } from './test-db.mjs';

const base = '/mcp/oauth';
const metadata = '/.well-known/oauth-authorization-server';
const protectedMetadata = '/.well-known/oauth-protected-resource';
const issuer = 'https://synergy.example';
const resource = issuer + '/api/mcp';
const redirect = 'https://agent.example/api/mcp/callback?connection=teams';
const password = 'FixtureOAuthPassword123!';
const verifier = 'A'.repeat(43);
const state = 'client-state-456';
const challenge = createHash('sha256').update(verifier).digest('base64url');

async function fixture(t) {
  const db = await openTestDb();
  const app = Fastify({ logger: false });
  t.after(async () => {
    await app.close();
    await closeTestDb(db);
  });
  registerAuthMiddleware(app, db, (method, path) =>
    (method === 'GET' && [metadata, protectedMetadata, base + '/authorize'].includes(path))
    || (method === 'POST' && [base + '/register', base + '/token'].includes(path)));
  registerAuthRoutes(app, db);
  registerUserRoutes(app, db);
  registerRemoteMcpGrantRoutes(app, db);
  registerRemoteMcpOAuthRoutes(app, db, { resourceUrl: resource });

  const created_at = new Date().toISOString();
  const password_hash = await hashPassword(password);
  const actor = await insertUser(db, { account: 'oauth.member', display_name: 'OAuth member', password_hash, created_at });
  const viewer = await insertUser(db, { account: 'oauth.viewer', display_name: 'OAuth viewer', password_hash, created_at });
  const team = await insertTeam(db, { name: 'Test Org', created_by: viewer.id, owner_principal_id: viewer.id, created_at });
  const project = await insertProject(db, { name: 'OAuth project', team_id: team.id, member_policy: 'private', owner_principal_id: actor.id, created_by: actor.id, created_at });
  const hidden = await insertProject(db, { name: 'Other project', team_id: team.id, member_policy: 'private', owner_principal_id: viewer.id, created_by: viewer.id, created_at });
  await insertProjectMember(db, { project_id: project.id, principal_id: viewer.id, role: 'viewer', display_name: viewer.display_name, created_at });

  async function login(user, loginPassword = password) {
    const headers = { host: 'localhost:8080', origin: 'http://localhost:8080' };
    const response = await app.inject({ method: 'POST', url: '/auth/web/login', headers,
      payload: { account: user.account, password: loginPassword, device_name: 'test browser' } });
    assert.equal(response.statusCode, 200);
    const cookie = response.headers['set-cookie'].map(value => value.split(';', 1)[0]).join('; ');
    return { ...headers, cookie, 'x-csrf-token': response.json().data.csrf_token };
  }

  function register(input = {}) {
    return app.inject({ method: 'POST', url: base + '/register', payload: {
      client_name: 'Personal Agent', redirect_uris: [redirect],
      grant_types: ['authorization_code', 'refresh_token'], token_endpoint_auth_method: 'none', ...input,
    } });
  }

  function authorizationQuery(client, params = {}) {
    return new URLSearchParams({
      client_id: client.client_id, redirect_uri: redirect, response_type: 'code', code_challenge: challenge,
      code_challenge_method: 'S256', resource, state, scope: 'project:read tasks:write', ...params,
    });
  }

  function authorize(client, params = {}) {
    return app.inject({ url: base + '/authorize?' + authorizationQuery(client, params) });
  }

  function token(input, headers = {}) {
    const payload = input instanceof URLSearchParams ? input : new URLSearchParams(input);
    return app.inject({ method: 'POST', url: base + '/token', headers: {
      'content-type': 'application/x-www-form-urlencoded', ...headers,
    }, payload: payload.toString() });
  }

  async function consentPath(client, params) {
    const authorization = await authorize(client, params);
    assert.equal(authorization.statusCode, 303);
    const url = new URL(authorization.headers.location);
    assert.equal(url.origin, issuer);
    assert.equal(url.pathname, '/agent/connect/authorize');
    assert.match(url.searchParams.get('request'), /^[a-f0-9]{64}$/);
    return base + '/requests/' + url.searchParams.get('request');
  }

  return { app, db, actor, viewer, project, hidden, login, register, authorizationQuery, authorize, consentPath, token };
}

async function approvedCode(f, client, headers, flags = {}) {
  const path = await f.consentPath(client);
  assert.equal((await f.app.inject({ url: path, headers })).statusCode, 200);
  const response = await f.app.inject({ method: 'POST', url: path, headers,
    payload: { decision: 'allow', projectCode: f.project.code, ...flags } });
  assert.equal(response.statusCode, 200, response.body);
  const callback = new URL(response.json().data.redirectUrl);
  assert.equal(callback.origin, 'https://agent.example');
  assert.equal(callback.pathname, '/api/mcp/callback');
  assert.equal(callback.searchParams.get('connection'), 'teams');
  assert.equal(callback.searchParams.get('state'), state);
  assert.equal(callback.searchParams.get('iss'), issuer);
  const code = callback.searchParams.get('code');
  assert.match(code, /^[a-f0-9]{64}$/);
  return { client_id: client.client_id, grant_type: 'authorization_code', resource,
    redirect_uri: redirect, code_verifier: verifier, code };
}

test('discovery advertises the public resource, issuer and S256 code flow', async t => {
  const { app } = await fixture(t);
  assert.equal(remoteMcpResourceMetadataUrl(resource), issuer + '/api' + protectedMetadata);
  const primary = await app.inject({ url: protectedMetadata });
  assert.equal(primary.statusCode, 200);
  assert.deepEqual(primary.json(), { resource, authorization_servers: [issuer], scopes_supported: ['project:read'], bearer_methods_supported: ['header'] });
  const discovery = (await app.inject({ url: metadata })).json();
  assert.equal(discovery.issuer, issuer);
  assert.equal(discovery.authorization_endpoint, issuer + '/api' + base + '/authorize');
  assert.equal(discovery.token_endpoint, issuer + '/api' + base + '/token');
  assert.equal(discovery.registration_endpoint, issuer + '/api' + base + '/register');
  assert.deepEqual(discovery.code_challenge_methods_supported, ['S256']);
  assert.ok(discovery.scopes_supported.includes('workspace:write'));
  assert.equal(discovery.authorization_response_iss_parameter_supported, true);
});

test('registration rejects unsafe and duplicate callbacks; authorize errors cannot redirect a browser', async t => {
  const f = await fixture(t);
  for (const redirect_uris of [
    ['http://agent.example/callback'], ['https://user:pass@agent.example/callback'],
    ['https://agent.example/callback#fragment'], ['https://agent.example/callback?code=prefilled'],
    ['https://agent.example/callback', 'https://agent.example/callback'],
    ['javascript:alert(1)'],
  ]) {
    const response = await f.register({ redirect_uris });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, 'invalid_redirect_uri');
  }
  const client = (await f.register()).json();
  for (const options of [
    { redirect_uri: 'https://agent.example/api/mcp/callback' },
    { redirect_uri: 'https://unregistered.example/callback' },
    { code_challenge_method: 'plain' },
    { code_challenge: '' },
    { resource: 'https://elsewhere.example/mcp' },
    { scope: 'unknown:write' },
  ]) {
    const response = await f.authorize(client, options);
    assert.equal(response.statusCode, 400);
    assert.equal(response.headers.location, undefined);
  }
  const repeated = f.authorizationQuery(client);
  repeated.append('redirect_uri', redirect);
  const malformed = await f.app.inject({ url: base + '/authorize?' + repeated });
  assert.equal(malformed.statusCode, 400);
  assert.equal(malformed.headers.location, undefined);
});

test('consent requires a current browser session, matching CSRF and the approver project role', async t => {
  const f = await fixture(t);
  const client = (await f.register()).json();
  const path = await f.consentPath(client, { scope: 'project:read tasks:write workspace:write' });
  const actor = await f.login(f.actor);
  const viewer = await f.login(f.viewer);
  const denial = { decision: 'deny' };
  const approval = { decision: 'allow', projectCode: f.project.code, allowTaskWrite: true };
  assert.equal((await f.app.inject({ url: path })).statusCode, 401);
  assert.equal((await f.app.inject({ method: 'POST', url: path, headers: viewer, payload: approval })).statusCode, 404);
  const pending = await f.app.inject({ url: path, headers: viewer });
  assert.deepEqual(pending.json(), { ok: true, data: { clientName: 'Personal Agent', redirectOrigin: 'https://agent.example',
    requestedTaskWrite: true, requestedWorkspaceWrite: true, requestedPersonalMemory: false } });
  assert.equal((await f.app.inject({ url: path, headers: actor })).statusCode, 404);
  assert.equal((await f.app.inject({ method: 'POST', url: path, headers: actor, payload: denial })).statusCode, 404);
  assert.equal((await f.app.inject({ method: 'POST', url: path, headers: { ...viewer, 'x-csrf-token': 'forged' }, payload: denial })).statusCode, 403);
  assert.equal((await f.app.inject({ method: 'POST', url: path, headers: viewer, payload: approval })).statusCode, 403);
  assert.equal((await f.app.inject({ method: 'POST', url: path, headers: viewer,
    payload: { ...approval, allowTaskWrite: false, allowWorkspaceWrite: true } })).statusCode, 403);
  const denied = await f.app.inject({ method: 'POST', url: path, headers: viewer, payload: denial });
  assert.equal(denied.statusCode, 200);
  const callback = new URL(denied.json().data.redirectUrl);
  assert.equal(callback.searchParams.get('error'), 'access_denied');
  assert.equal(callback.searchParams.get('state'), state);
  assert.equal(callback.searchParams.has('code'), false);
  assert.equal((await f.app.inject({ url: path, headers: viewer })).statusCode, 404);
  assert.equal((await f.db.select().from(schema.remoteMcpGrants)).length, 0);
});

test('OAuth binds one-time codes to PKCE, the registered client, callback and MCP resource', async t => {
  const f = await fixture(t);
  const client = (await f.register()).json();
  const otherClient = (await f.register()).json();
  const headers = await f.login(f.actor);
  const form = await approvedCode(f, client, headers, { allowTaskWrite: true, allowPersonalMemory: true, allowWorkspaceWrite: true });
  for (const additions of [
    { code_verifier: 'B'.repeat(43) }, { client_id: otherClient.client_id },
    { redirect_uri: redirect + '2' }, { resource: 'https://elsewhere.example/mcp' },
  ]) {
    const rejected = await f.token({ ...form, ...additions });
    assert.equal(rejected.statusCode, 400, rejected.body);
  }
  const duplicate = new URLSearchParams(form);
  duplicate.append('code', form.code);
  assert.equal((await f.token(duplicate)).statusCode, 400);
  const responses = await Promise.all([f.token(form), f.token(form)]);
  assert.deepEqual(responses.map(response => response.statusCode).sort(), [200, 400]);
  const response = responses.find(response => response.statusCode === 200);
  const data = response.json();
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.match(data.access_token, /^tsp_mcp_[a-f0-9]{64}$/);
  assert.match(data.refresh_token, /^tsp_mcp_refresh_[a-f0-9]{64}$/);
  assert.equal(data.expires_in, 3600);
  assert.equal(data.scope, 'project:read tasks:write memory:personal:read workspace:write');
  assert.equal(await resolveRemoteMcpGrant(f.db, data.access_token), null);
  assert.equal(await resolveRemoteMcpGrant(f.db, data.access_token, 'https://another.example/api/mcp'), null);
  const grant = await resolveRemoteMcpGrant(f.db, data.access_token, resource);
  assert.deepEqual(grant, { connectionCode: grant.connectionCode, principalCode: f.actor.code, projectCode: f.project.code, allowTaskWrite: true, allowPersonalMemory: true, allowWorkspaceWrite: true });
  assert.equal((await f.app.inject({ url: '/auth/whoami', headers: { authorization: 'Bearer ' + data.access_token } })).statusCode, 401);
  const [persisted] = await f.db.select().from(schema.remoteMcpGrants);
  assert.equal(persisted.token_hash, hashToken(data.access_token));
  const [refreshRecord] = await f.db.select().from(schema.remoteMcpOAuthRefreshTokens);
  assert.equal(refreshRecord.token_hash, hashToken(data.refresh_token));
  const revoke = await f.app.inject({ method: 'DELETE', url: '/account/mcp-connections/' + grant.connectionCode, headers });
  assert.equal(revoke.statusCode, 200);
  assert.equal(await resolveRemoteMcpGrant(f.db, data.access_token, resource), null);
});

test('refresh replaces access and refresh tokens, revoking the entire connection on reuse', async t => {
  const f = await fixture(t);
  const client = (await f.register()).json();
  const headers = await f.login(f.actor);
  const issued = (await f.token(await approvedCode(f, client, headers))).json();
  const refresh = { grant_type: 'refresh_token', client_id: client.client_id, refresh_token: issued.refresh_token, resource };
  assert.equal((await f.token({ ...refresh, scope: 'project:read workspace:write' })).statusCode, 400);
  const rotated = await f.token(refresh);
  assert.equal(rotated.statusCode, 200, rotated.body);
  const next = rotated.json();
  assert.equal(next.scope, 'project:read');
  assert.notEqual(next.access_token, issued.access_token);
  assert.notEqual(next.refresh_token, issued.refresh_token);
  assert.equal(await resolveRemoteMcpGrant(f.db, issued.access_token, resource), null);
  assert.ok(await resolveRemoteMcpGrant(f.db, next.access_token, resource));

  const repeated = await f.token(refresh);
  assert.equal(repeated.statusCode, 400);
  assert.equal(repeated.json().error, 'invalid_grant');
  assert.equal(await resolveRemoteMcpGrant(f.db, next.access_token, resource), null);
  assert.equal((await f.token({ ...refresh, refresh_token: next.refresh_token })).statusCode, 400);
});

test('account OAuth consent without a project remains valid for exchange and refresh across project changes', async t => {
  const f = await fixture(t);
  const client = (await f.register()).json();
  const headers = await f.login(f.actor);
  const accountCode = await approvedCode(f, client, headers, { projectCode: undefined, allowTaskWrite: true, allowWorkspaceWrite: true });
  const pinnedCode = await approvedCode(f, client, headers, { allowTaskWrite: true });

  await f.db.update(schema.projects).set({ status: 'archived' }).where(eq(schema.projects.id, f.project.id));
  const accountResponse = await f.token(accountCode);
  assert.equal(accountResponse.statusCode, 200, accountResponse.body);
  const account = accountResponse.json();
  assert.equal(account.scope, 'project:read tasks:write workspace:write');
  assert.equal((await f.token(pinnedCode)).json().error, 'invalid_grant');
  const grant = await resolveRemoteMcpGrant(f.db, account.access_token, resource);
  assert.deepEqual(grant, { connectionCode: grant.connectionCode, principalCode: f.actor.code, projectCode: null, allowTaskWrite: true, allowPersonalMemory: false, allowWorkspaceWrite: true });

  const refresh = { client_id: client.client_id, grant_type: 'refresh_token', refresh_token: account.refresh_token, resource };
  const rotated = await f.token(refresh);
  assert.equal(rotated.statusCode, 200, rotated.body);
  assert.equal(rotated.json().scope, account.scope);
  assert.deepEqual(await resolveRemoteMcpGrant(f.db, rotated.json().access_token, resource), grant);
});

test('confidential clients must present their one-time disclosed secret through their registered auth method', async t => {
  const f = await fixture(t);
  const registration = await f.register({ token_endpoint_auth_method: 'client_secret_basic' });
  assert.equal(registration.statusCode, 201);
  const client = registration.json();
  const [record] = await f.db.select().from(schema.remoteMcpOAuthClients).where(eq(schema.remoteMcpOAuthClients.id, client.client_id));
  assert.equal(record.secret_hash, hashToken(client.client_secret));
  const form = await approvedCode(f, client, await f.login(f.actor));
  assert.equal((await f.token(form)).statusCode, 400);
  assert.equal((await f.token({ ...form, client_secret: client.client_secret })).statusCode, 400);
  const basic = 'Basic ' + Buffer.from(client.client_id + ':' + client.client_secret).toString('base64');
  const response = await f.token(form, { authorization: basic });
  assert.equal(response.statusCode, 200, response.body);
});


test('expired unclaimed clients and expired consent requests cannot issue credentials', async t => {
  const f = await fixture(t);
  const stale = (await f.register()).json();
  await f.db.update(schema.remoteMcpOAuthClients).set({ created_at: new Date(Date.now() - 25 * 3600_000) })
    .where(eq(schema.remoteMcpOAuthClients.id, stale.client_id));
  const rejected = await f.authorize(stale);
  assert.equal(rejected.statusCode, 400);
  assert.equal(rejected.headers.location, undefined);

  const client = (await f.register()).json();
  const [expiredClient] = await f.db.select().from(schema.remoteMcpOAuthClients).where(eq(schema.remoteMcpOAuthClients.id, stale.client_id));
  assert.equal(expiredClient, undefined);
  const path = await f.consentPath(client);
  const requestId = path.split('/').at(-1);
  await f.db.update(schema.remoteMcpOAuthRequests).set({ expires_at: new Date(Date.now() - 1_000) })
    .where(eq(schema.remoteMcpOAuthRequests.id, requestId));
  const headers = await f.login(f.actor);
  assert.equal((await f.app.inject({ url: path, headers })).statusCode, 404);
  await f.consentPath(client);
  const [expiredConsent] = await f.db.select().from(schema.remoteMcpOAuthRequests).where(eq(schema.remoteMcpOAuthRequests.id, requestId));
  assert.equal(expiredConsent, undefined);
});

const passwordChange = '/auth/password-change';
const connectionList = '/account/mcp-connections';
const newPassword = 'RotatedConnectorPassword456!';
const recoveryPassword = 'RecoveryConnectorPassword89!';

async function prepareCredentialRotation(f) {
  const headers = await f.login(f.actor);
  const manual = await f.app.inject({ method: 'POST', url: connectionList, headers,
    payload: { name: 'Manual proof' } });
  assert.equal(manual.statusCode, 201);
  const client = (await f.register()).json();
  const issued = await f.token(await approvedCode(f, client, headers, { projectCode: null }));
  assert.equal(issued.statusCode, 200, issued.body);
  const unfinished = await approvedCode(f, client, headers, { projectCode: null });
  const { access_token, refresh_token } = issued.json();
  const oauth = await resolveRemoteMcpGrant(f.db, access_token, resource);
  assert.ok(oauth);
  return { headers, manual: manual.json().data, accessToken: access_token, oauthCode: oauth.connectionCode, unfinished,
    refresh: { grant_type: 'refresh_token', client_id: client.client_id, refresh_token, resource } };
}

async function assertCredentialRotation(f, rotation) {
  assert.equal(await resolveRemoteMcpGrant(f.db, rotation.manual.token, resource), null);
  assert.equal(await resolveRemoteMcpGrant(f.db, rotation.accessToken, resource), null);
  assert.equal((await f.token(rotation.unfinished)).json().error, 'invalid_grant');
  assert.equal((await f.token(rotation.refresh)).json().error, 'invalid_grant');
}

async function changePassword(f, headers, currentPassword, nextPassword) {
  const changed = await f.app.inject({ method: 'POST', url: passwordChange, headers,
    payload: { current_password: currentPassword, new_password: nextPassword } });
  assert.equal(changed.statusCode, 200, changed.body);
  assert.equal(changed.json().ok, true, changed.body);
}

test('ordinary password change permanently revokes access, refresh and approved OAuth codes', async t => {
  const f = await fixture(t);
  const rotation = await prepareCredentialRotation(f);
  await changePassword(f, rotation.headers, password, newPassword);
  await assertCredentialRotation(f, rotation);

  const headers = await f.login(f.actor, newPassword);
  const listed = (await f.app.inject({ url: connectionList, headers })).json().data;
  assert.deepEqual(listed.map(entry => entry.code).sort(), [rotation.manual.connection.code, rotation.oauthCode].sort());
  assert.ok(listed.every(entry => typeof entry.revokedAt === 'string'));
  const fresh = await f.app.inject({ method: 'POST', url: connectionList, headers,
    payload: { name: 'New connection', projectCode: f.project.code } });
  assert.equal(fresh.statusCode, 201, fresh.body);
  assert.ok(await resolveRemoteMcpGrant(f.db, fresh.json().data.token, resource));
  assert.ok((await f.app.inject({ url: connectionList, headers })).json().data.some(entry => entry.revokedAt === null));
});

test('admin reissue cannot revive a Connector after successful temporary-password replacement', async t => {
  const f = await fixture(t);
  await f.db.update(schema.users).set({ is_system_admin: true }).where(eq(schema.users.id, f.viewer.id));
  const rotation = await prepareCredentialRotation(f);
  const adminHeaders = await f.login(f.viewer);
  const reset = await f.app.inject({ method: 'POST', url: '/users/' + f.actor.code + '/initial-password', headers: adminHeaders });
  assert.equal(reset.json().ok, true, reset.body);
  const temporary = reset.json().data.initial_password;
  await assertCredentialRotation(f, rotation);

  const [before] = await f.db.select().from(schema.remoteMcpGrants).where(eq(schema.remoteMcpGrants.code, rotation.oauthCode));
  const headers = await f.login(f.actor, temporary);
  await changePassword(f, headers, temporary, newPassword);
  await assertCredentialRotation(f, rotation);
  const list = (await f.app.inject({ url: connectionList, headers })).json().data;
  assert.equal(list.find(entry => entry.code === rotation.oauthCode).revokedAt, before.revoked_at.toISOString());
});

test('local administrator recovery permanently invalidates the recovered account’s Connector', async t => {
  const f = await fixture(t);
  await f.db.update(schema.users).set({ is_system_admin: true }).where(eq(schema.users.id, f.actor.id));
  const rotation = await prepareCredentialRotation(f);
  const reset = await resetLocalAdminPassword(f.db, { account: f.actor.account, newPassword: recoveryPassword,
    localOperator: 'fixture-operator', localHostname: 'fixture-host' });
  assert.equal(reset.ok, true, JSON.stringify(reset));
  await assertCredentialRotation(f, rotation);

  const headers = await f.login(f.actor, recoveryPassword);
  await changePassword(f, headers, recoveryPassword, newPassword);
  await assertCredentialRotation(f, rotation);
});
