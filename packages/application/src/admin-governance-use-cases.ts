import { and, asc, count, eq, gt, ilike, inArray, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { schema, type Db } from '@team-synergy/persistence';
import { DomainError, assertAuditedChange, toAuditEvent } from '@team-synergy/domain';
import { createPublicCode } from './public-code.js';
import { fail, insertAudit, now } from './task-service.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type AdminGovernanceFilter = { q?: string; limit?: number; cursor?: string };

async function requireAdmin(tx: Tx, principalCode: string) {
  const [actor] = await tx.select().from(schema.users).where(eq(schema.users.code, principalCode)).for('share');
  if (!actor || actor.status !== 'active' || actor.deleted_at || actor.pending_deletion || !actor.is_system_admin) {
    throw new DomainError('admin_forbidden', '只有有效系统管理员可以使用系统管理');
  }
  return actor;
}

function listFilter(filter: AdminGovernanceFilter) {
  const limit = filter.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new DomainError('admin_query_invalid', '每页数量须为 1 到 200');
  if (filter.cursor && !/^[A-Z0-9]{20}$/.test(filter.cursor)) throw new DomainError('admin_query_invalid', '分页游标无效');
  const q = filter.q?.trim() ?? '';
  if (q.length > 200) throw new DomainError('admin_query_invalid', '搜索内容不能超过 200 个字符');
  // Search literal text, including user-entered SQL LIKE wildcards.
  return { limit, cursor: filter.cursor, pattern: q ? `%${q.replace(/[\\%_]/g, '\\$&')}%` : undefined };
}

function requiredText(value: string, field: string, max: number) {
  const text = value.trim();
  if (!text || text.length > max) throw new DomainError('admin_input_invalid', `${field}不能为空且不能超过 ${max} 个字符`);
  return text;
}

const owner = alias(schema.users, 'governance_owner');
const creator = alias(schema.users, 'governance_creator');
const ownershipFields = {
  owner_code: owner.code, owner_name: owner.display_name,
  created_by_code: creator.code, created_by_name: creator.display_name,
};

export function createAdminGovernanceUseCases(db: Db) {
  async function listTeams(principalCode: string, filter: AdminGovernanceFilter = {}) {
    try {
      return await db.transaction(async tx => {
        await requireAdmin(tx, principalCode);
        const { limit, cursor, pattern } = listFilter(filter);
        const where = pattern ? or(ilike(schema.teams.name, pattern), ilike(schema.teams.code, pattern)) : undefined;
        const [total] = await tx.select({ value: count() }).from(schema.teams).where(where);
        const rows = await tx.select({
          team_code: schema.teams.code, name: schema.teams.name, created_at: schema.teams.created_at,
          ...ownershipFields,
          ownership_pending: sql<boolean>`${schema.teams.owner_principal_id} is null`,
          members_count: sql<number>`(select count(*) from ${schema.teamMembers} where ${schema.teamMembers.team_id} = ${schema.teams.id})`.mapWith(Number),
          projects_count: sql<number>`(select count(*) from ${schema.projects} where ${schema.projects.team_id} = ${schema.teams.id})`.mapWith(Number),
        }).from(schema.teams)
          .leftJoin(owner, eq(owner.id, schema.teams.owner_principal_id))
          .leftJoin(creator, eq(creator.id, schema.teams.created_by))
          .where(and(where, cursor ? gt(schema.teams.code, cursor) : undefined))
          .orderBy(asc(schema.teams.code)).limit(limit + 1);
        const items = rows.slice(0, limit);
        return { ok: true as const, data: { items, total: total?.value ?? 0, next_cursor: rows.length > limit ? items.at(-1)?.team_code ?? null : null } };
      });
    } catch (error) { return fail(error); }
  }

  async function listProjects(principalCode: string, filter: AdminGovernanceFilter & { teamCode?: string; status?: string } = {}) {
    try {
      return await db.transaction(async tx => {
        await requireAdmin(tx, principalCode);
        const { limit, cursor, pattern } = listFilter(filter);
        if (filter.status && filter.status !== 'active' && filter.status !== 'archived') throw new DomainError('admin_query_invalid', '项目状态无效');
        const where = and(
          filter.teamCode ? eq(schema.teams.code, filter.teamCode) : undefined,
          filter.status ? eq(schema.projects.status, filter.status as 'active' | 'archived') : undefined,
          pattern ? or(ilike(schema.projects.name, pattern), ilike(schema.projects.code, pattern), ilike(schema.teams.name, pattern)) : undefined,
        );
        const [total] = await tx.select({ value: count() }).from(schema.projects)
          .innerJoin(schema.teams, eq(schema.teams.id, schema.projects.team_id)).where(where);
        const rows = await tx.select({
          project_code: schema.projects.code, team_code: schema.teams.code, team_name: schema.teams.name,
          name: schema.projects.name, description: schema.projects.description, status: schema.projects.status,
          member_policy: schema.projects.member_policy, current_snapshot: schema.projects.current_snapshot,
          created_at: schema.projects.created_at, ...ownershipFields,
          ownership_pending: sql<boolean>`${schema.projects.owner_principal_id} is null`,
          // Count the same active owner / explicit / inherited users allowed by resolveProjectAccess.
          members_count: sql<number>`(select count(*) from ${schema.users} where ${schema.users.status} = 'active'
            and ${schema.users.deleted_at} is null and (
              ${schema.users.id} = ${schema.projects.owner_principal_id}
              or exists (select 1 from ${schema.members} where ${schema.members.project_id} = ${schema.projects.id} and ${schema.members.principal_id} = ${schema.users.id})
              or (${schema.projects.member_policy} <> 'private' and exists (select 1 from ${schema.teamMembers} where ${schema.teamMembers.team_id} = ${schema.projects.team_id} and ${schema.teamMembers.principal_id} = ${schema.users.id}))
            ))`.mapWith(Number),
        }).from(schema.projects).innerJoin(schema.teams, eq(schema.teams.id, schema.projects.team_id))
          .leftJoin(owner, eq(owner.id, schema.projects.owner_principal_id))
          .leftJoin(creator, eq(creator.id, schema.projects.created_by))
          .where(and(where, cursor ? gt(schema.projects.code, cursor) : undefined))
          .orderBy(asc(schema.projects.code)).limit(limit + 1);
        const items = rows.slice(0, limit);
        return { ok: true as const, data: { items, total: total?.value ?? 0, next_cursor: rows.length > limit ? items.at(-1)?.project_code ?? null : null } };
      });
    } catch (error) { return fail(error); }
  }

  async function updateTeam(cmd: { principalCode: string; teamCode: string; name: string; reason: string }) {
    try {
      return await db.transaction(async tx => {
        const actor = await requireAdmin(tx, cmd.principalCode);
        const name = requiredText(cmd.name, '团队名称', 200);
        const reason = requiredText(cmd.reason, '管理原因', 1000);
        const [team] = await tx.select().from(schema.teams).where(eq(schema.teams.code, cmd.teamCode)).for('update');
        if (!team) throw new DomainError('team_not_found', '团队不存在');
        if (name !== team.name) {
          await tx.update(schema.teams).set({ name }).where(eq(schema.teams.id, team.id));
          const audit = { entity_type: 'team', entity_id: team.id, principal_id: actor.id, base_snapshot: 0,
            action: 'admin.team.updated', payload: { reason, name: { from: team.name, to: name } } };
          assertAuditedChange(audit);
          await insertAudit(tx, toAuditEvent(audit, createPublicCode(), now()));
        }
        return { ok: true as const, data: { team_code: team.code, name } };
      });
    } catch (error) { return fail(error); }
  }

  async function updateProject(cmd: { principalCode: string; projectCode: string; baseSnapshot: number; name?: string; description?: string | null; status?: string; reason: string }) {
    try {
      return await db.transaction(async tx => {
        const actor = await requireAdmin(tx, cmd.principalCode);
        const reason = requiredText(cmd.reason, '管理原因', 1000);
        if (!Number.isSafeInteger(cmd.baseSnapshot) || cmd.baseSnapshot < 0) throw new DomainError('admin_input_invalid', '必须提供有效项目版本');
        if (cmd.status !== undefined && cmd.status !== 'active' && cmd.status !== 'archived') throw new DomainError('admin_input_invalid', '项目状态无效');
        if (cmd.name === undefined && cmd.description === undefined && cmd.status === undefined) throw new DomainError('admin_input_invalid', '未提供可修改的项目信息');
        const [project] = await tx.select().from(schema.projects).where(eq(schema.projects.code, cmd.projectCode)).for('update');
        if (!project) throw new DomainError('project_not_found', '项目不存在');
        if (project.current_snapshot !== cmd.baseSnapshot) throw new DomainError('admin_revision_conflict', '项目已被其他操作更新，请刷新后重试', { current_snapshot: project.current_snapshot });
        const name = cmd.name === undefined ? project.name : requiredText(cmd.name, '项目名称', 200);
        const description = cmd.description === undefined ? project.description : cmd.description?.trim() || null;
        if (description && description.length > 10000) throw new DomainError('admin_input_invalid', '项目说明不能超过 10000 个字符');
        const status = cmd.status as 'active' | 'archived' | undefined ?? project.status;
        if (status === 'archived' && project.status !== status) {
          const activeRuns = await tx.select({ code: schema.runs.code }).from(schema.runs)
            .innerJoin(schema.tasks, eq(schema.tasks.id, schema.runs.task_id))
            .innerJoin(schema.features, eq(schema.features.id, schema.tasks.feature_id))
            .where(and(eq(schema.features.project_id, project.id), inArray(schema.runs.status, ['active', 'preparing', 'suspended']))).limit(20);
          if (activeRuns.length) throw new DomainError('project_has_active_runs', '项目仍有运行或交接中的任务，请先完成交接或结束运行', { run_codes: activeRuns.map(row => row.code) });
        }
        const changed = name !== project.name || description !== project.description || status !== project.status;
        const snapshot = project.current_snapshot + (changed ? 1 : 0);
        if (changed) {
          await tx.update(schema.projects).set({ name, description, status, current_snapshot: snapshot }).where(eq(schema.projects.id, project.id));
          const audit = { entity_type: 'project', entity_id: project.id, principal_id: actor.id, base_snapshot: project.current_snapshot,
            action: 'admin.project.updated', payload: { reason, name: { from: project.name, to: name }, description: { from: project.description, to: description }, status: { from: project.status, to: status } } };
          assertAuditedChange(audit);
          await insertAudit(tx, toAuditEvent(audit, createPublicCode(), now()));
        }
        return { ok: true as const, data: { project_code: project.code, name, description, status, current_snapshot: snapshot } };
      });
    } catch (error) { return fail(error); }
  }

  return { listTeams, listProjects, updateTeam, updateProject };
}
