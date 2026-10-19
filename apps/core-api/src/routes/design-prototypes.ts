import type { FastifyInstance } from 'fastify';
import {
  createDesignPrototypeUseCases,
  type DesignPrototypeStatus,
  type DesignPrototypeContentKind,
} from '@team-synergy/application';
import type { Db } from '@team-synergy/persistence';
import { principalOf, unauthorized } from '../auth.js';

interface PrincipalBody {
  principal_code?: string;
  user_code?: string;
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function contentOf(body: Record<string, unknown>) {
  return {
    contentKind: typeof body.content_kind === 'string' ? body.content_kind as DesignPrototypeContentKind : undefined,
    htmlContent: typeof body.html_content === 'string' ? body.html_content : undefined,
    externalUrl: typeof body.external_url === 'string' ? body.external_url : undefined,
    fileName: typeof body.file_name === 'string' ? body.file_name : undefined,
    fileMimeType: typeof body.file_mime_type === 'string' ? body.file_mime_type : undefined,
    fileContentBase64: typeof body.file_content_base64 === 'string' ? body.file_content_base64 : undefined,
  };
}

export function registerDesignPrototypeRoutes(app: FastifyInstance, db: Db): void {
  const uc = createDesignPrototypeUseCases(db);

  app.get<{
    Params: { project_code: string };
    Querystring: { q?: string; status?: string };
  }>('/projects/:project_code/design-prototypes', async (request) => (
    await uc.listPrototypes({
      projectCode: request.params.project_code,
      principalCode: principalOf(request),
      query: request.query.q,
      status: request.query.status as DesignPrototypeStatus | undefined,
    })
  ));

  app.post<{ Params: { project_code: string }; Body: Record<string, unknown> }>(
    '/projects/:project_code/design-prototypes',
    { bodyLimit: 30 * 1024 * 1024 },
    async (request) => {
      const body = request.body ?? {};
      return await uc.createPrototype({
        projectCode: request.params.project_code,
        title: String(body.title ?? ''),
        summary: typeof body.summary === 'string' ? body.summary : undefined,
        ...contentOf(body),
        notesMarkdown: typeof body.notes_markdown === 'string' ? body.notes_markdown : undefined,
        requirementCodes: stringsOf(body.requirement_codes),
        status: typeof body.status === 'string' ? body.status as DesignPrototypeStatus : undefined,
        principalCode: principalOf(request, body as PrincipalBody),
      });
    },
  );

  app.get<{ Params: { prototype_code: string } }>('/design-prototypes/:prototype_code', async (request) => (
    await uc.getPrototype(request.params.prototype_code, principalOf(request))
  ));

  app.get<{ Params: { prototype_code: string }; Querystring: { revision?: string } }>(
    '/design-prototypes/:prototype_code/file',
    async (request, reply) => {
      if (!request.principal) return unauthorized(reply);
      const version = request.query.revision;
      const revision = version === undefined ? undefined : (/^[1-9]\d*$/.test(version) ? Number(version) : NaN);
      const result = await uc.getPrototypeFile(request.params.prototype_code, principalOf(request), revision);
      if (!result.ok) return result;
      const encodedName = encodeURIComponent(result.data.file_name).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
      return reply.header('Content-Type', 'application/octet-stream')
        .header('Content-Disposition', `attachment; filename="prototype-file"; filename*=UTF-8''${encodedName}`)
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cache-Control', 'private, no-store')
        .send(result.data.bytes);
    },
  );

  app.patch<{ Params: { prototype_code: string }; Body: Record<string, unknown> }>(
    '/design-prototypes/:prototype_code',
    { bodyLimit: 30 * 1024 * 1024 },
    async (request) => {
      const body = request.body ?? {};
      return await uc.revisePrototype({
        prototypeCode: request.params.prototype_code,
        title: String(body.title ?? ''),
        summary: String(body.summary ?? ''),
        ...contentOf(body),
        notesMarkdown: typeof body.notes_markdown === 'string' ? body.notes_markdown : undefined,
        requirementCodes: stringsOf(body.requirement_codes),
        status: typeof body.status === 'string' ? body.status as DesignPrototypeStatus : undefined,
        changeSummary: String(body.change_summary ?? ''),
        principalCode: principalOf(request, body as PrincipalBody),
      });
    },
  );
}
