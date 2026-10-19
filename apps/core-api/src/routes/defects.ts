import type { FastifyInstance } from 'fastify';
import { createDefectUseCases } from '@team-synergy/application';
import { DefectSeveritySchema, DefectStatusSchema } from '@team-synergy/contracts';
import type { Db } from '@team-synergy/persistence';

interface StringEnumSchema<T extends string> {
  options: readonly T[];
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

function parseEnum<T extends string>(schema: StringEnumSchema<T>, value: unknown): T | null {
  const result = schema.safeParse(value);
  return result.success ? result.data : null;
}

function invalidEnumResult(code: string, label: string, value: unknown, valid: readonly string[]) {
  return {
    ok: false as const,
    error: {
      code,
      message: `非法${label}：${String(value ?? '')}`,
      details: { valid },
    },
  };
}

export function registerDefectRoutes(app: FastifyInstance, db: Db): void {
  const defects = createDefectUseCases(db);

  app.get<{ Querystring: { status?: string; feature_code?: string; project_code?: string } }>('/defects', async (request) => {
    const statusRaw = request.query.status;
    const status = statusRaw === undefined ? undefined : parseEnum(DefectStatusSchema, statusRaw);
    if (statusRaw !== undefined && !status) {
      return invalidEnumResult('invalid_status', '缺陷状态', request.query.status, DefectStatusSchema.options);
    }
    return {
      ok: true as const,
      data: await defects.listDefects({
        status: status ?? undefined,
        featureCode: request.query.feature_code,
        projectCode: request.query.project_code,
        principalCode: request.principal ?? '',
      }),
    };
  });

  app.post<{ Body: Record<string, unknown> }>('/defects', async (request) => {
    const body = request.body ?? {};
    const severity = parseEnum(DefectSeveritySchema, body.severity);
    if (!severity) {
      return invalidEnumResult('invalid_severity', '缺陷严重度', body.severity, DefectSeveritySchema.options);
    }
    return await defects.reportDefect({
      featureCode: String(body.feature_code ?? ''),
      title: String(body.title ?? ''),
      severity,
      description: String(body.description ?? ''),
      foundIn: typeof body.found_in === 'string' ? body.found_in : undefined,
      relatedRequirementCode: typeof body.related_requirement_code === 'string' ? body.related_requirement_code : undefined,
      principalCode: (request.principal ?? ''),
    });
  });

  app.post<{ Params: { defect_code: string }; Body: Record<string, unknown> }>('/defects/:defect_code/transition', async (request) => {
    const body = request.body ?? {};
    const to = parseEnum(DefectStatusSchema, body.to);
    if (!to) {
      return invalidEnumResult('defect_transition_invalid', '缺陷状态', body.to, DefectStatusSchema.options);
    }
    return await defects.transitionDefect({
      defectCode: request.params.defect_code,
      to,
      principalCode: (request.principal ?? ''),
      fixTaskCode: typeof body.fix_task_code === 'string' ? body.fix_task_code : undefined,
    });
  });
}
