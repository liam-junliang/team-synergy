import type { FastifyInstance } from 'fastify';
import { createArchitectureDocumentUseCases, type ArchitectureContentKind } from '@team-synergy/application';
import type { Db } from '@team-synergy/persistence';
import { unauthorized } from '../auth.js';

interface ArchitectureBody {
  title?: string;
  summary?: string;
  content_kind?: ArchitectureContentKind;
  source_content?: string;
  notes_markdown?: string;
  preview_svg?: string | null;
  base_revision?: number;
  change_summary?: string;
}
const properties = {
  title: { type: 'string' }, summary: { type: 'string' },
  content_kind: { type: 'string', enum: ['mermaid', 'drawio', 'image'] },
  source_content: { type: 'string' }, notes_markdown: { type: 'string' },
  preview_svg: { type: ['string', 'null'] }, base_revision: { type: 'integer', minimum: 1 },
  change_summary: { type: 'string' },
};
function contentOf(body: ArchitectureBody) {
  return { contentKind: body.content_kind, sourceContent: body.source_content, notesMarkdown: body.notes_markdown, previewSvg: body.preview_svg };
}

export function registerArchitectureDocumentRoutes(app: FastifyInstance, db: Db): void {
  const uc = createArchitectureDocumentUseCases(db);
  app.get<{ Params: { project_code: string }; Querystring: { q?: string } }>(
    '/projects/:project_code/architecture-documents',
    { schema: { querystring: { type: 'object', properties: { q: { type: 'string' } } } } },
    async (request, reply) => {
      if (!request.principal) return unauthorized(reply);
      return uc.listDocuments({ projectCode: request.params.project_code, principalCode: request.principal, query: request.query.q });
    },
  );
  app.post<{ Params: { project_code: string }; Body: ArchitectureBody }>(
    '/projects/:project_code/architecture-documents',
    { bodyLimit: 24 * 1024 * 1024, schema: { body: { type: 'object', required: ['title', 'content_kind', 'source_content'], properties } } },
    async (request, reply) => {
      if (!request.principal) return unauthorized(reply);
      const body = request.body;
      return uc.createDocument({ projectCode: request.params.project_code, principalCode: request.principal,
        title: body.title ?? '', summary: body.summary, ...contentOf(body) });
    },
  );
  app.get<{ Params: { document_code: string } }>('/architecture-documents/:document_code', async (request, reply) => {
    if (!request.principal) return unauthorized(reply);
    return uc.getDocument(request.params.document_code, request.principal);
  });
  app.patch<{ Params: { document_code: string }; Body: ArchitectureBody }>(
    '/architecture-documents/:document_code',
    { bodyLimit: 24 * 1024 * 1024, schema: { body: { type: 'object', required: ['base_revision', 'change_summary'], properties } } },
    async (request, reply) => {
      if (!request.principal) return unauthorized(reply);
      const body = request.body;
      return uc.reviseDocument({ documentCode: request.params.document_code, principalCode: request.principal,
        title: body.title, summary: body.summary, ...contentOf(body), baseRevision: body.base_revision ?? 0,
        changeSummary: body.change_summary ?? '' });
    },
  );
}
