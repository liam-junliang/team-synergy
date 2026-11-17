import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { schema } from '@team-synergy/persistence';
import { createAuthUseCases, hashPassword, resetLocalAdminPassword, aggregateLoginSecurity, readLoginFailureTotals } from '../dist/index.js';
import { insertUser, useTestDb } from './test-db.mjs';

const fixture = useTestDb(import.meta.url);
const originalLimit = process.env.TSP_AUTH_FAILURE_LIMIT;
afterEach(() => { if (originalLimit === undefined) delete process.env.TSP_AUTH_FAILURE_LIMIT; else process.env.TSP_AUTH_FAILURE_LIMIT = originalLimit; });
async function seeded() {
 process.env.TSP_AUTH_FAILURE_LIMIT = '2';
 const db = fixture.db;
 const admin = await insertUser(db, { account: 'security.admin', displayName: 'Admin', isSystemAdmin: true, passwordHash: await hashPassword('SecurityPass123!') });
 const member = await insertUser(db, { account: 'security.member', displayName: 'Member' });
 return { db, admin, member, auth: createAuthUseCases(db), login(password = 'wrong') { return this.auth.loginWithPassword(this.admin.account, password, 'device', undefined, { ip: '192.0.2.15' }); } };
}

test('failures lock once, throttled attempts stay recorded, expiry unlocks once and successful counter clearing is not a fictional unlock', async () => {
 const c = await seeded();
 assert.equal((await c.login()).ok, false);
 assert.equal((await c.login()).ok, false);
 assert.equal((await c.login()).error.code, 'slow_down');
 let audits = await c.db.select().from(schema.auditEvents);
 assert.equal(audits.filter(row => row.action === 'user.locked').length, 1);
 assert.equal(audits.filter(row => row.action === 'user.login_failed').length, 3);
 await c.db.update(schema.users).set({ login_locked_until: new Date(Date.now() - 10) }).where(eq(schema.users.id, c.admin.id));
 assert.equal((await c.login()).ok, false);
 assert.equal((await c.login('SecurityPass123!')).ok, true);
 audits = await c.db.select().from(schema.auditEvents);
 assert.equal(audits.filter(row => row.action === 'user.unlocked').length, 1);
 assert.equal(JSON.parse(audits.find(row => row.action === 'user.unlocked').payload).reason, 'expired');
 const events = await c.db.select().from(schema.authSecurityEvents);
 assert.equal(events.filter(row => row.kind === 'login_failed').length, 4);
 const serialized = JSON.stringify(events, (_, value) => typeof value === 'bigint' ? String(value) : value);
 assert.ok(!serialized.includes('192.0.2.15') && !serialized.includes('SecurityPass123!') && !serialized.includes('security.admin'));
});

test('unknown-account failures have no invented user audit and aggregate only hashed subjects/IPs behind current administrator permission', async () => {
 const c = await seeded();
 await c.login();
 await c.auth.loginWithPassword('unknown.account', 'incorrect', 'device', undefined, { ip: '192.0.2.15' });
 const events = await c.db.select().from(schema.authSecurityEvents).where(eq(schema.authSecurityEvents.kind, 'login_failed'));
 assert.equal(events.length, 2);
 assert.equal(events.filter(row => row.principal_id === null).length, 1);
 assert.equal((await c.db.select().from(schema.auditEvents)).length, 1);
 const groups = await aggregateLoginSecurity(c.db, c.admin.code, { groupBy: 'ip', limit: 10 });
 assert.equal(groups.ok, true, JSON.stringify(groups));
 assert.equal(groups.data.items.length, 1);
 assert.equal(groups.data.items[0].login_failures, 2);
 assert.match(groups.data.items[0].key, /^[a-f0-9]{64}$/);
 const totals = await readLoginFailureTotals(c.db);
 assert.equal(totals.reduce((n, row) => n + row.count, 0), 2);
 assert.equal((await aggregateLoginSecurity(c.db, c.member.code, { groupBy: 'account' })).error.code, 'admin_forbidden');
 assert.equal((await aggregateLoginSecurity(c.db, c.admin.code, { groupBy: 'ip', limit: 201 })).error.code, 'validation_failed');
});

test('local recovery records a real unlock only when clearing an existing lock and parallel failures cannot duplicate locking', async () => {
 const c = await seeded();
 await Promise.all([c.login(), c.login()]);
 assert.equal((await c.db.select().from(schema.auditEvents)).filter(row => row.action === 'user.locked').length, 1);
 const command = { account: c.admin.account, newPassword: 'RecoveredSecurity123!', localOperator: 'operator', localHostname: 'host' };
 assert.equal((await resetLocalAdminPassword(c.db, command)).ok, true);
 assert.equal((await resetLocalAdminPassword(c.db, command)).ok, true);
 const unlocked = (await c.db.select().from(schema.auditEvents)).filter(row => row.action === 'user.unlocked');
 assert.equal(unlocked.length, 1);
 assert.equal(JSON.parse(unlocked[0].payload).reason, 'local_admin_reset');
});


test('verified password change clears a real lock once and audits the authenticated unlock', async () => {
 const c = await seeded();
 await c.login(); await c.login();
 assert.equal((await c.auth.changePassword(c.admin.code, 'NewSecurityPass123!', { currentPassword: 'SecurityPass123!' })).ok, true);
 const events = (await c.db.select().from(schema.auditEvents)).filter(row => row.action === 'user.unlocked');
 assert.equal(events.length, 1);
 const payload = JSON.parse(events[0].payload);
 assert.equal(payload.reason, 'password_changed'); assert.equal(payload.actor_authenticated, true);
 const [user] = await c.db.select().from(schema.users).where(eq(schema.users.id, c.admin.id));
 assert.equal(user.login_locked_until, null); assert.equal(user.login_failure_count, 0);
 await assert.rejects(c.db.update(schema.authSecurityEvents).set({ reason: 'expired' }));
});
