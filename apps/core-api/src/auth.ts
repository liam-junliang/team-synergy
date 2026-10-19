import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createAuthUseCases } from '@team-synergy/application';
import type { Db } from '@team-synergy/persistence';

declare module 'fastify' {
  interface FastifyRequest {
    principal: string | null;
    authDeviceToken: string | null;
    authDeviceCode: string | null;
    authSessionCode: string | null;
    authKind: 'bearer' | 'legacy' | null;
    passwordChangeRequired: boolean;
  }
}

export function unauthorized(reply: FastifyReply) {
  return reply.code(401).send({
    ok: false as const,
    error: { code: 'unauthorized', message: '认证失败' },
  });
}

/** Exact anonymous endpoints; release filenames remain validated by the distribution handler. */
export function isPublicRoute(method: string, pathname: string): boolean {
  if (method === 'GET' && (pathname === '/health' || ['/cli/manifest.json', '/cli/install.ps1', '/cli/install.sh'].includes(pathname))) return true;
  if (method === 'GET' && /^\/cli\/releases\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(pathname)) return true;
  return method === 'POST' && ['/auth/login', '/auth/password-login', '/auth/device/start', '/auth/device/token'].includes(pathname);
}

/** Resolve Bearer credentials before routes, retaining x-principal-code for non-bearer transition flows. */
export function registerAuthMiddleware(app: FastifyInstance, db: Db): void {
  const auth = createAuthUseCases(db);
  app.decorateRequest('principal', null);
  app.decorateRequest('authDeviceToken', null);
  app.decorateRequest('authDeviceCode', null);
  app.decorateRequest('authSessionCode', null);
  app.decorateRequest('authKind', null);
  app.decorateRequest('passwordChangeRequired', false);

  app.addHook('onRequest', async (request, reply) => {
    const authorization = request.headers.authorization;
    if (authorization !== undefined) {
      const match = /^Bearer\s+([^\s]+)$/i.exec(authorization);
      if (!match?.[1]) return unauthorized(reply);
      const resolved = await auth.resolveToken(match[1]);
      if (!resolved.ok) return unauthorized(reply);
      request.principal = resolved.data.principal_code;
      request.authDeviceToken = match[1];
      request.authDeviceCode = resolved.data.device_code;
      request.authSessionCode = resolved.data.session_code;
      request.authKind = 'bearer';
      request.passwordChangeRequired = resolved.data.password_change_required;
      const path = request.url.split('?', 1)[0] ?? request.url;
      if (request.passwordChangeRequired && !new Set(['/auth/whoami', '/auth/password-change', '/auth/logout']).has(path)) {
        return reply.code(403).send({
          ok: false as const,
          error: { code: 'password_change_required', message: '首次登录必须先修改密码' },
        });
      }
      return;
    }

    const principalCode = request.headers['x-principal-code'];
    if (typeof principalCode === 'string' && principalCode.length > 0) {
      if (!allowLegacyIdentity()) {
        return reply.code(401).send({
          ok: false as const,
          error: { code: 'legacy_identity_disabled', message: 'x-principal-code 身份通道已关闭，请使用 tsp auth login 的设备凭据' },
        });
      }
      request.principal = principalCode;
      request.authKind = 'legacy';
      return;
    }

  });
  app.addHook('preHandler', async (request, reply) => {
    const path = request.url.split('?', 1)[0];
    if (isPublicRoute(request.method, path ?? '')) return;
    if (!request.principal) return unauthorized(reply);
  });
}

/**
 * Legacy 身份过渡通道（docs/23）：无 Bearer 凭据时允许 x-principal-code 声明身份。
 * 该通道不做凭据验证，仅限本机开发/测试使用；默认关闭，需显式开启：
 *   - 显式设置 ACP_ALLOW_LEGACY_IDENTITY=1 开启；
 *   - 未设置时仅在 NODE_ENV !== 'production' 且 ACP_ENV !== 'production' 的开发/测试环境放行。
 */
export function allowLegacyIdentity(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.ACP_ALLOW_LEGACY_IDENTITY;
  if (flag !== undefined && flag.length > 0) return flag === '1' || flag.toLowerCase() === 'true';
  return env.NODE_ENV !== 'production' && env.ACP_ENV !== 'production';
}

/** Route helper: only the authenticated middleware identity can act. */
export function principalOf(
  request: FastifyRequest,
  body: { principal_code?: unknown; user_code?: unknown } = {},
): string {
  if (request.principal) return request.principal;
  // Actor identity must come from the authentication middleware, never a target user/body field.
  void body;
  return '';
}
