import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { eq, sql } from 'drizzle-orm';
import { randomBytes, randomUUID } from 'node:crypto';
import { schema } from '@team-synergy/persistence';
import { ensureSystemAdmin, createAuthUseCases, createDeviceAuthorizationUseCases, hashPassword, hashToken, verifyPassword } from '../dist/index.js';
import { bootstrapPasswordTtlMinutes, resetLocalAdminPassword } from '../dist/admin-recovery.js';
import { insertUser, useTestDb } from './test-db.mjs';
const fixture = useTestDb(import.meta.url);
const originalTtl = process.env.TSP_BOOTSTRAP_TTL_MINUTES;
afterEach(() => { if (originalTtl === undefined) delete process.env.TSP_BOOTSTRAP_TTL_MINUTES; else process.env.TSP_BOOTSTRAP_TTL_MINUTES=originalTtl; });
test('bootstrap TTL defaults to30 minutes and validates explicit positive whole minutes', async () => {
 assert.equal(bootstrapPasswordTtlMinutes(undefined),30);
 assert.equal(bootstrapPasswordTtlMinutes('47'),47);
 for (const invalid of ['', '0','-1','1.5','abc','Infinity','9007199254740991']) assert.throws(() => bootstrapPasswordTtlMinutes(invalid));
 delete process.env.TSP_BOOTSTRAP_TTL_MINUTES;
 const before=Date.now(); const bootstrap=await ensureSystemAdmin(fixture.db);
 assert.ok(Date.parse(bootstrap.expires_at)>=before+30*60000);
 assert.ok(Date.parse(bootstrap.expires_at)<Date.now()+30*60000+1000);
});
test('bootstrap obeys configured TTL', async () => {
 process.env.TSP_BOOTSTRAP_TTL_MINUTES='47';
 const before=Date.now(); const bootstrap=await ensureSystemAdmin(fixture.db);
 assert.ok(Date.parse(bootstrap.expires_at)>=before+47*60000);
 assert.ok(Date.parse(bootstrap.expires_at)<Date.now()+47*60000+1000);
});
test('local administrator reset recovers expired bootstrap without restart and revokes device sessions atomically', async () => {
 const db=fixture.db;
 const bootstrap=await ensureSystemAdmin(db), auth=createAuthUseCases(db);
 const logged=await auth.loginWithPassword('admin',bootstrap.initial_password,'recovery-test');
 assert.equal(logged.ok,true);
 const [admin]=await db.select().from(schema.users).where(eq(schema.users.account,'admin'));
 await db.update(schema.users).set({password_expires_at:new Date(Date.now()-1000).toISOString(),login_failure_count:5,login_locked_until:new Date(Date.now()+60000)}).where(eq(schema.users.id,admin.id));
 const secret='RecoveryPass123!';
 const result=await resetLocalAdminPassword(db,{account:' ADMIN ',newPassword:secret,localOperator:'test-operator',localHostname:'test-host'});
 assert.equal(result.ok,true,JSON.stringify(result));
 assert.equal(JSON.stringify(result).includes(secret),false);
 assert.equal((await auth.resolveToken(logged.data.device_token)).ok,false);
 const [updated]=await db.select().from(schema.users).where(eq(schema.users.id,admin.id));
 assert.equal(await verifyPassword(secret,updated.password_hash),true);
 assert.equal(updated.is_system_admin,true); assert.equal(updated.must_change_password,true);
 assert.equal(updated.login_failure_count,0); assert.equal(updated.login_locked_until,null);
 assert.equal((await auth.loginWithPassword('admin',secret,'recovered')).ok,true);
 const audits=await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action,'admin.password_reset'));
 assert.equal(audits.length,1); assert.equal(audits[0].principal_id,admin.id);
 const audit=JSON.stringify(audits,(_,value)=>typeof value==='bigint'?String(value):value);
 assert.equal(audit.includes(secret),false); assert.equal(audit.includes('test-operator'),true); assert.equal(audit.includes('actor_authenticated'),true);
});
test('local reset refuses ordinary disabled deleted and pending-deletion accounts without modifying them', async () => {
 const db=fixture.db;
 for (const [account,admin,status,pending,deleted] of [['member',false,'active',false,false],['disabled',true,'disabled',false,false],['pending',true,'active',true,false],['deleted',true,'active',false,true]]) {
  const user=await insertUser(db,{account,displayName:account,isSystemAdmin:admin,status,passwordHash:await hashPassword('UnchangedPass123!')});
  await db.update(schema.users).set({pending_deletion:pending,deleted_at:deleted?new Date().toISOString():null}).where(eq(schema.users.id,user.id));
  const result=await resetLocalAdminPassword(db,{account,newPassword:'RejectedPass123!',localOperator:'test-operator',localHostname:'test-host'});
  assert.equal(result.ok,false);
  const [updated]=await db.select().from(schema.users).where(eq(schema.users.id,user.id));
  assert.equal(updated.password_hash,user.password_hash);
 }
 assert.equal((await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action,'admin.password_reset'))).length,0);
});


async function grantFixture() {
  const db = fixture.db;
  const admin = await insertUser(db, { account: 'grant-review-admin', displayName: 'Admin', isSystemAdmin: true,
    passwordHash: await hashPassword('OriginalReview123!') });
  const grants = createDeviceAuthorizationUseCases(db);
  const start = async () => {
    const grant = await grants.start({ device_name: 'Recovery grant', device_identity: {
      installation_id: randomUUID(), installation_secret: randomBytes(32).toString('base64url'), client_type: 'cli', platform: 'test',
    } });
    assert.equal(grant.ok, true, JSON.stringify(grant));
    return grant.data;
  };
  const reset = () => resetLocalAdminPassword(db, { account: admin.account, newPassword: 'TemporaryReview123!',
    localOperator: 'review-operator', localHostname: 'review-host' });
  return { db, admin, grants, start, reset, auth: createAuthUseCases(db) };
}

test('local recovery revokes approved and principal-bound pending grants permanently after the temporary password is changed', async () => {
  const c = await grantFixture();
  const approved = await c.start();
  assert.equal((await c.grants.approve(c.admin.code, approved.user_code, 'approve')).ok, true);
  const pending = await c.start();
  await c.db.update(schema.deviceAuthorizationRequests).set({ principal_id: c.admin.id }).where(eq(schema.deviceAuthorizationRequests.device_code_hash,
    hashToken(pending.device_code)));
  const unowned = await c.start();
  assert.equal((await c.reset()).ok, true);
  assert.equal((await c.auth.changePassword(c.admin.code, 'FreshReview123!', { currentPassword: 'TemporaryReview123!' })).ok, true);
  for (const grant of [approved, pending]) {
    const replay = await c.grants.token(grant.device_code);
    assert.equal(replay.ok, false, 'a pre-reset authorization must never mint a new administrator login');
  }
  const rows = await c.db.select().from(schema.deviceAuthorizationRequests).where(eq(schema.deviceAuthorizationRequests.principal_id, c.admin.id));
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.status === 'denied'));
  assert.equal((await c.grants.request(unowned.user_code)).data.status, 'pending', 'unapproved requests of other/unknown principals retain their normal flow');
});

for (const operation of ['redemption', 'approval']) {
test(`local recovery fences before user locks against in-flight ${operation} and revokes the resulting authority`, async () => {
  const c = await grantFixture();
  const grant = await c.start();
  if (operation === 'redemption') assert.equal((await c.grants.approve(c.admin.code, grant.user_code, 'approve')).ok, true);
  const blocker = await c.db.$client.connect();
  let redemption, reset;
  try {
    await blocker.query('begin');
    await blocker.query('select id from users where id=$1 for update', [String(c.admin.id)]);
    const pid = (await blocker.query('select pg_backend_pid() as pid')).rows[0].pid;
    redemption = operation === 'redemption' ? c.grants.token(grant.device_code)
      : c.grants.approve(c.admin.code, grant.user_code, 'approve');
    const waitFor = async predicate => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (await predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.fail('expected actual PostgreSQL lock barrier was not reached');
    };
    await waitFor(async () => (await c.db.execute(sql`select 1 from pg_stat_activity where ${pid}::integer = any(pg_blocking_pids(pid)) and query like '%"users"%' and query ilike '%for update%'`)).rows.length > 0);
    reset = c.reset();
    await waitFor(async () => (await c.db.execute(sql`select 1 from pg_locks where relation = 'device_authorization_requests'::regclass and mode = 'ExclusiveLock' and not granted`)).rows.length > 0);
    await blocker.query('commit');
    const login = await redemption;
    assert.equal(login.ok, true, JSON.stringify(login));
    const result = await reset;
    assert.equal(result.ok, true, JSON.stringify(result));
    if (operation === 'redemption') {
      assert.equal((await c.auth.resolveToken(login.data.device_token)).ok, false, 'a grant finishing just before reset must also be revoked');
    } else {
      assert.equal((await c.auth.changePassword(c.admin.code, 'FreshReview123!', { currentPassword: 'TemporaryReview123!' })).ok, true);
      assert.equal((await c.grants.token(grant.device_code)).ok, false, 'an approval finishing just before reset must also be revoked');
    }
  } finally {
    await blocker.query('rollback');
    blocker.release();
    await Promise.allSettled([redemption, reset].filter(Boolean));
  }
});

}
