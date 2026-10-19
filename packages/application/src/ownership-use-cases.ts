import { and, asc, desc, eq, inArray, isNull, max, or, sql } from 'drizzle-orm';
import { schema, type Db } from '@team-synergy/persistence';
import { DomainError, assertAuditedChange, toAuditEvent } from '@team-synergy/domain';
import { fail, insertAudit, now } from './task-service.js';
import { createPublicCode, findProjectByCode, findTeamByCode, findUserByCode } from './public-code.js';
import { resolveTeamRole, type AccessDb } from './project-access.js';
import { revokeStableDevice } from './auth-device.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Scope = 'team' | 'project';
type ScopeRecord = { scope: Scope; id: bigint; teamId: bigint; code: string; name: string; ownerId: bigint | null };
type User = typeof schema.users.$inferSelect;
type Transfer = typeof schema.ownershipTransfers.$inferSelect;
type TransferCommand = { scope: Scope; scopeCode: string; targetUserCode: string; actorPrincipalCode: string; reason?: string; recovery?: boolean };

function assertActive(user: User | undefined): asserts user is User {
  if (!user || user.status !== 'active' || user.deleted_at) throw new DomainError('user_not_found', '有效用户不存在');
}

async function audit(tx: Tx, scope: Scope | 'user', id: bigint, actorId: bigint, action: string, payload: Record<string, unknown>) {
  const event = { entity_type: scope, entity_id: id, principal_id: actorId, base_snapshot: 0, action, payload };
  assertAuditedChange(event);
  await insertAudit(tx, toAuditEvent(event, createPublicCode(), now()));
}

async function scopeById(db: AccessDb, scope: Scope, id: bigint): Promise<ScopeRecord | null> {
  if (scope === 'team') {
    const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, id));
    return team ? { scope, id, teamId: id, code: team.code, name: team.name, ownerId: team.owner_principal_id } : null;
  }
  const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, id));
  return project ? { scope, id, teamId: project.team_id, code: project.code, name: project.name, ownerId: project.owner_principal_id } : null;
}

async function lockScope(tx: Tx, scope: ScopeRecord) {
  await tx.select({ id: schema.teams.id }).from(schema.teams).where(eq(schema.teams.id, scope.teamId)).for('update');
  if (scope.scope === 'project') await tx.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.id, scope.id)).for('update');
  const current = await scopeById(tx, scope.scope, scope.id);
  if (!current) throw new DomainError('ownership_scope_not_found', '团队或项目不存在');
  return current;
}

async function lockUsers(tx: Tx, ids: bigint[]) {
  const rows = await tx.select().from(schema.users).where(inArray(schema.users.id, [...new Set(ids)])).orderBy(asc(schema.users.id)).for('update');
  return new Map(rows.map(user => [user.id, user]));
}

async function assertRecipient(tx: AccessDb, scope: ScopeRecord, user: User | undefined) {
  assertActive(user);
  if (user.pending_deletion) throw new DomainError('account_pending_deletion', '待注销账号不能接收所有权');
  const [membership] = await tx.select().from(schema.teamMembers).where(and(eq(schema.teamMembers.team_id, scope.teamId), eq(schema.teamMembers.principal_id, user.id)));
  if (!membership) throw new DomainError('ownership_recipient_not_team_member', '接收人必须是所属团队的正式成员');
}

async function assertRecoveryAuthority(tx: AccessDb, scope: ScopeRecord, actor: User | undefined, owner: User | undefined) {
  assertActive(actor);
  if (owner?.status === 'active' && !owner.deleted_at) throw new DomainError('ownership_recovery_not_required', '当前负责人有效，应使用正常转移流程');
  const permitted = scope.scope === 'team' ? actor.is_system_admin : await resolveTeamRole(tx, scope.teamId, actor.id) === 'owner';
  if (!permitted) throw new DomainError('ownership_recovery_forbidden', '只有团队负责人可恢复项目所有权，团队恢复由平台管理员处理');
}

async function storeAdminMembership(tx: Tx, scope: ScopeRecord, user: User) {
  if (scope.scope === 'team') {
    const [last] = await tx.select({ value: max(schema.teamMembers.sort_order) }).from(schema.teamMembers).where(eq(schema.teamMembers.principal_id, user.id));
    await tx.insert(schema.teamMembers).values({ team_id: scope.id, principal_id: user.id, role: 'admin', display_name: user.display_name, sort_order: (last?.value ?? -1) + 1, created_at: now() })
      .onConflictDoUpdate({ target: [schema.teamMembers.team_id, schema.teamMembers.principal_id], set: { role: 'admin', display_name: user.display_name } });
  } else {
    const [last] = await tx.select({ value: max(schema.members.sort_order) }).from(schema.members).where(eq(schema.members.principal_id, user.id));
    await tx.insert(schema.members).values({ project_id: scope.id, principal_id: user.id, role: 'admin', display_name: user.display_name, sort_order: (last?.value ?? -1) + 1, created_at: now() })
      .onConflictDoUpdate({ target: [schema.members.principal_id, schema.members.project_id], set: { role: 'admin', display_name: user.display_name } });
  }
}

export function createOwnershipUseCases(db: Db) {
  async function getScope(scope: Scope, code: string) {
    if (scope !== 'team' && scope !== 'project') throw new DomainError('ownership_scope_invalid', '所有权范围必须为 team 或 project');
    const row = scope === 'team' ? await findTeamByCode(db, code) : await findProjectByCode(db, code);
    const record = row ? await scopeById(db, scope, row.id) : null;
    if (!record) throw new DomainError('ownership_scope_not_found', '团队或项目不存在');
    return record;
  }

  async function transferDto(ctx: AccessDb, transfer: Transfer) {
    const [scope, users] = await Promise.all([
      scopeById(ctx, transfer.scope, transfer.scope_id),
      ctx.select().from(schema.users).where(inArray(schema.users.id, [transfer.from_principal_id, transfer.to_principal_id, transfer.initiated_by])),
    ]);
    const byId = new Map(users.map(user => [user.id, user]));
    return {
      code: transfer.code, scope: transfer.scope, scope_code: scope?.code ?? '', scope_name: scope?.name ?? '',
      target_user_code: byId.get(transfer.to_principal_id)?.code ?? '', from_user_code: byId.get(transfer.from_principal_id)?.code ?? '',
      initiated_by_code: byId.get(transfer.initiated_by)?.code ?? '', is_recovery: transfer.is_recovery, reason: transfer.reason,
      status: transfer.status, created_at: transfer.created_at, expires_at: transfer.expires_at, completed_at: transfer.completed_at,
    };
  }

  async function listTransfers(principalCode: string) {
    try {
      const actor = await findUserByCode(db, principalCode);
      assertActive(actor);
      const rows = await db.select().from(schema.ownershipTransfers).where(or(eq(schema.ownershipTransfers.from_principal_id, actor.id), eq(schema.ownershipTransfers.to_principal_id, actor.id), eq(schema.ownershipTransfers.initiated_by, actor.id)))
        .orderBy(desc(schema.ownershipTransfers.created_at));
      return { ok: true as const, data: await Promise.all(rows.map(row => transferDto(db, row))) };
    } catch (error) { return fail(error); }
  }

  async function requestTransfer(cmd: TransferCommand) {
    try {
      const [initial, actor, target] = await Promise.all([getScope(cmd.scope, cmd.scopeCode), findUserByCode(db, cmd.actorPrincipalCode), findUserByCode(db, cmd.targetUserCode)]);
      assertActive(actor);
      assertActive(target);
      if (initial.ownerId === null) throw new DomainError('ownership_resolution_required', '历史负责人尚未确认，请先完成所有权确认');
      if (initial.ownerId === target.id) throw new DomainError('ownership_same_owner', '接收人已是当前负责人');
      const reason = cmd.reason?.trim() || null;
      if (cmd.recovery && !reason) throw new DomainError('ownership_recovery_reason_required', '恢复所有权必须填写原因');
      const data = await db.transaction(async tx => {
        const users = await lockUsers(tx, [actor.id, target.id, initial.ownerId!]);
        const currentActor = users.get(actor.id);
        assertActive(currentActor);
        const current = await lockScope(tx, initial);
        if (current.ownerId !== initial.ownerId) throw new DomainError('ownership_changed', '负责人已变更，请刷新后重试');
        if (cmd.recovery) await assertRecoveryAuthority(tx, current, currentActor, users.get(current.ownerId!));
        else if (current.ownerId !== currentActor.id) throw new DomainError('ownership_forbidden', '只有当前负责人可以发起所有权转移');
        await assertRecipient(tx, current, users.get(target.id));
        const [pending] = await tx.select().from(schema.ownershipTransfers).where(and(eq(schema.ownershipTransfers.scope, current.scope), eq(schema.ownershipTransfers.scope_id, current.id), eq(schema.ownershipTransfers.status, 'pending'))).for('update');
        const timestamp = now();
        if (pending && Date.parse(pending.expires_at) > Date.parse(timestamp)) throw new DomainError('ownership_transfer_pending', '已有待接收的转移请求，请先取消或等待其到期');
        if (pending) {
          await tx.update(schema.ownershipTransfers).set({ status: 'cancelled', completed_at: timestamp }).where(eq(schema.ownershipTransfers.id, pending.id));
          await audit(tx, current.scope, current.id, currentActor.id, 'ownership.transfer_expired', { transfer_code: pending.code });
        }
        const [transfer] = await tx.insert(schema.ownershipTransfers).values({ code: createPublicCode(), scope: current.scope, scope_id: current.id, from_principal_id: current.ownerId!, to_principal_id: target.id, initiated_by: currentActor.id, is_recovery: cmd.recovery ?? false, reason, status: 'pending', created_at: timestamp, expires_at: new Date(Date.parse(timestamp) + 7 * 24 * 60 * 60 * 1000).toISOString() }).returning();
        if (!transfer) throw new DomainError('internal_error', '转移请求创建失败');
        await audit(tx, current.scope, current.id, currentActor.id, cmd.recovery ? 'ownership.recovery_requested' : 'ownership.transfer_requested', { transfer_code: transfer.code, from_user_code: users.get(current.ownerId!)?.code, target_user_code: target.code, reason });
        return transferDto(tx, transfer);
      });
      return { ok: true as const, data };
    } catch (error) { return fail(error); }
  }

  async function changeTransfer(cmd: { transferCode: string; actorPrincipalCode: string }, operation: 'accept' | 'cancel') {
    try {
      const [initial] = await db.select().from(schema.ownershipTransfers).where(eq(schema.ownershipTransfers.code, cmd.transferCode));
      if (!initial) throw new DomainError('ownership_transfer_not_found', '转移请求不存在');
      const actor = await findUserByCode(db, cmd.actorPrincipalCode);
      assertActive(actor);
      const initialScope = await scopeById(db, initial.scope, initial.scope_id);
      if (!initialScope) throw new DomainError('ownership_scope_not_found', '团队或项目不存在');
      const data = await db.transaction(async tx => {
        const users = await lockUsers(tx, [actor.id, initial.from_principal_id, initial.to_principal_id, initial.initiated_by]);
        const currentActor = users.get(actor.id);
        assertActive(currentActor);
        const current = await lockScope(tx, initialScope);
        const [transfer] = await tx.select().from(schema.ownershipTransfers).where(eq(schema.ownershipTransfers.id, initial.id)).for('update');
        if (!transfer) throw new DomainError('ownership_transfer_not_found', '转移请求不存在');
        if (transfer.status !== 'pending') throw new DomainError('ownership_transfer_not_pending', '该转移请求已处理');
        if (operation === 'cancel') {
          if (![transfer.from_principal_id, transfer.to_principal_id, transfer.initiated_by].includes(actor.id)) throw new DomainError('ownership_forbidden', '只有转移参与人可以取消请求');
        } else {
          if (transfer.to_principal_id !== actor.id) throw new DomainError('ownership_recipient_required', '只能由接收人本人接受转移');
          if (!Number.isFinite(Date.parse(transfer.expires_at)) || Date.parse(transfer.expires_at) <= Date.now()) throw new DomainError('ownership_transfer_expired', '转移请求已到期，请重新发起');
          if (current.ownerId !== transfer.from_principal_id) throw new DomainError('ownership_changed', '负责人已变更，此请求不能继续使用');
          await assertRecipient(tx, current, currentActor);
          if (transfer.is_recovery) await assertRecoveryAuthority(tx, current, users.get(transfer.initiated_by), users.get(transfer.from_principal_id));
          else assertActive(users.get(transfer.from_principal_id));
          if (current.scope === 'team') await tx.update(schema.teams).set({ owner_principal_id: actor.id }).where(eq(schema.teams.id, current.id));
          else await tx.update(schema.projects).set({ owner_principal_id: actor.id }).where(eq(schema.projects.id, current.id));
          await storeAdminMembership(tx, current, currentActor);
          const oldOwner = users.get(transfer.from_principal_id);
          if (oldOwner) await storeAdminMembership(tx, current, oldOwner);
        }
        const [updated] = await tx.update(schema.ownershipTransfers).set({ status: operation === 'accept' ? 'accepted' : 'cancelled', completed_at: now() }).where(eq(schema.ownershipTransfers.id, transfer.id)).returning();
        await audit(tx, current.scope, current.id, actor.id, operation === 'accept' ? transfer.is_recovery ? 'ownership.recovery_accepted' : 'ownership.transfer_accepted' : 'ownership.transfer_cancelled', {
          transfer_code: transfer.code, from_user_code: users.get(transfer.from_principal_id)?.code, target_user_code: users.get(transfer.to_principal_id)?.code,
          initiated_by_code: users.get(transfer.initiated_by)?.code, is_recovery: transfer.is_recovery, reason: transfer.reason,
        });
        return transferDto(tx, updated!);
      });
      return { ok: true as const, data };
    } catch (error) { return fail(error); }
  }

  async function resolveOwnership(cmd: { scope: Scope; scopeCode: string; ownerUserCode: string; actorPrincipalCode: string }) {
    try {
      const [initial, actor, target] = await Promise.all([getScope(cmd.scope, cmd.scopeCode), findUserByCode(db, cmd.actorPrincipalCode), findUserByCode(db, cmd.ownerUserCode)]);
      assertActive(actor);
      if (!target) throw new DomainError('user_not_found', '历史负责人不存在');
      const data = await db.transaction(async tx => {
        const users = await lockUsers(tx, [actor.id, target.id]);
        const currentActor = users.get(actor.id);
        assertActive(currentActor);
        const current = await lockScope(tx, initial);
        if (current.ownerId !== null) throw new DomainError('ownership_already_resolved', '该团队或项目已有唯一负责人');
        const memberships = current.scope === 'team'
          ? await tx.select({ principal_id: schema.teamMembers.principal_id, role: schema.teamMembers.role }).from(schema.teamMembers).where(eq(schema.teamMembers.team_id, current.id))
          : await tx.select({ principal_id: schema.members.principal_id, role: schema.members.role }).from(schema.members).where(eq(schema.members.project_id, current.id));
        const owners = memberships.filter(member => member.role === 'owner');
        if (!currentActor.is_system_admin && !owners.some(member => member.principal_id === actor.id)) throw new DomainError('ownership_forbidden', '只有历史负责人或平台管理员可以确认负责人');
        if (!owners.some(member => member.principal_id === target.id)) throw new DomainError('ownership_resolution_target_invalid', '只能选择现有历史负责人，不得通过迁移授予新权限');
        const selectedOwner = users.get(target.id);
        // Resolving an existing, unavailable legacy owner establishes historical
        // responsibility only. A platform admin can then use recovery; it must
        // never grant a new user ownership or reactivate the old account.
        if (currentActor.is_system_admin && selectedOwner && (selectedOwner.status !== 'active' || selectedOwner.deleted_at)) {
          const [formalMember] = await tx.select({ id: schema.teamMembers.principal_id }).from(schema.teamMembers).where(and(eq(schema.teamMembers.team_id, current.teamId), eq(schema.teamMembers.principal_id, target.id)));
          if (!formalMember) throw new DomainError('ownership_recipient_not_team_member', '历史负责人不属于团队，需单独处理其迁移归属');
        } else await assertRecipient(tx, current, selectedOwner);
        if (current.scope === 'team') {
          await tx.update(schema.teams).set({ owner_principal_id: target.id }).where(eq(schema.teams.id, current.id));
          await tx.update(schema.teamMembers).set({ role: 'admin' }).where(and(eq(schema.teamMembers.team_id, current.id), eq(schema.teamMembers.role, 'owner')));
        } else {
          await tx.update(schema.projects).set({ owner_principal_id: target.id }).where(eq(schema.projects.id, current.id));
          await tx.update(schema.members).set({ role: 'admin' }).where(and(eq(schema.members.project_id, current.id), eq(schema.members.role, 'owner')));
        }
        await audit(tx, current.scope, current.id, actor.id, 'ownership.legacy_resolved', { owner_user_code: target.code, previous_owner_ids: owners.map(owner => owner.principal_id.toString()), preserved_role: 'admin', creator_backfill: 'unchanged', requires_recovery: selectedOwner?.status !== 'active' || Boolean(selectedOwner?.deleted_at) });
        return { scope: current.scope, scope_code: current.code, owner_user_code: target.code };
      });
      return { ok: true as const, data };
    } catch (error) { return fail(error); }
  }

  async function closureData(ctx: AccessDb, user: User) {
    const [ownedTeams, ownedProjects, legacyTeams, legacyProjects, tasks, runs] = await Promise.all([
      ctx.select().from(schema.teams).where(eq(schema.teams.owner_principal_id, user.id)),
      ctx.select().from(schema.projects).where(eq(schema.projects.owner_principal_id, user.id)),
      ctx.select({ team: schema.teams }).from(schema.teamMembers).innerJoin(schema.teams, eq(schema.teams.id, schema.teamMembers.team_id)).where(and(eq(schema.teamMembers.principal_id, user.id), eq(schema.teamMembers.role, 'owner'), isNull(schema.teams.owner_principal_id))),
      ctx.select({ project: schema.projects }).from(schema.members).innerJoin(schema.projects, eq(schema.projects.id, schema.members.project_id)).where(and(eq(schema.members.principal_id, user.id), eq(schema.members.role, 'owner'), isNull(schema.projects.owner_principal_id))),
      ctx.select().from(schema.tasks).where(eq(schema.tasks.assignee_principal_id, user.id)),
      ctx.select().from(schema.runs).where(and(eq(schema.runs.principal_id, user.id), inArray(schema.runs.status, ['active', 'preparing', 'suspended']))),
    ]);
    return {
      pending_deletion: user.pending_deletion,
      teams: [...ownedTeams.map(team => ({ code: team.code, name: team.name, ownership_pending: false })), ...legacyTeams.map(({ team }) => ({ code: team.code, name: team.name, ownership_pending: true }))],
      projects: [...ownedProjects.map(project => ({ code: project.code, name: project.name, status: project.status, ownership_pending: false })), ...legacyProjects.map(({ project }) => ({ code: project.code, name: project.name, status: project.status, ownership_pending: true }))],
      open_tasks: tasks.filter(task => !['closed', 'failed', 'cancelled'].includes(task.status)).map(task => ({ code: task.code, title: task.title, status: task.status })),
      active_runs: runs.map(run => ({ code: run.code, status: run.status })),
    };
  }

  async function closureStatus(principalCode: string) {
    try { const user = await findUserByCode(db, principalCode); assertActive(user); return { ok: true as const, data: await closureData(db, user) }; }
    catch (error) { return fail(error); }
  }

  async function changeClosure(principalCode: string, operation: 'begin' | 'cancel' | 'complete') {
    try {
      const actor = await findUserByCode(db, principalCode);
      assertActive(actor);
      const data = await db.transaction(async tx => {
        // Serialize final account closures before user locks, including the
        // last-admin check; two administrators must not close concurrently.
        if (operation === 'complete') await tx.execute(sql`select pg_advisory_xact_lock(hashtext('account-closure-platform-admins'))`);
        const users = await lockUsers(tx, [actor.id]);
        const current = users.get(actor.id);
        assertActive(current);
        if (operation !== 'complete') {
          const pending = operation === 'begin';
          await tx.update(schema.users).set({ pending_deletion: pending }).where(eq(schema.users.id, current.id));
          await audit(tx, 'user', current.id, current.id, pending ? 'account.closure_started' : 'account.closure_cancelled', {});
          return closureData(tx, { ...current, pending_deletion: pending });
        }
        if (!current.pending_deletion) throw new DomainError('account_closure_not_started', '请先开始账号注销流程');
        const status = await closureData(tx, current);
        if (status.teams.length || status.projects.length || status.open_tasks.length || status.active_runs.length) throw new DomainError('account_closure_blocked', '请先转移全部所有权并完成任务和运行交接', status);
        if (current.is_system_admin) {
          const others = await tx.select({ id: schema.users.id }).from(schema.users).where(and(eq(schema.users.is_system_admin, true), eq(schema.users.status, 'active'), isNull(schema.users.deleted_at)));
          if (others.every(user => user.id === current.id)) throw new DomainError('last_system_admin_protected', '请先配置其他有效平台管理员');
        }
        const timestamp = now();
        const [devices, runs] = await Promise.all([
          tx.select({ id: schema.devices.id }).from(schema.devices).where(eq(schema.devices.principal_id, current.id)),
          tx.select({ id: schema.runs.id }).from(schema.runs).where(eq(schema.runs.principal_id, current.id)),
        ]);
        const leaseConditions = [];
        if (devices.length) leaseConditions.push(inArray(schema.runLeases.device_id, devices.map(device => device.id)));
        if (runs.length) leaseConditions.push(inArray(schema.runLeases.run_id, runs.map(run => run.id)));
        if (leaseConditions.length) await tx.update(schema.runLeases).set({ revoked_at: timestamp }).where(and(isNull(schema.runLeases.revoked_at), or(...leaseConditions)));
        for (const device of devices) await revokeStableDevice(tx, device.id);
        await tx.update(schema.ownershipTransfers).set({ status: 'cancelled', completed_at: timestamp }).where(and(eq(schema.ownershipTransfers.status, 'pending'), or(eq(schema.ownershipTransfers.to_principal_id, current.id), eq(schema.ownershipTransfers.initiated_by, current.id))));
        await tx.update(schema.users).set({ status: 'disabled', pending_deletion: false, deleted_at: timestamp, password_hash: null, bind_token_hash: null, bind_token_expires_at: null }).where(eq(schema.users.id, current.id));
        await audit(tx, 'user', current.id, current.id, 'account.closed', { revoked_devices: devices.length, retained_history: true });
        return { ...status, pending_deletion: false, closed: true, user_code: current.code };
      });
      return { ok: true as const, data };
    } catch (error) { return fail(error); }
  }

  return {
    listTransfers, requestTransfer, resolveOwnership, closureStatus,
    acceptTransfer: (cmd: { transferCode: string; actorPrincipalCode: string }) => changeTransfer(cmd, 'accept'),
    cancelTransfer: (cmd: { transferCode: string; actorPrincipalCode: string }) => changeTransfer(cmd, 'cancel'),
    beginClosure: (principalCode: string) => changeClosure(principalCode, 'begin'),
    cancelClosure: (principalCode: string) => changeClosure(principalCode, 'cancel'),
    completeClosure: (principalCode: string) => changeClosure(principalCode, 'complete'),
  };
}

export type OwnershipUseCases = ReturnType<typeof createOwnershipUseCases>;
