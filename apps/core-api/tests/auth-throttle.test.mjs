import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { schema } from '@team-synergy/persistence';
import { hashPassword } from '@team-synergy/application';
import { buildServer } from '../dist/server.js';
import { openTestDb, closeTestDb, insertUser, publicCode } from './test-db.mjs';
let app, db;
afterEach(async () => { await app?.close(); if (db) await closeTestDb(db); app = db = undefined; });
async function fixture() {
 db = await openTestDb(); app = await buildServer({ db, logger: false });
 const user = await insertUser(db, { code: publicCode(88001), account: 'throttle.user', display_name: 'Throttle', created_at: new Date().toISOString(), password_hash: await hashPassword('CorrectPass123!') });
 return user;
}
test('password login persists failures and sixth request returns Retry-After through twelfth', async () => {
 const user = await fixture();
 for (let attempt = 1; attempt <= 12; attempt++) {
  const response = await app.inject({ method: 'POST', url: '/auth/password-login', payload: { account: user.account, password: 'WrongPass123!', device_name: 'test' } });
  assert.equal(response.statusCode, attempt <= 5 ? 401 : 429, response.body);
  if (attempt > 5) assert.ok(Number(response.headers['retry-after']) > 0);
 }
 const failures = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, 'user.login_failed'));
 assert.equal(failures.filter(row => JSON.parse(row.payload).reason === 'invalid_credentials').length, 5);
 assert.equal(failures.filter(row => JSON.parse(row.payload).reason === 'rate_limited').length, 7);
 assert.equal(failures.length, 12);
 assert.ok(!JSON.stringify(failures, (_, value) => typeof value === 'bigint' ? String(value) : value).includes('WrongPass'));
});
test('account limits survive API recreation and rotating source IPs', async () => {
 const user = await fixture();
 for (let i = 0; i < 5; i++) await app.inject({ method: 'POST', url: '/auth/password-login', remoteAddress: `192.0.2.${i+1}`, payload: { account: user.account, password: 'wrong', device_name: 'test' } });
 await app.close(); app = await buildServer({ db, logger: false });
 const blocked = await app.inject({ method: 'POST', url: '/auth/password-login', remoteAddress: '192.0.2.99', payload: { account: user.account.toUpperCase(), password: 'CorrectPass123!', device_name: 'test' } });
 assert.equal(blocked.statusCode, 429, blocked.body); assert.ok(Number(blocked.headers['retry-after']) > 0);
});
test('auth endpoints reject oversized bodies and passwords', async () => {
 await fixture();
 const large = await app.inject({ method: 'POST', url: '/auth/password-login', payload: { account: 'test', password: 'x'.repeat(17000) } });
 assert.equal(large.statusCode, 413);
 const password = await app.inject({ method: 'POST', url: '/auth/password-login', payload: { account: 'test', password: 'x'.repeat(129), device_name: 'test' } });
 assert.equal(password.statusCode, 401);
});

test('known and unknown account median scrypt durations differ by less than 20 ms', async () => {
 const user = await fixture();
 const { createAuthUseCases } = await import('@team-synergy/application');
 const previous = process.env.TSP_AUTH_FAILURE_LIMIT;
 process.env.TSP_AUTH_FAILURE_LIMIT = '100';
 const auth = createAuthUseCases(db);
 if (previous === undefined) delete process.env.TSP_AUTH_FAILURE_LIMIT; else process.env.TSP_AUTH_FAILURE_LIMIT = previous;
 const known = [], unknown = [];
 for (let i = 0; i < 20; i++) {
  for (const [account, durations] of [[user.account, known], ['unknown.account', unknown]]) {
   const start = performance.now();
   const result = await auth.loginWithPassword(account, 'wrong', 'test');
   assert.equal(result.ok, false); durations.push(performance.now() - start);
  }
 }
 const median = values => values.sort((a,b) => a-b)[10];
 const delta = Math.abs(median(known) - median(unknown));
 console.log(`known median=${median(known).toFixed(1)}ms unknown median=${median(unknown).toFixed(1)}ms delta=${delta.toFixed(1)}ms`);
 assert.ok(delta < 20, `timing difference ${delta}ms`);
});
test('persistent account lock remains after rate quota expires and clears after lock expiry', async () => {
 const user = await fixture();
 const { createAuthUseCases } = await import('@team-synergy/application');
 const auth = createAuthUseCases(db);
 for (let i = 0; i < 5; i++) assert.equal((await auth.loginWithPassword(user.account, 'wrong', 'test')).error.code, 'auth_credentials_invalid');
 const locked = await auth.loginWithPassword(user.account, 'CorrectPass123!', 'test');
 assert.equal(locked.error.code, 'slow_down'); assert.ok(locked.error.details.retry_after > 0);
 await db.update(schema.users).set({ login_locked_until: new Date(Date.now()-1000) }).where(eq(schema.users.id, user.id));
 assert.equal((await auth.loginWithPassword(user.account, 'CorrectPass123!', 'test')).ok, true);
 const [fresh] = await db.select().from(schema.users).where(eq(schema.users.id,user.id));
 assert.equal(fresh.login_failure_count, 0); assert.equal(fresh.login_locked_until,null);
});

test('device approval rate limits both source IP and authenticated account', async () => {
 const user = await fixture();
 const login = await app.inject({ method: 'POST', url: '/auth/password-login', payload: { account: user.account, password: 'CorrectPass123!', device_name: 'test' } });
 assert.equal(login.statusCode, 200, login.body);
 for (let i = 0; i < 6; i++) {
  const response = await app.inject({ method: 'POST', url: '/auth/device/approve', remoteAddress: `192.0.2.${i+1}`, headers: { authorization: `Bearer ${login.json().data.device_token}` }, payload: { user_code: 'ABCD-EFGH', decision: 'approve' } });
  assert.equal(response.statusCode, i < 5 ? 400 : 429, response.body);
  if (i === 5) assert.ok(Number(response.headers['retry-after']) > 0);
 }
});
test('hour quota still applies after minute windows expire', async () => {
 await fixture();
 const { createAuthRateLimiter } = await import('@team-synergy/application');
 const limited = createAuthRateLimiter(db);
 for (let i = 0; i < 20; i++) {
  await db.update(schema.authRateLimits).set({ minute_started_at: new Date(Date.now()-61000) });
  assert.equal(await limited('quota-test', '192.0.2.1', 'someone'), 0);
 }
 await db.update(schema.authRateLimits).set({ minute_started_at: new Date(Date.now()-61000) });
 assert.ok(await limited('quota-test', '192.0.2.1', 'someone') > 3500);
});

test('concurrent requests reserve only five slots across limiter instances', async () => {
 await fixture();
 const { createAuthRateLimiter } = await import('@team-synergy/application');
 const first = createAuthRateLimiter(db), second = createAuthRateLimiter(db);
 const retries = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? first : second)('parallel', '192.0.2.1', 'same-account')));
 assert.equal(retries.filter(value => value === 0).length, 5);
 assert.equal(retries.filter(value => value > 0).length, 7);
});
