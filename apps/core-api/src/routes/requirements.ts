import type { FastifyInstance } from 'fastify';
import {
  createRequirementUseCases,
  type RequirementAcceptanceCriterion,
  type RequirementStatus,
} from '@team-synergy/application';
import type { Db } from '@team-synergy/persistence';
import { principalOf } from '../auth.js';

interface PrincipalBody {
  principal_code?: string;
  user_code?: string;
}

function acceptanceCriteriaOf(value: unknown): RequirementAcceptanceCriterion[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    if (typeof item === 'string') return [{ id: `AC-${index + 1}`, text: item }];
    if (!item || typeof item !== 'object') return [];
    const candidate = item as { id?: unknown; text?: unknown };
    return typeof candidate.text === 'string'
      ? [{ id: typeof candidate.id === 'string' ? candidate.id : `AC-${index + 1}`, text: candidate.text }]
      : [];
  });
}

function stringArrayOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function optionalCode(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function nullableCode(body: Record<string, unknown>, key: string): string | null | undefined {
  if (!(key in body)) return undefined;
  const value = body[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function registerRequirementRoutes(app: FastifyInstance, db: Db): void {
  const uc = createRequirementUseCases(db);

  app.get<{ Querystring: { project_code?: string; q?: string } }>('/requirements', async (request) => ({
    ok: true as const,
    data: await uc.listRequirements(request.query.project_code, request.query.q, principalOf(request)),
  }));

  app.get<{ Params: { requirement_code: string } }>('/requirements/:requirement_code', async (request) => (
    await uc.getRequirement(request.params.requirement_code, principalOf(request))
  ));

  app.post<{ Body: Record<string, unknown> }>('/requirements', async (request) => {
    const body = request.body ?? {};
    return await uc.createRequirement({
      featureCode: optionalCode(body.feature_code),
      moduleCode: optionalCode(body.module_code),
      documentCode: optionalCode(body.document_code),
      title: String(body.title ?? ''),
      body: String(body.body ?? ''),
      acceptanceCriteria: acceptanceCriteriaOf(body.acceptance_criteria),
      openQuestions: stringArrayOf(body.open_questions),
      status: typeof body.status === 'string' ? body.status as RequirementStatus : undefined,
      principalCode: principalOf(request, body as PrincipalBody),
    });
  });

  app.patch<{ Params: { requirement_code: string }; Body: Record<string, unknown> }>(
    '/requirements/:requirement_code',
    async (request) => {
      const body = request.body ?? {};
      return await uc.updateRequirement({
        requirementCode: request.params.requirement_code,
        title: typeof body.title === 'string' ? body.title : undefined,
        body: typeof body.body === 'string' ? body.body : undefined,
        acceptanceCriteria: body.acceptance_criteria === undefined ? undefined : acceptanceCriteriaOf(body.acceptance_criteria),
        openQuestions: body.open_questions === undefined ? undefined : stringArrayOf(body.open_questions),
        featureCode: nullableCode(body, 'feature_code'),
        moduleCode: nullableCode(body, 'module_code'),
        documentCode: nullableCode(body, 'document_code'),
        principalCode: principalOf(request, body as PrincipalBody),
      });
    },
  );

  app.post<{ Params: { requirement_code: string }; Body: Record<string, unknown> }>(
    '/requirements/:requirement_code/transition',
    async (request) => {
      const body = request.body ?? {};
      return await uc.transitionRequirement({
        requirementCode: request.params.requirement_code,
        to: String(body.status ?? body.to ?? '') as RequirementStatus,
        principalCode: principalOf(request, body as PrincipalBody),
      });
    },
  );
}
