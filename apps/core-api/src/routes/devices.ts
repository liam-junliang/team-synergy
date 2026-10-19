import type { FastifyInstance } from 'fastify';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { createPublicCode, fail, findUserByCode, codeCondition, insertAudit, now, revokeStableDevice } from '@team-synergy/application';
import { DomainError, assertAuditedChange, toAuditEvent } from '@team-synergy/domain';
import { schema, type Db } from '@team-synergy/persistence';
import { unauthorized } from '../auth.js';

/** Installation management and individual session revocation share the same ownership boundary. */
export function registerDeviceRoutes(app: FastifyInstance, db: Db): void {
  async function ownDevice(principal: string, deviceCode: string, conn: Db | Parameters<Parameters<Db['transaction']>[0]>[0] = db) {
    const actorCondition = codeCondition(schema.users, principal);
    const deviceCondition = codeCondition(schema.devices, deviceCode);
    const [actor] = actorCondition ? await conn.select().from(schema.users).where(actorCondition).limit(1) : [];
    const [device] = deviceCondition ? await conn.select().from(schema.devices).where(deviceCondition).limit(1) : [];
    if (!actor || actor.status !== 'active' || !device || !actor.is_system_admin && actor.id !== device.principal_id) throw new DomainError('device_forbidden', '只能管理自己的客户端，系统管理员可管理全部客户端');
    return { actor, device };
  }
  async function audited(tx: Parameters<Parameters<Db['transaction']>[0]>[0], actorId: bigint, device: typeof schema.devices.$inferSelect, action: string, payload: Record<string, unknown> = {}) {
    const audit = { entity_type: 'device', entity_id: device.id, principal_id: actorId, base_snapshot: 0, action, payload: { device_code: device.code, ...payload } };
    assertAuditedChange(audit);
    await insertAudit(tx, toAuditEvent(audit, createPublicCode(), now()));
  }
  app.get<{ Querystring: { user_code?: string } }>('/devices', async (request, reply) => {
    if (request.authKind !== 'bearer' || !request.principal) return unauthorized(reply);
    try {
      const actor = await findUserByCode(db, request.principal);
      const target = await findUserByCode(db, request.query.user_code ?? request.principal);
      if (!actor || actor.status !== 'active' || !actor.is_system_admin && actor.id !== target?.id) throw new DomainError('device_forbidden', '只能查看自己的客户端');
      if (!target) return { ok: true as const, data: [] };
      const devices = await db.select().from(schema.devices).where(eq(schema.devices.principal_id, target.id)).orderBy(desc(schema.devices.last_login_at), desc(schema.devices.created_at));
      const data = await Promise.all(devices.map(async device => {
        const sessions = await db.select().from(schema.deviceSessions).where(and(eq(schema.deviceSessions.device_id, device.id), isNull(schema.deviceSessions.revoked_at)));
        return { device_code: device.code, device_name: device.device_name, created_at: device.created_at, last_login_at: device.last_login_at ?? device.created_at, client_type: device.client_type, platform: device.platform, current: device.code === request.authDeviceCode, status: device.revoked_at ? 'revoked' : 'active', session_count: device.revoked_at ? 0 : sessions.filter(s => !s.expires_at || Date.parse(s.expires_at) > Date.now()).length };
      }));
      return { ok: true as const, data };
    } catch (error) { return fail(error); }
  });
  app.get<{ Params: { device_code: string } }>('/devices/:device_code/sessions', async (request, reply) => {
    if (request.authKind !== 'bearer' || !request.principal) return unauthorized(reply);
    try {
      const { device } = await ownDevice(request.principal, request.params.device_code);
      const sessions = await db.select().from(schema.deviceSessions).where(eq(schema.deviceSessions.device_id, device.id)).orderBy(desc(schema.deviceSessions.created_at));
      return { ok: true as const, data: sessions.map(session => ({ code: session.code, created_at: session.created_at, expires_at: session.expires_at, revoked_at: session.revoked_at, current: session.code === request.authSessionCode, status: session.revoked_at || device.revoked_at ? 'revoked' : session.expires_at && Date.parse(session.expires_at) <= Date.now() ? 'expired' : 'active' })) };
    } catch (error) { return fail(error); }
  });
  app.post<{ Params: { session_code: string } }>('/sessions/:session_code/revoke', async (request, reply) => {
    if (request.authKind !== 'bearer' || !request.principal) return unauthorized(reply);
    const principal = request.principal;
    try {
      const data = await db.transaction(async tx => {
        const [session] = await tx.select().from(schema.deviceSessions).where(eq(schema.deviceSessions.code, request.params.session_code)).limit(1);
        const [device] = session ? await tx.select().from(schema.devices).where(eq(schema.devices.id, session.device_id)).limit(1) : [];
        if (!device || !session) throw new DomainError('device_forbidden', '会话不可访问');
        const { actor } = await ownDevice(principal, device.code, tx);
        await tx.update(schema.deviceSessions).set({ revoked_at: now() }).where(eq(schema.deviceSessions.id, session.id));
        await audited(tx, actor.id, device, 'device.session_revoked', { session_code: session.code });
        return { session_code: session.code };
      });
      return { ok: true as const, data };
    } catch (error) { return fail(error); }
  });
  app.patch<{ Params: { device_code: string }; Body: { device_name?: string } }>('/devices/:device_code', async (request, reply) => {
    if (request.authKind !== 'bearer' || !request.principal) return unauthorized(reply);
    const principal = request.principal;
    try {
      const name = request.body?.device_name;
      if (typeof name !== 'string' || !name.trim() || name.length > 200) throw new DomainError('validation_failed', '客户端名称应为 1 到 200 个字符');
      const data = await db.transaction(async tx => {
        const { actor, device } = await ownDevice(principal, request.params.device_code, tx);
        await tx.update(schema.devices).set({ device_name: name.trim() }).where(eq(schema.devices.id, device.id));
        await audited(tx, actor.id, device, 'device.renamed', { device_name: name.trim() });
        return { device_code: device.code, device_name: name.trim() };
      });
      return { ok: true as const, data };
    } catch (error) { return fail(error); }
  });
  app.post<{ Params: { device_code: string } }>('/devices/:device_code/revoke', async (request, reply) => {
    if (request.authKind !== 'bearer' || !request.principal) return unauthorized(reply);
    const principal = request.principal;
    try {
      const data = await db.transaction(async tx => {
        const { actor, device } = await ownDevice(principal, request.params.device_code, tx);
        await revokeStableDevice(tx, device.id);
        await audited(tx, actor.id, device, 'device.revoked');
        const [user] = await tx.select().from(schema.users).where(eq(schema.users.id, device.principal_id)).limit(1);
        return { device_code: device.code, user_code: user?.code ?? '' };
      });
      return { ok: true as const, data };
    } catch (error) { return fail(error); }
  });
}
