import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { isPublicCode } from '@team-synergy/contracts';
import { createAuthUseCases, createDeviceAuthorizationUseCases, createAuthRateLimiter, getWebSessionUser, recordRateLimitedLogin } from '@team-synergy/application';
import { schema, type Db } from '@team-synergy/persistence';
import { hasAuthenticatedSession, unauthorized } from '../auth.js';
import { browserIdentity, clearWebSession, createWebCsrf, readWebCookies, refreshWebCsrf, setWebSession, validWebCsrf, webCookieSecure } from '../web-session.js';

export function registerAuthRoutes(app: FastifyInstance, db: Db): void {
  const auth = createAuthUseCases(db);
  const deviceAuth = createDeviceAuthorizationUseCases(db);
  const limited = createAuthRateLimiter(db);
  const throttled = (reply: import('fastify').FastifyReply, seconds: number) => reply.header('Retry-After', Math.max(1, seconds)).code(429).send({ ok: false, error: { code: 'slow_down', message: '请求过多，请稍后重试' } });
  app.post<{ Body: Record<string, unknown> }>('/auth/web/login', { bodyLimit: 16 * 1024 }, async (request, reply) => {
    const body = request.body ?? {};
    const account = typeof body.account === 'string' ? body.account.trim().toLowerCase() : '';
    const retry = await limited('password', request.ip, account);
    if (retry) { await recordRateLimitedLogin(db, account, { ip: request.ip }); return throttled(reply, retry); }
    const browser = browserIdentity(request, (body.device_identity as { platform?: unknown } | undefined)?.platform);
    const result = await auth.loginWithPassword(account, typeof body.password === 'string' ? body.password : '',
      typeof body.device_name === 'string' ? body.device_name : 'Web browser', browser.identity, { ip: request.ip });
    if (!result.ok && result.error.code === 'slow_down') return throttled(reply, Number((result.error.details as { retry_after: number }).retry_after));
    if (!result.ok) {
      if (result.error.code === 'auth_device_limit_reached') return reply.code(409).send(result);
      return unauthorized(reply);
    }
    const user = await getWebSessionUser(db, result.data.user_code);
    if (!user) return unauthorized(reply);
    const csrf = createWebCsrf(result.data.device_token);
    setWebSession(reply, result.data.device_token, csrf, browser.cookie, webCookieSecure(request) === true);
    return { ok: true, data: { user, csrf_token: csrf } };
  });
  app.get('/auth/web/session', async (request, reply) => {
    if (request.authKind !== 'cookie' || !request.principal || !request.authDeviceToken) return unauthorized(reply);
    const user = await getWebSessionUser(db, request.principal);
    if (!user) return unauthorized(reply);
    const stored = readWebCookies(request).csrf;
    const csrf = validWebCsrf(request.authDeviceToken, stored) && stored ? stored : createWebCsrf(request.authDeviceToken);
    reply.header('cache-control', 'no-store');
    if (csrf !== stored) refreshWebCsrf(reply, csrf, webCookieSecure(request) === true);
    return { ok: true, data: { user, csrf_token: csrf } };
  });
  app.post('/auth/web/logout', { bodyLimit: 16 * 1024 }, async (request, reply) => {
    if (request.authKind !== 'cookie' || !request.authDeviceToken) return unauthorized(reply);
    const result = await auth.logout(request.authDeviceToken);
    if (!result.ok) return unauthorized(reply);
    clearWebSession(reply, webCookieSecure(request) === true);
    return { ok: true, data: { logged_out: true } };
  });
  app.post<{ Body: Record<string, unknown> }>('/auth/device/start', { bodyLimit: 16 * 1024 }, async (request, reply) => {
    const retry = await limited('start', request.ip, undefined, 12, 120);
    if (retry) return throttled(reply, retry);
    return deviceAuth.start(request.body ?? {});
  });
  app.post<{ Body: { device_code?: string } }>('/auth/device/token', { bodyLimit: 16 * 1024 }, async (request, reply) => {
    const retry = await limited('token', request.ip, undefined, 120, 1200);
    if (retry) return throttled(reply, retry);
    const result = await deviceAuth.token(typeof request.body?.device_code === 'string' ? request.body.device_code : '');
    if (!result.ok && result.error.code === 'slow_down') return throttled(reply, Number((result.error.details as { retry_after: number }).retry_after));
    return result;
  });
  app.get<{ Querystring: { user_code?: string } }>('/auth/device/request', async (request, reply) => {
    if (!hasAuthenticatedSession(request) || !request.principal) return unauthorized(reply);
    const retry = await limited('request', request.ip, request.principal, 30, 300);
    if (retry) return throttled(reply, retry);
    return deviceAuth.request(typeof request.query.user_code === 'string' ? request.query.user_code : '');
  });
  app.post<{ Body: { user_code?: string; decision?: 'approve' | 'deny' } }>('/auth/device/approve', { bodyLimit: 16 * 1024 }, async (request, reply) => {
    if (!hasAuthenticatedSession(request) || !request.principal) return unauthorized(reply);
    const retry = await limited('approve', request.ip, request.principal);
    if (retry) return throttled(reply, retry);
    return deviceAuth.approve(request.principal, typeof request.body?.user_code === 'string' ? request.body.user_code : '', request.body?.decision as 'approve' | 'deny');
  });
  app.post<{ Body: { device_identity?: unknown } }>('/auth/device-identity', { bodyLimit: 16 * 1024 }, async (request, reply) => {
    if (!hasAuthenticatedSession(request) || !request.authDeviceToken) return unauthorized(reply);
    return auth.bindIdentity(request.authDeviceToken, request.body?.device_identity);
  });

  function userCodeCondition(identifier: string) {
    const value = identifier.trim();
    if (!value) return undefined;
    return isPublicCode(value)
      ? eq(schema.users.code, value)
      : eq(schema.users.legacy_code, value);
  }

  app.post<{ Body: Record<string, unknown> }>('/auth/login', { bodyLimit: 16 * 1024 }, async (request, reply) => {
    const body = request.body ?? {};
    const retry = await limited('bind', request.ip, typeof body.bind_token === 'string' ? body.bind_token : undefined);
    if (retry) return throttled(reply, retry);
    const result = await auth.bindDevice(
      typeof body.bind_token === 'string' ? body.bind_token : '',
      typeof body.device_name === 'string' ? body.device_name : '',
      undefined,
      body.device_identity,
    );
    if (!result.ok) return unauthorized(reply);
    return result;
  });

  app.post<{ Body: Record<string, unknown> }>('/auth/password-login', { bodyLimit: 16 * 1024 }, async (request, reply) => {
    const body = request.body ?? {};
    const account = typeof body.account === 'string' ? body.account.trim().toLowerCase() : '';
    const retry = await limited('password', request.ip, account);
    if (retry) { await recordRateLimitedLogin(db, account, { ip: request.ip }); return throttled(reply, retry); }
    const result = await auth.loginWithPassword(
      typeof body.account === 'string' ? body.account : '',
      typeof body.password === 'string' ? body.password : '',
      typeof body.device_name === 'string' ? body.device_name : '',
      body.device_identity,
      { ip: request.ip },
    );
    if (!result.ok && result.error.code === 'slow_down') return throttled(reply, Number((result.error.details as { retry_after: number }).retry_after));
    if (!result.ok) return unauthorized(reply);
    return result;
  });

  app.post<{ Body: Record<string, unknown> }>('/auth/password-change', { bodyLimit: 16 * 1024 }, async (request, reply) => {
    if (!hasAuthenticatedSession(request) || !request.principal || !request.authDeviceToken) return unauthorized(reply);
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

  app.post('/auth/logout', { bodyLimit: 16 * 1024 }, async (request, reply) => {
    if (!hasAuthenticatedSession(request) || !request.authDeviceToken) return unauthorized(reply);
    const result = await auth.logout(request.authDeviceToken);
    if (!result.ok) return unauthorized(reply);
    if (request.authKind === 'cookie') clearWebSession(reply, webCookieSecure(request) === true);
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
    if (!hasAuthenticatedSession(request) || !request.principal) return unauthorized(reply);
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
