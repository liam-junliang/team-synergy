import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { isPublicCode } from '@team-synergy/contracts';
import { createAuthUseCases, createDeviceAuthorizationUseCases } from '@team-synergy/application';
import { schema, type Db } from '@team-synergy/persistence';
import { unauthorized } from '../auth.js';

export function registerAuthRoutes(app: FastifyInstance, db: Db): void {
  const auth = createAuthUseCases(db);
  const deviceAuth = createDeviceAuthorizationUseCases(db);
  const attempts = new Map<string, { count: number; expires: number }>();
  function limited(key: string, maximum: number) {
    const timestamp = Date.now();
    for (const [entry, value] of attempts) if (value.expires <= timestamp) attempts.delete(entry);
    const value = attempts.get(key) ?? { count: 0, expires: timestamp + 60_000 };
    value.count += 1; attempts.set(key, value);
    return value.count > maximum;
  }
  const throttled = (reply: import('fastify').FastifyReply) => reply.code(429).send({ ok: false, error: { code: 'slow_down', message: '请求过多，请稍后重试' } });

  app.post<{ Body: Record<string, unknown> }>('/auth/device/start', async (request, reply) => {
    if (limited(`start:${request.ip}`, 12)) return throttled(reply);
    return deviceAuth.start(request.body ?? {});
  });
  app.post<{ Body: { device_code?: string } }>('/auth/device/token', async (request, reply) => {
    if (limited(`token:${request.ip}`, 120)) return throttled(reply);
    return deviceAuth.token(typeof request.body?.device_code === 'string' ? request.body.device_code : '');
  });
  app.get<{ Querystring: { user_code?: string } }>('/auth/device/request', async (request, reply) => {
    if (request.authKind !== 'bearer' || !request.principal) return unauthorized(reply);
    if (limited(`request:${request.principal}`, 30)) return throttled(reply);
    return deviceAuth.request(typeof request.query.user_code === 'string' ? request.query.user_code : '');
  });
  app.post<{ Body: { user_code?: string; decision?: 'approve' | 'deny' } }>('/auth/device/approve', async (request, reply) => {
    if (request.authKind !== 'bearer' || !request.principal) return unauthorized(reply);
    if (limited(`approve:${request.principal}`, 30)) return throttled(reply);
    return deviceAuth.approve(request.principal, typeof request.body?.user_code === 'string' ? request.body.user_code : '', request.body?.decision as 'approve' | 'deny');
  });
  app.post<{ Body: { device_identity?: unknown } }>('/auth/device-identity', async (request, reply) => {
    if (request.authKind !== 'bearer' || !request.authDeviceToken) return unauthorized(reply);
    return auth.bindIdentity(request.authDeviceToken, request.body?.device_identity);
  });

  function userCodeCondition(identifier: string) {
    const value = identifier.trim();
    if (!value) return undefined;
    return isPublicCode(value)
      ? eq(schema.users.code, value)
      : eq(schema.users.legacy_code, value);
  }

  app.post<{ Body: Record<string, unknown> }>('/auth/login', async (request, reply) => {
    const body = request.body ?? {};
    const result = await auth.bindDevice(
      typeof body.bind_token === 'string' ? body.bind_token : '',
      typeof body.device_name === 'string' ? body.device_name : '',
      undefined,
      body.device_identity,
    );
    if (!result.ok) return unauthorized(reply);
    return result;
  });

  app.post<{ Body: Record<string, unknown> }>('/auth/password-login', async (request, reply) => {
    const body = request.body ?? {};
    const result = await auth.loginWithPassword(
      typeof body.account === 'string' ? body.account : '',
      typeof body.password === 'string' ? body.password : '',
      typeof body.device_name === 'string' ? body.device_name : '',
      body.device_identity,
    );
    if (!result.ok) return unauthorized(reply);
    return result;
  });

  app.post<{ Body: Record<string, unknown> }>('/auth/password-change', async (request, reply) => {
    if (request.authKind !== 'bearer' || !request.principal || !request.authDeviceToken) return unauthorized(reply);
    const body = request.body ?? {};
    const result = await auth.changePassword(
      request.principal,
      typeof body.new_password === 'string' ? body.new_password : '',
      {
        currentDeviceToken: request.authDeviceToken,
        currentPassword: typeof body.current_password === 'string' ? body.current_password : undefined,
      },
    );
    if (!result.ok && result.error.code === 'auth_token_invalid') return unauthorized(reply);
    return result;
  });

  app.post('/auth/logout', async (request, reply) => {
    if (request.authKind !== 'bearer' || !request.authDeviceToken) return unauthorized(reply);
    const result = await auth.logout(request.authDeviceToken);
    if (!result.ok) return unauthorized(reply);
    return {
      ok: true as const,
      data: {
        logged_out: true,
        device_code: result.data.device_code,
        user_code: result.data.principal_code,
      },
    };
  });

  app.get('/auth/whoami', async (request, reply) => {
    if (request.authKind !== 'bearer' || !request.principal) return unauthorized(reply);
    const condition = userCodeCondition(request.principal);
    if (!condition) return unauthorized(reply);
    const [user] = await db.select().from(schema.users).where(condition).limit(1);
    if (!user || user.status === 'disabled') return unauthorized(reply);
    return {
      ok: true as const,
      data: {
        user_code: user.code,
        account: user.account,
        display_name: user.display_name,
        status: user.status,
        is_system_admin: user.is_system_admin,
        must_change_password: user.must_change_password,
      },
    };
  });
}
