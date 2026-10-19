import { assertProjectAccess, effectiveProjectMember, isProjectManager } from './project-access.js';
import { and, eq, sql } from 'drizzle-orm';
import { schema, type Db } from '@team-synergy/persistence';
import { DomainError, assertAuditedChange, toAuditEvent } from '@team-synergy/domain';
import { createPublicCode } from './public-code.js';
import { fail, insertAudit, now, type TaskResult } from './task-service.js';
import { collectProjectStandardsDocuments, ensureProjectStandardsFolder } from './project-standards.js';

const HOME_FIELDS = {
  overview: 'overview_document_id',
  guide: 'guide_document_id',
} as const;
export type ProjectHomeRole = keyof typeof HOME_FIELDS;
export type ProjectHomeBindings = Partial<Record<`${ProjectHomeRole}_document_code`, string | null>>;
export interface ProjectHomeDocument {
  document_code: string;
  title: string;
  summary: string;
  content: string;
  revision: number;
  updated_at: string;
  can_edit: boolean;
}
export interface ProjectHome {
  project_code: string;
  can_edit: boolean;
  overview: ProjectHomeDocument | null;
  guide: ProjectHomeDocument | null;
  standards: ProjectHomeDocument[];
  standards_folder_code: string;
}
type Project = typeof schema.projects.$inferSelect;
type User = typeof schema.users.$inferSelect;
type Member = typeof schema.members.$inferSelect;
type Reader = Pick<Db, 'select'>;

function bindingsOf(value: ProjectHomeBindings): ProjectHomeBindings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DomainError('project_home_invalid', '首页关联必须是对象');
  if (Object.hasOwn(value, 'standards_document_code')) throw new DomainError('project_home_standards_managed', '项目规范由固定的“项目规范”目录汇总，请在文档库中管理该目录内的文档');
  const entries = Object.entries(value);
  const allowed = Object.keys(HOME_FIELDS).map(role => `${role}_document_code`);
  if (!entries.length || entries.some(([key, code]) => !allowed.includes(key)
    || (code !== null && (typeof code !== 'string' || !/^[0-9A-HJKMNP-TV-Z]{20}$/.test(code))))) {
    throw new DomainError('project_home_invalid', '请至少提供一个有效的首页文档编码，或使用 null 解除关联');
  }
  return value;
}

async function homeView(db: Reader, project: Project, principal: User, member: Member, standardsFolderCode: string): Promise<ProjectHome> {
  const [documents, folders] = await Promise.all([
    db.select().from(schema.projectDocuments).where(and(eq(schema.projectDocuments.project_id, project.id), eq(schema.projectDocuments.status, 'active'))),
    db.select().from(schema.projectDocumentFolders).where(eq(schema.projectDocumentFolders.project_id, project.id)),
  ]);
  const documentView = (document: typeof schema.projectDocuments.$inferSelect): ProjectHomeDocument => ({
    document_code: document.code, title: document.title, summary: document.summary ?? '', content: document.content,
    revision: document.revision, updated_at: document.updated_at, can_edit: project.status === 'active' && member.role !== 'viewer' && (isProjectManager(member.role) || document.created_by === principal.id),
  });
  const documentFor = (role: ProjectHomeRole): ProjectHomeDocument | null => {
    const document = documents.find(row => row.id === project[HOME_FIELDS[role]]);
    return document ? documentView(document) : null;
  };
  return { project_code: project.code, can_edit: isProjectManager(member.role) && project.status === 'active',
    overview: documentFor('overview'), guide: documentFor('guide'), standards_folder_code: standardsFolderCode,
    standards: collectProjectStandardsDocuments(project.id, folders, documents).map(documentView) };
}

export function createProjectHomeUseCases(db: Db) {
  async function getHome(projectCode: string, principalCode: string): Promise<TaskResult<ProjectHome>> {
    try {
      const [project] = await db.select().from(schema.projects).where(eq(schema.projects.code, projectCode)).limit(1);
      const [principal] = await db.select().from(schema.users).where(eq(schema.users.code, principalCode)).limit(1);
      if (!project || !principal || principal.status !== 'active') throw new DomainError('project_forbidden', '项目不存在或当前用户无权访问');
      const member = await effectiveProjectMember(db, project.id, principal.id);
      if (!member) throw new DomainError('project_forbidden', '项目不存在或当前用户无权访问');
      const data = await db.transaction(async tx => {
        const folder = await ensureProjectStandardsFolder(tx, project.id);
        return homeView(tx, project, principal, member, folder.code);
      });
      return { ok: true, data };
    } catch (error) { return fail(error); }
  }

  async function updateHome(cmd: { projectCode: string; principalCode: string; bindings: ProjectHomeBindings }): Promise<TaskResult<ProjectHome>> {
    try {
      const bindings = bindingsOf(cmd.bindings);
      const result = await db.transaction(async tx => {
        // Match material writers' lock ordering before taking project/document row locks.
        await tx.execute(sql`select pg_advisory_xact_lock(1094930512::bigint)`);
        const [principal] = await tx.select().from(schema.users).where(eq(schema.users.code, cmd.principalCode)).for('share').limit(1);
        const [project] = await tx.select().from(schema.projects).where(eq(schema.projects.code, cmd.projectCode)).for('update').limit(1);
        if (!project || !principal || principal.status !== 'active') throw new DomainError('project_forbidden', '项目不存在或当前用户无权访问');
        const member = await effectiveProjectMember(tx, project.id, principal.id);
        if (!member || !isProjectManager(member.role)) throw new DomainError('project_home_forbidden', '只有项目负责人或管理员可以配置首页文档');
        await assertProjectAccess(tx, project.id, principal.id, 'manage');
        if (project.status !== 'active') throw new DomainError('project_archived', '已归档项目不能修改首页');
        const changes: Partial<Pick<Project, typeof HOME_FIELDS[ProjectHomeRole]>> = {};
        for (const role of Object.keys(HOME_FIELDS) as ProjectHomeRole[]) {
          const code = bindings[`${role}_document_code`];
          if (code === undefined) continue;
          const field = HOME_FIELDS[role];
          if (code === null) { changes[field] = null; continue; }
          const [document] = await tx.select().from(schema.projectDocuments).where(and(
            eq(schema.projectDocuments.code, code), eq(schema.projectDocuments.project_id, project.id),
          )).for('share').limit(1);
          if (!document) throw new DomainError('project_home_document_invalid', '首页只能关联当前项目的文档');
          if (document.status !== 'active') throw new DomainError('project_home_document_archived', '已归档文档不能关联项目首页');
          changes[field] = document.id;
        }
        const [updated] = await tx.update(schema.projects).set(changes).where(eq(schema.projects.id, project.id)).returning();
        if (!updated) throw new DomainError('internal_error', '项目首页更新失败');
        const audit = { entity_type: 'project', entity_id: project.id, principal_id: principal.id, base_snapshot: project.current_snapshot,
          action: 'project.home_updated', payload: bindings };
        assertAuditedChange(audit);
        await insertAudit(tx, toAuditEvent(audit, createPublicCode(), now()));
        const folder = await ensureProjectStandardsFolder(tx, project.id);
        return await homeView(tx, updated, principal, member, folder.code);
      });
      return { ok: true, data: result };
    } catch (error) { return fail(error); }
  }
  return { getHome, updateHome };
}
