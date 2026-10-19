import type { FastifyInstance } from 'fastify';
import { createRequirementBaselineUseCases } from '@team-synergy/application';
import { PublicCodeSchema } from '@team-synergy/contracts';
import type { Db } from '@team-synergy/persistence';
import { unauthorized } from '../auth.js';

const isCode = (value: unknown): value is string => PublicCodeSchema.safeParse(value).success;
const invalid = () => ({ ok: false as const, error: { code: 'validation_failed', message: '需求基线参数无效' } });
const isText = (value: unknown, max: number) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;

export function registerRequirementBaselineRoutes(app: FastifyInstance, db: Db): void {
  const uc = createRequirementBaselineUseCases(db);
  const root = '/projects/:project_code/requirement-baselines';
  app.get<{ Params: { project_code: string } }>(root, async (request, reply) => {
    if (request.authKind !== 'bearer') return unauthorized(reply);
    if (!isCode(request.params.project_code)) return invalid();
    return uc.list({ projectCode: request.params.project_code, principalCode: request.principal ?? '' });
  });
  app.get<{ Params: { project_code: string } }>(`${root}/bindings`, async (request, reply) => {
    if (request.authKind !== 'bearer') return unauthorized(reply);
    if (!isCode(request.params.project_code)) return invalid();
    return uc.bindings({ projectCode: request.params.project_code, principalCode: request.principal ?? '' });
  });
  app.post<{ Params: { project_code: string }; Body: Record<string, unknown> }>(root, async (request, reply) => {
    if (request.authKind !== 'bearer') return unauthorized(reply);
    const body = request.body;
    if (!isCode(request.params.project_code) || !body || Array.isArray(body)
      || Object.keys(body).some(key => !['name', 'scope', 'reason', 'parent_baseline_code', 'requirements'].includes(key))
      || !isText(body.name, 200) || !isText(body.scope, 2000) || !isText(body.reason, 4000)
      || (body.parent_baseline_code !== undefined && body.parent_baseline_code !== null && !isCode(body.parent_baseline_code))
      || !Array.isArray(body.requirements) || body.requirements.length === 0 || body.requirements.length > 1000
      || body.requirements.some(item => !item || typeof item !== 'object' || Array.isArray(item)
        || Object.keys(item).some(key => !['requirement_code', 'revision'].includes(key))
        || !isCode(item.requirement_code) || !Number.isSafeInteger(item.revision) || item.revision < 1)) return invalid();
    return uc.create({ projectCode: request.params.project_code, principalCode: request.principal ?? '',
      name: String(body.name), scope: String(body.scope), reason: String(body.reason),
      parentBaselineCode: body.parent_baseline_code as string | null | undefined,
      requirements: body.requirements as Array<{ requirement_code: string; revision: number }> });
  });
  app.get<{ Params: { project_code: string; baseline_code: string } }>(`${root}/:baseline_code`, async (request, reply) => {
    if (request.authKind !== 'bearer') return unauthorized(reply);
    if (!isCode(request.params.project_code) || !isCode(request.params.baseline_code)) return invalid();
    return uc.get({ projectCode: request.params.project_code, baselineCode: request.params.baseline_code, principalCode: request.principal ?? '' });
  });
  app.get<{ Params: { project_code: string; baseline_code: string }; Querystring: { compare_to?: string } }>(`${root}/:baseline_code/diff`, async (request, reply) => {
    if (request.authKind !== 'bearer') return unauthorized(reply);
    const compareTo = request.query.compare_to ?? 'current';
    if (!isCode(request.params.project_code) || !isCode(request.params.baseline_code)
      || (compareTo !== 'current' && !isCode(compareTo)) || Object.keys(request.query).some(key => key !== 'compare_to')) return invalid();
    return uc.compare({ projectCode: request.params.project_code, baselineCode: request.params.baseline_code, compareTo, principalCode: request.principal ?? '' });
  });
}
