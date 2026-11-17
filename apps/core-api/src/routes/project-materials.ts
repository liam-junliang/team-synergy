import type { FastifyInstance } from 'fastify';
import type { Db } from '@team-synergy/persistence';
import { createProjectMaterialQueryUseCases } from '@team-synergy/application';
import { ProjectMaterialListInput, ProjectMaterialGlobInput, ProjectMaterialGrepInput, ProjectMaterialReadInput } from '@team-synergy/contracts';
import { hasAuthenticatedSession, unauthorized } from '../auth.js';
import { httpStatusForError } from '../error-status.js';

/** Explicit read-only business queries, shared by CLI and MCP; no URL or local file execution. */
export function registerProjectMaterialRoutes(app: FastifyInstance, db: Db) {
  const material = createProjectMaterialQueryUseCases(db);
  for (const action of ['list', 'glob', 'grep', 'read'] as const) {
    app.post<{ Params: { projectCode: string } }>(`/projects/:projectCode/materials/${action}`, { bodyLimit: 8192 }, async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!hasAuthenticatedSession(request) || !request.principal) return unauthorized(reply);
      if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) {
        return reply.code(400).send({ ok: false, error: { code: 'material_invalid', message: '请提供资料查询对象' } });
      }
      // Reject identity/URL/unknown fields before adding the trusted request actor.
      const actor = { projectCode: request.params.projectCode, principalCode: request.principal };
      const result = await (async () => {
        if (action === 'list') {
          const input = ProjectMaterialListInput.safeParse(request.body);
          if (input.success) return material.list({ ...actor, ...input.data });
        } else if (action === 'glob') {
          const input = ProjectMaterialGlobInput.safeParse(request.body);
          if (input.success) return material.glob({ ...actor, ...input.data });
        } else if (action === 'grep') {
          const input = ProjectMaterialGrepInput.safeParse(request.body);
          if (input.success) return material.grep({ ...actor, ...input.data });
        } else {
          const input = ProjectMaterialReadInput.safeParse(request.body);
          if (input.success) return material.read({ ...actor, ...input.data });
        }
        return { ok: false as const, error: { code: 'material_invalid', message: '资料查询参数无效' } };
      })();
      if (!result.ok) {
        const code = result.error.code;
        const status = code === 'material_not_found' ? 404 : code === 'material_search_timeout' ? 408 : code === 'material_search_busy' ? 503 :
          code === 'material_search_failed' || code === 'internal_error' ? 500 : code.startsWith('material_') ? 400 : httpStatusForError(code);
        return reply.code(status).send(result);
      }
      return result;
    });
  }
}
