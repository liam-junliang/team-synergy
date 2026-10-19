import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { schema } from '@team-synergy/persistence';
import { createUserUseCases, ensureSystemAdmin, verifyPassword } from '../dist/index.js';
import { insertUser, useTestDb } from './test-db.mjs';

const fixture = useTestDb(import.meta.url);

async function seededDb() {
  const db = fixture.db;
  const admin = await insertUser(db, {
    legacyCode: 'USR-ADMIN',
    account: 'admin',
    displayName: '系统管理员',
    status: 'active',
    isSystemAdmin: true,
  });
  const chen = await insertUser(db, { legacyCode: 'user-chen', account: 'chen', displayName: 'chen', status: 'active' });
  const wang = await insertUser(db, { legacyCode: 'user-wang', account: 'wang', displayName: 'wang', status: 'active' });
  return { db, admin, chen, wang };
}

test('ensureSystemAdmin 首次部署生成 admin 与短时初始密码', async () => {
  const db = fixture.db;
  const bootstrap = await ensureSystemAdmin(db);
  assert.equal(bootstrap.account, 'admin');
  assert.match(bootstrap.user_code, /^[0-9A-HJKMNP-TV-Z]{20}$/);
  assert.match(bootstrap.initial_password, /^[A-Z2-9]{8}$/);
  const [admin] = await db.select().from(schema.users).where(eq(schema.users.code, bootstrap.user_code)).limit(1);
  assert.equal(admin.is_system_admin, true);
  assert.equal(admin.must_change_password, true);
  assert.equal(await verifyPassword(bootstrap.initial_password, admin.password_hash), true);
});

test('users 表以内部编码关联，同时保留独立登录账号', async () => {
  const { db } = await seededDb();
  const created = await insertUser(db, { legacyCode: 'USR-TEST001', account: 'tester', displayName: 'x', status: 'active' });
  const [row] = await db.select().from(schema.users).where(eq(schema.users.id, created.id)).limit(1);
  assert.equal(row.account, 'tester');
});

test('createUser：只有系统管理员可创建，user_id 自动编码并返回初始密码', async () => {
  const { db, admin, chen } = await seededDb();
  const uc = createUserUseCases(db);

  const ownerForbidden = await uc.createUser({ account: 'li', displayName: 'li', actorPrincipalCode: chen.code });
  assert.equal(ownerForbidden.ok, false);
  assert.equal(ownerForbidden.error.code, 'user_forbidden');

  const created = await uc.createUser({ account: 'Li.Ming', displayName: '李明', actorPrincipalCode: admin.code });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.data.account, 'li.ming');
  assert.match(created.data.user_code, /^[0-9A-HJKMNP-TV-Z]{20}$/);
  assert.match(created.data.initial_password, /^[A-Z2-9]{8}$/);
  const [row] = await db.select().from(schema.users).where(eq(schema.users.code, created.data.user_code)).limit(1);
  assert.equal(row.must_change_password, true);
  assert.equal(await verifyPassword(created.data.initial_password, row.password_hash), true);
  assert.equal((await db.select().from(schema.members).where(eq(schema.members.principal_id, row.id))).length, 0);
});

test('disableUser：系统管理员可禁用普通账号，但系统管理员账号受保护', async () => {
  const { db, admin, chen } = await seededDb();
  const uc = createUserUseCases(db);
  const created = await uc.createUser({ account: 'li.ming', displayName: '李明', actorPrincipalCode: admin.code });

  const protectedAdmin = await uc.disableUser({ userCode: admin.code, actorPrincipalCode: admin.code });
  assert.equal(protectedAdmin.ok, false);
  assert.equal(protectedAdmin.error.code, 'user_self_disable');

  const byTeamOwner = await uc.disableUser({ userCode: created.data.user_code, actorPrincipalCode: chen.code });
  assert.equal(byTeamOwner.ok, false);
  assert.equal(byTeamOwner.error.code, 'user_forbidden');

  const disabled = await uc.disableUser({ userCode: created.data.user_code, actorPrincipalCode: admin.code });
  assert.equal(disabled.ok, true, JSON.stringify(disabled));
  const [row] = await db.select().from(schema.users).where(eq(schema.users.code, created.data.user_code)).limit(1);
  assert.equal(row.status, 'disabled');

  const listed = await uc.listUsers(admin.code);
  assert.equal(listed.ok, true);
  assert.ok(listed.data.some((user) => user.user_code === created.data.user_code && user.status === 'disabled'));
});

test('系统管理员可分别签发 Web 初始密码与 CLI 绑定 Token', async () => {
  const { db, admin, chen } = await seededDb();
  const uc = createUserUseCases(db);
  const created = await uc.createUser({ account: 'li.ming', displayName: '李明', actorPrincipalCode: admin.code });

  const initial = await uc.issueInitialPassword({ userCode: created.data.user_code, actorPrincipalCode: admin.code });
  assert.equal(initial.ok, true, JSON.stringify(initial));
  assert.notEqual(initial.data.initial_password, created.data.initial_password);

  const binding = await uc.issueBindToken({ userCode: created.data.user_code, actorPrincipalCode: admin.code });
  assert.equal(binding.ok, true, JSON.stringify(binding));
  assert.match(binding.data.bind_token, /^[a-f0-9]{64}$/);

  const forbidden = await uc.issueBindToken({ userCode: created.data.user_code, actorPrincipalCode: chen.code });
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.error.code, 'user_forbidden');
});
