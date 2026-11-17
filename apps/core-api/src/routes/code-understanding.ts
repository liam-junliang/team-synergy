import type { FastifyInstance } from 'fastify';
import type { Db } from '@team-synergy/persistence';
import { createCodeUnderstandingUseCases, createHostedCodeAnalysisUseCases } from '@team-synergy/application';
import { CODE_UNDERSTANDING_MAX_BYTES } from '@team-synergy/contracts';
import { hasAuthenticatedSession, unauthorized } from '../auth.js';

type Params = { project_code: string; code: string };
export interface CodeUnderstandingRouteOptions {
  isConfigured?: () => boolean;
  status?: () => { configured: boolean; model?: string; message?: string };
}
export function registerCodeUnderstandingRoutes(app: FastifyInstance, db: Db, options: CodeUnderstandingRouteOptions = {}) {
  const uc = createCodeUnderstandingUseCases(db), hosted = createHostedCodeAnalysisUseCases(db), base = '/projects/:project_code/code-understanding';
  app.get<{ Params: Params }>(`${base}/runtime`, async (request, reply) => {
    if (!request.principal || !hasAuthenticatedSession(request)) return unauthorized(reply);
    const access = await uc.context({ principalCode: request.principal, projectCode: request.params.project_code });
    if (!access.ok) return access;
    const status = options.status?.();
    return { ok: true, data: { configured: status?.configured ?? options.isConfigured?.() ?? false, model: status?.model ?? '', message: status?.message ?? 'Hosted analysis worker is not configured' } };
  });
  app.get<{ Params: Params }>(`${base}/analyses`, async (request, reply) => {
    if (!request.principal || !hasAuthenticatedSession(request)) return unauthorized(reply);
    return hosted.listJobs({ principalCode: request.principal, projectCode: request.params.project_code });
  });
  app.get<{ Params: Params }>(`${base}/analyses/:code`, async (request, reply) => {
    if (!request.principal || !hasAuthenticatedSession(request)) return unauthorized(reply);
    return hosted.getJob({ principalCode: request.principal, projectCode: request.params.project_code, jobCode: request.params.code });
  });
  app.post<{ Params: Params }>(`${base}/analyses`, async (request, reply) => {
    if (!request.principal || !hasAuthenticatedSession(request)) return unauthorized(reply);
    const actor = { principalCode: request.principal, projectCode: request.params.project_code };
    const access = await uc.context(actor); if (!access.ok) return access;
    if (!(options.isConfigured?.() ?? options.status?.().configured ?? false)) return { ok: false, error: { code: 'code_understanding_unavailable', message: 'Hosted analysis worker is not configured' } };
    return hosted.enqueue({ ...actor, input: request.body });
  });
  app.get<{ Params: Params }>(`${base}/context`, async (request, reply) => {
    if (!request.principal || !hasAuthenticatedSession(request)) return unauthorized(reply);
    return uc.context({ principalCode: request.principal, projectCode: request.params.project_code });
  });
  app.get<{ Params: Params }>(`${base}/runs/:code`, async (request, reply) => {
    if (!request.principal || !hasAuthenticatedSession(request)) return unauthorized(reply);
    return uc.detail({ principalCode: request.principal, projectCode: request.params.project_code, code: request.params.code });
  });
  app.get<{ Params: Params }>(`${base}/runs/:code/ua-map`, async (request, reply) => {
    if (!request.principal || !hasAuthenticatedSession(request)) return unauthorized(reply);
    return uc.uaMap({ principalCode: request.principal, projectCode: request.params.project_code, code: request.params.code });
  });
  app.get<{ Params: Params }>(`${base}/graph`, async (request, reply) => {
    if (!request.principal || !hasAuthenticatedSession(request)) return unauthorized(reply);
    return uc.graph({ principalCode: request.principal, projectCode: request.params.project_code, input: request.query });
  });
  for (const [route, method] of [
    ['/runs', 'register'], ['/runs/:code/progress', 'progress'], ['/runs/:code/publish', 'publish'], ['/views', 'compose'], ['/views/:code/select', 'select'],
  ] as const) app.post<{ Params: Params }>(`${base}${route}`, { bodyLimit: CODE_UNDERSTANDING_MAX_BYTES }, async (request, reply) => {
    if (!request.principal || !hasAuthenticatedSession(request)) return unauthorized(reply);
    return uc[method]({ principalCode: request.principal, projectCode: request.params.project_code, code: request.params.code, input: request.body });
  });
}
