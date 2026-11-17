import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createMemoryProjectManagementUseCases } from '@team-synergy/application';
import { PublicCodeSchema } from '@team-synergy/contracts';
import { DomainError } from '@team-synergy/domain';
import type { Db } from '@team-synergy/persistence';
import { hasAuthenticatedSession, unauthorized } from '../auth.js';
import { httpStatusForError } from '../error-status.js';
import { ensureProjectMemoryResource, verifyProjectMemoryResource, type EngineConfig } from '../memory-engines.js';
import { resolveProjectMemoryEngines } from '../memory-project-runtime.js';

type Request = FastifyRequest<{ Params: { projectCode: string } }>;
type Actor = { principalCode: string; projectCode: string };
const emptyBody = (value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;

/** Browsers control project policy; only the server supplies engine identities. */
export function registerMemoryManagementRoutes(app: FastifyInstance, db: Db, engines?: EngineConfig) {
  const memory = createMemoryProjectManagementUseCases(db);
  const base = '/projects/:projectCode/memory/management';
  const options = (code: string) => ({ serviceConfigured: Boolean(engines), legacyConfigured: Boolean(engines?.projects[code]) });

  async function handle(request: Request, reply: FastifyReply, work: (actor: Actor) => Promise<unknown>) {
    reply.header('Cache-Control', 'no-store');
    if (!hasAuthenticatedSession(request) || !request.principal) return unauthorized(reply);
    try {
      const code = PublicCodeSchema.safeParse(request.params.projectCode);
      if (!code.success || request.method === 'POST' && !emptyBody(request.body)) {
        throw new DomainError('invalid_request', '项目记忆管理请求无效。');
      }
      return { ok: true, data: await work({ principalCode: request.principal, projectCode: code.data }) };
    } catch (error) {
      if (error instanceof DomainError) return reply.code(httpStatusForError(error.code)).send({ ok: false, error: error.toJSON() });
      request.log.error('Project memory management failed');
      return reply.code(500).send({ ok: false, error: { code: 'internal_error', message: '项目记忆管理失败。' } });
    }
  }

  async function enable(actor: Actor, guard?: { expectedGeneration: number | null; onlyIfEnabled: true }) {
    const ticket = await memory.enable(actor, options(actor.projectCode), guard);
    if (ticket.provisionRequired && engines) {
      try {
        const binding = await ensureProjectMemoryResource(engines, actor.projectCode);
        await memory.completeProvision({ projectCode: actor.projectCode, generation: ticket.generation, binding });
      } catch (error) {
        const errorCode = error instanceof Error && error.message === 'Wiki identity mismatch' ? 'identity_mismatch' : 'engine_unavailable';
        await memory.failProvision({ projectCode: actor.projectCode, generation: ticket.generation, errorCode });
      }
    }
    return memory.status(actor, options(actor.projectCode));
  }

  app.get(base, (request: Request, reply) => handle(request, reply, actor => memory.status(actor, options(actor.projectCode))));
  app.post(base + '/enable', { bodyLimit: 256 }, (request: Request, reply) => handle(request, reply, actor => enable(actor)));
  app.post(base + '/pause', { bodyLimit: 256 }, (request: Request, reply) => handle(request, reply, actor => memory.pause(actor, options(actor.projectCode))));
  app.post(base + '/retry', { bodyLimit: 256 }, (request: Request, reply) => handle(request, reply, async actor => {
    // Authorization and the enabled check happen before any engine access.
    await memory.retry(actor, options(actor.projectCode));
    const binding = await memory.binding(actor.projectCode);
    let expectedGeneration = binding?.generation ?? null;
    if (engines && binding?.enabled && binding.state === 'ready') {
      try {
        const resolved = await resolveProjectMemoryEngines(db, engines, actor.projectCode);
        if (resolved.generation !== expectedGeneration || !resolved.config.projects[actor.projectCode]) return memory.status(actor, options(actor.projectCode));
        await verifyProjectMemoryResource(resolved.config, actor.projectCode);
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'Engine HTTP 404') {
          throw new DomainError('memory_service_unavailable', '项目记忆连接暂时无法验证，请稍后重试。');
        }
        const invalidated = await memory.invalidateBinding({ projectCode: actor.projectCode, generation: binding.generation, errorCode: 'resource_unavailable' });
        if (!invalidated) return memory.status(actor, options(actor.projectCode));
        expectedGeneration = binding.generation + 1;
      }
    }
    await enable(actor, { expectedGeneration, onlyIfEnabled: true });
    try { return (await memory.retry(actor, options(actor.projectCode))).status; }
    catch (error) {
      if (error instanceof DomainError && error.code === 'memory_not_enabled') return memory.status(actor, options(actor.projectCode));
      throw error;
    }
  }));
}
