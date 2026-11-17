import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import { schema } from '@team-synergy/persistence';
import { hashPassword, recordLoginSecurityEvent } from '@team-synergy/application';
import { registerMetrics } from '../dist/metrics.js';
import { registerAuthMiddleware } from '../dist/auth.js';
import { registerAuthRoutes } from '../dist/routes/auth.js';
import { registerLoginSecurityRoutes } from '../dist/routes/login-security.js';
import { openTestDb, closeTestDb, insertUser } from './test-db.mjs';

const fixtures = [];
const originalLimit = process.env.TSP_AUTH_FAILURE_LIMIT;
afterEach(async () => {
 for (const f of fixtures.splice(0)) { await f.app.close(); await closeTestDb(f.db); }
 if (originalLimit === undefined) delete process.env.TSP_AUTH_FAILURE_LIMIT; else process.env.TSP_AUTH_FAILURE_LIMIT = originalLimit;
});
async function fixture() {
 process.env.TSP_AUTH_FAILURE_LIMIT = '2';
 const db = await openTestDb();
 const app = Fastify({ logger: false });
 registerMetrics(app, db);
 registerAuthMiddleware(app, db);
 registerAuthRoutes(app, db);
 registerLoginSecurityRoutes(app, db);
 const users = {};
 for (const name of ['admin', 'member', 'victim']) {
  const user = await insertUser(db, { account: `b04.${name}`, display_name: name, is_system_admin: name === 'admin',
   password_hash: await hashPassword('B04Password123!'), created_at: new Date().toISOString() });
  const token = createHash('sha256').update(`b04-${name}-session`).digest('hex');
  await db.insert(schema.devices).values({ principal_id: user.id, device_name: name, credential_hash: createHash('sha256').update(token).digest('hex'), created_at: new Date().toISOString() });
  users[name] = { ...user, token, headers: { authorization: `Bearer ${token}` } };
 }
 const f = { db, app, users }; fixtures.push(f); return f;
}

test('HTTP failures including lock/rate refusals are aggregated by IP hash and durable metrics do not accumulate on repeated scrapes', async () => {
 const f = await fixture();
 for (let i = 0; i < 6; i++) {
  const result = await f.app.inject({ method: 'POST', url: '/auth/password-login', remoteAddress: '192.0.2.45',
   payload: { account: f.users.victim.account, password: 'wrong', device_name: 'B04' } });
  assert.equal(result.statusCode, i < 2 ? 401 : 429, result.body);
 }
 const response = await f.app.inject({ url: '/admin/security/login-events?group_by=ip', headers: f.users.admin.headers });
 assert.equal(response.statusCode, 200, response.body);
 const items = response.json().data.items;
 assert.equal(items.length, 1);
 assert.equal(items[0].login_failures, 6);
 assert.equal(items[0].locks, 1);
 assert.match(items[0].key, /^[a-f0-9]{64}$/);
 assert.ok(!response.body.includes('192.0.2.45') && !response.body.includes('b04.victim') && !response.body.includes('wrong'));
 for (let i = 0; i < 3; i++) {
  const metrics = await f.app.inject({ url: '/metrics', headers: f.users.admin.headers });
  assert.equal(metrics.statusCode, 200, metrics.body);
  assert.match(metrics.body, /login_failures_total\{reason="invalid_credentials"\} 2/);
  assert.match(metrics.body, /login_failures_total\{reason="locked"\} 3/);
  assert.match(metrics.body, /login_failures_total\{reason="rate_limited"\} 1/);
  assert.ok(!metrics.body.includes('192.0.2.45') && !metrics.body.includes('b04.victim'));
 }
});

test('security aggregation requires current admin before query validation; bounded windows, hashes and pagination are strict', async () => {
 const f = await fixture();
 const invalid = ['group_by=other', 'ip_hash=raw-ip', 'account_hash=invalid', 'since=2026-02-30', 'until=bad-date',
  'since=2020-01-01&until=2026-01-01', 'since=2026-01-02&until=2026-01-01', 'limit=201', 'offset=-1', 'extra=field'];
 for (const query of invalid) {
  const url = `/admin/security/login-events?${query}`;
  assert.equal((await f.app.inject({ url, headers: f.users.member.headers })).statusCode, 403);
  assert.equal((await f.app.inject({ url, headers: f.users.admin.headers })).statusCode, 400);
 }
 assert.equal((await f.app.inject('/admin/security/login-events')).statusCode, 401);
 assert.equal((await f.app.inject({ url: '/admin/security/login-events', headers: { 'x-principal-code': f.users.admin.code } })).statusCode, 401);
 for (const account of ['one', 'two', 'three']) await recordLoginSecurityEvent(f.db, { account, context: { ip: '198.51.100.10' }, kind: 'login_failed', reason: 'invalid_credentials' });
 const first = (await f.app.inject({ url: '/admin/security/login-events?limit=2', headers: f.users.admin.headers })).json().data;
 const second = (await f.app.inject({ url: '/admin/security/login-events?limit=2&offset=2', headers: f.users.admin.headers })).json().data;
 assert.equal(first.total, 3); assert.equal(first.has_more, true); assert.equal(second.has_more, false);
 assert.equal(new Set([...first.items, ...second.items].map(row => row.key)).size, 3);
 const cookie = await f.app.inject({ url: '/admin/security/login-events', headers: { cookie: `tsp_session=${f.users.admin.token}` } });
 assert.equal(cookie.statusCode, 200, cookie.body);
});
