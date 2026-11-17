import type { FastifyInstance } from 'fastify';
import type { Db } from '@team-synergy/persistence';
import { exportAuditPage } from '@team-synergy/application';
import { DomainError } from '@team-synergy/domain';
import { hasAuthenticatedSession, unauthorized } from '../auth.js';

export function registerAuditRoutes(app: FastifyInstance, db: Db) {
  app.get<{ Querystring: { since?: string; cursor?: string; snapshot?: string; limit?: string } }>('/audit/export', async (request, reply) => {
    if (!hasAuthenticatedSession(request) || !request.principal) return unauthorized(reply);
    try {
      const data = await exportAuditPage(db, request.principal, { since: request.query.since ?? '', cursor: request.query.cursor, snapshot: request.query.snapshot,
        limit: request.query.limit === undefined ? undefined : /^\d+$/.test(request.query.limit) ? Number(request.query.limit) : NaN });
      return { ok: true, data };
    } catch (error) {
      if (error instanceof DomainError) return reply.code(error.code === 'admin_forbidden' ? 403 : 400).send({ ok: false, error: { code: error.code, message: error.message } });
      return reply.code(500).send({ ok: false, error: { code: 'internal_error', message: '审计导出失败' } });
    }
  });
}
