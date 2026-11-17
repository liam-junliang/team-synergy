import { auditLoginFailure, auditLoginState, auditLoginUnlock, recordLoginSecurityEvent, type LoginSecurityContext } from './login-security.js';
import { and, eq, ne, isNull } from 'drizzle-orm';
import type { Db } from '@team-synergy/persistence';
import { schema } from '@team-synergy/persistence';
import { DomainError, assertAuditedChange, toAuditEvent } from '@team-synergy/domain';
import { createPublicCode, findDeviceByCode, findUserByCode } from './public-code.js';
import { hashToken, normalizeAccount } from './user-use-cases.js';
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from './password-auth.js';
import { fail, insertAudit, now, type TaskResult } from './task-service.js';
import { createDeviceLogin, parseDeviceIdentity, resolveSessionToken, revokeStableDevice } from './auth-device.js';
export { MAX_DEVICES_PER_USER } from './auth-device.js';

export interface BindDeviceResult { device_code: string; device_token: string; user_code: string; device_name: string; session_code?: string }
export interface ChangePasswordResult { user_code: string; revoked_devices: number }
export interface ResolveTokenResult { principal_code: string; password_change_required: boolean; device_code: string; session_code: string }
export interface RevokeDeviceResult { device_code: string; principal_code: string }

export function createAuthUseCases(db: Db) {
  const positiveSetting = (name: string, fallback: number) => {
    const value = Number(process.env[name]);
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
  };
  const failureLimit = positiveSetting('TSP_AUTH_FAILURE_LIMIT', 5);
  const lockSeconds = positiveSetting('TSP_AUTH_LOCK_SECONDS', 900);
  async function bindDevice(bindToken: string, deviceName: string, principalCode?: string, identityInput?: unknown): Promise<TaskResult<BindDeviceResult>> {
    try {
      if (!bindToken) throw new DomainError('auth_bind_token_invalid', '绑定 token 无效');
      const identity = parseDeviceIdentity(identityInput);
      const principal = principalCode ? await findUserByCode(db, principalCode) : undefined;
      if (principalCode && !principal) throw new DomainError('auth_bind_token_invalid', '绑定 token 无效或已使用');
      const data = await db.transaction(async tx => {
        const [user] = await tx.select().from(schema.users).where(and(eq(schema.users.bind_token_hash, hashToken(bindToken)), principal ? eq(schema.users.id, principal.id) : undefined)).for('update').limit(1);
        if (!user) throw new DomainError('auth_bind_token_invalid', '绑定 token 无效或已使用');
        const expiry = user.bind_token_expires_at ? Date.parse(user.bind_token_expires_at) : NaN;
        if (!Number.isFinite(expiry) || expiry <= Date.now()) throw new DomainError('auth_bind_token_expired', '绑定 token 已过期');
        const login = await createDeviceLogin(tx, user, deviceName, identity);
        await tx.update(schema.users).set({ bind_token_hash: null, bind_token_expires_at: null }).where(eq(schema.users.id, user.id));
        return login;
      });
      return { ok: true, data };
    } catch (error) { return fail(error); }
  }

  async function loginWithPassword(account: string, password: string, deviceName: string, identityInput?: unknown, context: LoginSecurityContext = {}): Promise<TaskResult<BindDeviceResult>> {
    try {
      const normalizedAccount = normalizeAccount(account);
      if (!normalizedAccount || !password || password.length > 128) {
        await recordLoginSecurityEvent(db, { account: normalizedAccount, context, kind: 'login_failed', reason: 'invalid_credentials' });
        throw new DomainError('auth_credentials_invalid', '账号或密码错误');
      }
      const identity = parseDeviceIdentity(identityInput);
      const [candidate] = await db.select().from(schema.users).where(eq(schema.users.account, normalizedAccount)).limit(1);
      const matches = await verifyPassword(password, candidate?.password_hash ?? DUMMY_PASSWORD_HASH);
      if (!candidate) {
        await recordLoginSecurityEvent(db, { account: normalizedAccount, context, kind: 'login_failed', reason: 'invalid_credentials' });
        throw new DomainError('auth_credentials_invalid', '账号或密码错误');
      }
      return await db.transaction(async tx => {
        const [user] = await tx.select().from(schema.users).where(eq(schema.users.id, candidate.id)).for('update').limit(1);
        if (!user || user.password_hash !== candidate.password_hash) throw new DomainError('auth_credentials_invalid', '账号或密码错误');
        if (user.login_locked_until && user.login_locked_until.getTime() > Date.now()) {
          await auditLoginFailure(tx, user, 'locked', user.login_failure_count, true, context);
          return fail<BindDeviceResult>(new DomainError('slow_down', '请求过多，请稍后重试', { retry_after: Math.ceil((user.login_locked_until.getTime() - Date.now()) / 1000) }));
        }
        const expiredLock = user.login_locked_until !== null;
        if (expiredLock) {
          await auditLoginUnlock(tx, user, 'expired', context);
          await tx.update(schema.users).set({ login_failure_count: 0, login_locked_until: null }).where(eq(schema.users.id, user.id));
        }
        if (!matches || user.status !== 'active' || !user.password_hash) {
          const failures = (user.login_locked_until ? 0 : user.login_failure_count) + 1;
          const lockedUntil = failures >= failureLimit ? new Date(Date.now() + lockSeconds * 1000) : null;
          await tx.update(schema.users).set({ login_failure_count: failures, login_locked_until: lockedUntil }).where(eq(schema.users.id, user.id));
          await auditLoginFailure(tx, user, 'invalid_credentials', failures, lockedUntil !== null, context);
          if (lockedUntil) await auditLoginState(tx, user, 'locked', 'failure_limit', context);
          // Return the refusal so the transaction commits the failure and its audit.
          return fail<BindDeviceResult>(new DomainError('auth_credentials_invalid', '账号或密码错误'));
        }
        if (user.must_change_password) {
          const expiry = user.password_expires_at ? Date.parse(user.password_expires_at) : NaN;
          if (!Number.isFinite(expiry) || expiry <= Date.now()) return fail<BindDeviceResult>(new DomainError('auth_initial_password_expired', '初始密码已过期'));
        }
        const data = await createDeviceLogin(tx, user, deviceName, identity);
        await tx.update(schema.users).set({ login_failure_count: 0, login_locked_until: null }).where(eq(schema.users.id, user.id));
        return { ok: true as const, data };
      });
    } catch (error) { return fail(error); }
  }

  async function changePassword(principalCode: string, newPassword: string, options: { currentDeviceToken?: string; currentPassword?: string } = {}): Promise<TaskResult<ChangePasswordResult>> {
    try {
      if (!principalCode) throw new DomainError('auth_token_invalid', '认证失败');
      if (newPassword.length < 8 || newPassword.length > 128) throw new DomainError('auth_password_invalid', '密码长度必须为 8 到 128 个字符');
      const user = await findUserByCode(db, principalCode);
      if (!user || user.status !== 'active') throw new DomainError('auth_user_disabled', '用户不存在或已禁用');
      if (!options.currentPassword) throw new DomainError('auth_current_password_required', '修改密码必须提供当前密码');
      if (options.currentPassword.length > 128) throw new DomainError('auth_credentials_invalid', '当前密码错误');
      if (!user.password_hash || !(await verifyPassword(options.currentPassword, user.password_hash))) throw new DomainError('auth_credentials_invalid', '当前密码错误');
      const passwordHash = await hashPassword(newPassword);
      const data = await db.transaction(async tx => {
        const [fresh] = await tx.select().from(schema.users).where(eq(schema.users.id, user.id)).for('update').limit(1);
        if (!fresh || fresh.password_hash !== user.password_hash) throw new DomainError('auth_credentials_invalid', '当前密码错误');
        const current = options.currentDeviceToken ? await resolveSessionToken(tx, options.currentDeviceToken) : undefined;
        if (options.currentDeviceToken && (!current || current.user.id !== user.id)) throw new DomainError('auth_token_invalid', '认证失败');
        await auditLoginUnlock(tx, fresh, 'password_changed');
        await tx.update(schema.users).set({ password_hash: passwordHash, must_change_password: false, password_expires_at: null, login_failure_count: 0, login_locked_until: null }).where(eq(schema.users.id, user.id));
        const otherDevices = await tx.select().from(schema.devices).where(and(eq(schema.devices.principal_id, user.id), isNull(schema.devices.revoked_at), current ? ne(schema.devices.id, current.device.id) : undefined));
        for (const device of otherDevices) await revokeStableDevice(tx, device.id);
        // Keep only the session that proved the current password, even on the same installation.
        if (current) await tx.update(schema.deviceSessions).set({ revoked_at: now() }).where(and(eq(schema.deviceSessions.device_id, current.device.id), ne(schema.deviceSessions.id, current.session.id), isNull(schema.deviceSessions.revoked_at)));
        const audit = { entity_type: 'user' as const, entity_id: user.id, legacy_entity_code: user.legacy_code ?? undefined, principal_id: user.id, base_snapshot: 0, action: 'user.password_changed', payload: { revoked_devices: otherDevices.length } };
        assertAuditedChange(audit);
        await insertAudit(tx, toAuditEvent(audit, createPublicCode(), now()));
        return { user_code: user.code, revoked_devices: otherDevices.length };
      });
      return { ok: true, data };
    } catch (error) { return fail(error); }
  }

  async function resolveToken(token: string): Promise<TaskResult<ResolveTokenResult>> {
    try {
      const resolved = await resolveSessionToken(db, token);
      if (!resolved) throw new DomainError('auth_token_invalid', '会话无效、已过期或已吊销');
      return { ok: true, data: { principal_code: resolved.user.code, password_change_required: resolved.user.must_change_password, device_code: resolved.device.code, session_code: resolved.session.code } };
    } catch (error) { return fail(error); }
  }

  async function revokeDevice(codeOrToken: string): Promise<TaskResult<RevokeDeviceResult>> {
    try {
      const resolved = await resolveSessionToken(db, codeOrToken);
      const device = await findDeviceByCode(db, codeOrToken) ?? resolved?.device;
      if (!device) throw new DomainError('auth_device_not_found', '设备不存在');
      const [user] = await db.select().from(schema.users).where(eq(schema.users.id, device.principal_id)).limit(1);
      await db.transaction(tx => revokeStableDevice(tx, device.id));
      return { ok: true, data: { device_code: device.code, principal_code: user?.code ?? '' } };
    } catch (error) { return fail(error); }
  }

  async function logout(token: string): Promise<TaskResult<RevokeDeviceResult>> {
    try {
      const resolved = await resolveSessionToken(db, token);
      if (!resolved) throw new DomainError('auth_token_invalid', '会话无效');
      await db.update(schema.deviceSessions).set({ revoked_at: now() }).where(eq(schema.deviceSessions.id, resolved.session.id));
      return { ok: true, data: { device_code: resolved.device.code, principal_code: resolved.user.code } };
    } catch (error) { return fail(error); }
  }

  async function bindIdentity(token: string, input: unknown) {
    try {
      const identity = parseDeviceIdentity(input);
      if (!identity) throw new DomainError('auth_device_identity_invalid', '需要设备安装身份');
      // Complete one-time legacy enrollment before acquiring user/device locks,
      // keeping the same user -> installation lock order as ordinary login.
      const original = await resolveSessionToken(db, token);
      if (!original) throw new DomainError('auth_token_invalid', '会话无效');
      const data = await db.transaction(async tx => {
        await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, original.user.id)).for('update');
        const current = await resolveSessionToken(tx, token);
        if (!current) throw new DomainError('auth_token_invalid', '会话无效');
        const [device] = await tx.select().from(schema.devices).where(eq(schema.devices.id, current.device.id)).for('update').limit(1);
        if (!device || device.revoked_at) throw new DomainError('auth_token_invalid', '设备已吊销');
        if (device.installation_id && (device.installation_id !== identity.installation_id || device.client_type !== identity.client_type || device.installation_secret_hash !== identity.installation_secret_hash)) throw new DomainError('auth_device_identity_mismatch', '当前设备已绑定其他安装身份');
        const [existing] = await tx.select().from(schema.devices).where(and(eq(schema.devices.principal_id, current.user.id), eq(schema.devices.client_type, identity.client_type), eq(schema.devices.installation_id, identity.installation_id), ne(schema.devices.id, device.id))).limit(1);
        if (existing) throw new DomainError('auth_device_identity_conflict', '该安装身份已绑定其他设备，不能合并执行身份');
        await tx.update(schema.devices).set(identity).where(eq(schema.devices.id, device.id));
        return { device_code: device.code };
      });
      return { ok: true as const, data };
    } catch (error) { return fail(error); }
  }
  return { bindDevice, loginWithPassword, changePassword, resolveToken, revokeDevice, logout, bindIdentity };
}
export type AuthUseCases = ReturnType<typeof createAuthUseCases>;
