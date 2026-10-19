import type { FastifyInstance } from 'fastify';
import type { Db } from '@team-synergy/persistence';
import { createTestingUseCases } from '@team-synergy/application';
import type { TestAssetInput, TestAssetRevisionInput, TestCaseInput, TestCaseRevisionInput, TestExecutionInput, TestResultDefectInput } from '@team-synergy/contracts';
import { unauthorized } from '../auth.js';

const string = { type: 'string' };
const strings = { type: 'array', items: string, maxItems: 100 };
const revision = { type: 'integer', minimum: 1 };
const common = { title: string, summary: string, module_code: { type: ['string', 'null'] }, requirement_codes: strings, tags: strings };
const caseProperties = { ...common, priority: { enum: ['low', 'medium', 'high', 'critical'] }, method: { enum: ['manual', 'automated'] },
  suite: string, preconditions: string, notes_markdown: string, asset_codes: strings,
  steps: { type: 'array', maxItems: 200, items: { type: 'object', required: ['action', 'expected'], properties: { action: string, expected: string } } } };
const assetProperties = { ...common, purpose: { enum: ['guide', 'script', 'data', 'environment', 'report'] },
  storage_kind: { enum: ['markdown', 'file', 'url', 'git'] }, content: string, url: { type: ['string', 'null'] },
  file: { type: ['object', 'null'], required: ['file_name', 'content_base64'], properties: {
    file_name: string, mime_type: string, content_base64: string, size_bytes: { type: 'integer', minimum: 0 }, sha256: string,
  } }, git: { type: ['object', 'null'], required: ['repository_code'], properties: {
    repository_code: string, path: string, ref: string, commit: string, command: string, setup: string,
  } } };
const revisionProperties = { base_revision: revision, change_summary: string };
function body(properties: object, required: string[]) { return { bodyLimit: 10 * 1024 * 1024, schema: { body: { type: 'object', required, properties } } }; }
type ProjectParams = { project_code: string };
type CodeParams = { code: string };
type Query = { q?: string; module_code?: string; requirement_code?: string; suite?: string; method?: string; purpose?: string; storage_kind?: string };
const querySchema = { schema: { querystring: { type: 'object', properties: {
  q: string, module_code: string, requirement_code: string, suite: string, method: string, purpose: string, storage_kind: string,
} } } };

export function registerTestingRoutes(app: FastifyInstance, db: Db): void {
  const uc = createTestingUseCases(db);
  app.get<{ Params: ProjectParams; Querystring: Query }>('/projects/:project_code/test-cases', querySchema, async (request, reply) => {
    if (!request.principal) return unauthorized(reply);
    return uc.listCases({ projectCode: request.params.project_code, principalCode: request.principal, query: request.query.q,
      module_code: request.query.module_code, requirement_code: request.query.requirement_code, suite: request.query.suite, method: request.query.method });
  });
  app.post<{ Params: ProjectParams; Body: TestCaseInput }>('/projects/:project_code/test-cases', body(caseProperties, ['title']), async (request, reply) => {
    if (!request.principal) return unauthorized(reply);
    return uc.createCase({ projectCode: request.params.project_code, principalCode: request.principal, input: request.body });
  });
  app.get<{ Params: CodeParams }>('/test-cases/:code', async (request, reply) => {
    if (!request.principal) return unauthorized(reply);
    return uc.getCase(request.params.code, request.principal);
  });
  app.patch<{ Params: CodeParams; Body: TestCaseRevisionInput }>('/test-cases/:code', body({ ...caseProperties, ...revisionProperties }, ['base_revision', 'change_summary']), async (request, reply) => {
    if (!request.principal) return unauthorized(reply);
    return uc.reviseCase({ code: request.params.code, principalCode: request.principal, input: request.body });
  });
  app.get<{ Params: ProjectParams; Querystring: Query }>('/projects/:project_code/test-assets', querySchema, async (request, reply) => {
    if (!request.principal) return unauthorized(reply);
    return uc.listAssets({ projectCode: request.params.project_code, principalCode: request.principal, query: request.query.q,
      module_code: request.query.module_code, requirement_code: request.query.requirement_code, purpose: request.query.purpose, storage_kind: request.query.storage_kind });
  });
  app.post<{ Params: ProjectParams; Body: TestAssetInput }>('/projects/:project_code/test-assets', body(assetProperties, ['title']), async (request, reply) => {
    if (!request.principal) return unauthorized(reply);
    return uc.createAsset({ projectCode: request.params.project_code, principalCode: request.principal, input: request.body });
  });
  app.get<{ Params: CodeParams }>('/test-assets/:code', async (request, reply) => {
    if (!request.principal) return unauthorized(reply);
    return uc.getAsset(request.params.code, request.principal);
  });
  app.patch<{ Params: CodeParams; Body: TestAssetRevisionInput }>('/test-assets/:code', body({ ...assetProperties, ...revisionProperties }, ['base_revision', 'change_summary']), async (request, reply) => {
    if (!request.principal) return unauthorized(reply);
    return uc.reviseAsset({ code: request.params.code, principalCode: request.principal, input: request.body });
  });
  app.get<{ Params: ProjectParams; Querystring: { q?: string } }>('/projects/:project_code/test-executions', querySchema, async (request, reply) => {
    if (!request.principal) return unauthorized(reply);
    return uc.listExecutions({ projectCode: request.params.project_code, principalCode: request.principal, query: request.query.q });
  });
  app.get<{ Params: CodeParams }>('/test-executions/:code', async (request, reply) => {
    if (!request.principal) return unauthorized(reply);
    return uc.getExecution(request.params.code, request.principal);
  });
  app.post<{ Params: ProjectParams; Body: TestExecutionInput }>('/projects/:project_code/test-executions', body({
    title: string, environment: string, tested_version: string, commit_sha: string, source: { enum: ['manual', 'agent', 'ci'] },
    task_code: { type: ['string', 'null'] }, notes_markdown: string,
    asset_refs: { type: 'array', maxItems: 100, items: { type: 'object', required: ['asset_code', 'revision'], properties: { asset_code: string, revision } } },
    results: { type: 'array', minItems: 1, maxItems: 500, items: { type: 'object', required: ['case_code', 'case_revision', 'result'], properties: {
      case_code: string, case_revision: revision, result: { enum: ['not_run', 'pass', 'fail', 'blocked', 'skipped'] },
      actual_result: string, notes: string, report_urls: strings,
    } } },
  }, ['title', 'environment', 'tested_version', 'results']), async (request, reply) => {
    if (!request.principal) return unauthorized(reply);
    return uc.createExecution({ projectCode: request.params.project_code, principalCode: request.principal, input: request.body });
  });
  app.post<{ Params: CodeParams & { result_code: string }; Body: TestResultDefectInput }>('/test-executions/:code/results/:result_code/defect', body({
    defect_code: string, feature_code: string, title: string, severity: { enum: ['critical', 'high', 'medium', 'low'] },
  }, []), async (request, reply) => {
    if (!request.principal) return unauthorized(reply);
    return uc.linkResultDefect({ code: request.params.code, resultCode: request.params.result_code, principalCode: request.principal, input: request.body });
  });
}
