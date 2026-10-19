import { and, asc, eq, inArray, max } from 'drizzle-orm';
import type { Db } from '@team-synergy/persistence';
import { schema } from '@team-synergy/persistence';
import { DomainError, assertAuditedChange, toAuditEvent } from '@team-synergy/domain';
import type { MemberRole } from '@team-synergy/contracts';
import { fail, insertAudit, now } from './task-service.js';
import { createPublicCode, findProjectByCode, findUserByCode } from './public-code.js';
import { isProjectManager, projectCapabilities, resolveProjectAccess } from './project-access.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type MemberCommand = { userCode: string; actorPrincipalCode: string; projectCode: string };

function assertAssignableRole(role: MemberRole) {
  if (!['admin', 'member', 'viewer'].includes(role)) {
    throw new DomainError('member_role_invalid', '只能授予 Admin、Member 或 Viewer；Owner 必须通过所有权转移变更');
  }
}

function assertCanManage(actorRole: MemberRole | undefined, targetRole?: MemberRole, nextRole?: MemberRole) {
  if (!actorRole || !isProjectManager(actorRole)) throw new DomainError('member_forbidden', '只有项目负责人或管理员可以管理项目成员');
  if (targetRole === 'owner') throw new DomainError('project_owner_protected', '请先完成项目所有权转移，不能直接修改或移除负责人');
  if (actorRole === 'admin' && (targetRole === 'admin' || nextRole === 'admin')) {
    throw new DomainError('member_forbidden', '只有项目负责人可以任免或移除管理员');
  }
}

export async function assertWorkHandedOff(tx: Tx, projectId: bigint, principalId: bigint) {
  const tasks = await tx.select({ id: schema.tasks.id, code: schema.tasks.code, status: schema.tasks.status, assignee: schema.tasks.assignee_principal_id })
    .from(schema.tasks).innerJoin(schema.features, eq(schema.features.id, schema.tasks.feature_id))
    .where(eq(schema.features.project_id, projectId));
  const open = tasks.filter(task => task.assignee === principalId && !['closed', 'failed', 'cancelled'].includes(task.status));
  const activeRuns = tasks.length ? await tx.select({ code: schema.runs.code }).from(schema.runs).where(and(
    eq(schema.runs.principal_id, principalId), inArray(schema.runs.task_id, tasks.map(task => task.id)),
    inArray(schema.runs.status, ['active', 'preparing', 'suspended']),
  )) : [];
  if (open.length || activeRuns.length) throw new DomainError('member_has_open_tasks', '该成员仍有未完成任务或运行，请先完成交接', {
    open_task_codes: open.map(task => task.code), active_run_codes: activeRuns.map(run => run.code),
  });
}

export function createMemberUseCases(db: Db) {
  async function mutate(cmd: MemberCommand, operation: 'add' | 'update' | 'remove', role?: MemberRole) {
    try {
      if (role !== undefined) assertAssignableRole(role);
      const [project, actor, user] = await Promise.all([
        findProjectByCode(db, cmd.projectCode), findUserByCode(db, cmd.actorPrincipalCode), findUserByCode(db, cmd.userCode),
      ]);
      if (!project) throw new DomainError('project_not_found', `项目不存在：${cmd.projectCode}`);
      if (!actor) throw new DomainError('user_not_found', `用户不存在：${cmd.actorPrincipalCode}`);
      if (!user) throw new DomainError('member_not_found', `成员不存在：${cmd.userCode}`);
      const data = await db.transaction(async tx => {
        const lockedUsers = await tx.select().from(schema.users).where(inArray(schema.users.id, [...new Set([actor.id, user.id])])).orderBy(asc(schema.users.id)).for('update');
        const activeActor = lockedUsers.find(row => row.id === actor.id);
        const targetUser = lockedUsers.find(row => row.id === user.id);
        if (activeActor?.status !== 'active' || activeActor.deleted_at) throw new DomainError('user_not_found', '操作账号已失效');
        if (!targetUser || (operation !== 'remove' && (targetUser.status !== 'active' || targetUser.deleted_at))) {
          throw new DomainError('user_not_found', '只能授权有效用户');
        }
        await tx.select({ id: schema.teams.id }).from(schema.teams).where(eq(schema.teams.id, project.team_id)).for('update');
        const [current] = await tx.select().from(schema.projects).where(eq(schema.projects.id, project.id)).for('update');
        if (!current) throw new DomainError('project_not_found', '项目不存在');
        if (current.status === 'archived') throw new DomainError('project_archived', '归档项目不能修改成员权限');
        const actorAccess = await resolveProjectAccess(tx, current.id, actor.id);
        const targetAccess = await resolveProjectAccess(tx, current.id, user.id);
        const [existing] = await tx.select().from(schema.members).where(and(eq(schema.members.project_id, current.id), eq(schema.members.principal_id, user.id)));
        const targetRole = current.owner_principal_id === user.id ? 'owner' : existing?.role === 'owner' && current.owner_principal_id !== null ? 'admin' : existing?.role ?? targetAccess?.role;
        assertCanManage(actorAccess?.role, targetRole, role);
        if (operation === 'add' && existing) throw new DomainError('member_exists', `成员已存在：${cmd.userCode}`);
        if (operation === 'update' && !targetAccess) throw new DomainError('member_not_found', `成员不存在：${cmd.userCode}`);
        if (operation === 'remove' && !existing) throw new DomainError('member_not_found', '该用户没有可撤销的单独授权');
        // Removing an explicit override can restore inherited collaboration; only
        // loss of write access requires handing off existing work.
        let resultingRole: MemberRole | null = role ?? null;
        if (operation === 'remove') {
          const [teamMember] = await tx.select().from(schema.teamMembers).where(and(eq(schema.teamMembers.team_id, current.team_id), eq(schema.teamMembers.principal_id, user.id)));
          resultingRole = teamMember && current.member_policy !== 'private' ? current.member_policy === 'team_write' ? 'member' : 'viewer' : null;
        }
        if (resultingRole === null || resultingRole === 'viewer') await assertWorkHandedOff(tx, current.id, user.id);
        if (operation === 'remove') {
          await tx.delete(schema.members).where(and(eq(schema.members.project_id, current.id), eq(schema.members.principal_id, user.id)));
        } else if (existing) {
          await tx.update(schema.members).set({ role: role!, display_name: targetUser.display_name }).where(and(eq(schema.members.project_id, current.id), eq(schema.members.principal_id, user.id)));
        } else {
          const [last] = await tx.select({ value: max(schema.members.sort_order) }).from(schema.members).where(eq(schema.members.principal_id, user.id));
          await tx.insert(schema.members).values({ principal_id: user.id, project_id: current.id, role: role!, display_name: targetUser.display_name, sort_order: (last?.value ?? -1) + 1, created_at: now() });
        }
        const audit = {
          entity_type: 'project', entity_id: current.id, legacy_entity_code: current.legacy_code ?? undefined,
          principal_id: actor.id, base_snapshot: 0,
          action: operation === 'add' ? 'member.added' : operation === 'update' ? 'member.role_updated' : 'member.removed',
          payload: { user_code: user.code, from: targetAccess?.role ?? null, to: resultingRole, access_source: operation === 'remove' ? resultingRole ? 'team' : null : 'explicit' },
        };
        assertAuditedChange(audit);
        await insertAudit(tx, toAuditEvent(audit, createPublicCode(), now()));
        return { user_code: user.code, role: resultingRole, effective_role: resultingRole, access_source: operation === 'remove' ? resultingRole ? 'team' as const : null : 'explicit' as const, display_name: targetUser.display_name };
      });
      return { ok: true as const, data };
    } catch (error) { return fail(error); }
  }

  async function listMembers(projectCode?: string, actorPrincipalCode?: string) {
    if (!projectCode || !actorPrincipalCode) return [];
    const project = await findProjectByCode(db, projectCode);
    if (!project) return [];
    const actor = await findUserByCode(db, actorPrincipalCode);
    if (!actor || !(await resolveProjectAccess(db, project.id, actor.id))) return [];
    const explicit = await db.select().from(schema.members).where(eq(schema.members.project_id, project.id));
    const teamMembers = await db.select().from(schema.teamMembers).where(eq(schema.teamMembers.team_id, project.team_id));
    const ids = new Set(explicit.map(row => row.principal_id));
    if (project.owner_principal_id) ids.add(project.owner_principal_id);
    if (project.member_policy !== 'private') for (const member of teamMembers) ids.add(member.principal_id);
    const users = ids.size ? await db.select().from(schema.users).where(inArray(schema.users.id, [...ids])).orderBy(asc(schema.users.display_name), asc(schema.users.code)) : [];
    const result = await Promise.all(users.map(async user => {
      const access = await resolveProjectAccess(db, project.id, user.id);
      if (!access) return null;
      return {
        user_code: user.code, account: user.account, display_name: user.display_name,
        role: access.role, effective_role: access.role, access_source: access.source,
        is_external: access.isExternal, capabilities: projectCapabilities(access.role),
      };
    }));
    return result.filter((row): row is NonNullable<typeof row> => row !== null);
  }

  return {
    addMember: (cmd: MemberCommand & { role: MemberRole }) => mutate(cmd, 'add', cmd.role),
    updateMemberRole: (cmd: MemberCommand & { role: MemberRole }) => mutate(cmd, 'update', cmd.role),
    removeMember: (cmd: MemberCommand) => mutate(cmd, 'remove'),
    listMembers,
  };
}

export type MemberUseCases = ReturnType<typeof createMemberUseCases>;
