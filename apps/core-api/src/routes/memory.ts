import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createMemoryCenterUseCases, createMemorySliceUseCases } from '@team-synergy/application';
import { MemoryBindingQuery, MemoryBriefInput, MemoryCaptureInput, MemoryDocumentReadInput, MemorySearchQuery, MemorySourcesInput, PublicCodeSchema } from '@team-synergy/contracts';
import { DomainError } from '@team-synergy/domain';
import type { Db } from '@team-synergy/persistence';
import { hasAuthenticatedSession, unauthorized } from '../auth.js';
import { extractMemoryParts } from '../memory-extraction.js';
import { httpStatusForError } from '../error-status.js';
import { rankedMemoryRefs, searchMemoryEngineDetailed, type EngineConfig, type MemoryEngineMatches } from '../memory-engines.js';
import { resolveProjectMemoryEngines } from '../memory-project-runtime.js';
import { enqueueMemoryCapture, readMemoryCapture, retryMemoryCapture } from '../memory-capture-queue.js';
import { ensurePersonalMemoryResource } from '../memory-personal-runtime.js';
import { MemoryCenterQuery } from '@team-synergy/contracts';
import { memoryModelStatus } from '../memory-observability.js';

type Request = FastifyRequest<{ Params: { projectCode: string } }>;
type Actor = { principalCode: string; projectCode: string };

/** Read-only account entry remains available when capture/projection is disabled. */
export function registerMemoryCenterRoutes(app: FastifyInstance, db: Db, engines?: EngineConfig) {
  const center = createMemoryCenterUseCases(db);
  app.get('/account/memory-center', { logLevel: 'silent' }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!hasAuthenticatedSession(request) || !request.principal) return unauthorized(reply);
    try {
      const query = MemoryCenterQuery.safeParse(request.query);
      if (!query.success) throw new DomainError('invalid_request', '记忆中心筛选条件无效。');
      const { canViewServiceObservations, ...data } = await center.read({ ...query.data, principalCode: request.principal },
        projectCode => ({ serviceConfigured: Boolean(engines), legacyConfigured: Boolean(engines?.projects[projectCode]) }));
      return { ok: true, data: { ...data, model: memoryModelStatus(canViewServiceObservations), serviceEnabled: process.env.TSP_MEMORY_ENABLED === '1' } };
    } catch (error) {
      if (error instanceof DomainError) return reply.code(httpStatusForError(error.code)).send({ ok: false, error: error.toJSON() });
      request.log.error('Memory center request failed');
      return reply.code(500).send({ ok: false, error: { code: 'internal_error', message: '记忆中心暂不可用。' } });
    }
  });
}

export function registerMemoryRoutes(app: FastifyInstance, db: Db, engines?: EngineConfig) {
  const memory = createMemorySliceUseCases(db);
  const base = '/projects/:projectCode/memory';

  async function handle(request: Request, reply: FastifyReply, action: (actor: Actor) => Promise<unknown>) {
    reply.header('Cache-Control', 'no-store');
    if (!hasAuthenticatedSession(request) || !request.principal) return unauthorized(reply);
    try {
      const project = PublicCodeSchema.safeParse(request.params.projectCode);
      if (!project.success) throw new DomainError('invalid_request', '项目编码无效。');
      const data = await action({ principalCode: request.principal, projectCode: project.data });
      return { ok: true, data };
    } catch (error) {
      if (error instanceof DomainError) {
        return reply.code(httpStatusForError(error.code)).send({ ok: false, error: error.toJSON() });
      }
      request.log.error('Memory request failed');
      return reply.code(500).send({ ok: false, error: { code: 'internal_error', message: '记忆请求失败。' } });
    }
  }

  const search = (request: Request, reply: FastifyReply) => handle(request, reply, async actor => {
    const input = MemorySearchQuery.safeParse(request.method === 'POST' ? request.body : request.query);
    if (!input.success) throw new DomainError('invalid_request', '请提供有效的记忆查询。');
    const command = { ...actor, ...input.data };
    const authorized = await memory.searchEvidence(command);
    const { scope, query } = input.data;
    const binding = engines && scope === 'project' ? await resolveProjectMemoryEngines(db, engines, actor.projectCode) : null;
    const resolved = binding?.config ?? engines;
    let personalUnavailable = false;
    if (scope === 'personal' && resolved?.personalProvisioning && !resolved.accounts[actor.principalCode]) {
      try { await ensurePersonalMemoryResource(resolved,actor.principalCode); }
      catch { personalUnavailable = true; }
    }
    const mapping = scope === 'project' ? resolved?.projects[actor.projectCode] : resolved?.accounts[actor.principalCode];
    const explain = request.headers['x-tsp-memory-explain'] === '1';
    let matches: MemoryEngineMatches = {wiki:[],core:[],viking:[]};
    let rows = authorized;
    if (!scope || !resolved || !mapping) {
      reply.header('X-TSP-Memory-Retrieval', personalUnavailable ? 'platform-fallback' : 'platform');
    } else {
      const attempted = scope === 'personal' ? ['viking'] : resolved.projects[actor.projectCode]?.semanticAgentId ? ['wiki','core'] : ['wiki'];
      if (explain) reply.header('X-TSP-Memory-Engines', attempted.join(','));
      try {
        const detail = await searchMemoryEngineDetailed(resolved, actor, query, scope);
        matches = {wiki:detail.wiki,core:detail.core,viking:detail.viking};
        reply.header('X-TSP-Memory-Retrieval', detail.degraded.length === 0 ? 'engine-and-platform' :
          detail.degraded.length === attempted.length ? 'platform-fallback' : 'partial-engine-and-platform');
      } catch {
        reply.header('X-TSP-Memory-Retrieval', 'platform-fallback');
      }
      if (engines && scope === 'project') {
        const current = await resolveProjectMemoryEngines(db, engines, actor.projectCode);
        if (current.generation !== binding?.generation || !current.config.projects[actor.projectCode]) {
          matches = { wiki: [], core: [], viking: [] };
          reply.header('X-TSP-Memory-Retrieval', 'platform');
        }
      }
      // Recheck current visibility after the upstream call, including on fallback.
      rows = await memory.searchEvidence({...command,engineRefs:rankedMemoryRefs(matches)});
    }
    if (explain) {
      const trace = Object.fromEntries(rows.map(row => {
        const channels = Object.entries(matches).filter(([,refs])=>row.externalRef && refs.includes(row.externalRef)).map(([name])=>name);
        return [row.data.source, row.literal ? ['literal',...channels] : channels];
      }));
      reply.header('X-TSP-Memory-Matches', JSON.stringify(trace));
    }
    return rows.map(row => row.data);
  });

  app.get(base, { logLevel: 'silent' }, search);
  app.post(base + '/search', { bodyLimit: 4096 }, search);
  app.post(base + '/sources', { bodyLimit: 4096 }, (request: Request, reply) => handle(request,reply,async actor=>{
    const input=MemorySourcesInput.safeParse(request.body);
    if (!input.success) throw new DomainError('invalid_request','请提供有效来源编码');
    return memory.readSources({...actor,...input.data});
  }));
  app.post(base + '/documents/read', { bodyLimit: 4096 }, (request: Request, reply) => handle(request, reply, async actor => {
    const input = MemoryDocumentReadInput.safeParse(request.body);
    if (!input.success) throw new DomainError('invalid_request', '文档来源或分页参数无效。');
    return memory.readDocument({ ...actor, ...input.data });
  }));
  app.post(base + '/brief', { bodyLimit: 1024 }, (request: Request, reply) => handle(request, reply, async actor => {
    const input = MemoryBriefInput.safeParse(request.body);
    if (!input.success) throw new DomainError('invalid_request', '请选择项目背景或个人偏好。');
    return memory.brief({ ...actor, scope: input.data.scope });
  }));
  app.get(base + '/binding', (request: Request, reply) => handle(request, reply, async actor => {
    if (request.query && Object.keys(request.query).length === 0) return memory.inspect(actor);
    const input = MemoryBindingQuery.safeParse(request.query);
    if (!input.success) throw new DomainError('invalid_request', '请选择议题与需求。');
    return memory.inspect({ ...actor, ...input.data });
  }));
  app.post(base + '/capture-events', { bodyLimit: 32 * 1024 }, (request: Request, reply) => handle(request, reply, async actor => {
    const input = MemoryCaptureInput.safeParse(request.body);
    if (!input.success) throw new DomainError('invalid_request', '会话事件或可选绑定无效。');
    const result = await enqueueMemoryCapture(db, { ...input.data, ...actor });
    reply.code(202);
    return result;
  }));
  app.get(base + '/captures/:captureCode', (request: FastifyRequest<{ Params: { projectCode: string; captureCode: string } }>, reply) =>
    handle(request, reply, async actor => {
      const code = PublicCodeSchema.safeParse(request.params.captureCode);
      if (!code.success) throw new DomainError('memory_capture_not_found', '找不到采集事件。');
      return readMemoryCapture(db, actor, code.data);
    }));
  app.post(base + '/captures/:captureCode/retry', { bodyLimit: 1024 },
    (request: FastifyRequest<{ Params: { projectCode: string; captureCode: string } }>, reply) => handle(request, reply, async actor => {
      const code = PublicCodeSchema.safeParse(request.params.captureCode);
      if (!code.success) throw new DomainError('memory_capture_not_found', '找不到采集事件。');
      return retryMemoryCapture(db, actor, code.data);
    }));
  app.post(base + '/captures', { bodyLimit: 32 * 1024 }, (request: Request, reply) => handle(request, reply, async actor => {
    const input = MemoryCaptureInput.safeParse(request.body);
    if (!input.success) throw new DomainError('invalid_request', '会话事件或来源版本无效。');
    const command = { ...input.data, ...actor };
    const existing = await memory.replay(command);
    if (existing) return existing;
    const binding = await memory.inspect(command);
    if (command.topicCode && (binding.expectedRevision !== command.expectedRevision || binding.expectedHead !== command.expectedHead)) {
      throw new DomainError('memory_source_changed', '议题或需求版本已变化，请核对影响后更新绑定。');
    }
    const parts = await extractMemoryParts(command.sourceText);
    return memory.capture({ ...command, parts });
  }));
}
