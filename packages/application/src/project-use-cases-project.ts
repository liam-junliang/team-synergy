import { and, asc, eq, inArray, max, or, sql } from 'drizzle-orm';
import type { Db } from '@team-synergy/persistence';
import { schema } from '@team-synergy/persistence';
import { DomainError, assertAuditedChange, toAuditEvent } from '@team-synergy/domain';
import type { ArtifactKind, MemberRole, ProjectMemberPolicy } from '@team-synergy/contracts';
import { fail, insertAudit, now } from './task-service.js';
import { createPublicCode, findProjectByCode, findTeamByCode, findUserByCode } from './public-code.js';
import { ensureProjectSystemFolders } from './project-document-folders.js';
import { assertProjectAccess, effectiveProjectMember, isProjectManager, projectCapabilities, resolveProjectAccess, resolveTeamRole } from './project-access.js';
import { createMemberUseCases } from './member-use-cases.js';

async function usersByIds(db: Db, ids: bigint[]) {
  if (ids.length === 0) return new Map<bigint, typeof schema.users.$inferSelect>();
  const rows = await db.select().from(schema.users).where(inArray(schema.users.id, ids));
  return new Map(rows.map((row) => [row.id, row]));
}

function normalizeRepositoryRemote(value: string): string {
  const remote = value.trim().replace(/\/+$/, '');
  if (!remote || /\s/.test(remote)) {
    throw new DomainError('repository_remote_invalid', '代码仓库地址不能为空或包含空白字符');
  }
  if (/^[^/@\s]+@[^/:\s]+:[^\s]+$/.test(remote)) return remote;
  let parsed: URL;
  try {
    parsed = new URL(remote);
  } catch {
    throw new DomainError('repository_remote_invalid', '代码仓库地址必须是 HTTPS、SSH、Git URL 或 SCP 风格地址');
  }
  if (!['https:', 'http:', 'ssh:', 'git:'].includes(parsed.protocol)) {
    throw new DomainError('repository_remote_invalid', '仅支持 HTTPS、SSH、Git URL 或 SCP 风格地址');
  }
  if (parsed.password || parsed.search || parsed.hash || ((parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.username)) {
    throw new DomainError('repository_remote_contains_credentials', '代码仓库地址不能包含账号、密码、Token、查询参数或片段');
  }
  return remote;
}

export function createProjectUseCasesProject(db: Db) {
  async function createProject(cmd: { teamCode: string; name: string; description?: string; principalCode: string; memberPolicy?: ProjectMemberPolicy }) {
    try {
      const [creator, team] = await Promise.all([
        findUserByCode(db, cmd.principalCode),
        findTeamByCode(db, cmd.teamCode),
      ]);
      if (!creator || creator.status !== 'active') {
        return fail(new DomainError('user_not_found', `用户不存在：${cmd.principalCode}`));
      }
      if (!team) return fail(new DomainError('team_not_found', `团队不存在：${cmd.teamCode}`));
      if (creator.pending_deletion) throw new DomainError('account_closing', '注销交接期间不能创建项目');
      const teamRole = await resolveTeamRole(db, team.id, creator.id);
      if (!isProjectManager(teamRole ?? undefined)) {
        return fail(new DomainError('project_create_forbidden', '只有团队 Owner 可以在该团队下创建项目', {
          team_code: team.code,
          principal_code: creator.code,
        }));
      }

      const name = cmd.name.trim();
      if (!name) return fail(new DomainError('project_name_required', '项目名称不能为空'));
      const description = cmd.description?.trim() || null;
      const [lastPosition] = await db.select({ value: max(schema.members.sort_order) })
        .from(schema.members)
        .where(eq(schema.members.principal_id, creator.id));
      const createdAt = now();
      const result = await db.transaction(async (tx) => {
        const [lockedCreator] = await tx.select().from(schema.users).where(eq(schema.users.id, creator.id)).for('update');
        await tx.select().from(schema.teams).where(eq(schema.teams.id, team.id)).for('update');
        if (!lockedCreator || lockedCreator.status !== 'active' || lockedCreator.pending_deletion || !isProjectManager((await resolveTeamRole(tx, team.id, creator.id)) ?? undefined)) throw new DomainError('project_create_forbidden', '当前用户不能创建项目');
        const [project] = await tx.insert(schema.projects).values({
          code: createPublicCode(),
          team_id: team.id,
          owner_principal_id: creator.id,
          created_by: creator.id,
          member_policy: cmd.memberPolicy ?? 'team_read',
          name,
          description,
          created_at: createdAt,
        }).returning({
          id: schema.projects.id,
          code: schema.projects.code,
          team_id: schema.projects.team_id,
          name: schema.projects.name,
          description: schema.projects.description,
          status: schema.projects.status,
          created_at: schema.projects.created_at,
        });
        if (!project) throw new DomainError('internal_error', '项目创建失败');
        await tx.insert(schema.members).values({
          principal_id: creator.id,
          project_id: project.id,
          role: 'admin',
          display_name: creator.display_name,
          sort_order: (lastPosition?.value ?? -1) + 1,
          created_at: createdAt,
        });
        await ensureProjectSystemFolders(tx, project.id);
        const audit = {
          entity_type: 'project',
          entity_id: project.id,
          principal_id: creator.id,
          base_snapshot: 0,
          action: 'project.created',
          payload: { name, description, team_code: team.code },
        };
        assertAuditedChange(audit);
        await insertAudit(tx, toAuditEvent(audit, createPublicCode(), createdAt));
        return {
          project_code: project.code,
          team_code: team.code,
          name: project.name,
          description: project.description,
          status: project.status,
          role: 'owner' as const,
          created_at: project.created_at,
        };
      });
      return { ok: true as const, data: result };
    } catch (error) {
      return fail(error);
    }
  }

  async function projectView(project: typeof schema.projects.$inferSelect, principal: typeof schema.users.$inferSelect) {
    const access = await resolveProjectAccess(db, project.id, principal.id);
    if (!access) return null;
    const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, project.team_id)).limit(1);
    const userMap = await usersByIds(db, [project.owner_principal_id, project.created_by].filter((id): id is bigint => id !== null));
    const roster = await createMemberUseCases(db).listMembers(project.code, principal.code);
    return {
      project_code: project.code, team_code: team?.code ?? '', team_name: team?.name ?? '',
      name: project.name, description: project.description, status: project.status,
      created_at: project.created_at, current_snapshot: project.current_snapshot,
      role: access.role, effective_role: access.role, access_source: access.source,
      is_external: access.isExternal, member_policy: project.member_policy,
      capabilities: { ...projectCapabilities(access.role), ...(project.status === 'archived' ? { write: false, manage: false, manage_policy: false } : {}) }, members_count: roster.length,
      owner_code: project.owner_principal_id ? userMap.get(project.owner_principal_id)?.code ?? null : null,
      created_by_code: project.created_by ? userMap.get(project.created_by)?.code ?? null : null,
      ownership_pending: project.owner_principal_id === null,
    };
  }

  async function listProjects(principalCode: string, teamCode?: string) {
    const principal = await findUserByCode(db, principalCode);
    if (!principal || principal.status !== 'active') return [];
    const team = teamCode ? await findTeamByCode(db, teamCode) : undefined;
    if (teamCode && !team) return [];
    const teamIds = (await db.select({ id: schema.teamMembers.team_id }).from(schema.teamMembers).where(eq(schema.teamMembers.principal_id, principal.id))).map(row => row.id);
    const explicitIds = (await db.select({ id: schema.members.project_id }).from(schema.members).where(eq(schema.members.principal_id, principal.id))).map(row => row.id);
    const rows = await db.select().from(schema.projects).where(and(
      team ? eq(schema.projects.team_id, team.id) : undefined,
      or(eq(schema.projects.owner_principal_id, principal.id), teamIds.length ? inArray(schema.projects.team_id, teamIds) : undefined, explicitIds.length ? inArray(schema.projects.id, explicitIds) : undefined),
    )).orderBy(asc(schema.projects.created_at), asc(schema.projects.code));
    const orders = new Map((await db.select().from(schema.projectOrders).where(eq(schema.projectOrders.principal_id, principal.id))).map(row => [row.project_id, row.sort_order]));
    rows.sort((a,b) => (orders.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (orders.get(b.id) ?? Number.MAX_SAFE_INTEGER));
    const views = await Promise.all(rows.map(row => projectView(row, principal)));
    return views.filter((row): row is NonNullable<typeof row> => row !== null);
  }

  async function reorderProjects(cmd: { teamCode: string; projectCodes: string[]; principalCode: string }) {
    try {
      const principal = await findUserByCode(db, cmd.principalCode);
      if (!principal || principal.status !== 'active') throw new DomainError('user_not_found', '用户不存在');
      const visible = await listProjects(cmd.principalCode, cmd.teamCode);
      const available = new Set(visible.map(row => row.project_code));
      if (cmd.projectCodes.length !== available.size || new Set(cmd.projectCodes).size !== available.size || cmd.projectCodes.some(code => !available.has(code))) throw new DomainError('project_order_invalid', '排序必须包含全部可访问项目');
      await db.transaction(async tx => {
        for (const [order, code] of cmd.projectCodes.entries()) {
          const [project] = await tx.select().from(schema.projects).where(eq(schema.projects.code, code)).limit(1);
          if (!project) throw new DomainError('project_not_found', '项目不存在');
          await assertProjectAccess(tx, project.id, principal.id);
          await tx.insert(schema.projectOrders).values({ project_id: project.id, principal_id: principal.id, sort_order: order })
            .onConflictDoUpdate({ target: [schema.projectOrders.project_id, schema.projectOrders.principal_id], set: { sort_order: order } });
        }
      });
      return { ok: true as const, data: { project_codes: cmd.projectCodes } };
    } catch(error) { return fail(error); }
  }

  async function updateProject(cmd: { projectCode: string; name: string; description?: string | null; principalCode: string }) {
    try {
      const [project, principal] = await Promise.all([
        findProjectByCode(db, cmd.projectCode),
        findUserByCode(db, cmd.principalCode),
      ]);
      if (!project || !principal || principal.status !== 'active') {
        return fail(new DomainError('project_forbidden', '项目不存在或当前用户无权修改', { project_code: cmd.projectCode }));
      }
      const membership = await effectiveProjectMember(db, project.id, principal.id);
      if (!membership || !isProjectManager(membership.role)) {
        return fail(new DomainError('project_forbidden', '只有项目 Owner 可以修改项目基本信息', {
          project_code: project.code,
          principal_code: principal.code,
        }));
      }
      await assertProjectAccess(db, project.id, principal.id, 'manage');
      const name = cmd.name.trim();
      if (!name) return fail(new DomainError('project_name_required', '项目名称不能为空'));
      const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, project.team_id)).limit(1);
      const changedAt = now();
      const result = await db.transaction(async (tx) => {
        await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, principal.id)).for('share');
        await tx.select({ id: schema.teams.id }).from(schema.teams).where(eq(schema.teams.id, project.team_id)).for('share');
        const [current] = await tx.select().from(schema.projects).where(eq(schema.projects.id, project.id)).for('update');
        if (!current) throw new DomainError('project_not_found', '项目不存在');
        await assertProjectAccess(tx, project.id, principal.id, 'manage');
        const description = cmd.description === undefined ? current.description : cmd.description?.trim() || null;
        if (name === current.name && description === current.description) return {
          project_code: current.code, team_code: team?.code ?? '', name: current.name,
          description: current.description, status: current.status, role: membership.role,
          current_snapshot: current.current_snapshot, created_at: current.created_at,
        };
        const nextSnapshot = current.current_snapshot + 1;
        await tx.update(schema.projects).set({ name, description, current_snapshot: nextSnapshot }).where(eq(schema.projects.id, project.id));
        const audit = {
          entity_type: 'project',
          entity_id: project.id,
          legacy_entity_code: project.legacy_code ?? undefined,
          principal_id: principal.id,
          base_snapshot: current.current_snapshot,
          action: 'project.updated',
          payload: {
            name: { from: current.name, to: name },
            description: { from: current.description, to: description },
          },
        };
        assertAuditedChange(audit);
        await insertAudit(tx, toAuditEvent(audit, createPublicCode(), changedAt));
        return {
          project_code: project.code,
          team_code: team?.code ?? '',
          name,
          description,
          status: current.status,
          role: membership.role,
          current_snapshot: nextSnapshot,
          created_at: project.created_at,
        };
      });
      return { ok: true as const, data: result };
    } catch (error) {
      return fail(error);
    }
  }

  async function updateProjectStatus(cmd: { projectCode: string; status: 'active' | 'archived'; principalCode: string }) {
    try {
      const [project, principal] = await Promise.all([
        findProjectByCode(db, cmd.projectCode),
        findUserByCode(db, cmd.principalCode),
      ]);
      if (!project || !principal || principal.status !== 'active') {
        return fail(new DomainError('project_forbidden', '项目不存在或当前用户无权修改', { project_code: cmd.projectCode }));
      }
      const [membership, team] = await Promise.all([
        effectiveProjectMember(db, project.id, principal.id),
        db.select().from(schema.teams).where(eq(schema.teams.id, project.team_id)).limit(1).then((rows) => rows[0]),
      ]);
      if (!membership || membership.role !== 'owner') {
        return fail(new DomainError('project_forbidden', '只有项目 Owner 可以归档或恢复项目', {
          project_code: project.code,
          principal_code: principal.code,
        }));
      }
      const changedAt = now();
      const result = await db.transaction(async (tx) => {
        await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, principal.id)).for('share');
        await tx.select({ id: schema.teams.id }).from(schema.teams).where(eq(schema.teams.id, project.team_id)).for('share');
        const [current] = await tx.select().from(schema.projects).where(eq(schema.projects.id, project.id)).for('update');
        if (!current) throw new DomainError('project_not_found', '项目不存在');
        await assertProjectAccess(tx, project.id, principal.id, 'owner');
        if (current.status === cmd.status) return {
          project_code: current.code, team_code: team?.code ?? '', name: current.name,
          description: current.description, status: current.status, role: membership.role,
          current_snapshot: current.current_snapshot, created_at: current.created_at,
        };
        const nextSnapshot = current.current_snapshot + 1;
        await tx.update(schema.projects).set({ status: cmd.status, current_snapshot: nextSnapshot }).where(eq(schema.projects.id, project.id));
        const audit = {
          entity_type: 'project',
          entity_id: project.id,
          legacy_entity_code: project.legacy_code ?? undefined,
          principal_id: principal.id,
          base_snapshot: current.current_snapshot,
          action: cmd.status === 'archived' ? 'project.archived' : 'project.restored',
          payload: { status: { from: current.status, to: cmd.status } },
        };
        assertAuditedChange(audit);
        await insertAudit(tx, toAuditEvent(audit, createPublicCode(), changedAt));
        return {
          project_code: project.code,
          team_code: team?.code ?? '',
          name: current.name,
          description: current.description,
          status: cmd.status,
          role: membership.role,
          current_snapshot: nextSnapshot,
          created_at: project.created_at,
        };
      });
      return { ok: true as const, data: result };
    } catch (error) {
      return fail(error);
    }
  }

  async function getProject(projectCode: string, principalCode: string) {
    const [project, principal] = await Promise.all([findProjectByCode(db, projectCode), findUserByCode(db, principalCode)]);
    if (!project || !principal || principal.status !== 'active') return fail(new DomainError('project_forbidden', '项目不存在或当前用户无权访问'));
    const view = await projectView(project, principal);
    if (!view) return fail(new DomainError('project_forbidden', '项目不存在或当前用户无权访问'));
    return { ok: true as const, data: view };
  }

  async function getProjectDocument(projectCode: string, principalCode: string) {
    const access = await getProject(projectCode, principalCode);
    if (!access.ok) return access;
    const project = access.data as { project_code: string; name: string; role: MemberRole };
    const projectRow = await findProjectByCode(db, projectCode);
    if (!projectRow) return fail(new DomainError('project_not_found', `项目不存在：${projectCode}`));
    const [document] = projectRow.overview_document_id === null ? [] : await db.select().from(schema.projectDocuments).where(and(
      eq(schema.projectDocuments.id, projectRow.overview_document_id),
      eq(schema.projectDocuments.project_id, projectRow.id),
      eq(schema.projectDocuments.status, 'active'),
    )).limit(1);
    const updatedBy = document?.updated_by
      ? (await db.select().from(schema.users).where(eq(schema.users.id, document.updated_by)).limit(1))[0]
      : undefined;
    return {
      ok: true as const,
      data: document
        ? {
            document_code: document.code,
            project_code: project.project_code,
            title: document.title,
            content: document.content,
            revision: document.revision,
            updated_by_user_code: updatedBy?.code ?? null,
            updated_at: document.updated_at,
            can_edit: isProjectManager(project.role) && projectRow.status === 'active',
          }
        : {
            document_code: null,
            project_code: project.project_code,
            title: `${project.name} 项目文档`,
            content: '',
            revision: 0,
            updated_by_user_code: null,
            updated_at: null,
            can_edit: isProjectManager(project.role) && projectRow.status === 'active',
          },
    };
  }

  async function saveProjectDocument(cmd: { projectCode: string; principalCode: string; title: string; content: string }) {
    try {
      const access = await getProject(cmd.projectCode, cmd.principalCode);
      if (!access.ok) return access;
      const projectAccess = access.data as { role: MemberRole };
      if (!isProjectManager(projectAccess.role)) {
        return fail(new DomainError('project_document_forbidden', '只有项目负责人或管理员可以编辑项目文档', {
          project_code: cmd.projectCode,
        }));
      }
      const [project, principal] = await Promise.all([
        findProjectByCode(db, cmd.projectCode),
        findUserByCode(db, cmd.principalCode),
      ]);
      if (!project || !principal) return fail(new DomainError('project_not_found', `项目不存在：${cmd.projectCode}`));
      await assertProjectAccess(db, project.id, principal.id, 'write');
      const title = cmd.title.trim();
      const content = cmd.content.replace(/\r\n/g, '\n');
      if (!title) return fail(new DomainError('project_document_title_required', '项目文档标题不能为空'));
      if (!content.trim()) return fail(new DomainError('project_document_content_required', '项目文档正文不能为空'));

      const updatedAt = now();
      const result = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(1094930512::bigint)`);
        const [currentProject] = await tx.select().from(schema.projects).where(eq(schema.projects.id, project.id)).for('update').limit(1);
        await assertProjectAccess(tx, project.id, principal.id, 'manage');
        if (!currentProject) throw new DomainError('project_document_forbidden', '项目不存在');
        if (currentProject.status !== 'active') throw new DomainError('project_archived', '已归档项目不能编辑项目文档');
        const [existing] = currentProject.overview_document_id === null ? [] : await tx.select().from(schema.projectDocuments).where(and(
          eq(schema.projectDocuments.id, currentProject.overview_document_id), eq(schema.projectDocuments.project_id, project.id),
        )).for('update').limit(1);
        if (currentProject.overview_document_id !== null && !existing) throw new DomainError('project_home_document_invalid', '项目首页说明关联无效，请重新关联文档');
        if (existing?.status === 'archived') throw new DomainError('project_home_document_archived', '项目说明文档已归档，请先解除或重新关联首页文档');
        const revision = (existing?.revision ?? 0) + 1;
        const [document] = existing
          ? await tx.update(schema.projectDocuments).set({
            title,
            content,
            revision,
            updated_by: principal.id,
            updated_at: updatedAt,
          }).where(eq(schema.projectDocuments.id, existing.id)).returning()
          : await tx.insert(schema.projectDocuments).values({
            code: createPublicCode(),
            project_id: project.id,
            title,
            content,
            revision,
            created_by: principal.id,
            created_at: updatedAt,
            updated_by: principal.id,
            updated_at: updatedAt,
          }).returning();
        if (!document) throw new DomainError('internal_error', '项目文档保存失败');
        if (!existing) await tx.update(schema.projects).set({ overview_document_id: document.id }).where(eq(schema.projects.id, project.id));
        await tx.insert(schema.projectDocumentRevisions).values({
          code: createPublicCode(),
          document_id: document.id,
          revision,
          title,
          summary: document.summary,
          content,
          change_summary: existing ? '通过兼容接口更新交接文档' : '通过兼容接口创建交接文档',
          created_by: principal.id,
          created_at: updatedAt,
        });
        const audit = {
          entity_type: 'project',
          entity_id: project.id,
          legacy_entity_code: project.legacy_code ?? undefined,
          principal_id: principal.id,
          base_snapshot: existing?.revision ?? 0,
          action: existing ? 'project.document_updated' : 'project.document_created',
          payload: { title, revision, document_code: document.code },
        };
        assertAuditedChange(audit);
        await insertAudit(tx, toAuditEvent(audit, createPublicCode(), updatedAt));
        return {
          document_code: document.code,
          project_code: project.code,
          title,
          content,
          revision,
          updated_by_user_code: principal.code,
          updated_at: updatedAt,
          can_edit: true,
        };
      });
      return { ok: true as const, data: result };
    } catch (error) {
      return fail(error);
    }
  }

  async function listArtifacts(projectCode: string, principalCode: string) {
    const access = await getProject(projectCode, principalCode);
    if (!access.ok) return access;
    const project = await findProjectByCode(db, projectCode);
    if (!project) return fail(new DomainError('project_not_found', `项目不存在：${projectCode}`));
    const rows = await db.select().from(schema.artifacts).where(eq(schema.artifacts.project_id, project.id));
    const users = await usersByIds(db, []);
    void users;
    const taskIds = rows.map((row) => row.task_id).filter((value): value is bigint => value !== null);
    const runIds = rows.map((row) => row.run_id).filter((value): value is bigint => value !== null);
    const [tasks, runs] = await Promise.all([
      taskIds.length ? db.select().from(schema.tasks).where(inArray(schema.tasks.id, taskIds)) : Promise.resolve([]),
      runIds.length ? db.select().from(schema.runs).where(inArray(schema.runs.id, runIds)) : Promise.resolve([]),
    ]);
    const taskMap = new Map(tasks.map((row) => [row.id, row]));
    const runMap = new Map(runs.map((row) => [row.id, row]));
    return {
      ok: true as const,
      data: rows.map((row) => ({
        artifact_code: row.code,
        project_code: project.code,
        task_code: row.task_id ? (taskMap.get(row.task_id)?.code ?? null) : null,
        run_code: row.run_id ? (runMap.get(row.run_id)?.code ?? null) : null,
        kind: row.kind,
        title: row.title,
        summary: row.summary,
        uri: row.uri,
        content_hash: row.content_hash,
        published_at: row.published_at,
      })),
    };
  }

  async function registerArtifact(cmd: {
    projectCode: string;
    principalCode: string;
    kind: ArtifactKind;
    title: string;
    summary?: string;
    uri: string;
    contentHash: string;
  }) {
    try {
      const access = await getProject(cmd.projectCode, cmd.principalCode);
      if (!access.ok) return access;
      const project = await findProjectByCode(db, cmd.projectCode);
      if (!project) return fail(new DomainError('project_not_found', `项目不存在：${cmd.projectCode}`));
      const principal = await findUserByCode(db, cmd.principalCode);
      if (!principal) throw new DomainError('user_not_found', '用户不存在');
      await assertProjectAccess(db, project.id, principal.id, 'write');
      const title = cmd.title.trim();
      const uri = cmd.uri.trim();
      if (!title || !uri) return fail(new DomainError('artifact_invalid', '项目产物标题和 URI 不能为空'));
      const artifactCode = createPublicCode();
      const publishedAt = now();
      await db.insert(schema.artifacts).values({
        code: artifactCode,
        project_id: project.id,
        kind: cmd.kind,
        title,
        summary: cmd.summary?.trim() || null,
        uri,
        content_hash: cmd.contentHash.trim() || 'unverified',
        published: true,
        published_at: publishedAt,
      });
      return {
        ok: true as const,
        data: {
          artifact_code: artifactCode,
          project_code: project.code,
          kind: cmd.kind,
          title,
          uri,
          published_at: publishedAt,
        },
      };
    } catch (error) {
      return fail(error);
    }
  }

  async function listProjectRepositories(projectCode: string, principalCode: string) {
    const access = await getProject(projectCode, principalCode);
    if (!access.ok) return access;
    const projectAccess = access.data as { role: MemberRole };
    const project = await findProjectByCode(db, projectCode);
    if (!project) return fail(new DomainError('project_not_found', `项目不存在：${projectCode}`));
    const rows = await db.select().from(schema.projectRepositories)
      .where(eq(schema.projectRepositories.project_id, project.id))
      .orderBy(asc(schema.projectRepositories.status), asc(schema.projectRepositories.name), asc(schema.projectRepositories.code));
    return {
      ok: true as const,
      data: rows.map((row) => ({
        repository_code: row.code,
        project_code: project.code,
        name: row.name,
        purpose: row.purpose,
        remote_url: row.remote_url,
        default_branch: row.default_branch,
        status: row.status,
        can_manage: isProjectManager(projectAccess.role) && project.status === 'active',
        created_at: row.created_at,
        updated_at: row.updated_at,
      })),
    };
  }

  async function createProjectRepository(cmd: {
    projectCode: string;
    principalCode: string;
    name: string;
    purpose?: string;
    remoteUrl: string;
    defaultBranch?: string;
  }) {
    try {
      const access = await getProject(cmd.projectCode, cmd.principalCode);
      if (!access.ok) return access;
      const projectAccess = access.data as { role: MemberRole };
      if (!isProjectManager(projectAccess.role)) {
        return fail(new DomainError('project_repository_forbidden', '只有项目负责人或管理员可以配置代码仓库'));
      }
      const [project, principal] = await Promise.all([
        findProjectByCode(db, cmd.projectCode),
        findUserByCode(db, cmd.principalCode),
      ]);
      if (!project || !principal) return fail(new DomainError('project_not_found', `项目不存在：${cmd.projectCode}`));
      await assertProjectAccess(db, project.id, principal.id, 'write');
      const name = cmd.name.trim();
      if (!name) return fail(new DomainError('repository_name_required', '代码仓库名称不能为空'));
      const remoteUrl = normalizeRepositoryRemote(cmd.remoteUrl);
      const purpose = cmd.purpose?.trim() || null;
      const defaultBranch = cmd.defaultBranch?.trim() || null;
      const [duplicate] = await db.select({ code: schema.projectRepositories.code })
        .from(schema.projectRepositories)
        .where(and(
          eq(schema.projectRepositories.project_id, project.id),
          eq(schema.projectRepositories.remote_url, remoteUrl),
        )).limit(1);
      if (duplicate) {
        return fail(new DomainError('repository_remote_duplicate', '当前项目已经配置该代码仓库地址', {
          repository_code: duplicate.code,
        }));
      }
      const changedAt = now();
      const result = await db.transaction(async (tx) => {
        await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, principal.id)).for('share');
        await tx.select({ id: schema.teams.id }).from(schema.teams).where(eq(schema.teams.id, project.team_id)).for('share');
        const [current] = await tx.select().from(schema.projects).where(eq(schema.projects.id, project.id)).for('update');
        if (!current) throw new DomainError('project_not_found', '项目不存在');
        await assertProjectAccess(tx, project.id, principal.id, 'manage');
        const [repository] = await tx.insert(schema.projectRepositories).values({
          code: createPublicCode(),
          project_id: project.id,
          name,
          purpose,
          remote_url: remoteUrl,
          default_branch: defaultBranch,
          created_by: principal.id,
          created_at: changedAt,
          updated_at: changedAt,
        }).returning();
        if (!repository) throw new DomainError('internal_error', '代码仓库创建失败');
        await tx.update(schema.projects).set({ current_snapshot: current.current_snapshot + 1 }).where(eq(schema.projects.id, project.id));
        const audit = {
          entity_type: 'project_repository',
          entity_id: repository.id,
          principal_id: principal.id,
          base_snapshot: current.current_snapshot,
          action: 'project.repository_created',
          payload: { project_code: project.code, repository_code: repository.code, name, remote_url: remoteUrl },
        };
        assertAuditedChange(audit);
        await insertAudit(tx, toAuditEvent(audit, createPublicCode(), changedAt));
        return {
          repository_code: repository.code,
          project_code: project.code,
          name: repository.name,
          purpose: repository.purpose,
          remote_url: repository.remote_url,
          default_branch: repository.default_branch,
          status: repository.status,
          can_manage: true,
          created_at: repository.created_at,
          updated_at: repository.updated_at,
        };
      });
      return { ok: true as const, data: result };
    } catch (error) {
      return fail(error);
    }
  }

  async function updateProjectRepository(cmd: {
    repositoryCode: string;
    principalCode: string;
    name?: string;
    purpose?: string | null;
    remoteUrl?: string;
    defaultBranch?: string | null;
    status?: 'active' | 'archived';
  }) {
    try {
      const [repository, principal] = await Promise.all([
        db.select().from(schema.projectRepositories).where(eq(schema.projectRepositories.code, cmd.repositoryCode)).limit(1).then((rows) => rows[0]),
        findUserByCode(db, cmd.principalCode),
      ]);
      if (!repository || !principal || principal.status !== 'active') {
        return fail(new DomainError('repository_not_found', `代码仓库不存在：${cmd.repositoryCode}`));
      }
      const [project, membership] = await Promise.all([
        db.select().from(schema.projects).where(eq(schema.projects.id, repository.project_id)).limit(1).then((rows) => rows[0]),
        effectiveProjectMember(db, repository.project_id, principal.id),
      ]);
      if (!project || !membership || !isProjectManager(membership.role)) {
        return fail(new DomainError('project_repository_forbidden', '只有项目负责人或管理员可以修改代码仓库'));
      }
      await assertProjectAccess(db, project.id, principal.id, 'manage');
      const name = cmd.name === undefined ? repository.name : cmd.name.trim();
      if (!name) return fail(new DomainError('repository_name_required', '代码仓库名称不能为空'));
      const purpose = cmd.purpose === undefined ? repository.purpose : cmd.purpose?.trim() || null;
      const remoteUrl = cmd.remoteUrl === undefined ? repository.remote_url : normalizeRepositoryRemote(cmd.remoteUrl);
      const defaultBranch = cmd.defaultBranch === undefined ? repository.default_branch : cmd.defaultBranch?.trim() || null;
      const status = cmd.status ?? repository.status;
      if (remoteUrl !== repository.remote_url) {
        const [duplicate] = await db.select({ code: schema.projectRepositories.code })
          .from(schema.projectRepositories)
          .where(and(
            eq(schema.projectRepositories.project_id, project.id),
            eq(schema.projectRepositories.remote_url, remoteUrl),
          )).limit(1);
        if (duplicate) return fail(new DomainError('repository_remote_duplicate', '当前项目已经配置该代码仓库地址', { repository_code: duplicate.code }));
      }
      const changedAt = now();
      await db.transaction(async (tx) => {
        await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, principal.id)).for('share');
        await tx.select({ id: schema.teams.id }).from(schema.teams).where(eq(schema.teams.id, project.team_id)).for('share');
        const [current] = await tx.select().from(schema.projects).where(eq(schema.projects.id, project.id)).for('update');
        if (!current) throw new DomainError('project_not_found', '项目不存在');
        await assertProjectAccess(tx, project.id, principal.id, 'manage');
        await tx.update(schema.projectRepositories).set({
          name,
          purpose,
          remote_url: remoteUrl,
          default_branch: defaultBranch,
          status,
          updated_at: changedAt,
        }).where(eq(schema.projectRepositories.id, repository.id));
        await tx.update(schema.projects).set({ current_snapshot: current.current_snapshot + 1 }).where(eq(schema.projects.id, project.id));
        const audit = {
          entity_type: 'project_repository',
          entity_id: repository.id,
          principal_id: principal.id,
          base_snapshot: current.current_snapshot,
          action: 'project.repository_updated',
          payload: { project_code: project.code, repository_code: repository.code, name, purpose, remote_url: remoteUrl, default_branch: defaultBranch, status },
        };
        assertAuditedChange(audit);
        await insertAudit(tx, toAuditEvent(audit, createPublicCode(), changedAt));
      });
      return {
        ok: true as const,
        data: {
          repository_code: repository.code,
          project_code: project.code,
          name,
          purpose,
          remote_url: remoteUrl,
          default_branch: defaultBranch,
          status,
          can_manage: true,
          created_at: repository.created_at,
          updated_at: changedAt,
        },
      };
    } catch (error) {
      return fail(error);
    }
  }

  async function registerProjectWorkspace(cmd: { projectCode: string; principalCode: string; name: string }) {
    try {
      const access = await getProject(cmd.projectCode, cmd.principalCode);
      if (!access.ok) return access;
      const [project, principal] = await Promise.all([
        findProjectByCode(db, cmd.projectCode),
        findUserByCode(db, cmd.principalCode),
      ]);
      if (!project || !principal) return fail(new DomainError('project_not_found', `项目不存在：${cmd.projectCode}`));
      await assertProjectAccess(db, project.id, principal.id, 'write');
      const name = cmd.name.trim();
      if (!name) return fail(new DomainError('project_workspace_name_required', '项目工作空间名称不能为空'));
      const createdAt = now();
      const [workspace] = await db.insert(schema.projectWorkspaces).values({
        code: createPublicCode(),
        project_id: project.id,
        principal_id: principal.id,
        name,
        last_seen_at: createdAt,
        created_at: createdAt,
      }).returning();
      if (!workspace) return fail(new DomainError('internal_error', '项目工作空间登记失败'));
      return {
        ok: true as const,
        data: {
          project_workspace_code: workspace.code,
          project_code: project.code,
          name: workspace.name,
          status: workspace.status,
          created_at: workspace.created_at,
        },
      };
    } catch (error) {
      return fail(error);
    }
  }

  return {
    createProject,
    listProjects,
    reorderProjects,
    updateProject,
    updateProjectStatus,
    getProject,
    getProjectDocument,
    saveProjectDocument,
    listArtifacts,
    registerArtifact,
    listProjectRepositories,
    createProjectRepository,
    updateProjectRepository,
    registerProjectWorkspace,
  };
}

export type ProjectUseCasesProject = ReturnType<typeof createProjectUseCasesProject>;
