import { asc, eq, inArray } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '@team-synergy/persistence';
import { schema } from '@team-synergy/persistence';
import { DomainError, assertAuditedChange, toAuditEvent } from '@team-synergy/domain';
import { hashPassword } from './password-auth.js';
import { createPublicCode, findUserByCode } from './public-code.js';
import { fail, insertAudit, now } from './task-service.js';
import { revokeStableDevice } from './auth-device.js';

const BIND_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const INITIAL_PASSWORD_TTL_MS = 15 * 60 * 1000;
const INITIAL_PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generateToken(): string {
  return randomBytes(32).toString('hex');
}

export function normalizeAccount(account: string): string {
  return account.trim().toLowerCase();
}

export function generateInitialPassword(): string {
  const bytes = randomBytes(8);
  return Array.from(bytes, (value) => INITIAL_PASSWORD_ALPHABET[value % INITIAL_PASSWORD_ALPHABET.length]).join('');
}

async function systemAdminByCode(db: Db, principalCode: string) {
  const user = await findUserByCode(db, principalCode);
  return user && user.status === 'active' && !user.deleted_at && !user.pending_deletion && user.is_system_admin ? user : undefined;
}

export async function ensureSystemAdmin(db: Db) {
  const [existing] = await db.select().from(schema.users).where(eq(schema.users.account, 'admin')).limit(1);
  const expired = existing?.must_change_password
    && (!existing.password_expires_at || Date.parse(existing.password_expires_at) <= Date.now());
  if (existing?.password_hash && !expired) {
    if (!existing.is_system_admin) {
      await db.update(schema.users).set({ is_system_admin: true }).where(eq(schema.users.id, existing.id));
    }
    return { user_code: existing.code, account: existing.account };
  }

  const initialPassword = generateInitialPassword();
  const expiresAt = new Date(Date.now() + INITIAL_PASSWORD_TTL_MS).toISOString();
  const passwordHash = await hashPassword(initialPassword);
  if (existing) {
    await db.update(schema.users).set({
      is_system_admin: true,
      status: 'active',
      password_hash: passwordHash,
      must_change_password: true,
      password_expires_at: expiresAt,
    }).where(eq(schema.users.id, existing.id));
    return { user_code: existing.code, account: existing.account, initial_password: initialPassword, expires_at: expiresAt };
  }

  const [created] = await db.insert(schema.users).values({
    code: createPublicCode(),
    account: 'admin',
    display_name: '系统管理员',
    status: 'active',
    is_system_admin: true,
    password_hash: passwordHash,
    must_change_password: true,
    password_expires_at: expiresAt,
    created_at: now(),
  }).returning({ id: schema.users.id, code: schema.users.code, account: schema.users.account });
  if (!created) throw new DomainError('internal_error', '系统管理员初始化失败');
  return { user_code: created.code, account: created.account, initial_password: initialPassword, expires_at: expiresAt };
}

export function createUserUseCases(db: Db) {
  async function createUser(cmd: { account: string; displayName: string; actorPrincipalCode: string }) {
    try {
      const admin = await systemAdminByCode(db, cmd.actorPrincipalCode);
      if (!admin) {
        return fail(new DomainError('user_forbidden', '只有系统管理员可以创建用户账号', { principal_code: cmd.actorPrincipalCode }));
      }
      const account = normalizeAccount(cmd.account);
      if (!/^[a-z0-9][a-z0-9._@-]{2,63}$/.test(account)) {
        return fail(new DomainError('user_account_invalid', '账号须为 3 到 64 位小写字母、数字或 . _ @ -'));
      }
      const displayName = cmd.displayName.trim();
      if (!displayName) return fail(new DomainError('user_display_name_required', '显示名称不能为空'));
      const [existing] = await db.select().from(schema.users).where(eq(schema.users.account, account)).limit(1);
      if (existing) return fail(new DomainError('user_account_exists', `用户账号已存在：${account}`));

      const initialPassword = generateInitialPassword();
      const expiresAt = new Date(Date.now() + INITIAL_PASSWORD_TTL_MS).toISOString();
      const [created] = await db.insert(schema.users).values({
        code: createPublicCode(),
        account,
        display_name: displayName,
        status: 'active',
        password_hash: await hashPassword(initialPassword),
        must_change_password: true,
        password_expires_at: expiresAt,
        created_at: now(),
      }).returning({ id: schema.users.id, code: schema.users.code });
      if (!created) throw new DomainError('internal_error', '创建用户失败');

      const audit = {
        entity_type: 'user',
        entity_id: created.id,
        principal_id: admin.id,
        base_snapshot: 0,
        action: 'user.created',
        payload: { account, display_name: displayName },
      };
      assertAuditedChange(audit);
      await insertAudit(db, toAuditEvent(audit, createPublicCode(), now()));
      return { ok: true as const, data: { user_code: created.code, account, initial_password: initialPassword, expires_at: expiresAt } };
    } catch (error) {
      return fail(error);
    }
  }

  async function listUsers(actorPrincipalCode: string) {
    const admin = await systemAdminByCode(db, actorPrincipalCode);
    if (!admin) return fail(new DomainError('user_forbidden', '只有系统管理员可以查看账号配置'));
    const rows = await db.select().from(schema.users);
    return {
      ok: true as const,
      data: rows.map((user) => ({
        user_code: user.code,
        account: user.account,
        display_name: user.display_name,
        status: user.status,
        is_system_admin: user.is_system_admin,
        must_change_password: user.must_change_password,
        pending_deletion: user.pending_deletion,
        deleted_at: user.deleted_at,
        created_at: user.created_at,
      })),
    };
  }

  async function listUserDirectory(actorPrincipalCode: string) {
    const actor = await findUserByCode(db, actorPrincipalCode);
    if (!actor || actor.status !== 'active') return fail(new DomainError('user_forbidden', '登录后才能查看用户目录'));
    const rows = await db.select({
      user_code: schema.users.code,
      account: schema.users.account,
      display_name: schema.users.display_name,
    }).from(schema.users).where(eq(schema.users.status, 'active'));
    return { ok: true as const, data: rows };
  }

  async function issueBindToken(cmd: { userCode: string; actorPrincipalCode: string }) {
    try {
      const admin = await systemAdminByCode(db, cmd.actorPrincipalCode);
      if (!admin) {
        return fail(new DomainError('user_forbidden', '只有系统管理员可以签发绑定 Token', { principal_code: cmd.actorPrincipalCode }));
      }
      const user = await findUserByCode(db, cmd.userCode);
      if (!user) return fail(new DomainError('user_not_found', `用户不存在：${cmd.userCode}`));
      if (user.status !== 'active') return fail(new DomainError('auth_user_disabled', '已禁用用户不能签发绑定 Token'));

      const bindToken = generateToken();
      const expiresAt = new Date(Date.now() + BIND_TOKEN_TTL_MS).toISOString();
      await db.update(schema.users).set({
        bind_token_hash: hashToken(bindToken),
        bind_token_expires_at: expiresAt,
      }).where(eq(schema.users.id, user.id));

      const audit = {
        entity_type: 'user',
        entity_id: user.id,
        legacy_entity_code: user.legacy_code ?? undefined,
        principal_id: admin.id,
        base_snapshot: 0,
        action: 'user.bind_token_issued',
      };
      assertAuditedChange(audit);
      await insertAudit(db, toAuditEvent(audit, createPublicCode(), now()));
      return { ok: true as const, data: { user_code: user.code, account: user.account, bind_token: bindToken, expires_at: expiresAt } };
    } catch (error) {
      return fail(error);
    }
  }

  async function issueInitialPassword(cmd: { userCode: string; actorPrincipalCode: string }) {
    try {
      const admin = await systemAdminByCode(db, cmd.actorPrincipalCode);
      if (!admin) {
        return fail(new DomainError('user_forbidden', '只有系统管理员可以重置初始密码', { principal_code: cmd.actorPrincipalCode }));
      }
      const user = await findUserByCode(db, cmd.userCode);
      if (!user) return fail(new DomainError('user_not_found', `用户不存在：${cmd.userCode}`));
      if (user.status !== 'active') return fail(new DomainError('auth_user_disabled', '已禁用用户不能重置密码'));
      if (user.is_system_admin && user.id !== admin.id) {
        return fail(new DomainError('user_system_admin_protected', '不能重置其他系统管理员的密码'));
      }

      const initialPassword = generateInitialPassword();
      const expiresAt = new Date(Date.now() + INITIAL_PASSWORD_TTL_MS).toISOString();
      const passwordHash = await hashPassword(initialPassword);
      await db.transaction(async (tx) => {
        await tx.update(schema.users).set({
          password_hash: passwordHash,
          must_change_password: true,
          password_expires_at: expiresAt,
        }).where(eq(schema.users.id, user.id));
        const devices = await tx.select().from(schema.devices).where(eq(schema.devices.principal_id, user.id));
        for (const device of devices) await revokeStableDevice(tx, device.id);
      });

      const audit = {
        entity_type: 'user',
        entity_id: user.id,
        legacy_entity_code: user.legacy_code ?? undefined,
        principal_id: admin.id,
        base_snapshot: 0,
        action: 'user.initial_password_issued',
      };
      assertAuditedChange(audit);
      await insertAudit(db, toAuditEvent(audit, createPublicCode(), now()));
      return { ok: true as const, data: { user_code: user.code, account: user.account, initial_password: initialPassword, expires_at: expiresAt } };
    } catch (error) {
      return fail(error);
    }
  }

  async function disableUser(cmd: { userCode: string; actorPrincipalCode: string }) {
    try {
      const admin = await systemAdminByCode(db, cmd.actorPrincipalCode);
      if (!admin) {
        return fail(new DomainError('user_forbidden', '只有系统管理员可以禁用账号', { principal_code: cmd.actorPrincipalCode }));
      }
      const user = await findUserByCode(db, cmd.userCode);
      if (!user) return fail(new DomainError('user_not_found', `用户不存在：${cmd.userCode}`));
      if (user.id === admin.id) return fail(new DomainError('user_self_disable', '不能禁用自己', { user_code: user.code }));
      if (user.is_system_admin) return fail(new DomainError('user_system_admin_protected', '系统管理员账号不能被禁用'));
      if (user.status === 'disabled') return { ok: true as const, data: { user_code: user.code, status: 'disabled' as const } };

      await db.update(schema.users).set({
        status: 'disabled',
        bind_token_hash: null,
        bind_token_expires_at: null,
      }).where(eq(schema.users.id, user.id));

      const audit = {
        entity_type: 'user',
        entity_id: user.id,
        legacy_entity_code: user.legacy_code ?? undefined,
        principal_id: admin.id,
        base_snapshot: 0,
        action: 'user.disabled',
      };
      assertAuditedChange(audit);
      await insertAudit(db, toAuditEvent(audit, createPublicCode(), now()));
      return { ok: true as const, data: { user_code: user.code, status: 'disabled' as const } };
    } catch (error) {
      return fail(error);
    }
  }

  async function enableUser(cmd: { userCode: string; actorPrincipalCode: string }) {
    try {
      return await db.transaction(async tx => {
        const users = await tx.select().from(schema.users)
          .where(inArray(schema.users.code, [cmd.userCode, cmd.actorPrincipalCode])).orderBy(asc(schema.users.id)).for('update');
        const admin = users.find(user => user.code === cmd.actorPrincipalCode);
        if (!admin || admin.status !== 'active' || admin.deleted_at || admin.pending_deletion || !admin.is_system_admin) {
          throw new DomainError('user_forbidden', '只有有效系统管理员可以恢复账号');
        }
        const user = users.find(row => row.code === cmd.userCode);
        if (!user) throw new DomainError('user_not_found', '用户不存在');
        if (user.deleted_at || user.pending_deletion) throw new DomainError('user_deleted', '已注销或正在注销的账号不能恢复');
        if (user.is_system_admin) throw new DomainError('user_system_admin_protected', '此操作不用于恢复系统管理员账号');
        if (user.status === 'active') return { ok: true as const, data: { user_code: user.code, status: 'active' as const } };
        // Enabling an account must never revive credentials or task leases from before its suspension.
        const devices = await tx.select().from(schema.devices).where(eq(schema.devices.principal_id, user.id));
        for (const device of devices) await revokeStableDevice(tx, device.id);
        await tx.update(schema.users).set({ status: 'active', bind_token_hash: null, bind_token_expires_at: null }).where(eq(schema.users.id, user.id));
        const audit = { entity_type: 'user', entity_id: user.id, principal_id: admin.id, base_snapshot: 0, action: 'user.enabled' };
        assertAuditedChange(audit);
        await insertAudit(tx, toAuditEvent(audit, createPublicCode(), now()));
        return { ok: true as const, data: { user_code: user.code, status: 'active' as const } };
      });
    } catch (error) { return fail(error); }
  }

  return { createUser, listUsers, listUserDirectory, issueBindToken, issueInitialPassword, disableUser, enableUser };
}

export type UserUseCases = ReturnType<typeof createUserUseCases>;
