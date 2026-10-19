import { assertProjectAccess, effectiveProjectMember, isProjectManager } from './project-access.js';
import { and, desc, eq, ilike, inArray, or } from 'drizzle-orm';
import type { Db } from '@team-synergy/persistence';
import { schema } from '@team-synergy/persistence';
import { DomainError, assertAuditedChange, toAuditEvent } from '@team-synergy/domain';
import { fail, insertAudit, now, type TaskResult } from './task-service.js';
import {
  designPrototypeContentMetadata,
  designPrototypeRevisionColumns,
  normalizeDesignPrototypeContent,
  type DesignPrototypeContentInput,
  type DesignPrototypeContentMetadata,
} from './design-prototype-content.js';
import {
  createPublicCode,
  findDesignPrototypeByCode,
  findProjectByCode,
  findRequirementByCode,
  findUserByCode,
} from './public-code.js';

export const DESIGN_PROTOTYPE_STATUSES = ['draft', 'ready', 'archived'] as const;
export type DesignPrototypeStatus = (typeof DESIGN_PROTOTYPE_STATUSES)[number];

export interface DesignPrototypeRequirementLink {
  requirement_code: string;
  title: string;
  status: string;
  feature_code: string | null;
  feature_name: string | null;
}

export interface DesignPrototypeSummary {
  prototype_code: string;
  project_code: string;
  title: string;
  summary: string;
  status: DesignPrototypeStatus;
  current_revision: number;
  owner_principal_code: string;
  linked_requirements: DesignPrototypeRequirementLink[];
  updated_at: string;
}

export interface DesignPrototypeRevision extends DesignPrototypeContentMetadata {
  revision_code: string;
  revision: number;
  change_summary: string;
  has_notes: boolean;
  created_by_user_code: string;
  created_at: string;
}

export interface DesignPrototypeDetail extends DesignPrototypeSummary, DesignPrototypeContentMetadata {
  html_content: string;
  notes_markdown: string;
  change_summary: string;
  revisions: DesignPrototypeRevision[];
  can_edit: boolean;
}

type PrototypeRow = typeof schema.designPrototypes.$inferSelect;
type RequirementRow = typeof schema.requirements.$inferSelect;
type MemberRow = typeof schema.members.$inferSelect;

const MAX_NOTES_LENGTH = 256 * 1024;

function normalizeNotes(value: string): string {
  const notes = value.replace(/\r\n/g, '\n').trim();
  if (notes.length > MAX_NOTES_LENGTH) {
    throw new DomainError('design_prototype_notes_too_large', '原型配套说明不能超过 256 KiB');
  }
  return notes;
}

function normalizeRequirementCodes(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizeStatus(value: DesignPrototypeStatus | undefined, fallback: DesignPrototypeStatus): DesignPrototypeStatus {
  const status = value ?? fallback;
  if (!DESIGN_PROTOTYPE_STATUSES.includes(status)) {
    throw new DomainError('design_prototype_status_invalid', `不支持的原型状态：${status}`);
  }
  return status;
}

async function projectMember(db: Db, projectId: bigint, principalId: bigint): Promise<MemberRow | undefined> {
  const member = await effectiveProjectMember(db, projectId, principalId);
  return member;
}

async function requirementProjectId(db: Db, requirement: RequirementRow): Promise<bigint | undefined> {
  const [feature, module, document] = await Promise.all([
    requirement.feature_id === null
      ? Promise.resolve(undefined)
      : db.select().from(schema.features).where(eq(schema.features.id, requirement.feature_id)).limit(1).then((rows) => rows[0]),
    requirement.module_id === null
      ? Promise.resolve(undefined)
      : db.select().from(schema.projectModules).where(eq(schema.projectModules.id, requirement.module_id)).limit(1).then((rows) => rows[0]),
    requirement.document_id === null
      ? Promise.resolve(undefined)
      : db.select().from(schema.requirementDocuments).where(eq(schema.requirementDocuments.id, requirement.document_id)).limit(1).then((rows) => rows[0]),
  ]);
  const projectIds = [feature?.project_id, module?.project_id, document?.project_id].filter((value): value is bigint => value !== undefined);
  if (projectIds.length === 0) return undefined;
  if (projectIds.some((value) => value !== projectIds[0])) {
    throw new DomainError('requirement_project_mismatch', `需求 ${requirement.code} 的项目上下文不一致`);
  }
  return projectIds[0];
}

async function resolveRequirements(db: Db, projectId: bigint, requirementCodes: string[]): Promise<RequirementRow[]> {
  return await Promise.all(normalizeRequirementCodes(requirementCodes).map(async (code) => {
    const requirement = await findRequirementByCode(db, code);
    if (!requirement) throw new DomainError('requirement_not_found', `需求不存在：${code}`);
    const linkedProjectId = await requirementProjectId(db, requirement);
    if (linkedProjectId !== projectId) {
      throw new DomainError('design_prototype_requirement_project_mismatch', `需求 ${code} 不属于当前项目`);
    }
    return requirement;
  }));
}

async function linkedRequirements(db: Db, prototypeId: bigint): Promise<DesignPrototypeRequirementLink[]> {
  const rows = await db.select({
    requirement: schema.requirements,
    feature: schema.features,
  })
    .from(schema.designPrototypeRequirements)
    .innerJoin(schema.requirements, eq(schema.designPrototypeRequirements.requirement_id, schema.requirements.id))
    .leftJoin(schema.features, eq(schema.requirements.feature_id, schema.features.id))
    .where(eq(schema.designPrototypeRequirements.prototype_id, prototypeId));
  return rows.map(({ requirement, feature }) => ({
    requirement_code: requirement.code,
    title: requirement.title,
    status: requirement.state,
    feature_code: feature?.code ?? null,
    feature_name: feature?.title ?? null,
  }));
}

export function createDesignPrototypeUseCases(db: Db) {
  async function toSummary(prototype: PrototypeRow): Promise<DesignPrototypeSummary> {
    const [project, owner, requirements] = await Promise.all([
      db.select().from(schema.projects).where(eq(schema.projects.id, prototype.project_id)).limit(1).then((rows) => rows[0]),
      db.select().from(schema.users).where(eq(schema.users.id, prototype.owner_principal_id)).limit(1).then((rows) => rows[0]),
      linkedRequirements(db, prototype.id),
    ]);
    return {
      prototype_code: prototype.code,
      project_code: project?.code ?? '',
      title: prototype.title,
      summary: prototype.summary,
      status: prototype.status,
      current_revision: prototype.current_revision,
      owner_principal_code: owner?.code ?? '',
      linked_requirements: requirements,
      updated_at: prototype.updated_at,
    };
  }

  async function createPrototype(cmd: {
    projectCode: string;
    title: string;
    summary?: string;
    notesMarkdown?: string;
    requirementCodes?: string[];
    status?: DesignPrototypeStatus;
    principalCode: string;
  } & DesignPrototypeContentInput): Promise<TaskResult<DesignPrototypeDetail>> {
    try {
      const [project, principal] = await Promise.all([
        findProjectByCode(db, cmd.projectCode),
        findUserByCode(db, cmd.principalCode),
      ]);
      if (!project) return fail(new DomainError('project_not_found', `项目不存在：${cmd.projectCode}`));
      if (!principal || principal.status !== 'active') return fail(new DomainError('user_not_found', `用户不存在：${cmd.principalCode}`));
      const member = await projectMember(db, project.id, principal.id);
      await assertProjectAccess(db, project.id, principal.id, 'write');
      if (!member) return fail(new DomainError('design_prototype_forbidden', '只有当前项目成员可以创建原型'));
      const title = cmd.title.trim();
      if (!title) return fail(new DomainError('design_prototype_title_required', '原型标题不能为空'));
      const summary = cmd.summary?.trim() ?? '';
      const content = normalizeDesignPrototypeContent(cmd);
      const notesMarkdown = normalizeNotes(cmd.notesMarkdown ?? '');
      const status = normalizeStatus(cmd.status, 'draft');
      if (status === 'archived') return fail(new DomainError('design_prototype_initial_status_invalid', '新原型不能直接归档'));
      const requirements = await resolveRequirements(db, project.id, cmd.requirementCodes ?? []);
      const changedAt = now();

      const prototype = await db.transaction(async (tx) => {
        await assertProjectAccess(tx, project.id, principal.id, 'write');
        const [created] = await tx.insert(schema.designPrototypes).values({
          code: createPublicCode(),
          project_id: project.id,
          title,
          summary,
          status,
          current_revision: 1,
          owner_principal_id: principal.id,
          created_at: changedAt,
          updated_at: changedAt,
        }).returning();
        if (!created) throw new DomainError('internal_error', '原型创建失败');
        await tx.insert(schema.designPrototypeRevisions).values({
          code: createPublicCode(),
          prototype_id: created.id,
          revision: 1,
          ...content,
          notes_markdown: notesMarkdown,
          change_summary: '初始原型',
          created_by: principal.id,
          created_at: changedAt,
        });
        if (requirements.length > 0) {
          await tx.insert(schema.designPrototypeRequirements).values(requirements.map((requirement) => ({
            prototype_id: created.id,
            requirement_id: requirement.id,
          })));
        }
        const audit = {
          entity_type: 'design_prototype',
          entity_id: created.id,
          principal_id: principal.id,
          base_snapshot: 0,
          to: status,
          action: 'design_prototype.created',
          payload: { prototype_code: created.code, revision: 1, requirement_codes: requirements.map((item) => item.code) },
        };
        assertAuditedChange(audit);
        await insertAudit(tx, toAuditEvent(audit, createPublicCode(), changedAt));
        return created;
      });
      return await getPrototype(prototype.code, principal.code);
    } catch (error) {
      return fail(error);
    }
  }

  async function listPrototypes(cmd: {
    projectCode: string;
    principalCode: string;
    query?: string;
    status?: DesignPrototypeStatus;
  }): Promise<TaskResult<DesignPrototypeSummary[]>> {
    try {
      const [project, principal] = await Promise.all([
        findProjectByCode(db, cmd.projectCode),
        findUserByCode(db, cmd.principalCode),
      ]);
      if (!project) return fail(new DomainError('project_not_found', `项目不存在：${cmd.projectCode}`));
      if (!principal || principal.status !== 'active') return fail(new DomainError('user_not_found', `用户不存在：${cmd.principalCode}`));
      if (!await projectMember(db, project.id, principal.id)) {
        return fail(new DomainError('design_prototype_forbidden', '只有当前项目成员可以查看原型'));
      }
      const query = cmd.query?.trim();
      const status = cmd.status ? normalizeStatus(cmd.status, 'draft') : undefined;
      const conditions = [
        eq(schema.designPrototypes.project_id, project.id),
        status ? eq(schema.designPrototypes.status, status) : undefined,
        query ? or(
          ilike(schema.designPrototypes.title, `%${query}%`),
          ilike(schema.designPrototypes.summary, `%${query}%`),
        ) : undefined,
      ].filter((condition) => condition !== undefined);
      const rows = await db.select().from(schema.designPrototypes)
        .where(and(...conditions))
        .orderBy(desc(schema.designPrototypes.updated_at));
      return { ok: true, data: await Promise.all(rows.map((row) => toSummary(row))) };
    } catch (error) {
      return fail(error);
    }
  }

  async function getPrototype(prototypeCode: string, principalCode: string): Promise<TaskResult<DesignPrototypeDetail>> {
    try {
      const [prototype, principal] = await Promise.all([
        findDesignPrototypeByCode(db, prototypeCode),
        findUserByCode(db, principalCode),
      ]);
      if (!prototype) return fail(new DomainError('design_prototype_not_found', `设计原型不存在：${prototypeCode}`));
      if (!principal || principal.status !== 'active') return fail(new DomainError('user_not_found', `用户不存在：${principalCode}`));
      const member = await projectMember(db, prototype.project_id, principal.id);
      if (!member) return fail(new DomainError('design_prototype_forbidden', '只有当前项目成员可以查看原型'));
      const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, prototype.project_id)).limit(1);
      const revisions = await db.select(designPrototypeRevisionColumns).from(schema.designPrototypeRevisions)
        .where(eq(schema.designPrototypeRevisions.prototype_id, prototype.id))
        .orderBy(desc(schema.designPrototypeRevisions.revision));
      const current = revisions.find((revision) => revision.revision === prototype.current_revision);
      if (!current) return fail(new DomainError('design_prototype_revision_missing', '原型当前版本不存在'));
      const creators = revisions.length === 0
        ? []
        : await db.select().from(schema.users).where(inArray(schema.users.id, [...new Set(revisions.map((revision) => revision.created_by))]));
      const creatorById = new Map(creators.map((creator) => [creator.id, creator]));
      return {
        ok: true,
        data: {
          ...await toSummary(prototype),
          ...designPrototypeContentMetadata(prototype.code, current),
          html_content: current.html_content,
          notes_markdown: current.notes_markdown,
          change_summary: current.change_summary,
          revisions: revisions.map((revision) => ({
            ...designPrototypeContentMetadata(prototype.code, revision),
            revision_code: revision.code,
            revision: revision.revision,
            change_summary: revision.change_summary,
            has_notes: Boolean(revision.notes_markdown.trim()),
            created_by_user_code: creatorById.get(revision.created_by)?.code ?? '',
            created_at: revision.created_at,
          })),
          can_edit: project?.status === 'active' && prototype.status !== 'archived' && (member.role !== 'viewer' && (isProjectManager(member.role) || prototype.owner_principal_id === principal.id)),
        },
      };
    } catch (error) {
      return fail(error);
    }
  }

  async function revisePrototype(cmd: {
    prototypeCode: string;
    title: string;
    summary: string;
    notesMarkdown?: string;
    requirementCodes?: string[];
    status?: DesignPrototypeStatus;
    changeSummary: string;
    principalCode: string;
  } & DesignPrototypeContentInput): Promise<TaskResult<DesignPrototypeDetail>> {
    try {
      const [prototype, principal] = await Promise.all([
        findDesignPrototypeByCode(db, cmd.prototypeCode),
        findUserByCode(db, cmd.principalCode),
      ]);
      if (!prototype) return fail(new DomainError('design_prototype_not_found', `设计原型不存在：${cmd.prototypeCode}`));
      if (!principal || principal.status !== 'active') return fail(new DomainError('user_not_found', `用户不存在：${cmd.principalCode}`));
      const member = await projectMember(db, prototype.project_id, principal.id);
      await assertProjectAccess(db, prototype.project_id, principal.id, 'write');
      if (!member || (!isProjectManager(member.role) && prototype.owner_principal_id !== principal.id)) {
        return fail(new DomainError('design_prototype_forbidden', '只有原型负责人或项目 Owner 可以修订'));
      }
      if (prototype.status === 'archived') return fail(new DomainError('design_prototype_archived', '已归档原型不能继续修订'));
      const title = cmd.title.trim();
      const summary = cmd.summary.trim();
      const changeSummary = cmd.changeSummary.trim();
      if (!title) return fail(new DomainError('design_prototype_title_required', '原型标题不能为空'));
      if (!changeSummary) return fail(new DomainError('design_prototype_change_summary_required', '修订时必须说明本次变更'));
      const [currentRevision] = await db.select().from(schema.designPrototypeRevisions).where(and(
        eq(schema.designPrototypeRevisions.prototype_id, prototype.id),
        eq(schema.designPrototypeRevisions.revision, prototype.current_revision),
      )).limit(1);
      if (!currentRevision) return fail(new DomainError('design_prototype_revision_missing', '原型当前版本不存在'));
      const content = normalizeDesignPrototypeContent(cmd, currentRevision);
      const notesMarkdown = cmd.notesMarkdown === undefined
        ? currentRevision.notes_markdown
        : normalizeNotes(cmd.notesMarkdown);
      const status = normalizeStatus(cmd.status, prototype.status);
      const requirements = await resolveRequirements(db, prototype.project_id, cmd.requirementCodes ?? []);
      const changedAt = now();
      const nextRevision = prototype.current_revision + 1;

      await db.transaction(async (tx) => {
        await assertProjectAccess(tx, prototype.project_id, principal.id, 'write');
        await tx.insert(schema.designPrototypeRevisions).values({
          code: createPublicCode(),
          prototype_id: prototype.id,
          revision: nextRevision,
          ...content,
          notes_markdown: notesMarkdown,
          change_summary: changeSummary,
          created_by: principal.id,
          created_at: changedAt,
        });
        await tx.delete(schema.designPrototypeRequirements).where(eq(schema.designPrototypeRequirements.prototype_id, prototype.id));
        if (requirements.length > 0) {
          await tx.insert(schema.designPrototypeRequirements).values(requirements.map((requirement) => ({
            prototype_id: prototype.id,
            requirement_id: requirement.id,
          })));
        }
        await tx.update(schema.designPrototypes).set({
          title,
          summary,
          status,
          current_revision: nextRevision,
          updated_at: changedAt,
        }).where(eq(schema.designPrototypes.id, prototype.id));
        const audit = {
          entity_type: 'design_prototype',
          entity_id: prototype.id,
          principal_id: principal.id,
          base_snapshot: prototype.current_revision,
          from: prototype.status,
          to: status,
          action: 'design_prototype.revised',
          payload: { revision: nextRevision, change_summary: changeSummary, requirement_codes: requirements.map((item) => item.code) },
        };
        assertAuditedChange(audit);
        await insertAudit(tx, toAuditEvent(audit, createPublicCode(), changedAt));
      });
      return await getPrototype(prototype.code, principal.code);
    } catch (error) {
      return fail(error);
    }
  }

  async function getPrototypeFile(prototypeCode: string, principalCode: string, revision?: number): Promise<TaskResult<{
    file_name: string;
    bytes: Buffer;
  }>> {
    try {
      const [prototype, principal] = await Promise.all([
        findDesignPrototypeByCode(db, prototypeCode), findUserByCode(db, principalCode),
      ]);
      if (!prototype) return fail(new DomainError('design_prototype_not_found', `设计原型不存在：${prototypeCode}`));
      if (!principal || principal.status !== 'active') return fail(new DomainError('user_not_found', `用户不存在：${principalCode}`));
      if (!await projectMember(db, prototype.project_id, principal.id)) return fail(new DomainError('design_prototype_forbidden', '只有当前项目成员可以下载原型文件'));
      const version = revision ?? prototype.current_revision;
      if (!Number.isSafeInteger(version) || version < 1) return fail(new DomainError('design_prototype_revision_invalid', '原型修订号必须是正整数'));
      const [file] = await db.select({
        content_kind: schema.designPrototypeRevisions.content_kind,
        file_name: schema.designPrototypeRevisions.file_name,
        file_content_base64: schema.designPrototypeRevisions.file_content_base64,
      }).from(schema.designPrototypeRevisions).where(and(
        eq(schema.designPrototypeRevisions.prototype_id, prototype.id), eq(schema.designPrototypeRevisions.revision, version),
      )).limit(1);
      if (!file || file.content_kind !== 'file' || !file.file_name || file.file_content_base64 === null) {
        return fail(new DomainError('design_prototype_file_not_found', '指定版本没有可下载的原型文件'));
      }
      return { ok: true, data: { file_name: file.file_name, bytes: Buffer.from(file.file_content_base64, 'base64') } };
    } catch (error) {
      return fail(error);
    }
  }

  return { createPrototype, listPrototypes, getPrototype, revisePrototype, getPrototypeFile };
}

export type DesignPrototypeUseCases = ReturnType<typeof createDesignPrototypeUseCases>;
