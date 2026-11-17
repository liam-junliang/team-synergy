import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { schema, type Db } from '@team-synergy/persistence';
import { DomainError } from '@team-synergy/domain';
import { findUserByCode } from './public-code.js';

export async function listPrincipalDevices(db: Db, principalCode: string, targetCode = principalCode, currentDeviceCode?: string) {
  const actor = await findUserByCode(db, principalCode);
  const target = targetCode === principalCode ? actor : await findUserByCode(db, targetCode);
  if (!actor || actor.status !== 'active' || !actor.is_system_admin && actor.id !== target?.id) {
    throw new DomainError('device_forbidden', '只能查看自己的客户端');
  }
  if (!target) return [];
  const devices = await db.select().from(schema.devices).where(eq(schema.devices.principal_id, target.id))
    .orderBy(desc(schema.devices.last_login_at), desc(schema.devices.created_at));
  const sessions = devices.length ? await db.select({ deviceId: schema.deviceSessions.device_id, expiresAt: schema.deviceSessions.expires_at })
    .from(schema.deviceSessions).where(and(inArray(schema.deviceSessions.device_id, devices.map(device => device.id)), isNull(schema.deviceSessions.revoked_at))) : [];
  const counts = new Map<bigint, number>();
  const currentTime = Date.now();
  for (const session of sessions) {
    if (!session.expiresAt || Date.parse(session.expiresAt) > currentTime) counts.set(session.deviceId, (counts.get(session.deviceId) ?? 0) + 1);
  }
  return devices.map(device => ({ device_code: device.code, device_name: device.device_name, created_at: device.created_at,
    last_login_at: device.last_login_at ?? device.created_at, client_type: device.client_type, platform: device.platform,
    current: device.code === currentDeviceCode, status: device.revoked_at ? 'revoked' : 'active',
    session_count: device.revoked_at ? 0 : counts.get(device.id) ?? 0 }));
}
