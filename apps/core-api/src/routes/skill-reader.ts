import type { FastifyInstance } from 'fastify';
import type { ProjectSkillManifest } from '@team-synergy/contracts';
import type { createSkillsUseCases } from '@team-synergy/application';
import { unauthorized } from '../auth.js';

interface ReaderQuery { run?: string; skill?: string; revision?: number; path?: string; offset?: number; limit?: number }
const code = { type: 'string', pattern: '^[0-9A-HJKMNP-TV-Z]{20}$' };
const rejected = (code: string, message: string) => ({ ok: false, error: { code, message } });

function readPage(manifest: Pick<ProjectSkillManifest, 'skills'> & Partial<Pick<ProjectSkillManifest, 'project_code' | 'generation'>>, query: ReaderQuery) {
  const { project_code, generation, skills } = manifest;
  const offset = query.offset ?? 0;
  if (!query.skill) {
    if (query.revision || query.path) return rejected('skill_invalid', '读取文件需要指定技能与修订');
    const limit = Math.min(query.limit ?? 30, 50);
    return { ok: true, data: { project_code, generation, total: skills.length,
      items: skills.slice(offset, offset + limit).map(({ files: _files, ...entry }) => entry),
      nextOffset: offset + limit < skills.length ? offset + limit : null } };
  }
  const entry = skills.find(skill => skill.skill_code === query.skill);
  if (!entry) return rejected('skill_not_found', '该技能未在此项目或指定 Run 的清单中');
  if (entry.revision !== query.revision) return rejected('skill_revision_conflict', '采用版本已变化，请重新查看技能清单');
  const path = query.path ?? 'SKILL.md';
  const file = entry.files.find(item => item.path === path);
  if (!file) return rejected('skill_not_found', '该版本没有此文件');
  const { files, ...source } = entry;
  const info = { project_code, ...source, path, sha256: file.sha256, size_bytes: file.size_bytes,
    ...(path === 'SKILL.md' && !offset ? { paths: files.map(f => f.path) } : {}) };
  const bytes = Buffer.from(file.content_base64, 'base64');
  let content: string;
  try {
    if (bytes.includes(0)) throw new Error('binary');
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    const download = query.run ? 'tsp skill sync --run ' + query.run : project_code ? 'tsp skill sync --project ' + project_code
      : `tsp skill export ${entry.skill_code} --revision ${entry.revision} --directory ./skill-package`;
    return { ok: true, data: { ...info, encoding: 'binary', download, nextOffset: null } };
  }
  const points = Array.from(content);
  const end = Math.min(offset + (query.limit ?? 4000), points.length);
  return { ok: true, data: { ...info, encoding: 'utf-8', content: points.slice(offset, end).join(''),
    offset, nextOffset: end < points.length ? end : null } };
}

/** Keep complete package bytes inside the API when the caller only needs a listing or one text page. */
export function registerSkillReader(app: FastifyInstance, uc: ReturnType<typeof createSkillsUseCases>) {
  app.get<{ Querystring: ReaderQuery }>('/skills/platform/reader', {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: {
      skill: code, revision: { type: 'integer', minimum: 1 }, path: { type: 'string', minLength: 1, maxLength: 240 },
      offset: { type: 'integer', minimum: 0, maximum: 6291456 }, limit: { type: 'integer', minimum: 1, maximum: 8000 },
    } } },
  }, async (request, reply) => {
    if (!request.principal) return unauthorized(reply);
    const principalCode = request.principal, query = request.query;
    if (!query.skill) {
      if (query.revision || query.path) return rejected('skill_invalid', '读取文件需要指定技能与修订');
      const result = await uc.listPlatformSkills({ principalCode });
      if (!result.ok) return result;
      const offset = query.offset ?? 0, limit = Math.min(query.limit ?? 30, 50);
      return { ok: true, data: { total: result.data.length, items: result.data.slice(offset, offset + limit).map(skill => ({
        skill_code: skill.code, revision: skill.current_revision, name: skill.name, description: skill.description,
        scope_type: skill.scope_type, scope_code: skill.scope_code, release_version: skill.release_version,
      })), nextOffset: offset + limit < result.data.length ? offset + limit : null } };
    }
    const result = await uc.getSkill({ principalCode, code: query.skill, source: 'platform' });
    if (!result.ok) return result;
    const revision = result.data.revisions.find(row => row.revision === query.revision);
    if (!revision) return rejected('skill_revision_not_found', '此平台修订不存在或尚未发布');
    return readPage({ skills: [{ skill_code: result.data.code, revision: revision.revision, alias: revision.name,
      name: revision.name, description: revision.description, scope_type: 'platform', scope_code: 'platform',
      package_sha256: revision.package_sha256, release_version: revision.release_version, files: revision.files }] }, query);
  });
  app.get<{ Params: { project_code: string }; Querystring: ReaderQuery }>('/projects/:project_code/skills/reader', {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: {
      run: code, skill: code, revision: { type: 'integer', minimum: 1 }, path: { type: 'string', minLength: 1, maxLength: 240 },
      offset: { type: 'integer', minimum: 0, maximum: 6291456 }, limit: { type: 'integer', minimum: 1, maximum: 8000 },
    } } },
  }, async (request, reply) => {
    if (!request.principal) return unauthorized(reply);
    const projectCode = request.params.project_code, principalCode = request.principal;
    const result = request.query.run
      ? await uc.getRunManifest({ principalCode, runCode: request.query.run })
      : await uc.getProjectManifest({ principalCode, projectCode });
    if (!result.ok) return result;
    if (result.data.project_code !== projectCode) return rejected('skill_forbidden', '该 Run 不属于当前项目');
    return readPage(result.data, request.query);
  });
}
