import type { FastifyInstance } from 'fastify';
import {
  PROJECT_DOCUMENT_INPUT_KINDS,
  createProjectDocumentUseCases,
  type ProjectDocumentInputKind,
  type ProjectDocumentStatus,
} from '@team-synergy/application';
import type { Db } from '@team-synergy/persistence';
import { principalOf } from '../auth.js';

interface PrincipalBody {
  principal_code?: string;
  user_code?: string;
}

function kindOf(value: unknown): ProjectDocumentInputKind | undefined {
  return typeof value === 'string' && PROJECT_DOCUMENT_INPUT_KINDS.includes(value as ProjectDocumentInputKind)
    ? value as ProjectDocumentInputKind
    : undefined;
}

function statusOf(value: unknown): ProjectDocumentStatus | undefined {
  return value === 'active' || value === 'archived' ? value : undefined;
}

/** Project handoff library: nested folders, multiple documents and immutable revisions. */
export function registerProjectDocumentRoutes(app: FastifyInstance, db: Db): void {
  const uc = createProjectDocumentUseCases(db);

  app.get<{
    Params: { project_code: string };
    Querystring: { q?: string };
  }>('/projects/:project_code/handoff', async (request) => (
    await uc.listLibrary({
      projectCode: request.params.project_code,
      principalCode: principalOf(request),
      query: request.query.q,
    })
  ));

  app.post<{ Params: { project_code: string }; Body: Record<string, unknown> }>(
    '/projects/:project_code/handoff/folders',
    async (request) => {
      const body = request.body ?? {};
      return await uc.createFolder({
        projectCode: request.params.project_code,
        principalCode: principalOf(request, body as PrincipalBody),
        name: String(body.name ?? ''),
        parentFolderCode: typeof body.parent_folder_code === 'string' ? body.parent_folder_code : null,
      });
    },
  );

  app.patch<{ Params: { folder_code: string }; Body: Record<string, unknown> }>(
    '/handoff-folders/:folder_code',
    async (request) => {
      const body = request.body ?? {};
      return await uc.updateFolder({
        folderCode: request.params.folder_code,
        principalCode: principalOf(request, body as PrincipalBody),
        name: typeof body.name === 'string' ? body.name : undefined,
        parentFolderCode: body.parent_folder_code === null
          ? null
          : typeof body.parent_folder_code === 'string' ? body.parent_folder_code : undefined,
        status: statusOf(body.status),
      });
    },
  );

  app.post<{ Params: { project_code: string }; Body: Record<string, unknown> }>(
    '/projects/:project_code/handoff/documents',
    async (request) => {
      const body = request.body ?? {};
      return await uc.createDocument({
        projectCode: request.params.project_code,
        principalCode: principalOf(request, body as PrincipalBody),
        folderCode: typeof body.folder_code === 'string' ? body.folder_code : null,
        kind: kindOf(body.kind) ?? 'doc',
        title: String(body.title ?? ''),
        summary: typeof body.summary === 'string' ? body.summary : undefined,
        content: String(body.content ?? ''),
      });
    },
  );

  app.get<{ Params: { document_code: string } }>('/handoff-documents/:document_code', async (request) => (
    await uc.getDocument(request.params.document_code, principalOf(request))
  ));

  app.patch<{ Params: { document_code: string }; Body: Record<string, unknown> }>(
    '/handoff-documents/:document_code',
    async (request) => {
      const body = request.body ?? {};
      return await uc.reviseDocument({
        documentCode: request.params.document_code,
        principalCode: principalOf(request, body as PrincipalBody),
        folderCode: body.folder_code === null
          ? null
          : typeof body.folder_code === 'string' ? body.folder_code : undefined,
        kind: kindOf(body.kind),
        title: String(body.title ?? ''),
        summary: typeof body.summary === 'string' ? body.summary : undefined,
        content: String(body.content ?? ''),
        changeSummary: String(body.change_summary ?? ''),
        status: statusOf(body.status),
      });
    },
  );
}
