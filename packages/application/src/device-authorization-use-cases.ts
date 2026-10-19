import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema, type Db } from '@team-synergy/persistence';
import { DomainError } from '@team-synergy/domain';
import { createDeviceLogin, parseDeviceIdentity } from './auth-device.js';
import { findUserByCode } from './public-code.js';
import { hashToken, generateToken } from './user-use-cases.js';
import { fail, now } from './task-service.js';

const TTL_MS = 10 * 60_000;
const normalizeCode = (value: string) => value.replace(/[\s-]/g, '').toUpperCase();
const codeHash = (value: string) => hashToken(`tsp-device-code:${normalizeCode(value)}`);
const expired = (value: string) => Date.parse(value) <= Date.now();

export function createDeviceAuthorizationUseCases(db: Db) {
  async function start(input: { device_name?: unknown; device_identity?: unknown }) {
    try {
      const identity = parseDeviceIdentity(input.device_identity);
      if (!identity || identity.client_type !== 'cli') throw new DomainError('auth_device_identity_invalid', '需要 CLI 安装身份');
      if (typeof input.device_name !== 'string' || !input.device_name.trim() || input.device_name.length > 200) throw new DomainError('auth_device_name_required', '设备名称不能为空且最多 200 字符');
      const deviceCode = generateToken();
      const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
      const raw = [...randomBytes(8)].map(byte => alphabet[byte % 32]).join('');
      const userCode = `${raw.slice(0, 4)}-${raw.slice(4)}`;
      await db.insert(schema.deviceAuthorizationRequests).values({ device_code_hash: hashToken(deviceCode), user_code_hash: codeHash(userCode), device_name: input.device_name.trim(), ...identity, created_at: now(), expires_at: new Date(Date.now() + TTL_MS).toISOString() });
      return { ok: true as const, data: { device_code: deviceCode, user_code: userCode, expires_in: TTL_MS / 1000, interval: 5 } };
    } catch (error) { return fail(error); }
  }
  async function request(userCode: string) {
    try {
      const [row] = await db.select().from(schema.deviceAuthorizationRequests).where(eq(schema.deviceAuthorizationRequests.user_code_hash, codeHash(userCode))).limit(1);
      if (!row || expired(row.expires_at)) throw new DomainError('expired_token', '授权请求不存在或已过期，请重新发起');
      return { ok: true as const, data: { user_code: userCode, device_name: row.device_name, client_type: row.client_type, platform: row.platform, expires_at: row.expires_at, status: row.status } };
    } catch (error) { return fail(error); }
  }
  async function approve(principalCode: string, userCode: string, decision: 'approve' | 'deny') {
    try {
      if (!['approve', 'deny'].includes(decision)) throw new DomainError('validation_failed', '授权决定无效');
      const actor = await findUserByCode(db, principalCode);
      if (!actor) throw new DomainError('unauthorized', '请登录');
      const data = await db.transaction(async tx => {
        const [row] = await tx.select().from(schema.deviceAuthorizationRequests).where(eq(schema.deviceAuthorizationRequests.user_code_hash, codeHash(userCode))).for('update').limit(1);
        if (!row || expired(row.expires_at)) throw new DomainError('expired_token', '授权请求不存在或已过期');
        if (row.status !== 'pending') throw new DomainError('access_denied', '此请求已处理，请重新发起授权');
        const [user] = await tx.select().from(schema.users).where(eq(schema.users.id, actor.id)).for('update').limit(1);
        if (!user || user.status !== 'active') throw new DomainError('auth_user_disabled', '账号已禁用');
        if (user.must_change_password) throw new DomainError('password_change_required', '请先修改初始密码');
        await tx.update(schema.deviceAuthorizationRequests).set({ status: decision === 'approve' ? 'approved' : 'denied', principal_id: user.id }).where(eq(schema.deviceAuthorizationRequests.id, row.id));
        return { status: decision === 'approve' ? 'approved' : 'denied' };
      });
      return { ok: true as const, data };
    } catch (error) { return fail(error); }
  }
  async function token(deviceCode: string) {
    try {
      if (!deviceCode || deviceCode.length > 256) throw new DomainError('expired_token', '授权请求无效');
      return await db.transaction(async tx => {
        const [row] = await tx.select().from(schema.deviceAuthorizationRequests).where(eq(schema.deviceAuthorizationRequests.device_code_hash, hashToken(deviceCode))).for('update').limit(1);
        if (!row || expired(row.expires_at) || row.status === 'consumed') return fail(new DomainError('expired_token', '授权请求已过期或已兑换'));
        if (row.status === 'denied') return fail(new DomainError('access_denied', '用户拒绝授权'));
        const timestamp = now();
        if (row.last_polled_at && Date.now() - Date.parse(row.last_polled_at) < row.interval_seconds * 1000) {
          await tx.update(schema.deviceAuthorizationRequests).set({ last_polled_at: timestamp, interval_seconds: Math.min(60, row.interval_seconds + 5) }).where(eq(schema.deviceAuthorizationRequests.id, row.id));
          return fail(new DomainError('slow_down', '轮询过快，请增加至少 5 秒间隔'));
        }
        await tx.update(schema.deviceAuthorizationRequests).set({ last_polled_at: timestamp }).where(eq(schema.deviceAuthorizationRequests.id, row.id));
        if (row.status === 'pending' || !row.principal_id) return fail(new DomainError('authorization_pending', '等待浏览器授权'));
        const [user] = await tx.select().from(schema.users).where(eq(schema.users.id, row.principal_id)).for('update').limit(1);
        if (!user || user.status !== 'active' || user.must_change_password) return fail(new DomainError('access_denied', '账号不能授权，请重新登录'));
        const data = await createDeviceLogin(tx, user, row.device_name, { installation_id: row.installation_id, installation_secret_hash: row.installation_secret_hash, client_type: row.client_type, platform: row.platform });
        await tx.update(schema.deviceAuthorizationRequests).set({ status: 'consumed' }).where(eq(schema.deviceAuthorizationRequests.id, row.id));
        return { ok: true as const, data };
      });
    } catch (error) { return fail(error); }
  }
  return { start, request, approve, token };
}
