import type { FastifyInstance } from 'fastify';
import type { Db } from '@team-synergy/persistence';
import { createSkillsUseCases } from '@team-synergy/application';
import type { SkillCreateInput, SkillInstallInput, SkillReviseInput, SkillShareInput } from '@team-synergy/contracts';
import { unauthorized } from '../auth.js';

const text = { type: 'string' }; const version = { type: 'integer', minimum: 1 }; const scope = { enum: ['team', 'project'] };
const files = { type: 'array', minItems: 1, maxItems: 200, items: { type: 'object', additionalProperties: false, required: ['path', 'content_base64'], properties: {
  path: text, content_base64: text, sha256: text, size_bytes: { type: 'integer', minimum: 0 },
} } };
const body = (properties: object, required: string[]) => ({ bodyLimit: 10 * 1024 * 1024, schema: { body: { type: 'object', additionalProperties: false, required, properties } } });
type Code = { code: string };
type Project = { project_code: string };
export function registerSkillRoutes(app: FastifyInstance, db: Db) {
  const uc = createSkillsUseCases(db);
  app.get<{ Querystring: { team_code?: string; project_code?: string; view?: 'owned' | 'available' | 'shared'; q?: string } }>('/skills', async (request, reply) => {
    if (!request.principal) return unauthorized(reply);
    return uc.listSkills({ principalCode: request.principal, teamCode: request.query.team_code, projectCode: request.query.project_code, view: request.query.view, query: request.query.q });
  });
  app.get<{ Params: Code; Querystring: { project_code?: string } }>('/skills/:code', async (request, reply) => {
    if (!request.principal) return unauthorized(reply);
    return uc.getSkill({ principalCode: request.principal, code: request.params.code, projectCode: request.query.project_code });
  });
  app.post<{ Body: SkillCreateInput }>('/skills', body({ scope_type: scope, scope_code: text, files, change_summary: text }, ['scope_type', 'scope_code', 'files']), async (request, reply) => {
    if (!request.principal) return unauthorized(reply);
    return uc.createSkill({ principalCode: request.principal, input: request.body });
  });
  app.patch<{ Params: Code; Body: SkillReviseInput }>('/skills/:code', body({ base_revision: version, files, change_summary: text }, ['base_revision', 'files', 'change_summary']), async (request, reply) => {
    if (!request.principal) return unauthorized(reply);
    return uc.reviseSkill({ principalCode: request.principal, code: request.params.code, input: request.body });
  });
  app.post<{ Params: Code; Body: { revision: number } }>('/skills/:code/publish', body({ revision: version }, ['revision']), async (request, reply) => {
    if (!request.principal) return unauthorized(reply);
    return uc.publishSkill({ principalCode: request.principal, code: request.params.code, revision: request.body.revision });
  });
  app.post<{ Params: Code; Body: { archived: boolean } }>('/skills/:code/archive', body({ archived: { type: 'boolean' } }, ['archived']), async (request, reply) => {
    if (!request.principal) return unauthorized(reply);
    return uc.archiveSkill({ principalCode: request.principal, code: request.params.code, archived: request.body.archived });
  });
  app.post<{ Params: Code; Body: SkillShareInput }>('/skills/:code/shares', body({ target_type: scope, target_code: text, revisions: { type: 'array', minItems: 1, maxItems: 200, items: version },
    allow_projects: { type: 'boolean' }, allow_external: { type: 'boolean' } }, ['target_type', 'target_code', 'revisions']), async (request, reply) => {
    if (!request.principal) return unauthorized(reply);
    return uc.shareSkill({ principalCode: request.principal, code: request.params.code, input: request.body });
  });
  app.delete<{ Params: Code & { share_code: string } }>('/skills/:code/shares/:share_code', async (request, reply) => {
    if (!request.principal) return unauthorized(reply);
    return uc.revokeShare({ principalCode: request.principal, code: request.params.code, shareCode: request.params.share_code });
  });
  app.get<{ Params: Project }>('/projects/:project_code/skills', async (request, reply) => {
    if (!request.principal) return unauthorized(reply);
    return uc.listProjectSkills({ principalCode: request.principal, projectCode: request.params.project_code });
  });
  app.put<{ Params: Project & { code: string }; Body: SkillInstallInput }>('/projects/:project_code/skills/:code', body({ revision: version, alias: text,
    enabled: { type: 'boolean' }, base_generation: { type: 'integer', minimum: 0 } }, ['revision', 'alias', 'enabled', 'base_generation']), async (request, reply) => {
    if (!request.principal) return unauthorized(reply);
    return uc.installSkill({ principalCode: request.principal, projectCode: request.params.project_code, code: request.params.code, input: request.body });
  });
  app.get<{ Params: Project }>('/projects/:project_code/skills/manifest', async (request, reply) => {
    if (!request.principal) return unauthorized(reply);
    return uc.getProjectManifest({ principalCode: request.principal, projectCode: request.params.project_code });
  });
  app.get<{ Params: { run_code: string } }>('/runs/:run_code/skills', async (request, reply) => {
    if (!request.principal) return unauthorized(reply);
    return uc.getRunManifest({ principalCode: request.principal, runCode: request.params.run_code });
  });
}
