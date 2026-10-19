import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { schema } from '@team-synergy/persistence';
import { createAuthUseCases, hashPassword, hashToken } from '../dist/index.js';
import { insertUser, useTestDb } from './test-db.mjs';

const fixture = useTestDb(import.meta.url);

async function seededDb({ bindToken = 'bind-secret', expiresAt, status = 'active', password, mustChangePassword = false, passwordExpiresAt } = {}) {
  const db = fixture.db;
  const user = await insertUser(db, {
    legacyCode: 'user-auth',
    account: 'auth.user',
    displayName: 'Auth User',
    status,
    passwordHash: password ? await hashPassword(password) : null,
    mustChangePassword,
    passwordExpiresAt: passwordExpiresAt ?? null,
    bindTokenHash: hashToken(bindToken),
    bindTokenExpiresAt: expiresAt ?? new Date(Date.now() + 60_000).toISOString(),
  });
  return { db, user };
}

test('bindDevice consumes the bind token once and separates session credentials from the stable execution secret', async () => {
  const { db, user } = await seededDb();
  const auth = createAuthUseCases(db);

  const first = await auth.bindDevice('bind-secret', 'test-device');
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.data.user_code, user.code);
  assert.match(first.data.device_token, /^[a-f0-9]{64}$/);

  const [device] = await db.select().from(schema.devices).where(eq(schema.devices.code, first.data.device_code)).limit(1);
  const [session] = await db.select().from(schema.deviceSessions).where(eq(schema.deviceSessions.device_id, device.id));
  assert.equal(session.token_hash, hashToken(first.data.device_token));
  assert.notEqual(device.credential_hash, session.token_hash);
  assert.notEqual(device.credential_hash, first.data.device_token);
  const [storedUser] = await db.select().from(schema.users).where(eq(schema.users.id, user.id)).limit(1);
  assert.equal(storedUser.bind_token_hash, null);
  assert.equal(storedUser.bind_token_expires_at, null);

  const second = await auth.bindDevice('bind-secret', 'second-device');
  assert.equal(second.ok, false);
  assert.equal(second.error.code, 'auth_bind_token_invalid');
});

test('bindDevice rejects expired bind tokens without creating a device', async () => {
  const { db } = await seededDb({ expiresAt: new Date(Date.now() - 1_000).toISOString() });
  const result = await createAuthUseCases(db).bindDevice('bind-secret', 'expired-device');

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'auth_bind_token_expired');
  assert.equal((await db.select().from(schema.devices)).length, 0);
});

test('initial password login requires a password change before normal use', async () => {
  const { db, user } = await seededDb({
    password: 'TEMP1234',
    mustChangePassword: true,
    passwordExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const auth = createAuthUseCases(db);

  const initialLogin = await auth.loginWithPassword('AUTH.USER', 'TEMP1234', 'web-initial');
  assert.equal(initialLogin.ok, true, JSON.stringify(initialLogin));
  const initialSession = await auth.resolveToken(initialLogin.data.device_token);
  assert.equal(initialSession.ok, true);
  assert.equal(initialSession.data.password_change_required, true);

  const weak = await auth.changePassword(user.code, 'short');
  assert.equal(weak.ok, false);
  assert.equal(weak.error.code, 'auth_password_invalid');

  // 首次改密同样必须提供当前凭据（初始密码），防止被窃 token 直接换锁。
  const missingCurrent = await auth.changePassword(user.code, 'StrongPass1!');
  assert.equal(missingCurrent.ok, false);
  assert.equal(missingCurrent.error.code, 'auth_current_password_required');

  // 首次改密携带初始密码：成功并吊销其他设备。
  const changed = await auth.changePassword(user.code, 'StrongPass1!', { currentPassword: 'TEMP1234' });
  assert.equal(changed.ok, true, JSON.stringify(changed));
  assert.equal(changed.data.user_code, user.code);
  const changedSession = await auth.resolveToken(initialLogin.data.device_token);
  assert.equal(changedSession.ok, false);
  assert.equal(changedSession.error.code, 'auth_token_invalid');

  const login = await auth.loginWithPassword('auth.user', 'StrongPass1!', 'web-login');
  assert.equal(login.ok, true, JSON.stringify(login));
  assert.equal(login.data.user_code, user.code);
  assert.equal((await auth.resolveToken(login.data.device_token)).ok, true);
});

test('proactive password change requires the current password and revokes other devices', async () => {
  const { db } = await seededDb({ password: 'CurrentPass1!' });
  const auth = createAuthUseCases(db);

  const first = await auth.bindDevice('bind-secret', 'device-a');
  assert.equal(first.ok, true, JSON.stringify(first));

  // 已有正式密码：缺旧密码被拒绝。
  const missing = await auth.changePassword(first.data.user_code, 'NextPass123!');
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'auth_current_password_required');

  // 旧密码错误被拒绝。
  const wrong = await auth.changePassword(first.data.user_code, 'NextPass123!', { currentPassword: 'WrongPass1!' });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.error.code, 'auth_credentials_invalid');

  // 正确旧密码：改密成功；未提供当前设备 token 时保守地吊销全部设备。
  const changed = await auth.changePassword(first.data.user_code, 'NextPass123!', { currentPassword: 'CurrentPass1!' });
  assert.equal(changed.ok, true, JSON.stringify(changed));
  assert.equal(changed.data.revoked_devices, 1);
  const oldDevice = await auth.resolveToken(first.data.device_token);
  assert.equal(oldDevice.ok, false);
  assert.equal(oldDevice.error.code, 'auth_token_invalid');

  // 第二台设备登录并携带自己的 token 改密：仅保留当前设备。
  const second = await auth.loginWithPassword('auth.user', 'NextPass123!', 'device-b');
  assert.equal(second.ok, true, JSON.stringify(second));
  const rotated = await auth.changePassword(second.data.user_code, 'FinalPass123!', {
    currentPassword: 'NextPass123!',
    currentDeviceToken: second.data.device_token,
  });
  assert.equal(rotated.ok, true, JSON.stringify(rotated));
  assert.equal(rotated.data.revoked_devices, 0);
  assert.equal((await auth.resolveToken(second.data.device_token)).ok, true);
});

test('device binding enforces a per-user device limit', async () => {
  const { db, user } = await seededDb();
  const auth = createAuthUseCases(db);

  for (let i = 0; i < 10; i += 1) {
    const bound = await auth.bindDevice(`bind-secret`, `device-${i}`, user.code);
    assert.equal(bound.ok, true, JSON.stringify(bound));
    // 每次绑定都会消耗 bind token；为下一次循环重新签发。
    const reissue = await db.update(schema.users)
      .set({ bind_token_hash: hashToken('bind-secret'), bind_token_expires_at: new Date(Date.now() + 60_000).toISOString() })
      .where(eq(schema.users.id, user.id))
      .returning({ id: schema.users.id });
    assert.equal(reissue.length, 1);
  }
  assert.equal((await db.select().from(schema.devices)).length, 10);

  const overflow = await auth.bindDevice('bind-secret', 'device-overflow', user.code);
  assert.equal(overflow.ok, false);
  assert.equal(overflow.error.code, 'auth_device_limit_reached');
});

test('resolveToken rejects a disabled user immediately', async () => {
  const { db, user } = await seededDb();
  const auth = createAuthUseCases(db);
  const bound = await auth.bindDevice('bind-secret', 'disabled-device');
  assert.equal(bound.ok, true, JSON.stringify(bound));
  await db.update(schema.users).set({ status: 'disabled' }).where(eq(schema.users.id, user.id));

  const resolved = await auth.resolveToken(bound.data.device_token);
  assert.equal(resolved.ok, false);
  assert.equal(resolved.error.code, 'auth_user_disabled');
});

test('revokeDevice accepts a token and makes it unresolvable', async () => {
  const { db } = await seededDb();
  const auth = createAuthUseCases(db);
  const bound = await auth.bindDevice('bind-secret', 'revoked-device');
  assert.equal(bound.ok, true, JSON.stringify(bound));
  assert.equal((await auth.resolveToken(bound.data.device_token)).ok, true);

  const revoked = await auth.revokeDevice(bound.data.device_token);
  assert.equal(revoked.ok, true, JSON.stringify(revoked));
  const resolved = await auth.resolveToken(bound.data.device_token);
  assert.equal(resolved.ok, false);
  assert.equal(resolved.error.code, 'auth_token_invalid');
});
