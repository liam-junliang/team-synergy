import type { FastifyInstance } from 'fastify';
import { aggregateLoginSecurity } from '@team-synergy/application';
import type { Db } from '@team-synergy/persistence';
import { hasAuthenticatedSession, unauthorized } from '../auth.js';

type Query = { group_by?: string; since?: string; until?: string; limit?: string; offset?: string; account_hash?: string; ip_hash?: string };
export function registerLoginSecurityRoutes(app: FastifyInstance, db: Db) {
  app.get<{ Querystring: Query }>('/admin/security/login-events', async (request, reply) => {
    if (!hasAuthenticatedSession(request) || !request.principal) return unauthorized(reply);
    const query = request.query;
    const result = await aggregateLoginSecurity(db, request.principal, {
      invalidParameters: Object.keys(query).some(key => !['group_by', 'since', 'until', 'limit', 'offset', 'account_hash', 'ip_hash'].includes(key)),
      groupBy: (query.group_by ?? 'account') as 'account' | 'ip', since: query.since, until: query.until,
      limit: query.limit === undefined ? undefined : Number(query.limit), offset: query.offset === undefined ? undefined : Number(query.offset),
      accountHash: query.account_hash, ipHash: query.ip_hash,
    });
    if (!result.ok) return reply.code(result.error.code === 'admin_forbidden' ? 403 : result.error.code === 'validation_failed' ? 400 : 503).send(result);
    return result;
  });
}
