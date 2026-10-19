import type { FastifyInstance } from 'fastify';
import {
  createRequirementDocumentUseCases,
  type RequirementDocumentStatus,
} from '@team-synergy/application';
import type { Db } from '@team-synergy/persistence';
import { principalOf } from '../auth.js';

interface PrincipalBody {
  principal_code?: string;
  user_code?: string;
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function registerRequirementDocumentRoutes(app: FastifyInstance, db: Db): void {
  const uc = createRequirementDocumentUseCases(db);

  app.get('/requirement-documents/template', async () => ({
    ok: true as const,
    data: {
      format: 'markdown',
      instructions: [
        '一份文档聚焦一个稳定模块或跨模块主题；不要按临时任务拆文档。',
        '标题层级保持稳定，原子需求用 REQ-* ID 引用，避免复制成多个事实源。',
        '文档创建后即可协作查阅；重要修改通过新 Revision 保留历史，不引入评审状态。',
      ],
      content: '# 文档标题\n\n## 背景\n\n## 目标\n\n## 范围\n\n### 范围内\n\n### 范围外\n\n## 用户与场景\n\n## 业务规则\n\n## 结构化需求条目\n\n## 验收策略\n\n## 开放问题\n',
    },
  }));

  app.get<{
    Params: { project_code: string };
    Querystring: { q?: string; module?: string; state?: string };
  }>('/projects/:project_code/requirement-documents', async (request) => (
    await uc.listDocuments({
      projectCode: request.params.project_code,
      principalCode: principalOf(request),
      query: request.query.q,
      moduleIdentifier: request.query.module,
      state: request.query.state as RequirementDocumentStatus | undefined,
    })
  ));

  app.post<{ Params: { project_code: string }; Body: Record<string, unknown> }>(
    '/projects/:project_code/requirement-documents',
    async (request) => {
      const body = request.body ?? {};
      return await uc.createDocument({
        projectCode: request.params.project_code,
        moduleCode: typeof body.module_code === 'string' ? body.module_code : undefined,
        moduleKey: typeof body.module_key === 'string' ? body.module_key : undefined,
        title: String(body.title ?? ''),
        summary: typeof body.summary === 'string' ? body.summary : undefined,
        content: String(body.content ?? ''),
        keywords: stringsOf(body.keywords),
        principalCode: principalOf(request, body as PrincipalBody),
      });
    },
  );

  app.get<{ Params: { document_code: string } }>('/requirement-documents/:document_code', async (request) => (
    await uc.getDocument(request.params.document_code, principalOf(request))
  ));

  app.patch<{ Params: { document_code: string }; Body: Record<string, unknown> }>(
    '/requirement-documents/:document_code',
    async (request) => {
      const body = request.body ?? {};
      return await uc.reviseDocument({
        documentCode: request.params.document_code,
        moduleCode: typeof body.module_code === 'string' ? body.module_code : undefined,
        moduleKey: typeof body.module_key === 'string' ? body.module_key : undefined,
        title: String(body.title ?? ''),
        summary: String(body.summary ?? ''),
        content: String(body.content ?? ''),
        keywords: stringsOf(body.keywords),
        changeSummary: String(body.change_summary ?? ''),
        principalCode: principalOf(request, body as PrincipalBody),
      });
    },
  );
}
