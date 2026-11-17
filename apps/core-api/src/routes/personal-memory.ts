import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createPersonalMemoryUseCases } from '@team-synergy/application';
import { PersonalMemoryEditInput, PersonalMemoryListQuery, PersonalMemoryWithdrawInput, PublicCodeSchema } from '@team-synergy/contracts';
import { DomainError } from '@team-synergy/domain';
import type { Db } from '@team-synergy/persistence';
import { hasAuthenticatedSession, unauthorized } from '../auth.js';
import { httpStatusForError } from '../error-status.js';

export function registerPersonalMemoryRoutes(app: FastifyInstance, db: Db) {
  const personal = createPersonalMemoryUseCases(db);
  const base = '/memory/personal';
  type Request = FastifyRequest<{ Params: { source: string } }>;
  async function handle(request: FastifyRequest, reply: FastifyReply, action: (principalCode: string) => Promise<unknown>) {
    reply.header('Cache-Control', 'no-store');
    if (!hasAuthenticatedSession(request) || !request.principal) return unauthorized(reply);
    try { return { ok: true, data: await action(request.principal) }; }
    catch (error) {
      if (error instanceof DomainError) return reply.code(httpStatusForError(error.code)).send({ ok: false, error: error.toJSON() });
      request.log.error('Personal memory request failed');
      return reply.code(500).send({ ok: false, error: { code: 'internal_error', message: '个人记忆请求失败。' } });
    }
  }
  function source(request: Request) {
    const parsed = PublicCodeSchema.safeParse(request.params.source);
    if (!parsed.success) throw new DomainError('memory_invalid', '记忆编码无效。');
    return parsed.data;
  }
  app.get(base, { logLevel: 'silent' }, (request, reply) => handle(request,reply,async principalCode => {
    const input = PersonalMemoryListQuery.safeParse(request.query);
    if (!input.success) throw new DomainError('memory_invalid', '记忆筛选条件无效。');
    return personal.list({ principalCode, ...input.data });
  }));
  app.get(base + '/:source', { logLevel: 'silent' }, (request: Request, reply) => handle(request,reply,async principalCode =>
    personal.read({ principalCode, source: source(request) })));
  app.patch(base + '/:source', { bodyLimit: 32 * 1024 }, (request: Request, reply) => handle(request,reply,async principalCode => {
    const input = PersonalMemoryEditInput.safeParse(request.body);
    if (!input.success) throw new DomainError('memory_invalid', '请提供正文与打开编辑时的版本。');
    return personal.edit({ principalCode, source: source(request), ...input.data });
  }));
  app.post(base + '/:source/withdraw', { bodyLimit: 4096 }, (request: Request, reply) => handle(request,reply,async principalCode => {
    const input = PersonalMemoryWithdrawInput.safeParse(request.body);
    if (!input.success) throw new DomainError('memory_invalid', '请提供当前记忆版本。');
    return personal.withdraw({ principalCode, source: source(request), ...input.data });
  }));
}
