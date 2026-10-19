import { writeArchitecture } from './intake-entity-writers.js';
import { assertProjectAccess, effectiveProjectMember, isProjectManager } from './project-access.js';
import { and, desc, eq, ilike, inArray, or } from 'drizzle-orm';
import { schema, type Db } from '@team-synergy/persistence';
import { DomainError, toAuditEvent } from '@team-synergy/domain';
import { fail, insertAudit, now, type TaskResult } from './task-service.js';
import { createPublicCode, findProjectByCode, findUserByCode } from './public-code.js';
import { ensureProjectSystemFolders } from './project-document-folders.js';
import { architectureText, normalizeArchitectureContent, type ArchitectureContent, type ArchitectureContentInput, type ArchitectureContentKind } from './architecture-document-content.js';

export type { ArchitectureContentKind } from './architecture-document-content.js';
export interface ArchitectureDocumentSummary {
  document_code: string;
  project_code: string;
  title: string;
  summary: string;
  content_kind: ArchitectureContentKind;
  current_revision: number;
  owner_principal_code: string;
  updated_at: string;
  can_edit: boolean;
}
export interface ArchitectureDocumentRevision extends ArchitectureContent {
  revision_code: string;
  revision: number;
  title: string;
  summary: string;
  change_summary: string;
  created_by_user_code: string;
  created_at: string;
}
export interface ArchitectureDocumentDetail extends ArchitectureDocumentSummary, ArchitectureContent {
  revisions: ArchitectureDocumentRevision[];
}
type DocumentRow = typeof schema.architectureDocuments.$inferSelect;

export function createArchitectureDocumentUseCases(db: Db) {
  async function memberOf(projectId: bigint, principalCode: string) {
    const principal = await findUserByCode(db, principalCode);
    if (!principal || principal.status !== 'active') throw new DomainError('user_not_found', '用户不存在或已停用');
    const member = await effectiveProjectMember(db, projectId, principal.id);
    if (!member) throw new DomainError('architecture_document_forbidden', '只有当前项目成员可以访问架构设计');
    return { principal, member };
  }

  async function documentOf(code: string) {
    const [document] = await db.select().from(schema.architectureDocuments).where(eq(schema.architectureDocuments.code, code)).limit(1);
    if (!document) throw new DomainError('architecture_document_not_found', '架构资料不存在');
    return document;
  }

  async function toSummary(document: DocumentRow, principalId: bigint, role: string): Promise<ArchitectureDocumentSummary> {
    const [project, owner] = await Promise.all([
      db.select({ code: schema.projects.code, status: schema.projects.status }).from(schema.projects).where(eq(schema.projects.id, document.project_id)).limit(1),
      db.select({ code: schema.users.code }).from(schema.users).where(eq(schema.users.id, document.owner_principal_id)).limit(1),
    ]);
    return {
      document_code: document.code, project_code: project[0]?.code ?? '', title: document.title, summary: document.summary,
      content_kind: document.content_kind, current_revision: document.current_revision, owner_principal_code: owner[0]?.code ?? '',
      updated_at: document.updated_at,
      can_edit: project[0]?.status === 'active' && (role !== 'viewer' && (isProjectManager(role) || document.owner_principal_id === principalId)),
    };
  }

  async function listDocuments(cmd: { projectCode: string; principalCode: string; query?: string }): Promise<TaskResult<ArchitectureDocumentSummary[]>> {
    try {
      const project = await findProjectByCode(db, cmd.projectCode);
      if (!project) throw new DomainError('project_not_found', '项目不存在');
      const { principal, member } = await memberOf(project.id, cmd.principalCode);
      const query = cmd.query?.trim();
      const documents = await db.select().from(schema.architectureDocuments).where(and(
        eq(schema.architectureDocuments.project_id, project.id),
        query ? or(ilike(schema.architectureDocuments.title, `%${query}%`), ilike(schema.architectureDocuments.summary, `%${query}%`)) : undefined,
      )).orderBy(desc(schema.architectureDocuments.updated_at), desc(schema.architectureDocuments.id));
      return { ok: true, data: await Promise.all(documents.map((document) => toSummary(document, principal.id, member.role))) };
    } catch (error) { return fail(error); }
  }

  async function getDocument(documentCode: string, principalCode: string): Promise<TaskResult<ArchitectureDocumentDetail>> {
    try {
      const document = await documentOf(documentCode);
      const { principal, member } = await memberOf(document.project_id, principalCode);
      const revisions = await db.select().from(schema.architectureDocumentRevisions)
        .where(eq(schema.architectureDocumentRevisions.document_id, document.id)).orderBy(desc(schema.architectureDocumentRevisions.revision));
      const current = revisions.find((revision) => revision.revision === document.current_revision);
      if (!current) throw new DomainError('internal_error', '架构资料当前修订不存在');
      const authors = await db.select({ id: schema.users.id, code: schema.users.code }).from(schema.users)
        .where(inArray(schema.users.id, [...new Set(revisions.map((revision) => revision.created_by))]));
      const authorCodes = new Map(authors.map((author) => [author.id, author.code]));
      return { ok: true, data: {
        ...await toSummary(document, principal.id, member.role), source_content: current.source_content,
        notes_markdown: current.notes_markdown, preview_svg: current.preview_svg,
        revisions: revisions.map((revision) => ({
          revision_code: revision.code, revision: revision.revision, title: revision.title, summary: revision.summary,
          content_kind: revision.content_kind, source_content: revision.source_content, notes_markdown: revision.notes_markdown,
          preview_svg: revision.preview_svg, change_summary: revision.change_summary,
          created_by_user_code: authorCodes.get(revision.created_by) ?? '', created_at: revision.created_at,
        })),
      } };
    } catch (error) { return fail(error); }
  }

  async function createDocument(cmd: { projectCode: string; principalCode: string; title: string; summary?: string } & ArchitectureContentInput): Promise<TaskResult<ArchitectureDocumentDetail>> {
    try {
      const project = await findProjectByCode(db, cmd.projectCode);
      if (!project) throw new DomainError('project_not_found', '项目不存在');
      const { principal } = await memberOf(project.id, cmd.principalCode);
      await assertProjectAccess(db, project.id, principal.id, 'write');
      if (project.status === 'archived') throw new DomainError('project_archived', '已归档项目不能新增架构资料');
      const title = architectureText(cmd.title, '标题', 512, true);
      const summary = architectureText(cmd.summary ?? '', '摘要', 4096);
      const content = normalizeArchitectureContent(cmd);
      const document = await db.transaction(async (tx) => {
        await assertProjectAccess(tx, project.id, principal.id, 'write');
        await ensureProjectSystemFolders(tx, project.id);
        return writeArchitecture(tx, { projectId: project.id, projectCode: project.code, principalId: principal.id }, { title, summary, content });
      });
      return await getDocument(document.code, principal.code);
    } catch (error) { return fail(error); }
  }

  async function reviseDocument(cmd: { documentCode: string; principalCode: string; title?: string; summary?: string; baseRevision: number; changeSummary: string } & ArchitectureContentInput): Promise<TaskResult<ArchitectureDocumentDetail>> {
    try {
      const document = await documentOf(cmd.documentCode);
      const { principal, member } = await memberOf(document.project_id, cmd.principalCode);
      await assertProjectAccess(db, document.project_id, principal.id, 'write');
      if (!isProjectManager(member.role) && document.owner_principal_id !== principal.id) {
        throw new DomainError('architecture_document_forbidden', '只有架构资料作者或项目 Owner 可以修订');
      }
      const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, document.project_id)).limit(1);
      if (project?.status === 'archived') throw new DomainError('project_archived', '已归档项目不能修订架构资料');
      if (!Number.isSafeInteger(cmd.baseRevision) || cmd.baseRevision < 1) {
        throw new DomainError('architecture_document_base_revision_invalid', '修订必须提供正整数 base_revision');
      }
      const changeSummary = architectureText(cmd.changeSummary, '变更说明', 4096, true);
      await db.transaction(async (tx) => {
        await assertProjectAccess(tx, document.project_id, principal.id, 'write');
        const [locked] = await tx.select().from(schema.architectureDocuments)
          .where(eq(schema.architectureDocuments.id, document.id)).for('update');
        if (!locked || locked.current_revision !== cmd.baseRevision) {
          throw new DomainError('architecture_document_revision_conflict', '架构资料已更新，请重新加载后合并修改');
        }
        const [current] = await tx.select().from(schema.architectureDocumentRevisions).where(and(
          eq(schema.architectureDocumentRevisions.document_id, locked.id), eq(schema.architectureDocumentRevisions.revision, locked.current_revision),
        )).limit(1);
        if (!current) throw new DomainError('internal_error', '架构资料当前修订不存在');
        const title = architectureText(cmd.title ?? current.title, '标题', 512, true);
        const summary = architectureText(cmd.summary ?? current.summary, '摘要', 4096);
        const content = normalizeArchitectureContent(cmd, current);
        const nextRevision = locked.current_revision + 1;
        const timestamp = now();
        await tx.insert(schema.architectureDocumentRevisions).values({
          code: createPublicCode(), document_id: locked.id, revision: nextRevision, title, summary, ...content,
          change_summary: changeSummary, created_by: principal.id, created_at: timestamp,
        });
        await tx.update(schema.architectureDocuments).set({ title, summary, content_kind: content.content_kind,
          current_revision: nextRevision, updated_at: timestamp }).where(eq(schema.architectureDocuments.id, locked.id));
        await insertAudit(tx, toAuditEvent({ entity_type: 'architecture_document', entity_id: locked.id,
          principal_id: principal.id, base_snapshot: locked.current_revision, action: 'architecture_document.revised',
          payload: { revision: nextRevision, content_kind: content.content_kind, change_summary: changeSummary },
        }, createPublicCode(), timestamp));
      });
      return await getDocument(document.code, principal.code);
    } catch (error) { return fail(error); }
  }

  return { createDocument, listDocuments, getDocument, reviseDocument };
}
export type ArchitectureDocumentUseCases = ReturnType<typeof createArchitectureDocumentUseCases>;
