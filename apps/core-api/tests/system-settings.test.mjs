import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { schema } from '@team-synergy/persistence';
import { hashToken } from '@team-synergy/application';
import { buildServer } from '../dist/server.js';
import { closeTestDb, insertUser, openTestDb } from './test-db.mjs';

const fixtures = [];
const defaults = { public_web_url: null, public_api_url: null, revision: 0, updated_at: null, updated_by: null };
async function setup() {
  const db = await openTestDb();
  const app = await buildServer({ db, logger: false });
  fixtures.push({ db, app });
  const actors = {};
  for (const [account, is_system_admin] of [['admin-one', true], ['admin-two', true], ['member', false]]) {
    const user = await insertUser(db, { account, display_name: account, is_system_admin, status: 'active', created_at: new Date().toISOString() });
    const token = `test-system-settings-${account}`;
    await db.insert(schema.devices).values({ principal_id: user.id, device_name: 'Settings test browser', credential_hash: hashToken(token), created_at: new Date().toISOString() });
    actors[account] = { user, headers: { authorization: `Bearer ${token}` } };
  }
  const update = (payload, actor = 'admin-one', headers = {}) => app.inject({ method: 'PUT', url: '/admin/settings', headers: { ...actors[actor].headers, ...headers }, payload });
  return { db, app, actors, update };
}
afterEach(async () => {
  for (const { db, app } of fixtures.splice(0)) { await app.close(); await closeTestDb(db); }
});

test('settings require active system-admin bearer credentials and client-config exposes only public URLs', async () => {
  const { db, app, actors, update } = await setup();
  for (const method of ['GET', 'PUT']) {
    const request = { method, url: '/admin/settings', ...(method === 'PUT' ? { payload: { ...defaults, base_revision: 0 } } : {}) };
    assert.equal((await app.inject(request)).statusCode, 401);
    assert.equal((await app.inject({ ...request, headers: { 'x-principal-code': actors['admin-one'].user.code } })).statusCode, 401);
    assert.equal((await app.inject({ ...request, headers: actors.member.headers })).statusCode, 403);
  }
  assert.equal((await app.inject({ method: 'GET', url: '/platform/client-config' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/platform/client-config', headers: { 'x-principal-code': actors.member.user.code } })).statusCode, 401);
  const config = await app.inject({ method: 'GET', url: '/platform/client-config', headers: actors.member.headers });
  assert.deepEqual(config.json(), { ok: true, data: { public_web_url: null, public_api_url: null } });
  await db.update(schema.users).set({ status: 'disabled' }).where(eq(schema.users.id, actors['admin-one'].user.id));
  assert.equal((await update({ public_web_url: 'https://example.com', public_api_url: 'https://example.com/api', base_revision: 0 })).statusCode, 401);
  assert.equal((await db.select().from(schema.systemSettings)).length, 0);
});

test('settings persist normalized URLs, version changes atomically with audit, and keep Host out of configuration', async () => {
  const { db, app, actors, update } = await setup();
  const read = await app.inject({ method: 'GET', url: '/admin/settings', headers: { ...actors['admin-one'].headers, host: 'attacker.example' } });
  assert.deepEqual(read.json().data, defaults);
  const saved = await update({ public_web_url: 'https://PLATFORM.example:443/', public_api_url: 'https://api.example/platform/api/', base_revision: 0 });
  assert.equal(saved.statusCode, 200, saved.body);
  const value = saved.json().data;
  assert.equal(value.public_web_url, 'https://platform.example');
  assert.equal(value.public_api_url, 'https://api.example/platform/api');
  assert.equal(value.revision, 1);
  assert.equal(value.updated_by, actors['admin-one'].user.code);
  assert.ok(Number.isFinite(Date.parse(value.updated_at)));
  const [stored] = await db.select().from(schema.systemSettings);
  assert.equal(stored.public_api_url, value.public_api_url);
  assert.equal(stored.updated_by, actors['admin-one'].user.id);
  const newServer = await buildServer({ db, logger: false });
  try {
    const reread = await newServer.inject({ method: 'GET', url: '/admin/settings', headers: actors['admin-two'].headers });
    assert.deepEqual(reread.json().data, value);
  } finally { await newServer.close(); }
  const config = await app.inject({ method: 'GET', url: '/platform/client-config', headers: actors.member.headers });
  assert.deepEqual(config.json().data, { public_web_url: value.public_web_url, public_api_url: value.public_api_url });
  const unchanged = await update({ public_web_url: value.public_web_url, public_api_url: value.public_api_url, base_revision: 1 });
  assert.deepEqual(unchanged.json().data, value);
  const cleared = await update({ public_web_url: '', public_api_url: null, base_revision: 1 });
  assert.equal(cleared.json().data.revision, 2);
  assert.equal(cleared.json().data.public_web_url, null);
  const audit = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.entity_type, 'system_settings'));
  assert.equal(audit.length, 2);
  assert.equal(audit[0].principal_id, actors['admin-one'].user.id);
  assert.equal(audit[0].base_snapshot, 0);
  assert.deepEqual(JSON.parse(audit[0].payload), { before: { public_web_url: null, public_api_url: null }, after: { public_web_url: value.public_web_url, public_api_url: value.public_api_url }, revision: 1 });
  assert.equal(audit.map(row => row.payload).join('').includes('Bearer'), false);
});

test('admins closing their accounts cannot read or change system settings', async () => {
  const { db, app, actors, update } = await setup();
  for (const state of [
    { pending_deletion: true, deleted_at: null },
    { pending_deletion: false, deleted_at: new Date().toISOString() },
  ]) {
    await db.update(schema.users).set(state).where(eq(schema.users.id, actors['admin-one'].user.id));
    const read = await app.inject({ method: 'GET', url: '/admin/settings', headers: actors['admin-one'].headers });
    assert.equal(read.statusCode, 403, read.body);
    const write = await update({ public_web_url: 'https://example.com', public_api_url: null, base_revision: 0 });
    assert.equal(write.statusCode, 403, write.body);
  }
  assert.equal((await db.select().from(schema.systemSettings)).length, 0);
  assert.equal((await db.select().from(schema.auditEvents)).length, 0);
});

test('URL validation rejects unsafe schemes, credentials, deployment paths and command injection without partial writes', async () => {
  const { db, update } = await setup();
  const badUrls = [
    'http://public.example/api', 'http://192.168.1.10/api', 'ftp://platform.example/api', 'javascript:alert(1)', '//platform.example/api',
    'https://user:secret@example.com/api', 'https://example.com/api?token=secret', 'https://example.com/api#fragment', 'https://example.com/api?',
    'https://example.com/a\nb', 'https://example.com/a\tb', 'https://example.com/a\\b', 'https://example.com/api;echo',
    'https://example.com/$(secret)', 'https://example.com/`secret`', 'https://example.com/api&secret', 'https://example.com/"secret"',
    "https://example.com/'secret'", 'https://example.com/a|secret', 'https://example.com/a>secret', 'https://example.com/a<secret',
    'https://example.com/a%0ab', 'https://example.com/a%2fb', 'https://example.com/a%5cb', 'https://example.com/a%invalid',
    'https://exa;mple.com/api', 'http:localhost/api', 42, {}, false,
  ];
  for (const url of badUrls) {
    const response = await update({ public_web_url: null, public_api_url: url, base_revision: 0 });
    assert.equal(response.statusCode, 400, `${JSON.stringify(url)}: ${response.body}`);
    assert.equal(response.json().error.code, 'settings_url_invalid');
  }
  for (const payload of [
    { public_web_url: 'https://example.com/nested', public_api_url: null, base_revision: 0 },
    { public_web_url: null, public_api_url: null, base_revision: '0' },
    { public_web_url: null, public_api_url: null, base_revision: -1 },
    { public_web_url: null, public_api_url: null, base_revision: 0, cli_directory: 'C:/secrets' },
    { public_web_url: null, base_revision: 0 }, [],
  ]) assert.equal((await update(payload)).statusCode, 400);
  assert.equal((await db.select().from(schema.systemSettings)).length, 0);
  assert.equal((await db.select().from(schema.auditEvents)).length, 0);
  for (const [index, url] of ['http://localhost:5173/api/', 'http://127.0.0.1:8080/api', 'http://[::1]:8080/api', 'https://example.com/a%20b/api'].entries()) {
    const saved = await update({ public_web_url: null, public_api_url: url, base_revision: index });
    assert.equal(saved.statusCode, 200, saved.body);
  }
});

test('concurrent admins cannot overwrite an unseen settings revision or produce a phantom audit', async () => {
  const { db, update } = await setup();
  const results = await Promise.all([
    update({ public_web_url: 'https://first.example', public_api_url: null, base_revision: 0 }),
    update({ public_web_url: 'https://second.example', public_api_url: null, base_revision: 0 }, 'admin-two'),
  ]);
  assert.deepEqual(results.map(result => result.statusCode).sort(), [200, 409]);
  const failed = results.find(result => result.statusCode === 409);
  assert.equal(failed.json().error.code, 'settings_revision_conflict');
  const [row] = await db.select().from(schema.systemSettings);
  assert.equal(row.revision, 1);
  assert.equal(row.public_web_url, results.find(result => result.statusCode === 200).json().data.public_web_url);
  assert.equal((await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.entity_type, 'system_settings'))).length, 1);
  const staleNoop = await update({ public_web_url: row.public_web_url, public_api_url: null, base_revision: 0 });
  assert.equal(staleNoop.statusCode, 409);
});
