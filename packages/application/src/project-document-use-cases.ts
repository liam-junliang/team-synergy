import { assertProjectAccess, effectiveProjectMember, isProjectManager } from './project-access.js';
import { and, asc, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import type { Db } from '@team-synergy/persistence';
import { schema } from '@team-synergy/persistence';
import { DomainError, assertAuditedChange, toAuditEvent } from '@team-synergy/domain';
import { fail, insertAudit, now, type TaskResult } from './task-service.js';
import { ensureProjectSystemFolders, PROJECT_SYSTEM_FOLDER_NAMES } from './project-document-folders.js';
import { createRequirementDocumentUseCases, type RequirementDocumentSummary } from './requirement-document-use-cases.js';
import { createArchitectureDocumentUseCases, type ArchitectureDocumentSummary } from './architecture-document-use-cases.js';
import { createTestingUseCases } from './testing-use-cases.js';
import type { TestAssetSummary } from '@team-synergy/contracts';
import { projectDocumentKindView, type ProjectDocumentInputKind } from './project-document-kinds.js';
export { PROJECT_DOCUMENT_KINDS, PROJECT_DOCUMENT_INPUT_KINDS, LEGACY_PROJECT_DOCUMENT_KINDS, projectDocumentKindView } from './project-document-kinds.js';
export type { ProjectDocumentKind, ProjectDocumentInputKind } from './project-document-kinds.js';
import {
  createPublicCode,
  findProjectByCode,
  findProjectDocumentByCode,
  findProjectDocumentFolderByCode,
  findUserByCode,
} from './public-code.js';

export type ProjectDocumentStatus = 'active' | 'archived';

type FolderRow = typeof schema.projectDocumentFolders.$inferSelect;
type DocumentRow = typeof schema.projectDocuments.$inferSelect;
type MemberRow = typeof schema.members.$inferSelect;

function summaryOf(content: string, title: string): string {
  const paragraph = content
    .split(/\n\s*\n/)
    .map((part) => part.replace(/^#{1,6}\s+.+$/gm, '').replace(/^[-*]\s+/gm, '').trim())
    .find(Boolean);
  return paragraph?.slice(0, 240) || title;
}

function outlineOf(content: string) {
  return content.split(/\r?\n/).flatMap((line) => {
    const match = /^(#{1,4})\s+(.+)$/.exec(line.trim());
    if (!match) return [];
    const title = match[2]!.replace(/[*_`]/g, '').trim();
    return [{
      level: match[1]!.length,
      title,
      anchor: title.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, ''),
    }];
  });
}

async function memberInProject(db: Db, projectId: bigint, principalId: bigint): Promise<MemberRow | undefined> {
  const member = await effectiveProjectMember(db, projectId, principalId);
  return member;
}

function canManage(createdBy: bigint | null, member: MemberRow, principalId: bigint): boolean {
  return member.role !== 'viewer' && (isProjectManager(member.role) || createdBy === principalId);
}

export function createProjectDocumentUseCases(db: Db) {
  const requirementDocuments = createRequirementDocumentUseCases(db);
  const architectureDocuments = createArchitectureDocumentUseCases(db);
  const testing = createTestingUseCases(db);

  function assertWritableFolder(folder: FolderRow | undefined) {
    if (folder?.system_role === 'requirements' || folder?.system_role === 'architecture' || folder?.system_role === 'testing') {
      throw new DomainError('project_document_folder_read_only', `“${folder.name}”目录自动关联原始资料，请在对应业务页面创建和编辑，不能放入其他文档或子目录`);
    }
  }

  async function assertWritableProject(projectId: bigint, principalId: bigint) {
    await assertProjectAccess(db, projectId, principalId, 'write');
    const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1);
    if (project?.status === 'archived') throw new DomainError('project_archived', '已归档项目不能修改文档库');
  }

  async function systemAncestor(folder: FolderRow | undefined): Promise<FolderRow | undefined> {
    const visited = new Set<bigint>();
    let cursor = folder;
    while (cursor && !visited.has(cursor.id)) {
      visited.add(cursor.id);
      if (cursor.system_role) return cursor;
      cursor = cursor.parent_id ? await db.select().from(schema.projectDocumentFolders).where(and(
        eq(schema.projectDocumentFolders.id, cursor.parent_id), eq(schema.projectDocumentFolders.project_id, cursor.project_id),
      )).limit(1).then(rows => rows[0]) : undefined;
    }
    return undefined;
  }

  async function assertFolderParent(parent: FolderRow | undefined) {
    const system = await systemAncestor(parent);
    if (system) throw new DomainError('project_document_folder_read_only', `“${system.name}”是固定资料集合，不能新建或移入子文件夹；已有子目录和内容保持可读`);
  }

  async function projectAccess(projectCode: string, principalCode: string) {
    const [project, principal] = await Promise.all([
      findProjectByCode(db, projectCode),
      findUserByCode(db, principalCode),
    ]);
    if (!project) throw new DomainError('project_not_found', `项目不存在：${projectCode}`);
    if (!principal || principal.status !== 'active') throw new DomainError('user_not_found', `用户不存在：${principalCode}`);
    const member = await memberInProject(db, project.id, principal.id);
    if (!member) throw new DomainError('project_document_forbidden', '当前用户不是项目成员');
    return { project, principal, member };
  }

  async function folderInProject(projectId: bigint, folderCode: string | null | undefined): Promise<FolderRow | undefined> {
    if (!folderCode) return undefined;
    const folder = await findProjectDocumentFolderByCode(db, folderCode);
    if (!folder || folder.project_id !== projectId) throw new DomainError('project_document_folder_not_found', `交接文件夹不存在：${folderCode}`);
    if (folder.status !== 'active') throw new DomainError('project_document_folder_archived', `交接文件夹已归档：${folderCode}`);
    return folder;
  }

  async function folderSummary(folder: FolderRow, parentCode: string | null, principalId: bigint, member: MemberRow) {
    return {
      folder_code: folder.code,
      parent_folder_code: parentCode,
      name: folder.name,
      sort_order: folder.sort_order,
      status: folder.status,
      system_role: folder.system_role,
      can_edit: folder.system_role === null && canManage(folder.created_by, member, principalId),
      can_create_folder: member.role !== 'viewer' && !(await systemAncestor(folder)),
      created_at: folder.created_at,
      updated_at: folder.updated_at,
    };
  }

  async function documentSummary(document: DocumentRow, folder: FolderRow | undefined, updatedByCode: string | null, principalId: bigint, member: MemberRow) {
    return {
      document_code: document.code,
      source_kind: 'project' as const,
      folder_code: folder?.code ?? null,
      folder_name: folder?.name ?? null,
      ...projectDocumentKindView(document.kind),
      title: document.title,
      summary: document.summary ?? summaryOf(document.content, document.title),
      current_revision: document.revision,
      status: document.status,
      updated_by_user_code: updatedByCode,
      updated_at: document.updated_at,
      can_edit: canManage(document.created_by, member, principalId),
    };
  }

  function requirementSummary(document: RequirementDocumentSummary, folder: FolderRow, sourceCanEdit: boolean) {
    return {
      ...document,
      source_kind: 'requirement' as const,
      folder_code: folder.code,
      folder_name: folder.name,
      kind: 'doc' as const,
      status: document.state,
      updated_by_user_code: null,
      can_edit: false,
      source_can_edit: sourceCanEdit,
    };
  }

  function architectureSummary(document: ArchitectureDocumentSummary, folder: FolderRow) {
    return {
      document_code: document.document_code, project_code: document.project_code,
      title: document.title, summary: document.summary, current_revision: document.current_revision,
      content_kind: document.content_kind, owner_principal_code: document.owner_principal_code,
      updated_at: document.updated_at,
      source_kind: 'architecture' as const,
      folder_code: folder.code,
      folder_name: folder.name,
      kind: 'diagram' as const,
      status: 'active' as const,
      updated_by_user_code: null,
      source_can_edit: document.can_edit,
      can_edit: false,
    };
  }

  function testingSummary(asset: TestAssetSummary, folder: FolderRow) {
    return {
      document_code: asset.code, project_code: asset.project_code,
      title: asset.title, summary: asset.summary, current_revision: asset.current_revision,
      updated_at: asset.updated_at, owner_principal_code: asset.owner_user_code,
      source_kind: 'testing' as const, storage_kind: asset.storage_kind, purpose: asset.purpose,
      folder_code: folder.code, folder_name: folder.name, kind: 'doc' as const,
      status: 'active' as const, updated_by_user_code: null,
      source_can_edit: asset.can_edit, can_edit: false,
    };
  }

  async function listLibrary(cmd: { projectCode: string; principalCode: string; query?: string }): Promise<TaskResult<Record<string, unknown>>> {
    try {
      const { project, principal, member } = await projectAccess(cmd.projectCode, cmd.principalCode);
      const systemFolders = await db.transaction(tx => ensureProjectSystemFolders(tx, project.id));
      const pattern = cmd.query?.trim() ? `%${cmd.query.trim()}%` : undefined;
      const [folders, documents, requirementResult, architectureResult, testingResult] = await Promise.all([
        db.select().from(schema.projectDocumentFolders)
          .where(eq(schema.projectDocumentFolders.project_id, project.id))
          .orderBy(asc(schema.projectDocumentFolders.sort_order), asc(schema.projectDocumentFolders.id)),
        db.select().from(schema.projectDocuments)
          .where(and(
            eq(schema.projectDocuments.project_id, project.id),
            pattern ? or(
              ilike(schema.projectDocuments.title, pattern),
              ilike(schema.projectDocuments.summary, pattern),
              ilike(schema.projectDocuments.content, pattern),
            ) : undefined,
          ))
          .orderBy(asc(schema.projectDocuments.title)),
        requirementDocuments.listDocuments(cmd),
        architectureDocuments.listDocuments(cmd),
        testing.listAssets(cmd),
      ]);
      if (!requirementResult.ok) return requirementResult;
      if (!architectureResult.ok) return architectureResult;
      if (!testingResult.ok) return testingResult;
      const folderMap = new Map(folders.map((folder) => [folder.id, folder]));
      const userIds = [...new Set(documents.map((document) => document.updated_by))];
      const users = userIds.length ? await db.select().from(schema.users).where(inArray(schema.users.id, userIds)) : [];
      const userMap = new Map(users.map((user) => [user.id, user.code]));
      const projectSummaries = await Promise.all(documents.map((document) => documentSummary(
        document, document.folder_id ? folderMap.get(document.folder_id) : undefined,
        userMap.get(document.updated_by) ?? null, principal.id, member,
      )));
      const requirementSummaries = requirementResult.data.map(document => requirementSummary(
        document, systemFolders.requirements,
        project.status === 'active' && document.state === 'active' && (member.role !== 'viewer' && (isProjectManager(member.role) || document.owner_principal_code === principal.code)),
      ));
      const architectureSummaries = architectureResult.data.map(document => architectureSummary(document, systemFolders.architecture));
      const testingSummaries = testingResult.data.map(asset => testingSummary(asset, systemFolders.testing));
      const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
      return {
        ok: true,
        data: {
          project_code: project.code,
          can_create: project.status === 'active' && member.role !== 'viewer',
          folders: await Promise.all(folders.map(async (folder) => ({ ...await folderSummary(
            folder,
            folder.parent_id ? folderMap.get(folder.parent_id)?.code ?? null : null,
            principal.id,
            member,
          ), ...(project.status === 'archived' ? { can_edit: false, can_create_folder: false } : {}) }))),
          documents: [...projectSummaries.map(document => ({ ...document, can_edit: project.status === 'active' && document.can_edit })), ...requirementSummaries, ...architectureSummaries, ...testingSummaries].sort((left, right) =>
            compare(left.title, right.title) || compare(left.document_code, right.document_code)),
        },
      };
    } catch (error) {
      return fail(error);
    }
  }

  async function createFolder(cmd: { projectCode: string; principalCode: string; name: string; parentFolderCode?: string | null }): Promise<TaskResult<Record<string, unknown>>> {
    try {
      const { project, principal, member } = await projectAccess(cmd.projectCode, cmd.principalCode);
      await assertWritableProject(project.id, principal.id);
      await db.transaction(tx => ensureProjectSystemFolders(tx, project.id));
      const parent = await folderInProject(project.id, cmd.parentFolderCode);
      await assertFolderParent(parent);
      const name = cmd.name.trim();
      if (!name) return fail(new DomainError('project_document_folder_name_required', '交接文件夹名称不能为空'));
      const siblings = await db.select().from(schema.projectDocumentFolders).where(and(
        eq(schema.projectDocumentFolders.project_id, project.id),
        parent ? eq(schema.projectDocumentFolders.parent_id, parent.id) : sql`${schema.projectDocumentFolders.parent_id} is null`,
        eq(schema.projectDocumentFolders.status, 'active'),
      ));
      if (siblings.some((folder) => folder.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
        return fail(new DomainError('project_document_folder_duplicate', `同级文件夹已存在：${name}`));
      }
      const createdAt = now();
      const sortOrder = siblings.reduce((maximum, folder) => Math.max(maximum, folder.sort_order), -1) + 1;
      const [folder] = await db.insert(schema.projectDocumentFolders).values({
        code: createPublicCode(),
        project_id: project.id,
        parent_id: parent?.id ?? null,
        name,
        sort_order: sortOrder,
        status: 'active',
        created_by: principal.id,
        created_at: createdAt,
        updated_at: createdAt,
      }).returning();
      if (!folder) throw new DomainError('internal_error', '交接文件夹创建失败');
      return { ok: true, data: await folderSummary(folder, parent?.code ?? null, principal.id, member) };
    } catch (error) {
      return fail(error);
    }
  }

  async function updateFolder(cmd: {
    folderCode: string;
    principalCode: string;
    name?: string;
    parentFolderCode?: string | null;
    status?: ProjectDocumentStatus;
  }): Promise<TaskResult<Record<string, unknown>>> {
    try {
      const [folder, principal] = await Promise.all([
        findProjectDocumentFolderByCode(db, cmd.folderCode),
        findUserByCode(db, cmd.principalCode),
      ]);
      if (!folder) return fail(new DomainError('project_document_folder_not_found', `交接文件夹不存在：${cmd.folderCode}`));
      if (!principal || principal.status !== 'active') return fail(new DomainError('user_not_found', `用户不存在：${cmd.principalCode}`));
      const member = await memberInProject(db, folder.project_id, principal.id);
      if (member && folder.system_role !== null) return fail(new DomainError('project_document_folder_system', `“${folder.name}”是固定目录，不能重命名、移动或归档`));
      if (!member || !canManage(folder.created_by, member, principal.id)) return fail(new DomainError('project_document_folder_forbidden', '只有文件夹创建者或项目 Owner 可以修改文件夹'));
      await assertWritableProject(folder.project_id, principal.id);
      const parent = cmd.parentFolderCode === undefined
        ? (folder.parent_id ? await db.select().from(schema.projectDocumentFolders).where(eq(schema.projectDocumentFolders.id, folder.parent_id)).limit(1).then((rows) => rows[0]) : undefined)
        : await folderInProject(folder.project_id, cmd.parentFolderCode);
      // Existing descendants remain manageable, but no operation can add nesting to a system tree.
      if (cmd.parentFolderCode !== undefined && (parent?.id ?? null) !== folder.parent_id) await assertFolderParent(parent);
      if (parent?.id === folder.id) return fail(new DomainError('project_document_folder_cycle', '文件夹不能成为自己的子目录'));
      let cursor = parent;
      while (cursor?.parent_id) {
        if (cursor.parent_id === folder.id) return fail(new DomainError('project_document_folder_cycle', '文件夹移动会形成循环目录'));
        cursor = await db.select().from(schema.projectDocumentFolders).where(eq(schema.projectDocumentFolders.id, cursor.parent_id)).limit(1).then((rows) => rows[0]);
      }
      const name = cmd.name === undefined ? folder.name : cmd.name.trim();
      if (!name) return fail(new DomainError('project_document_folder_name_required', '交接文件夹名称不能为空'));
      if (!parent && Object.values(PROJECT_SYSTEM_FOLDER_NAMES).some(reserved => reserved === name)) return fail(new DomainError('project_document_folder_duplicate', `根目录名称“${name}”保留给固定目录`));
      const updatedAt = now();
      const [updated] = await db.update(schema.projectDocumentFolders).set({
        name,
        parent_id: parent?.id ?? null,
        status: cmd.status ?? folder.status,
        updated_at: updatedAt,
      }).where(eq(schema.projectDocumentFolders.id, folder.id)).returning();
      if (!updated) throw new DomainError('internal_error', '交接文件夹更新失败');
      return { ok: true, data: await folderSummary(updated, parent?.code ?? null, principal.id, member) };
    } catch (error) {
      return fail(error);
    }
  }

  async function createDocument(cmd: {
    projectCode: string;
    principalCode: string;
    folderCode?: string | null;
    kind: ProjectDocumentInputKind;
    title: string;
    summary?: string;
    content: string;
  }): Promise<TaskResult<Record<string, unknown>>> {
    try {
      const { project, principal, member } = await projectAccess(cmd.projectCode, cmd.principalCode);
      await assertWritableProject(project.id, principal.id);
      const folder = await folderInProject(project.id, cmd.folderCode);
      assertWritableFolder(await systemAncestor(folder));
      const title = cmd.title.trim();
      const content = cmd.content.replace(/\r\n/g, '\n').trim();
      if (!title) return fail(new DomainError('project_document_title_required', '交接文档标题不能为空'));
      if (!content) return fail(new DomainError('project_document_content_required', '交接文档正文不能为空'));
      const summary = cmd.summary?.trim() || summaryOf(content, title);
      const createdAt = now();
      const created = await db.transaction(async (tx) => {
        await assertProjectAccess(tx, project.id, principal.id, 'write');
        const [document] = await tx.insert(schema.projectDocuments).values({
          code: createPublicCode(),
          project_id: project.id,
          folder_id: folder?.id ?? null,
          kind: cmd.kind,
          title,
          summary,
          content,
          revision: 1,
          status: 'active',
          created_by: principal.id,
          created_at: createdAt,
          updated_by: principal.id,
          updated_at: createdAt,
        }).returning();
        if (!document) throw new DomainError('internal_error', '交接文档创建失败');
        await tx.insert(schema.projectDocumentRevisions).values({
          code: createPublicCode(),
          document_id: document.id,
          revision: 1,
          title,
          summary,
          content,
          change_summary: '创建交接文档',
          created_by: principal.id,
          created_at: createdAt,
        });
        const audit = {
          entity_type: 'project_document', entity_id: document.id, principal_id: principal.id,
          base_snapshot: 0, to: 'active', action: 'project_document.created',
          payload: { project_code: project.code, document_code: document.code, folder_code: folder?.code ?? null, kind: cmd.kind, revision: 1 },
        };
        assertAuditedChange(audit);
        await insertAudit(tx, toAuditEvent(audit, createPublicCode(), createdAt));
        return document;
      });
      const updatedByCode = principal.code;
      return { ok: true, data: await documentSummary(created, folder, updatedByCode, principal.id, member) };
    } catch (error) {
      return fail(error);
    }
  }

  async function getDocument(documentCode: string, principalCode: string): Promise<TaskResult<Record<string, unknown>>> {
    try {
      const [document, principal] = await Promise.all([
        findProjectDocumentByCode(db, documentCode),
        findUserByCode(db, principalCode),
      ]);
      if (!document) {
        const source = await requirementDocuments.getDocument(documentCode, principalCode);
        if (!source.ok) {
          if (source.error.code !== 'requirement_document_not_found') return source;
          const architecture = await architectureDocuments.getDocument(documentCode, principalCode);
          if (!architecture.ok) {
            if (architecture.error.code !== 'architecture_document_not_found') return architecture;
            const asset = await testing.getAsset(documentCode, principalCode);
            if (!asset.ok) return asset.error.code === 'test_asset_not_found'
              ? fail(new DomainError('project_document_not_found', `交接文档不存在：${documentCode}`)) : asset;
            const project = await findProjectByCode(db, asset.data.project_code);
            if (!project) return fail(new DomainError('project_not_found', `项目不存在：${asset.data.project_code}`));
            const folders = await db.transaction(tx => ensureProjectSystemFolders(tx, project.id));
            return { ok: true, data: {
              ...testingSummary(asset.data, folders.testing),
              content: asset.data.content, outline: outlineOf(asset.data.content), testing_asset: asset.data,
              revisions: asset.data.revisions.map(revision => ({
                revision_code: revision.revision_code, revision: revision.revision, title: revision.title,
                summary: revision.summary, content: revision.content, change_summary: revision.change_summary,
                created_by_user_code: revision.created_by_user_code, created_at: revision.created_at,
              })),
              updated_by_user_code: asset.data.revisions.find(revision => revision.revision === asset.data.current_revision)?.created_by_user_code ?? null,
            } };
          }
          const project = await findProjectByCode(db, architecture.data.project_code);
          if (!project) return fail(new DomainError('project_not_found', `项目不存在：${architecture.data.project_code}`));
          const folders = await db.transaction(tx => ensureProjectSystemFolders(tx, project.id));
          return { ok: true, data: {
            ...architectureSummary(architecture.data, folders.architecture),
            content: architecture.data.notes_markdown,
            outline: outlineOf(architecture.data.notes_markdown),
            architecture_document: architecture.data,
            revisions: architecture.data.revisions.map(revision => ({
              revision_code: revision.revision_code, revision: revision.revision, title: revision.title,
              summary: revision.summary, content: revision.notes_markdown, change_summary: revision.change_summary,
              created_by_user_code: revision.created_by_user_code, created_at: revision.created_at,
            })),
            updated_by_user_code: architecture.data.revisions.find(revision => revision.revision === architecture.data.current_revision)?.created_by_user_code ?? null,
          } };
        }
        const project = await findProjectByCode(db, source.data.project_code);
        if (!project) return fail(new DomainError('project_not_found', `项目不存在：${source.data.project_code}`));
        const folders = await db.transaction(tx => ensureProjectSystemFolders(tx, project.id));
        return { ok: true, data: {
          ...requirementSummary(source.data, folders.requirements, project.status === 'active' && source.data.can_edit),
          content: source.data.content,
          outline: source.data.outline,
          linked_requirements: source.data.linked_requirements,
          // Requirement revisions have no historical title; display the current title without changing the source history.
          revisions: source.data.revisions.map(revision => ({ ...revision, title: source.data.title })),
          updated_by_user_code: source.data.revisions.find(revision => revision.revision === source.data.current_revision)?.created_by_user_code ?? null,
        } };
      }
      if (!principal || principal.status !== 'active') return fail(new DomainError('user_not_found', `用户不存在：${principalCode}`));
      const member = await memberInProject(db, document.project_id, principal.id);
      if (!member) return fail(new DomainError('project_document_forbidden', '当前用户不是项目成员'));
      const [project, folder, revisions] = await Promise.all([
        db.select().from(schema.projects).where(eq(schema.projects.id, document.project_id)).limit(1).then((rows) => rows[0]),
        document.folder_id ? db.select().from(schema.projectDocumentFolders).where(eq(schema.projectDocumentFolders.id, document.folder_id)).limit(1).then((rows) => rows[0]) : Promise.resolve(undefined),
        db.select().from(schema.projectDocumentRevisions).where(eq(schema.projectDocumentRevisions.document_id, document.id)).orderBy(desc(schema.projectDocumentRevisions.revision)),
      ]);
      const users = revisions.length ? await db.select().from(schema.users).where(inArray(schema.users.id, [...new Set(revisions.map((revision) => revision.created_by))])) : [];
      const userMap = new Map(users.map((user) => [user.id, user.code]));
      return {
        ok: true,
        data: {
          document_code: document.code,
          source_kind: 'project',
          project_code: project?.code ?? '',
          folder_code: folder?.code ?? null,
          folder_name: folder?.name ?? null,
          ...projectDocumentKindView(document.kind),
          title: document.title,
          summary: document.summary ?? summaryOf(document.content, document.title),
          content: document.content,
          current_revision: document.revision,
          status: document.status,
          outline: outlineOf(document.content),
          revisions: revisions.map((revision) => ({
            revision_code: revision.code,
            revision: revision.revision,
            title: revision.title,
            summary: revision.summary,
            content: revision.content,
            change_summary: revision.change_summary,
            created_by_user_code: userMap.get(revision.created_by) ?? '',
            created_at: revision.created_at,
          })),
          updated_by_user_code: userMap.get(document.updated_by) ?? null,
          updated_at: document.updated_at,
          can_edit: project?.status === 'active' && canManage(document.created_by, member, principal.id),
        },
      };
    } catch (error) {
      return fail(error);
    }
  }

  async function reviseDocument(cmd: {
    documentCode: string;
    principalCode: string;
    folderCode?: string | null;
    kind?: ProjectDocumentInputKind;
    title: string;
    summary?: string;
    content: string;
    changeSummary: string;
    status?: ProjectDocumentStatus;
  }): Promise<TaskResult<Record<string, unknown>>> {
    try {
      const [document, principal] = await Promise.all([
        findProjectDocumentByCode(db, cmd.documentCode),
        findUserByCode(db, cmd.principalCode),
      ]);
      if (!document) {
        const source = await getDocument(cmd.documentCode, cmd.principalCode);
        if (!source.ok) return source;
        return fail(new DomainError('project_document_source_read_only', '这是业务资料的关联视图，请通过原始文档的编辑入口修订'));
      }
      if (!principal || principal.status !== 'active') return fail(new DomainError('user_not_found', `用户不存在：${cmd.principalCode}`));
      const member = await memberInProject(db, document.project_id, principal.id);
      if (!member || !canManage(document.created_by, member, principal.id)) return fail(new DomainError('project_document_forbidden', '只有文档创建者或项目 Owner 可以修订交接文档'));
      await assertWritableProject(document.project_id, principal.id);
      const folder = cmd.folderCode === undefined
        ? (document.folder_id ? await db.select().from(schema.projectDocumentFolders).where(eq(schema.projectDocumentFolders.id, document.folder_id)).limit(1).then((rows) => rows[0]) : undefined)
        : await folderInProject(document.project_id, cmd.folderCode);
      assertWritableFolder(await systemAncestor(folder));
      const title = cmd.title.trim();
      const content = cmd.content.replace(/\r\n/g, '\n').trim();
      const changeSummary = cmd.changeSummary.trim();
      if (!title) return fail(new DomainError('project_document_title_required', '交接文档标题不能为空'));
      if (!content) return fail(new DomainError('project_document_content_required', '交接文档正文不能为空'));
      if (!changeSummary) return fail(new DomainError('project_document_change_summary_required', '修订说明不能为空'));
      const summary = cmd.summary?.trim() || summaryOf(content, title);
      const revision = document.revision + 1;
      const updatedAt = now();
      await db.transaction(async (tx) => {
        const access = await assertProjectAccess(tx, document.project_id, principal.id, 'write');
        if (!isProjectManager(access.role) && document.created_by !== principal.id) {
          throw new DomainError('project_document_forbidden', '只有文档创建者或项目管理者可以修订文档');
        }
        await tx.update(schema.projectDocuments).set({
          folder_id: folder?.id ?? null,
          kind: cmd.kind ?? document.kind,
          title,
          summary,
          content,
          revision,
          status: cmd.status ?? document.status,
          updated_by: principal.id,
          updated_at: updatedAt,
        }).where(eq(schema.projectDocuments.id, document.id));
        await tx.insert(schema.projectDocumentRevisions).values({
          code: createPublicCode(), document_id: document.id, revision, title, summary, content,
          change_summary: changeSummary, created_by: principal.id, created_at: updatedAt,
        });
        const audit = {
          entity_type: 'project_document', entity_id: document.id, principal_id: principal.id,
          base_snapshot: document.revision, action: 'project_document.revised',
          payload: { document_code: document.code, folder_code: folder?.code ?? null, kind: cmd.kind ?? document.kind, revision, change_summary: changeSummary },
        };
        assertAuditedChange(audit);
        await insertAudit(tx, toAuditEvent(audit, createPublicCode(), updatedAt));
      });
      return await getDocument(document.code, principal.code);
    } catch (error) {
      return fail(error);
    }
  }

  return { listLibrary, createFolder, updateFolder, createDocument, getDocument, reviseDocument };
}

export type ProjectDocumentUseCases = ReturnType<typeof createProjectDocumentUseCases>;
