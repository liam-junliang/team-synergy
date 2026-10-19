import { timingSafeEqual } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { schema, type Db } from '@team-synergy/persistence';
import { DomainError } from '@team-synergy/domain';
import { createPublicCode } from './public-code.js';
import { generateToken, hashToken } from './user-use-cases.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type AuthDb = Db | Tx;
export const MAX_DEVICES_PER_USER = 10;
export interface DeviceIdentity { installation_id: string; installation_secret: string; client_type: 'web' | 'cli'; platform: string }
export interface StoredDeviceIdentity { installation_id: string; installation_secret_hash: string; client_type: 'web' | 'cli'; platform: string }

export function parseDeviceIdentity(value: unknown): StoredDeviceIdentity | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DomainError('auth_device_identity_invalid', '设备安装身份无效');
  const v = value as Record<string, unknown>;
  if (typeof v.installation_id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v.installation_id)
    || typeof v.installation_secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(v.installation_secret)
    || !['web', 'cli'].includes(String(v.client_type)) || typeof v.platform !== 'string' || !v.platform.trim() || v.platform.length > 100) {
    throw new DomainError('auth_device_identity_invalid', '设备安装身份无效');
  }
  return { installation_id: v.installation_id.toLowerCase(), installation_secret_hash: hashToken(v.installation_secret), client_type: v.client_type as 'web' | 'cli', platform: v.platform.trim() };
}

function equalHash(a: string | null, b: string) {
  return a !== null && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** Caller holds the user row lock. The execution secret and device id never change on relogin. */
export async function createDeviceLogin(tx: Tx, user: typeof schema.users.$inferSelect, deviceName: string, identity?: StoredDeviceIdentity) {
  if (user.status !== 'active') throw new DomainError('auth_user_disabled', '用户已禁用');
  const name = deviceName.trim();
  if (!name || name.length > 200) throw new DomainError('auth_device_name_required', '设备名称不能为空且最多 200 字符');
  let device = identity ? (await tx.select().from(schema.devices).where(and(
    eq(schema.devices.principal_id, user.id), eq(schema.devices.client_type, identity.client_type), eq(schema.devices.installation_id, identity.installation_id),
  )).for('update').limit(1))[0] : undefined;
  if (device && identity && !equalHash(device.installation_secret_hash, identity.installation_secret_hash)) throw new DomainError('auth_device_identity_mismatch', '设备安装凭据不匹配，请重新初始化客户端身份');
  if (!device || device.revoked_at) {
    const active = await tx.select({ id: schema.devices.id }).from(schema.devices).where(and(eq(schema.devices.principal_id, user.id), isNull(schema.devices.revoked_at)));
    if (active.length >= MAX_DEVICES_PER_USER) throw new DomainError('auth_device_limit_reached', `设备数量已达上限（${MAX_DEVICES_PER_USER}），请先吊销不再使用的设备`);
  }
  const timestamp = new Date().toISOString();
  if (!device) {
    [device] = await tx.insert(schema.devices).values({ code: createPublicCode(), principal_id: user.id, device_name: name,
      credential_hash: hashToken(generateToken()), legacy_session_initialized: true, created_at: timestamp, last_login_at: timestamp,
      ...identity,
    }).returning();
  } else {
    [device] = await tx.update(schema.devices).set({ last_login_at: timestamp, revoked_at: null, platform: identity?.platform }).where(eq(schema.devices.id, device.id)).returning();
  }
  if (!device) throw new DomainError('internal_error', '无法创建客户端');
  const token = generateToken();
  const [session] = await tx.insert(schema.deviceSessions).values({ code: createPublicCode(), device_id: device.id,
    token_hash: hashToken(token), created_at: timestamp, expires_at: new Date(Date.now() + 90 * 24 * 60 * 60_000).toISOString(),
  }).returning();
  if (!session) throw new DomainError('internal_error', '无法创建登录会话');
  return { device_code: device.code, device_token: token, user_code: user.code, device_name: device.device_name ?? name, session_code: session.code };
}

/** One-time legacy enrollment preserves existing fixtures/credentials, never resurrects a revoked session. */
export async function resolveSessionToken(db: AuthDb, token: string) {
  if (!token) return undefined;
  const tokenHash = hashToken(token);
  let session = (await db.select().from(schema.deviceSessions).where(eq(schema.deviceSessions.token_hash, tokenHash)).limit(1))[0];
  if (!session) {
    await db.transaction(async tx => {
      const [legacy] = await tx.select().from(schema.devices).where(eq(schema.devices.credential_hash, tokenHash)).for('update').limit(1);
      if (!legacy || legacy.legacy_session_initialized || legacy.revoked_at) return;
      await tx.insert(schema.deviceSessions).values({ code: createPublicCode(), device_id: legacy.id, token_hash: tokenHash, created_at: legacy.created_at }).onConflictDoNothing();
      await tx.update(schema.devices).set({ legacy_session_initialized: true, last_login_at: legacy.last_login_at ?? legacy.created_at }).where(eq(schema.devices.id, legacy.id));
    });
    session = (await db.select().from(schema.deviceSessions).where(eq(schema.deviceSessions.token_hash, tokenHash)).limit(1))[0];
  }
  if (!session || session.revoked_at || session.expires_at && Date.parse(session.expires_at) <= Date.now()) return undefined;
  const [device] = await db.select().from(schema.devices).where(eq(schema.devices.id, session.device_id)).limit(1);
  if (!device || device.revoked_at) return undefined;
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, device.principal_id)).limit(1);
  if (!user || user.status !== 'active') throw new DomainError('auth_user_disabled', '用户不存在或已禁用');
  return { device, session, user };
}

export async function revokeStableDevice(db: AuthDb, deviceId: bigint) {
  const timestamp = new Date().toISOString();
  await db.update(schema.devices).set({ revoked_at: timestamp, legacy_session_initialized: true }).where(eq(schema.devices.id, deviceId));
  await db.update(schema.deviceSessions).set({ revoked_at: timestamp }).where(and(eq(schema.deviceSessions.device_id, deviceId), isNull(schema.deviceSessions.revoked_at)));
  await db.update(schema.runLeases).set({ revoked_at: timestamp }).where(and(eq(schema.runLeases.device_id, deviceId), isNull(schema.runLeases.revoked_at)));
}
