import { and, asc, count, eq, inArray, max } from 'drizzle-orm';
import type { Db } from '@team-synergy/persistence';
import { schema } from '@team-synergy/persistence';
import { DomainError, assertAuditedChange, toAuditEvent } from '@team-synergy/domain';
import type { TeamRole } from '@team-synergy/contracts';
import { fail, insertAudit, now } from './task-service.js';
import { createPublicCode, findTeamByCode, findUserByCode } from './public-code.js';
import { resolveProjectAccess, resolveTeamRole } from './project-access.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type TeamMemberCommand = { teamCode: string; userCode: string; actorPrincipalCode: string };

async function activeUserByCode(db: Db, principalCode: string) {
  const user = await findUserByCode(db, principalCode);
  return user && user.status === 'active' && !user.deleted_at ? user : undefined;
}

function assertCanManage(actorRole: TeamRole | null, targetRole?: TeamRole, nextRole?: TeamRole) {
  if (actorRole !== 'owner' && actorRole !== 'admin') throw new DomainError('team_forbidden', '只有团队负责人或管理员可以管理团队');
  if (targetRole === 'owner') throw new DomainError('team_owner_protected', '请先完成团队所有权转移，不能直接修改或移除负责人');
  if (actorRole === 'admin' && (targetRole === 'admin' || nextRole === 'admin')) throw new DomainError('team_forbidden', '只有团队负责人可以任免或移除管理员');
}

async function writeAudit(tx: Tx, team: typeof schema.teams.$inferSelect, actorId: bigint, action: string, payload: Record<string, unknown>) {
  const audit = { entity_type: 'team', entity_id: team.id, legacy_entity_code: team.legacy_code ?? undefined, principal_id: actorId, base_snapshot: 0, action, payload };
  assertAuditedChange(audit);
  await insertAudit(tx, toAuditEvent(audit, createPublicCode(), now()));
}

export function createTeamUseCases(db: Db) {
  async function createTeam(cmd: { name: string; principalCode: string }) {
    try {
      const creator = await activeUserByCode(db, cmd.principalCode);
      if (!creator) throw new DomainError('user_not_found', `有效用户不存在：${cmd.principalCode}`);
      const name = cmd.name.trim();
      if (!name) throw new DomainError('team_name_required', '团队名称不能为空');
      const data = await db.transaction(async tx => {
        const [currentUser] = await tx.select().from(schema.users).where(eq(schema.users.id, creator.id)).for('update');
        if (!currentUser || currentUser.status !== 'active') throw new DomainError('user_not_found', '有效用户不存在');
        if (currentUser.pending_deletion) throw new DomainError('account_pending_deletion', '待注销账号不能创建团队');
        const [last] = await tx.select({ value: max(schema.teamMembers.sort_order) }).from(schema.teamMembers).where(eq(schema.teamMembers.principal_id, creator.id));
        const createdAt = now();
        const [team] = await tx.insert(schema.teams).values({ code: createPublicCode(), name, created_by: creator.id, owner_principal_id: creator.id, created_at: createdAt }).returning();
        if (!team) throw new DomainError('internal_error', '团队创建失败');
        await tx.insert(schema.teamMembers).values({ team_id: team.id, principal_id: creator.id, role: 'admin', display_name: currentUser.display_name, sort_order: (last?.value ?? -1) + 1, created_at: createdAt });
        await writeAudit(tx, team, creator.id, 'team.created', { name, owner_code: creator.code, created_by: creator.code });
        return { team_code: team.code, name: team.name, role: 'owner' as const, owner_code: creator.code, created_by: creator.code, created_at: team.created_at };
      });
      return { ok: true as const, data };
    } catch (error) { return fail(error); }
  }

  async function renameTeam(cmd: { teamCode: string; name: string; actorPrincipalCode: string }) {
    try {
      const [team, actor] = await Promise.all([findTeamByCode(db, cmd.teamCode), activeUserByCode(db, cmd.actorPrincipalCode)]);
      if (!team) throw new DomainError('team_not_found', `团队不存在：${cmd.teamCode}`);
      if (!actor) throw new DomainError('user_not_found', `有效用户不存在：${cmd.actorPrincipalCode}`);
      const name = cmd.name.trim();
      if (!name) throw new DomainError('team_name_required', '团队名称不能为空');
      const data = await db.transaction(async tx => {
        const [currentActor] = await tx.select().from(schema.users).where(eq(schema.users.id, actor.id)).for('update');
        if (currentActor?.status !== 'active') throw new DomainError('user_not_found', '操作账号已失效');
        const [current] = await tx.select().from(schema.teams).where(eq(schema.teams.id, team.id)).for('update');
        if (!current) throw new DomainError('team_not_found', '团队不存在');
        assertCanManage(await resolveTeamRole(tx, current.id, actor.id));
        if (current.name !== name) {
          await tx.update(schema.teams).set({ name }).where(eq(schema.teams.id, current.id));
          await writeAudit(tx, current, actor.id, 'team.renamed', { from: current.name, to: name });
        }
        return { team_code: current.code, name };
      });
      return { ok: true as const, data };
    } catch (error) { return fail(error); }
  }

  async function listTeams(principalCode: string) {
    const principal = await activeUserByCode(db, principalCode);
    if (!principal) return [];
    const rows = await db.select({ team: schema.teams, sort_order: schema.teamMembers.sort_order }).from(schema.teamMembers)
      .innerJoin(schema.teams, eq(schema.teams.id, schema.teamMembers.team_id))
      .where(eq(schema.teamMembers.principal_id, principal.id))
      .orderBy(asc(schema.teamMembers.sort_order), asc(schema.teams.created_at), asc(schema.teams.code));
    return Promise.all(rows.map(async ({ team }) => {
      const role = await resolveTeamRole(db, team.id, principal.id);
      const [memberCounts, projects, owner, creator] = await Promise.all([
        db.select({ value: count() }).from(schema.teamMembers).where(eq(schema.teamMembers.team_id, team.id)),
        db.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.team_id, team.id)),
        team.owner_principal_id ? db.select({ code: schema.users.code }).from(schema.users).where(eq(schema.users.id, team.owner_principal_id)) : Promise.resolve([]),
        team.created_by ? db.select({ code: schema.users.code }).from(schema.users).where(eq(schema.users.id, team.created_by)) : Promise.resolve([]),
      ]);
      const visible = role === 'owner' || role === 'admin' ? projects : (await Promise.all(projects.map(async project => (await resolveProjectAccess(db, project.id, principal.id)) ? project : null))).filter(Boolean);
      return { team_code: team.code, name: team.name, role: role!, owner_code: owner[0]?.code ?? null, created_by: creator[0]?.code ?? null, ownership_pending: team.owner_principal_id === null, created_at: team.created_at, members_count: memberCounts[0]?.value ?? 0, projects_count: visible.length };
    }));
  }

  async function reorderTeams(cmd: { teamCodes: string[]; principalCode: string }) {
    try {
      const principal = await activeUserByCode(db, cmd.principalCode);
      if (!principal) return fail(new DomainError('user_not_found', `有效用户不存在：${cmd.principalCode}`));
      const rows = await db.select({ team_id: schema.teams.id, team_code: schema.teams.code }).from(schema.teamMembers)
        .innerJoin(schema.teams, eq(schema.teams.id, schema.teamMembers.team_id)).where(eq(schema.teamMembers.principal_id, principal.id));
      const uniqueCodes = new Set(cmd.teamCodes);
      const availableCodes = new Set(rows.map(row => row.team_code));
      if (uniqueCodes.size !== cmd.teamCodes.length || cmd.teamCodes.length !== rows.length || cmd.teamCodes.some(code => !availableCodes.has(code))) {
        return fail(new DomainError('team_order_invalid', '团队排序必须包含当前用户的全部团队且不能重复'));
      }
      const rowByCode = new Map(rows.map(row => [row.team_code, row]));
      await db.transaction(async tx => {
        for (const [sortOrder, teamCode] of cmd.teamCodes.entries()) {
          await tx.update(schema.teamMembers).set({ sort_order: sortOrder }).where(and(eq(schema.teamMembers.team_id, rowByCode.get(teamCode)!.team_id), eq(schema.teamMembers.principal_id, principal.id)));
        }
      });
      return { ok: true as const, data: { team_codes: cmd.teamCodes } };
    } catch (error) { return fail(error); }
  }

  async function listMembers(teamCode: string, actorPrincipalCode: string) {
    const [team, actor] = await Promise.all([findTeamByCode(db, teamCode), activeUserByCode(db, actorPrincipalCode)]);
    if (!team) return fail(new DomainError('team_not_found', `团队不存在：${teamCode}`));
    if (!actor) return fail(new DomainError('user_not_found', `有效用户不存在：${actorPrincipalCode}`));
    if (!(await resolveTeamRole(db, team.id, actor.id))) return fail(new DomainError('team_forbidden', '只有团队成员可以查看成员列表'));
    const rows = await db.select({ member: schema.teamMembers, user: schema.users }).from(schema.teamMembers)
      .innerJoin(schema.users, eq(schema.users.id, schema.teamMembers.principal_id)).where(eq(schema.teamMembers.team_id, team.id))
      .orderBy(asc(schema.teamMembers.created_at), asc(schema.users.code));
    return { ok: true as const, data: rows.map(({ member, user }) => ({
      user_code: user.code, account: user.account, role: team.owner_principal_id === user.id ? 'owner' as const : member.role === 'owner' && team.owner_principal_id !== null ? 'admin' as const : member.role,
      display_name: user.display_name, status: user.status, pending_deletion: user.pending_deletion, created_at: member.created_at,
    })) };
  }

  async function mutateMember(cmd: TeamMemberCommand, operation: 'add' | 'update' | 'remove', role?: TeamRole) {
    try {
      if (role !== undefined && role !== 'admin' && role !== 'member') throw new DomainError('member_role_invalid', '团队仅可授予 Admin 或 Member；Owner 必须通过所有权转移变更');
      const [team, actor, user] = await Promise.all([findTeamByCode(db, cmd.teamCode), findUserByCode(db, cmd.actorPrincipalCode), findUserByCode(db, cmd.userCode)]);
      if (!team) throw new DomainError('team_not_found', `团队不存在：${cmd.teamCode}`);
      if (!actor) throw new DomainError('user_not_found', `有效用户不存在：${cmd.actorPrincipalCode}`);
      if (!user) throw new DomainError('team_member_not_found', `团队成员不存在：${cmd.userCode}`);
      const data = await db.transaction(async tx => {
        const locked = await tx.select().from(schema.users).where(inArray(schema.users.id, [...new Set([actor.id, user.id])])).orderBy(asc(schema.users.id)).for('update');
        const actorUser = locked.find(row => row.id === actor.id);
        const targetUser = locked.find(row => row.id === user.id);
        if (actorUser?.status !== 'active' || actorUser.deleted_at) throw new DomainError('user_not_found', '操作账号已失效');
        if (!targetUser || (operation !== 'remove' && (targetUser.status !== 'active' || targetUser.deleted_at))) throw new DomainError('user_not_found', '只能授权有效用户');
        const [current] = await tx.select().from(schema.teams).where(eq(schema.teams.id, team.id)).for('update');
        if (!current) throw new DomainError('team_not_found', '团队不存在');
        const [target] = await tx.select().from(schema.teamMembers).where(and(eq(schema.teamMembers.team_id, current.id), eq(schema.teamMembers.principal_id, user.id)));
        const targetRole = current.owner_principal_id === user.id ? 'owner' : target?.role === 'owner' && current.owner_principal_id !== null ? 'admin' : target?.role;
        assertCanManage(await resolveTeamRole(tx, current.id, actor.id), targetRole, role);
        if (operation === 'add' && target) throw new DomainError('team_member_exists', `团队成员已存在：${cmd.userCode}`);
        if (operation !== 'add' && !target) throw new DomainError('team_member_not_found', `团队成员不存在：${cmd.userCode}`);
        if (operation === 'remove') {
          const revoked = await revokeTeamProjectAccess(tx, current, user, actor.id);
          await tx.delete(schema.teamMembers).where(and(eq(schema.teamMembers.team_id, current.id), eq(schema.teamMembers.principal_id, user.id)));
          await writeAudit(tx, current, actor.id, 'team.member_removed', { user_code: user.code, revoked_project_codes: revoked });
          return { user_code: user.code, role: null, display_name: targetUser.display_name, revoked_project_codes: revoked };
        }
        if (operation === 'add') {
          const [last] = await tx.select({ value: max(schema.teamMembers.sort_order) }).from(schema.teamMembers).where(eq(schema.teamMembers.principal_id, user.id));
          await tx.insert(schema.teamMembers).values({ team_id: current.id, principal_id: user.id, role: role!, display_name: targetUser.display_name, sort_order: (last?.value ?? -1) + 1, created_at: now() });
        } else {
          await tx.update(schema.teamMembers).set({ role: role!, display_name: targetUser.display_name }).where(and(eq(schema.teamMembers.team_id, current.id), eq(schema.teamMembers.principal_id, user.id)));
        }
        await writeAudit(tx, current, actor.id, operation === 'add' ? 'team.member_added' : 'team.member_role_updated', { user_code: user.code, from: targetRole ?? null, to: role });
        return { user_code: user.code, role: role!, display_name: targetUser.display_name };
      });
      return { ok: true as const, data };
    } catch (error) { return fail(error); }
  }

  async function revokeTeamProjectAccess(tx: Tx, team: typeof schema.teams.$inferSelect, user: typeof schema.users.$inferSelect, actorId: bigint) {
    const projects = await tx.select().from(schema.projects).where(eq(schema.projects.team_id, team.id)).orderBy(asc(schema.projects.id)).for('update');
    const projectIds = projects.map(project => project.id);
    const memberships = projectIds.length ? await tx.select().from(schema.members).where(and(eq(schema.members.principal_id, user.id), inArray(schema.members.project_id, projectIds))) : [];
    const owned = projects.filter(project => project.owner_principal_id === user.id || (project.owner_principal_id === null && memberships.some(member => member.project_id === project.id && member.role === 'owner')));
    if (owned.length) throw new DomainError('project_owner_protected', '该成员仍是项目负责人，请先完成项目所有权转移', { project_codes: owned.map(project => project.code), user_code: user.code });
    const tasks = projectIds.length ? await tx.select({ id: schema.tasks.id, code: schema.tasks.code, status: schema.tasks.status, assignee: schema.tasks.assignee_principal_id })
      .from(schema.tasks).innerJoin(schema.features, eq(schema.features.id, schema.tasks.feature_id)).where(inArray(schema.features.project_id, projectIds)) : [];
    const open = tasks.filter(task => task.assignee === user.id && !['closed', 'failed', 'cancelled'].includes(task.status));
    const runs = tasks.length ? await tx.select({ code: schema.runs.code }).from(schema.runs).where(and(eq(schema.runs.principal_id, user.id), inArray(schema.runs.task_id, tasks.map(task => task.id)), inArray(schema.runs.status, ['active', 'preparing', 'suspended']))) : [];
    if (open.length || runs.length) throw new DomainError('team_member_has_open_tasks', '该成员仍有未完成任务或运行，请先完成交接', { open_task_codes: open.map(task => task.code), active_run_codes: runs.map(run => run.code) });
    const revoked = [];
    for (const membership of memberships) {
      const project = projects.find(project => project.id === membership.project_id)!;
      const audit = { entity_type: 'project', entity_id: project.id, legacy_entity_code: project.legacy_code ?? undefined, principal_id: actorId, base_snapshot: 0, action: 'member.removed', payload: { user_code: user.code, via_team_code: team.code, from: membership.role, to: null } };
      assertAuditedChange(audit);
      await insertAudit(tx, toAuditEvent(audit, createPublicCode(), now()));
      revoked.push(project.code);
    }
    if (projectIds.length) await tx.delete(schema.members).where(and(eq(schema.members.principal_id, user.id), inArray(schema.members.project_id, projectIds)));
    return revoked;
  }

  async function memberRemovalImpact(cmd: TeamMemberCommand) {
    try {
      const [team, actor, user] = await Promise.all([findTeamByCode(db, cmd.teamCode), activeUserByCode(db, cmd.actorPrincipalCode), findUserByCode(db, cmd.userCode)]);
      if (!team) throw new DomainError('team_not_found', '团队不存在');
      if (!actor) throw new DomainError('user_not_found', '操作账号已失效');
      if (!user) throw new DomainError('team_member_not_found', '团队成员不存在');
      const [target] = await db.select().from(schema.teamMembers).where(and(eq(schema.teamMembers.team_id, team.id), eq(schema.teamMembers.principal_id, user.id)));
      if (!target) throw new DomainError('team_member_not_found', '团队成员不存在');
      const targetRole = team.owner_principal_id === user.id ? 'owner' : target.role === 'owner' && team.owner_principal_id !== null ? 'admin' : target.role;
      assertCanManage(await resolveTeamRole(db, team.id, actor.id), targetRole);
      const projects = await db.select().from(schema.projects).where(eq(schema.projects.team_id, team.id)).orderBy(asc(schema.projects.id));
      const ids = projects.map(project => project.id);
      const explicit = ids.length ? await db.select().from(schema.members).where(and(eq(schema.members.principal_id, user.id), inArray(schema.members.project_id, ids))) : [];
      const affected = projects.flatMap(project => {
        const member = explicit.find(row => row.project_id === project.id);
        const owner = project.owner_principal_id === user.id || (project.owner_principal_id === null && member?.role === 'owner');
        const role = owner ? 'owner' : member ? member.role === 'owner' ? 'admin' : member.role : project.member_policy === 'team_write' ? 'member' : project.member_policy === 'team_read' ? 'viewer' : null;
        return role ? [{ project_code: project.code, name: project.name, role, access_source: owner ? 'owner' : member ? 'explicit' : 'team' }] : [];
      });
      const tasks = ids.length ? await db.select({ id: schema.tasks.id, task_code: schema.tasks.code, status: schema.tasks.status, assignee: schema.tasks.assignee_principal_id, project_id: schema.features.project_id })
        .from(schema.tasks).innerJoin(schema.features, eq(schema.features.id, schema.tasks.feature_id)).where(inArray(schema.features.project_id, ids)) : [];
      const openTasks = tasks.filter(task => task.assignee === user.id && !['closed', 'failed', 'cancelled'].includes(task.status));
      const runs = tasks.length ? await db.select({ run_code: schema.runs.code, task_id: schema.runs.task_id, status: schema.runs.status }).from(schema.runs).where(and(
        eq(schema.runs.principal_id, user.id), inArray(schema.runs.task_id, tasks.map(task => task.id)), inArray(schema.runs.status, ['active', 'preparing', 'suspended']),
      )) : [];
      return { ok: true as const, data: {
        projects: affected,
        blocked_owned_projects: affected.filter(project => project.role === 'owner'),
        open_tasks: openTasks.map(task => ({ task_code: task.task_code, project_code: projects.find(project => project.id === task.project_id)!.code, status: task.status })),
        active_runs: runs.map(run => ({ run_code: run.run_code, task_code: tasks.find(task => task.id === run.task_id)!.task_code, status: run.status })),
      } };
    } catch (error) { return fail(error); }
  }

  async function listProjectGovernance(teamCode: string, actorPrincipalCode: string) {
    try {
      const [team, actor] = await Promise.all([findTeamByCode(db, teamCode), activeUserByCode(db, actorPrincipalCode)]);
      if (!team) throw new DomainError('team_not_found', '团队不存在');
      if (!actor) throw new DomainError('user_not_found', '有效用户不存在');
      assertCanManage(await resolveTeamRole(db, team.id, actor.id));
      const projects = await db.select().from(schema.projects).where(eq(schema.projects.team_id, team.id)).orderBy(asc(schema.projects.created_at), asc(schema.projects.code));
      const ownerIds = projects.map(project => project.owner_principal_id).filter((id): id is bigint => id !== null);
      const owners = ownerIds.length ? await db.select().from(schema.users).where(inArray(schema.users.id, ownerIds)) : [];
      const ownerById = new Map(owners.map(owner => [owner.id, owner]));
      const data = await Promise.all(projects.map(async project => ({
        project_code: project.code, name: project.name, status: project.status,
        owner_user_code: project.owner_principal_id ? ownerById.get(project.owner_principal_id)?.code ?? null : null,
        owner_name: project.owner_principal_id ? ownerById.get(project.owner_principal_id)?.display_name ?? null : null,
        ownership_pending: project.owner_principal_id === null,
        can_access: Boolean(await resolveProjectAccess(db, project.id, actor.id)),
      })));
      return { ok: true as const, data };
    } catch (error) { return fail(error); }
  }

  return {
    createTeam, renameTeam, listTeams, reorderTeams, listMembers, memberRemovalImpact, listProjectGovernance,
    addMember: (cmd: TeamMemberCommand & { role: TeamRole }) => mutateMember(cmd, 'add', cmd.role),
    updateMemberRole: (cmd: TeamMemberCommand & { role: TeamRole }) => mutateMember(cmd, 'update', cmd.role),
    removeMember: (cmd: TeamMemberCommand) => mutateMember(cmd, 'remove'),
  };
}

export type TeamUseCases = ReturnType<typeof createTeamUseCases>;
