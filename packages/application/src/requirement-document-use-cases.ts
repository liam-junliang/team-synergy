import { writeRequirementDocument } from './intake-entity-writers.js';
import { assertProjectAccess, effectiveProjectMember, isProjectManager } from './project-access.js';
import { and, asc, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import type { Db } from '@team-synergy/persistence';
import { schema } from '@team-synergy/persistence';
import { DomainError, assertAuditedChange, toAuditEvent } from '@team-synergy/domain';
import { fail, insertAudit, now, type TaskResult } from './task-service.js';
import { ensureProjectSystemFolders } from './project-document-folders.js';
import {
  createPublicCode,
  findProjectByCode,
  findProjectModuleByCode,
  findRequirementDocumentByCode,
  findUserByCode,
} from './public-code.js';

export const REQUIREMENT_DOCUMENT_STATUSES = ['active', 'archived'] as const;
export type RequirementDocumentStatus = (typeof REQUIREMENT_DOCUMENT_STATUSES)[number];

export interface RequirementDocumentOutlineItem {
  level: number;
  title: string;
  anchor: string;
}

export interface RequirementDocumentSummary {
  document_code: string;
  project_code: string;
  module_code: string | null;
  module_name: string | null;
  module_key: string;
  title: string;
  state: RequirementDocumentStatus;
  current_revision: number;
  owner_principal_code: string;
  summary: string;
  keywords: string[];
  updated_at: string;
}

export interface RequirementDocumentRevision {
  revision_code: string;
  revision: number;
  summary: string;
  content: string;
  keywords: string[];
  change_summary: string;
  created_by_user_code: string;
  created_at: string;
}

export interface LinkedRequirementSummary {
  requirement_code: string;
  title: string;
  state: string;
  current_revision: number;
  module_code: string | null;
  module_name: string | null;
}

export interface RequirementDocumentDetail extends RequirementDocumentSummary {
  content: string;
  change_summary: string;
  outline: RequirementDocumentOutlineItem[];
  revisions: RequirementDocumentRevision[];
  linked_requirements: LinkedRequirementSummary[];
  can_edit: boolean;
}

type DocumentRow = typeof schema.requirementDocuments.$inferSelect;
type RevisionRow = typeof schema.requirementDocumentRevisions.$inferSelect;
type MemberRow = typeof schema.members.$inferSelect;
type ModuleRow = typeof schema.projectModules.$inferSelect;

function normalizeKeywords(keywords: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const keyword of keywords) {
    const value = keyword.trim();
    const key = value.toLocaleLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function parseKeywords(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? normalizeKeywords(value.filter((item): item is string => typeof item === 'string')) : [];
  } catch {
    return [];
  }
}

function outlineOf(content: string): RequirementDocumentOutlineItem[] {
  return content.split(/\r?\n/).flatMap((line) => {
    const match = /^(#{1,4})\s+(.+)$/.exec(line.trim());
    if (!match) return [];
    const title = match[2]!.replace(/[*_`]/g, '').trim();
    const anchor = title.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
    return [{ level: match[1]!.length, title, anchor }];
  });
}

function summaryOf(content: string, title: string): string {
  const paragraph = content
    .split(/\n\s*\n/)
    .map((part) => part.replace(/^#{1,6}\s+.+$/gm, '').replace(/^[-*]\s+/gm, '').trim())
    .find(Boolean);
  return paragraph?.slice(0, 240) || title;
}

async function modulesByIds(db: Db, ids: bigint[]) {
  if (ids.length === 0) return new Map<bigint, ModuleRow>();
  const rows = await db.select().from(schema.projectModules).where(inArray(schema.projectModules.id, ids));
  return new Map(rows.map((row) => [row.id, row]));
}

function canAuthor(document: DocumentRow, member: MemberRow | undefined, principalId: bigint): boolean {
  return Boolean(member && member.role !== 'viewer' && (isProjectManager(member.role) || document.owner_principal_id === principalId));
}

async function projectMember(db: Db, projectId: bigint, principalId: bigint): Promise<MemberRow | undefined> {
  const member = await effectiveProjectMember(db, projectId, principalId);
  return member;
}

async function findModuleByCompat(db: Db, projectId: bigint, identifier: string) {
  const trimmed = identifier.trim();
  if (!trimmed) return undefined;
  const byCode = await findProjectModuleByCode(db, trimmed);
  if (byCode && byCode.project_id === projectId) return byCode;
  const [byName] = await db.select().from(schema.projectModules).where(and(
    eq(schema.projectModules.project_id, projectId),
    eq(sql`upper(${schema.projectModules.name})`, trimmed.toLocaleUpperCase()),
  )).limit(1);
  return byName;
}

async function resolveCompatModule(db: Db, projectId: bigint, moduleCode: string | undefined, moduleKey: string | undefined, principalId: bigint) {
  const moduleIdentifier = moduleCode?.trim() || moduleKey?.trim() || '';
  let module = await findModuleByCompat(db, projectId, moduleIdentifier);
  if (!module && !moduleCode && moduleKey?.trim()) {
    await assertProjectAccess(db, projectId, principalId, 'manage');
    const [sortOrderRow] = await db.select({
      value: sql<number>`coalesce(max(${schema.projectModules.sort_order}), -1)`,
    }).from(schema.projectModules).where(eq(schema.projectModules.project_id, projectId));
    const createdAt = now();
    [module] = await db.insert(schema.projectModules).values({
      code: createPublicCode(),
      project_id: projectId,
      name: moduleKey.trim().toLocaleUpperCase(),
      description: null,
      sort_order: (sortOrderRow?.value ?? -1) + 1,
      status: 'active',
      created_at: createdAt,
      updated_at: createdAt,
    }).returning();
  }
  return module;
}

export function createRequirementDocumentUseCases(db: Db) {
  async function toSummary(document: DocumentRow, revision: RevisionRow, module?: ModuleRow): Promise<RequirementDocumentSummary> {
    const [project, owner, resolvedModule] = await Promise.all([
      db.select().from(schema.projects).where(eq(schema.projects.id, document.project_id)).limit(1).then((rows) => rows[0]),
      db.select().from(schema.users).where(eq(schema.users.id, document.owner_principal_id)).limit(1).then((rows) => rows[0]),
      module
        ? Promise.resolve(module)
        : (document.module_id === null
          ? Promise.resolve(undefined)
          : db.select().from(schema.projectModules).where(eq(schema.projectModules.id, document.module_id)).limit(1).then((rows) => rows[0])),
    ]);
    return {
      document_code: document.code,
      project_code: project?.code ?? '',
      module_code: resolvedModule?.code ?? null,
      module_name: resolvedModule?.name ?? null,
      module_key: document.module_key,
      title: document.title,
      state: document.state,
      current_revision: document.current_revision,
      owner_principal_code: owner?.code ?? '',
      summary: revision.summary,
      keywords: parseKeywords(revision.keywords),
      updated_at: document.updated_at,
    };
  }

  async function toRevision(row: RevisionRow): Promise<RequirementDocumentRevision> {
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, row.created_by)).limit(1);
    return {
      revision_code: row.code,
      revision: row.revision,
      summary: row.summary,
      content: row.content,
      keywords: parseKeywords(row.keywords),
      change_summary: row.change_summary,
      created_by_user_code: user?.code ?? '',
      created_at: row.created_at,
    };
  }

  async function createDocument(cmd: {
    projectCode: string;
    moduleCode?: string;
    moduleKey?: string;
    title: string;
    summary?: string;
    content: string;
    keywords?: string[];
    principalCode: string;
  }): Promise<TaskResult<RequirementDocumentSummary>> {
    try {
      const [project, principal] = await Promise.all([
        findProjectByCode(db, cmd.projectCode),
        findUserByCode(db, cmd.principalCode),
      ]);
      if (!project) return fail(new DomainError('project_not_found', `项目不存在：${cmd.projectCode}`));
      if (!principal || principal.status !== 'active') return fail(new DomainError('user_not_found', `用户不存在：${cmd.principalCode}`));
      const member = await projectMember(db, project.id, principal.id);
      await assertProjectAccess(db, project.id, principal.id, 'write');
      if (!member) return fail(new DomainError('requirement_document_forbidden', '只有项目成员可以创建需求文档'));
      if (project.status === 'archived') return fail(new DomainError('project_archived', '已归档项目不能新增需求文档'));

      const title = cmd.title.trim();
      const content = cmd.content.replace(/\r\n/g, '\n').trim();
      const keywords = normalizeKeywords(cmd.keywords ?? []);
      const summary = cmd.summary?.trim() || summaryOf(content, title);
      const moduleIdentifier = cmd.moduleCode?.trim() || cmd.moduleKey?.trim() || '';
      const module = await resolveCompatModule(db, project.id, cmd.moduleCode, cmd.moduleKey, principal.id);
      if (!module) return fail(new DomainError('module_not_found', `功能模块不存在：${moduleIdentifier}`));
      if (!title) return fail(new DomainError('requirement_document_title_required', '需求文档标题不能为空'));
      if (!summary) return fail(new DomainError('requirement_document_summary_required', '需求文档摘要不能为空'));
      if (!content) return fail(new DomainError('requirement_document_content_required', '需求文档正文不能为空'));

      const moduleKey = cmd.moduleKey?.trim() || module.name;
      const created = await db.transaction(async (tx) => {
        await assertProjectAccess(tx, project.id, principal.id, 'write');
        await ensureProjectSystemFolders(tx, project.id);
        return writeRequirementDocument(tx, { projectId: project.id, projectCode: project.code, principalId: principal.id },
          { moduleId: module.id, moduleKey, title, summary, content, keywords });
      });
      return { ok: true, data: await toSummary(created.document, created.revision, module) };
    } catch (error) {
      return fail(error);
    }
  }

  async function listDocuments(cmd: {
    projectCode: string;
    principalCode: string;
    moduleIdentifier?: string;
    state?: RequirementDocumentStatus;
    query?: string;
  }): Promise<TaskResult<RequirementDocumentSummary[]>> {
    try {
      const [project, principal] = await Promise.all([
        findProjectByCode(db, cmd.projectCode),
        findUserByCode(db, cmd.principalCode),
      ]);
      if (!project) return fail(new DomainError('project_not_found', `项目不存在：${cmd.projectCode}`));
      if (!principal || principal.status !== 'active') return fail(new DomainError('user_not_found', `用户不存在：${cmd.principalCode}`));
      const member = await projectMember(db, project.id, principal.id);
      if (!member) return fail(new DomainError('requirement_document_forbidden', '当前用户不是项目成员'));

      const query = cmd.query?.trim();
      const pattern = query ? `%${query}%` : undefined;
      const module = cmd.moduleIdentifier ? await findModuleByCompat(db, project.id, cmd.moduleIdentifier) : undefined;
      const rows = await db.select({
        document: schema.requirementDocuments,
        revision: schema.requirementDocumentRevisions,
      })
        .from(schema.requirementDocuments)
        .innerJoin(schema.requirementDocumentRevisions, and(
          eq(schema.requirementDocumentRevisions.document_id, schema.requirementDocuments.id),
          eq(schema.requirementDocumentRevisions.revision, schema.requirementDocuments.current_revision),
        ))
        .where(and(
          eq(schema.requirementDocuments.project_id, project.id),
          module
            ? eq(schema.requirementDocuments.module_id, module.id)
            : (cmd.moduleIdentifier ? eq(schema.requirementDocuments.module_key, cmd.moduleIdentifier) : undefined),
          cmd.state ? eq(schema.requirementDocuments.state, cmd.state) : undefined,
          pattern ? or(
            ilike(schema.requirementDocuments.title, pattern),
            ilike(schema.requirementDocuments.module_key, pattern),
            ilike(schema.requirementDocumentRevisions.summary, pattern),
            ilike(schema.requirementDocumentRevisions.content, pattern),
            ilike(schema.requirementDocumentRevisions.keywords, pattern),
          ) : undefined,
        ))
        .orderBy(asc(schema.requirementDocuments.module_key), asc(schema.requirementDocuments.title));
      const moduleMap = await modulesByIds(
        db,
        [...new Set(rows.map((row) => row.document.module_id).filter((value): value is bigint => value !== null))],
      );
      return {
        ok: true,
        data: await Promise.all(rows.map((row) => toSummary(
          row.document,
          row.revision,
          row.document.module_id ? moduleMap.get(row.document.module_id) : undefined,
        ))),
      };
    } catch (error) {
      return fail(error);
    }
  }

  async function getDocument(documentCode: string, principalCode: string): Promise<TaskResult<RequirementDocumentDetail>> {
    try {
      const [document, principal] = await Promise.all([
        findRequirementDocumentByCode(db, documentCode),
        findUserByCode(db, principalCode),
      ]);
      if (!document) return fail(new DomainError('requirement_document_not_found', `需求文档不存在：${documentCode}`));
      if (!principal || principal.status !== 'active') return fail(new DomainError('user_not_found', `用户不存在：${principalCode}`));
      const member = await projectMember(db, document.project_id, principal.id);
      if (!member) return fail(new DomainError('requirement_document_forbidden', '当前用户不是项目成员'));
      const [currentRevision, revisions, linkedRequirements, module, project] = await Promise.all([
        db.select().from(schema.requirementDocumentRevisions).where(and(
          eq(schema.requirementDocumentRevisions.document_id, document.id),
          eq(schema.requirementDocumentRevisions.revision, document.current_revision),
        )).limit(1).then((rows) => rows[0]),
        db.select().from(schema.requirementDocumentRevisions)
          .where(eq(schema.requirementDocumentRevisions.document_id, document.id))
          .orderBy(desc(schema.requirementDocumentRevisions.revision)),
        db.select({
          requirement: schema.requirements,
          module: schema.projectModules,
        }).from(schema.requirements)
          .leftJoin(schema.projectModules, eq(schema.projectModules.id, schema.requirements.module_id))
          .where(eq(schema.requirements.document_id, document.id)),
        document.module_id === null
          ? Promise.resolve(undefined)
          : db.select().from(schema.projectModules).where(eq(schema.projectModules.id, document.module_id)).limit(1).then((rows) => rows[0]),
        db.select().from(schema.projects).where(eq(schema.projects.id, document.project_id)).limit(1).then(rows => rows[0]),
      ]);
      if (!currentRevision) return fail(new DomainError('requirement_document_revision_not_found', `需求文档当前版本不存在：${documentCode}`));
      const summary = await toSummary(document, currentRevision, module);
      return {
        ok: true,
        data: {
          ...summary,
          content: currentRevision.content,
          change_summary: currentRevision.change_summary,
          outline: outlineOf(currentRevision.content),
          revisions: await Promise.all(revisions.map((row) => toRevision(row))),
          linked_requirements: linkedRequirements.map((row) => ({
            requirement_code: row.requirement.code,
            title: row.requirement.title,
            state: row.requirement.state,
            current_revision: row.requirement.current_revision,
            module_code: row.module?.code ?? null,
            module_name: row.module?.name ?? null,
          })),
          can_edit: project?.status === 'active' && document.state === 'active' && canAuthor(document, member, principal.id),
        },
      };
    } catch (error) {
      return fail(error);
    }
  }

  async function reviseDocument(cmd: {
    documentCode: string;
    moduleCode?: string;
    moduleKey?: string;
    title: string;
    summary: string;
    content: string;
    keywords?: string[];
    changeSummary: string;
    principalCode: string;
  }): Promise<TaskResult<RequirementDocumentSummary>> {
    try {
      const [document, principal] = await Promise.all([
        findRequirementDocumentByCode(db, cmd.documentCode),
        findUserByCode(db, cmd.principalCode),
      ]);
      if (!document) return fail(new DomainError('requirement_document_not_found', `需求文档不存在：${cmd.documentCode}`));
      if (!principal || principal.status !== 'active') return fail(new DomainError('user_not_found', `用户不存在：${cmd.principalCode}`));
      const title = cmd.title.trim();
      const summary = cmd.summary.trim();
      const content = cmd.content.replace(/\r\n/g, '\n').trim();
      const changeSummary = cmd.changeSummary.trim();
      const keywords = normalizeKeywords(cmd.keywords ?? []);
      if (!title) return fail(new DomainError('requirement_document_title_required', '需求文档标题不能为空'));
      if (!summary) return fail(new DomainError('requirement_document_summary_required', '需求文档摘要不能为空'));
      if (!content) return fail(new DomainError('requirement_document_content_required', '需求文档正文不能为空'));
      if (!changeSummary) return fail(new DomainError('requirement_document_change_summary_required', '修订时必须说明本次变更'));
      if (document.state === 'archived') {
        return fail(new DomainError('requirement_document_archived', '已归档的需求文档不能继续编辑'));
      }
      const member = await projectMember(db, document.project_id, principal.id);
      await assertProjectAccess(db, document.project_id, principal.id, 'write');
      if (!canAuthor(document, member, principal.id)) {
        return fail(new DomainError('requirement_document_forbidden', '只有文档负责人或项目 Owner 可以修订'));
      }
      const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, document.project_id)).limit(1);
      if (project?.status === 'archived') return fail(new DomainError('project_archived', '已归档项目不能修订需求文档'));

      const moduleIdentifier = cmd.moduleCode?.trim() || cmd.moduleKey?.trim() || document.module_key;
      const module = await resolveCompatModule(db, document.project_id, cmd.moduleCode, cmd.moduleKey ?? document.module_key, principal.id);
      if (!module) return fail(new DomainError('module_not_found', `功能模块不存在：${moduleIdentifier}`));

      const changedAt = now();
      const nextRevision = document.current_revision + 1;
      const [updatedDocument] = await db.transaction(async (tx) => {
        await assertProjectAccess(tx, document.project_id, principal.id, 'write');
        await tx.insert(schema.requirementDocumentRevisions).values({
          code: createPublicCode(),
          document_id: document.id,
          revision: nextRevision,
          summary,
          content,
          keywords: JSON.stringify(keywords),
          change_summary: changeSummary,
          created_by: principal.id,
          created_at: changedAt,
        });
        await tx.update(schema.requirementDocuments).set({
          module_id: module.id,
          module_key: cmd.moduleKey?.trim() || module.name,
          title,
          current_revision: nextRevision,
          updated_at: changedAt,
        }).where(eq(schema.requirementDocuments.id, document.id));
        const audit = {
          entity_type: 'requirement_document',
          entity_id: document.id,
          legacy_entity_code: document.legacy_code ?? undefined,
          principal_id: principal.id,
          base_snapshot: document.current_revision,
          action: 'requirement_document.revised',
          payload: { from_revision: document.current_revision, revision: nextRevision, change_summary: changeSummary, module_code: module.code },
        };
        assertAuditedChange(audit);
        await insertAudit(tx, toAuditEvent(audit, createPublicCode(), changedAt));
        return tx.select().from(schema.requirementDocuments).where(eq(schema.requirementDocuments.id, document.id)).limit(1);
      });
      if (!updatedDocument) return fail(new DomainError('internal_error', '需求文档修订失败'));
      const [revision] = await db.select().from(schema.requirementDocumentRevisions).where(and(
        eq(schema.requirementDocumentRevisions.document_id, document.id),
        eq(schema.requirementDocumentRevisions.revision, nextRevision),
      )).limit(1);
      if (!revision) return fail(new DomainError('internal_error', '需求文档修订版本缺失'));
      return { ok: true, data: await toSummary(updatedDocument, revision, module) };
    } catch (error) {
      return fail(error);
    }
  }

  return { createDocument, listDocuments, getDocument, reviseDocument };
}

export type RequirementDocumentUseCases = ReturnType<typeof createRequirementDocumentUseCases>;
