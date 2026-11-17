import type { FastifyInstance } from 'fastify';
import { createSystemAgentUseCases } from '@team-synergy/application';
import type { Db } from '@team-synergy/persistence';
import { principalOf } from '../auth.js';

export function registerSystemAgentRoutes(app: FastifyInstance, db: Db, options: { isConfigured?: () => boolean } = {}): void {
  const uc = createSystemAgentUseCases(db);
  app.get<{ Params: { project_code: string } }>('/projects/:project_code/system-agent/jobs', async request => (
    uc.listJobs({ projectCode: request.params.project_code, principalCode: principalOf(request) })
  ));
  app.post<{ Params: { project_code: string }; Body: Record<string, unknown> }>('/projects/:project_code/system-agent/jobs', async (request, reply) => {
    if (options.isConfigured && !options.isConfigured()) return reply.code(503).send({ ok: false, error: { code: 'system_agent_unavailable', message: '系统 Agent 执行器尚未配置，不能开始任务' } });
    const body = request.body ?? {};
    return uc.createJob({ projectCode: request.params.project_code, principalCode: principalOf(request),
      documentCode: typeof body.document_code === 'string' ? body.document_code : '', baseRevision: typeof body.base_revision === 'number' ? body.base_revision : NaN,
      instruction: typeof body.instruction === 'string' ? body.instruction : '', quote: typeof body.quote === 'string' ? body.quote : undefined,
      requestKey: typeof body.request_key === 'string' ? body.request_key : '',
    });
  });
  app.get<{ Params: { job_code: string } }>('/system-agent/jobs/:job_code', async request => uc.getJob({ jobCode: request.params.job_code, principalCode: principalOf(request) }));
  for (const action of ['cancel', 'reject'] as const) {
    app.post<{ Params: { job_code: string } }>(`/system-agent/jobs/:job_code/${action}`, async request => uc[action === 'cancel' ? 'cancelJob' : 'rejectJob']({ jobCode: request.params.job_code, principalCode: principalOf(request) }));
  }
  app.post<{ Params: { job_code: string }; Body: Record<string, unknown> }>('/system-agent/jobs/:job_code/apply', async request => {
    const body = request.body ?? {};
    return uc.applyJob({ jobCode: request.params.job_code, principalCode: principalOf(request),
      proposalHash: typeof body.proposal_hash === 'string' ? body.proposal_hash : '', baseRevision: typeof body.base_revision === 'number' ? body.base_revision : NaN,
    });
  });
}
