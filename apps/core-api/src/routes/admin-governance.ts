import type { FastifyInstance } from 'fastify';
import { createAdminGovernanceUseCases } from '@team-synergy/application';
import type { Db } from '@team-synergy/persistence';
import { unauthorized } from '../auth.js';

type Query = { q?: string; limit?: string; cursor?: string; team_code?: string; status?: string };

export function registerAdminGovernanceRoutes(app: FastifyInstance, db: Db): void {
  const uc = createAdminGovernanceUseCases(db);
  app.get<{ Querystring: Query }>('/admin/teams', async (request, reply) => {
    if (request.authKind !== 'bearer' || !request.principal) return unauthorized(reply);
    return uc.listTeams(request.principal, {
      q: request.query.q, cursor: request.query.cursor,
      limit: request.query.limit === undefined ? undefined : Number(request.query.limit),
    });
  });
  app.get<{ Querystring: Query }>('/admin/projects', async (request, reply) => {
    if (request.authKind !== 'bearer' || !request.principal) return unauthorized(reply);
    return uc.listProjects(request.principal, {
      q: request.query.q, cursor: request.query.cursor, teamCode: request.query.team_code, status: request.query.status,
      limit: request.query.limit === undefined ? undefined : Number(request.query.limit),
    });
  });
  app.patch<{ Params: { team_code: string }; Body: Record<string, unknown> }>('/admin/teams/:team_code', async (request, reply) => {
    if (request.authKind !== 'bearer' || !request.principal) return unauthorized(reply);
    if (Object.keys(request.body ?? {}).some(key => !['name', 'reason'].includes(key))) {
      return { ok: false, error: { code: 'admin_input_invalid', message: '仅允许修改团队名称' } };
    }
    return uc.updateTeam({ principalCode: request.principal, teamCode: request.params.team_code,
      name: typeof request.body?.name === 'string' ? request.body.name : '',
      reason: typeof request.body?.reason === 'string' ? request.body.reason : '',
    });
  });
  app.patch<{ Params: { project_code: string }; Body: Record<string, unknown> }>('/admin/projects/:project_code', async (request, reply) => {
    if (request.authKind !== 'bearer' || !request.principal) return unauthorized(reply);
    const body = request.body ?? {};
    if (Object.keys(body).some(key => !['name', 'description', 'status', 'reason', 'base_snapshot'].includes(key))) {
      return { ok: false, error: { code: 'admin_input_invalid', message: '仅允许修改项目名称、说明和归档状态' } };
    }
    if (typeof body.base_snapshot !== 'number' || (body.name !== undefined && typeof body.name !== 'string') || (body.description !== undefined && body.description !== null && typeof body.description !== 'string') || (body.status !== undefined && typeof body.status !== 'string')) {
      return { ok: false, error: { code: 'admin_input_invalid', message: '项目信息格式无效' } };
    }
    return uc.updateProject({ principalCode: request.principal, projectCode: request.params.project_code,
      baseSnapshot: body.base_snapshot,
      name: body.name as string | undefined, description: body.description as string | null | undefined,
      status: body.status as string | undefined, reason: typeof body.reason === 'string' ? body.reason : '',
    });
  });
}
