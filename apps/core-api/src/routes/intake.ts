import type { FastifyInstance } from 'fastify';
import type { Db } from '@team-synergy/persistence';
import { createIntakeUseCases } from '@team-synergy/application';
import { INTAKE_MAX_BYTES, IntakeApplySchema, IntakeReplaceSchema, IntakeReviewSchema, IntakeStopSchema, IntakeSubmitSchema } from '@team-synergy/contracts';
import { unauthorized } from '../auth.js';

type Project = { project_code: string };
type Batch = Project & { code: string };
function invalid(issues: Array<{ path: PropertyKey[]; message: string }>) {
  // Do not echo submitted source snippets or credentials in validation errors.
  return { ok: false as const, error: { code: 'intake_invalid', message: 'Invalid intake request', details: issues.slice(0, 20).map(issue => ({ path: issue.path.join('.'), message: issue.message })) } };
}
export function registerIntakeRoutes(app: FastifyInstance, db: Db) {
  const uc = createIntakeUseCases(db);
  app.get<{ Params: Project }>('/projects/:project_code/intake/context', async (request, reply) => {
    if (!request.principal || request.authKind !== 'bearer') return unauthorized(reply);
    return uc.context({ principalCode: request.principal, projectCode: request.params.project_code });
  });
  app.get<{ Params: Project }>('/projects/:project_code/intake', async (request, reply) => {
    if (!request.principal || request.authKind !== 'bearer') return unauthorized(reply);
    return uc.list({ principalCode: request.principal, projectCode: request.params.project_code });
  });
  app.post<{ Params: Project }>('/projects/:project_code/intake', { bodyLimit: INTAKE_MAX_BYTES }, async (request, reply) => {
    if (!request.principal || request.authKind !== 'bearer') return unauthorized(reply);
    const parsed = IntakeSubmitSchema.safeParse(request.body);
    if (!parsed.success) return invalid(parsed.error.issues);
    return uc.submit({ principalCode: request.principal, projectCode: request.params.project_code, bundle: parsed.data.bundle, idempotencyKey: parsed.data.idempotency_key });
  });
  app.get<{ Params: Batch }>('/projects/:project_code/intake/:code', async (request, reply) => {
    if (!request.principal || request.authKind !== 'bearer') return unauthorized(reply);
    return uc.detail({ principalCode: request.principal, projectCode: request.params.project_code, code: request.params.code });
  });
  app.put<{ Params: Batch }>('/projects/:project_code/intake/:code', { bodyLimit: INTAKE_MAX_BYTES }, async (request, reply) => {
    if (!request.principal || request.authKind !== 'bearer') return unauthorized(reply);
    const parsed = IntakeReplaceSchema.safeParse(request.body);
    if (!parsed.success) return invalid(parsed.error.issues);
    return uc.replace({ principalCode: request.principal, projectCode: request.params.project_code, code: request.params.code, baseRevision: parsed.data.base_revision, bundle: parsed.data.bundle });
  });
  app.post<{ Params: Batch }>('/projects/:project_code/intake/:code/review', async (request, reply) => {
    if (!request.principal || request.authKind !== 'bearer') return unauthorized(reply);
    const parsed = IntakeReviewSchema.safeParse(request.body);
    if (!parsed.success) return invalid(parsed.error.issues);
    return uc.review({ principalCode: request.principal, projectCode: request.params.project_code, code: request.params.code, input: parsed.data });
  });
  app.post<{ Params: Batch }>('/projects/:project_code/intake/:code/apply', async (request, reply) => {
    if (!request.principal || request.authKind !== 'bearer') return unauthorized(reply);
    const parsed = IntakeApplySchema.safeParse(request.body);
    if (!parsed.success) return invalid(parsed.error.issues);
    return uc.apply({ principalCode: request.principal, projectCode: request.params.project_code, code: request.params.code, input: parsed.data });
  });
  app.post<{ Params: Batch }>('/projects/:project_code/intake/:code/stop', async (request, reply) => {
    if (!request.principal || request.authKind !== 'bearer') return unauthorized(reply);
    const parsed = IntakeStopSchema.safeParse(request.body);
    if (!parsed.success) return invalid(parsed.error.issues);
    return uc.stop({ principalCode: request.principal, projectCode: request.params.project_code, code: request.params.code, baseRevision: parsed.data.base_revision });
  });
}
