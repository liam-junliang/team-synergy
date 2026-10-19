import { writeProjectModule } from './intake-entity-writers.js';
import { assertProjectAccess, effectiveProjectMember, isProjectManager } from './project-access.js';
import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import type { Db } from '@team-synergy/persistence';
import { schema } from '@team-synergy/persistence';
import { DomainError, assertAuditedChange, toAuditEvent } from '@team-synergy/domain';
import { fail, insertAudit, now } from './task-service.js';
import {
  createPublicCode,
  findProjectByCode,
  findProjectMilestoneByCode,
  findProjectModuleByCode,
  findProjectPhaseByCode,
  findUserByCode,
} from './public-code.js';
import { assertScheduleOrder, normalizeScheduleDate } from './schedule.js';

export const MODULE_STATUSES = ['active', 'archived'] as const;
export type ModuleStatus = (typeof MODULE_STATUSES)[number];
export const PHASE_STATUSES = ['planned', 'active', 'completed', 'archived'] as const;
export type PhaseStatus = (typeof PHASE_STATUSES)[number];
export const MILESTONE_STATUSES = ['planned', 'active', 'at_risk', 'completed', 'cancelled'] as const;
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];

type ModuleRow = typeof schema.projectModules.$inferSelect;
type PhaseRow = typeof schema.projectPhases.$inferSelect;
type MilestoneRow = typeof schema.projectMilestones.$inferSelect;

async function memberInProject(db: Db, projectId: bigint, principalId: bigint) {
  const membership = await effectiveProjectMember(db, projectId, principalId);
  return membership;
}

async function usersByIds(db: Db, ids: bigint[]) {
  if (ids.length === 0) return new Map<bigint, typeof schema.users.$inferSelect>();
  const rows = await db.select().from(schema.users).where(inArray(schema.users.id, ids));
  return new Map(rows.map((row) => [row.id, row]));
}

async function phasesByIds(db: Db, ids: bigint[]) {
  if (ids.length === 0) return new Map<bigint, PhaseRow>();
  const rows = await db.select().from(schema.projectPhases).where(inArray(schema.projectPhases.id, ids));
  return new Map(rows.map((row) => [row.id, row]));
}

function toModuleSummary(module: ModuleRow, projectCode: string) {
  return {
    module_code: module.code,
    project_code: projectCode,
    name: module.name,
    description: module.description,
    sort_order: module.sort_order,
    status: module.status,
    created_at: module.created_at,
    updated_at: module.updated_at,
  };
}

function toPhaseSummary(phase: PhaseRow, projectCode: string) {
  return {
    phase_code: phase.code,
    project_code: projectCode,
    name: phase.name,
    goal: phase.goal,
    sort_order: phase.sort_order,
    start_date: phase.start_date,
    end_date: phase.end_date,
    status: phase.status,
    created_at: phase.created_at,
    updated_at: phase.updated_at,
  };
}

function toMilestoneSummary(
  milestone: MilestoneRow,
  projectCode: string,
  phase: PhaseRow | undefined,
  owner: typeof schema.users.$inferSelect | undefined,
  counts: {
    feature_count: number;
    delivered_feature_count: number;
    task_total: number;
    closed_task_count: number;
  },
) {
  return {
    milestone_code: milestone.code,
    project_code: projectCode,
    phase_code: phase?.code ?? '',
    phase_name: phase?.name ?? '',
    name: milestone.name,
    goal: milestone.goal,
    start_date: milestone.start_date,
    target_date: milestone.target_date,
    sort_order: milestone.sort_order,
    status: milestone.status,
    owner_principal_code: owner?.code ?? null,
    owner_display_name: owner?.display_name ?? null,
    created_at: milestone.created_at,
    updated_at: milestone.updated_at,
    ...counts,
  };
}

async function mustAccessProject(db: Db, projectCode: string, principalCode: string) {
  const [project, principal] = await Promise.all([
    findProjectByCode(db, projectCode),
    findUserByCode(db, principalCode),
  ]);
  if (!project || !principal || principal.status !== 'active') {
    throw new DomainError('project_forbidden', '项目不存在或当前用户无权访问', { project_code: projectCode });
  }
  const membership = await memberInProject(db, project.id, principal.id);
  if (!membership) {
    throw new DomainError('project_forbidden', '项目不存在或当前用户无权访问', { project_code: projectCode });
  }
  return { project, principal, membership };
}

async function mustAccessProjectOwnerByEntity(
  db: Db,
  entity:
    | { project_id: bigint }
    | undefined,
  principalCode: string,
  errorCode: string,
  errorMessage: string,
) {
  if (!entity) throw new DomainError(errorCode, errorMessage);
  const [project, principal] = await Promise.all([
    db.select().from(schema.projects).where(eq(schema.projects.id, entity.project_id)).limit(1).then((rows) => rows[0]),
    findUserByCode(db, principalCode),
  ]);
  if (!project || !principal || principal.status !== 'active') {
    throw new DomainError('project_forbidden', '项目不存在或当前用户无权访问', { project_id: String(entity.project_id) });
  }
  const membership = await memberInProject(db, project.id, principal.id);
  if (!membership || !isProjectManager(membership.role)) {
    throw new DomainError('project_forbidden', '只有项目 Owner 可以修改项目结构', { principal_code: principal.code });
  }
  await assertProjectAccess(db, project.id, principal.id, 'manage');
  return { project, principal, membership };
}

export function createProjectStructureUseCases(db: Db) {
  async function listModules(cmd: { projectCode: string; principalCode: string }) {
    try {
      const access = await mustAccessProject(db, cmd.projectCode, cmd.principalCode);
      const rows = await db.select().from(schema.projectModules)
        .where(eq(schema.projectModules.project_id, access.project.id))
        .orderBy(asc(schema.projectModules.sort_order), asc(schema.projectModules.id));
      return { ok: true as const, data: rows.map((row) => toModuleSummary(row, access.project.code)) };
    } catch (error) {
      return fail(error);
    }
  }

  async function createModule(cmd: {
    projectCode: string;
    principalCode: string;
    name: string;
    description?: string;
    sortOrder?: number;
    status?: ModuleStatus;
  }) {
    try {
      const access = await mustAccessProject(db, cmd.projectCode, cmd.principalCode);
      await assertProjectAccess(db, access.project.id, access.principal.id, 'manage');
      if (!isProjectManager(access.membership.role)) {
        return fail(new DomainError('project_forbidden', '只有项目 Owner 可以创建功能模块'));
      }
      const name = cmd.name.trim();
      if (!name) return fail(new DomainError('module_name_required', '功能模块名称不能为空'));
      const module = await db.transaction(tx => writeProjectModule(tx, {
        projectId: access.project.id, projectCode: access.project.code, principalId: access.principal.id,
      }, { name, description: cmd.description, sortOrder: cmd.sortOrder, status: cmd.status }));
      return { ok: true as const, data: toModuleSummary(module, access.project.code) };
    } catch (error) {
      return fail(error);
    }
  }

  async function reorderModules(cmd: { projectCode: string; principalCode: string; moduleCodes: string[] }) {
    try {
      const access = await mustAccessProject(db, cmd.projectCode, cmd.principalCode);
      await assertProjectAccess(db, access.project.id, access.principal.id, 'manage');
      if (!isProjectManager(access.membership.role)) {
        return fail(new DomainError('project_forbidden', '只有项目 Owner 可以调整功能模块顺序'));
      }
      const rows = await db.select({ id: schema.projectModules.id, code: schema.projectModules.code })
        .from(schema.projectModules)
        .where(eq(schema.projectModules.project_id, access.project.id));
      const uniqueCodes = new Set(cmd.moduleCodes);
      const availableCodes = new Set(rows.map((row) => row.code));
      if (uniqueCodes.size !== cmd.moduleCodes.length
        || cmd.moduleCodes.length !== rows.length
        || cmd.moduleCodes.some((code) => !availableCodes.has(code))) {
        return fail(new DomainError('module_order_invalid', '模块排序必须包含当前项目的全部模块且不能重复'));
      }
      const rowByCode = new Map(rows.map((row) => [row.code, row]));
      const changedAt = now();
      await db.transaction(async (tx) => {
        for (const [sortOrder, moduleCode] of cmd.moduleCodes.entries()) {
          await tx.update(schema.projectModules).set({ sort_order: sortOrder, updated_at: changedAt })
            .where(eq(schema.projectModules.id, rowByCode.get(moduleCode)!.id));
        }
      });
      return { ok: true as const, data: { module_codes: cmd.moduleCodes } };
    } catch (error) {
      return fail(error);
    }
  }

  async function updateModule(cmd: {
    moduleCode: string;
    principalCode: string;
    name?: string;
    description?: string | null;
    sortOrder?: number;
    status?: ModuleStatus;
  }) {
    try {
      const module = await findProjectModuleByCode(db, cmd.moduleCode);
      const access = await mustAccessProjectOwnerByEntity(db, module, cmd.principalCode, 'module_not_found', `功能模块不存在：${cmd.moduleCode}`);
      if (!module) return fail(new DomainError('module_not_found', `功能模块不存在：${cmd.moduleCode}`));
      const nextName = cmd.name === undefined ? module.name : cmd.name.trim();
      if (!nextName) return fail(new DomainError('module_name_required', '功能模块名称不能为空'));
      if (cmd.status === 'archived' && module.status !== 'archived') {
        const [blockingFeature] = await db.select({ id: schema.features.id }).from(schema.features).where(and(
          eq(schema.features.module_id, module.id),
          ne(schema.features.status, 'archived'),
        )).limit(1);
        if (blockingFeature) {
          return fail(new DomainError('module_has_active_features', '模块仍有关联的未归档 Feature，请先归档或移出这些 Feature'));
        }
      }
      const changedAt = now();
      const [updated] = await db.update(schema.projectModules).set({
        name: nextName,
        description: cmd.description === undefined ? module.description : (cmd.description?.trim() || null),
        sort_order: cmd.sortOrder ?? module.sort_order,
        status: cmd.status ?? module.status,
        updated_at: changedAt,
      }).where(eq(schema.projectModules.id, module.id)).returning();
      if (!updated) return fail(new DomainError('internal_error', '功能模块更新失败'));
      const audit = {
        entity_type: 'project_module',
        entity_id: module.id,
        principal_id: access.principal.id,
        base_snapshot: 0,
        action: 'project_module.updated',
        payload: { name: updated.name, status: updated.status },
      };
      assertAuditedChange(audit);
      await insertAudit(db, toAuditEvent(audit, createPublicCode(), changedAt));
      return { ok: true as const, data: toModuleSummary(updated, access.project.code) };
    } catch (error) {
      return fail(error);
    }
  }

  async function listPhases(cmd: { projectCode: string; principalCode: string }) {
    try {
      const access = await mustAccessProject(db, cmd.projectCode, cmd.principalCode);
      const rows = await db.select().from(schema.projectPhases)
        .where(eq(schema.projectPhases.project_id, access.project.id))
        .orderBy(asc(schema.projectPhases.sort_order), asc(schema.projectPhases.id));
      return { ok: true as const, data: rows.map((row) => toPhaseSummary(row, access.project.code)) };
    } catch (error) {
      return fail(error);
    }
  }

  async function createPhase(cmd: {
    projectCode: string;
    principalCode: string;
    name: string;
    goal?: string;
    sortOrder?: number;
    startDate?: string | null;
    endDate?: string | null;
    status?: PhaseStatus;
  }) {
    try {
      const access = await mustAccessProject(db, cmd.projectCode, cmd.principalCode);
      await assertProjectAccess(db, access.project.id, access.principal.id, 'manage');
      if (!isProjectManager(access.membership.role)) {
        return fail(new DomainError('project_forbidden', '只有项目 Owner 可以创建阶段'));
      }
      const name = cmd.name.trim();
      if (!name) return fail(new DomainError('phase_name_required', '阶段名称不能为空'));
      const startDate = normalizeScheduleDate(cmd.startDate, 'start_date');
      const endDate = normalizeScheduleDate(cmd.endDate, 'end_date');
      assertScheduleOrder(startDate, endDate, 'phase');
      const changedAt = now();
      const [phase] = await db.insert(schema.projectPhases).values({
        code: createPublicCode(),
        project_id: access.project.id,
        name,
        goal: cmd.goal?.trim() || null,
        sort_order: cmd.sortOrder ?? 0,
        start_date: startDate,
        end_date: endDate,
        status: cmd.status ?? 'planned',
        created_at: changedAt,
        updated_at: changedAt,
      }).returning();
      if (!phase) return fail(new DomainError('internal_error', '阶段创建失败'));
      const audit = {
        entity_type: 'project_phase',
        entity_id: phase.id,
        principal_id: access.principal.id,
        base_snapshot: 0,
        action: 'project_phase.created',
        payload: { project_code: access.project.code, name },
      };
      assertAuditedChange(audit);
      await insertAudit(db, toAuditEvent(audit, createPublicCode(), changedAt));
      return { ok: true as const, data: toPhaseSummary(phase, access.project.code) };
    } catch (error) {
      return fail(error);
    }
  }

  async function updatePhase(cmd: {
    phaseCode: string;
    principalCode: string;
    name?: string;
    goal?: string | null;
    sortOrder?: number;
    startDate?: string | null;
    endDate?: string | null;
    status?: PhaseStatus;
  }) {
    try {
      const phase = await findProjectPhaseByCode(db, cmd.phaseCode);
      const access = await mustAccessProjectOwnerByEntity(db, phase, cmd.principalCode, 'phase_not_found', `阶段不存在：${cmd.phaseCode}`);
      if (!phase) return fail(new DomainError('phase_not_found', `阶段不存在：${cmd.phaseCode}`));
      const nextName = cmd.name === undefined ? phase.name : cmd.name.trim();
      if (!nextName) return fail(new DomainError('phase_name_required', '阶段名称不能为空'));
      const startDate = cmd.startDate === undefined ? phase.start_date : normalizeScheduleDate(cmd.startDate, 'start_date');
      const endDate = cmd.endDate === undefined ? phase.end_date : normalizeScheduleDate(cmd.endDate, 'end_date');
      assertScheduleOrder(startDate, endDate, 'phase');
      const changedAt = now();
      const [updated] = await db.update(schema.projectPhases).set({
        name: nextName,
        goal: cmd.goal === undefined ? phase.goal : (cmd.goal?.trim() || null),
        sort_order: cmd.sortOrder ?? phase.sort_order,
        start_date: startDate,
        end_date: endDate,
        status: cmd.status ?? phase.status,
        updated_at: changedAt,
      }).where(eq(schema.projectPhases.id, phase.id)).returning();
      if (!updated) return fail(new DomainError('internal_error', '阶段更新失败'));
      const audit = {
        entity_type: 'project_phase',
        entity_id: phase.id,
        principal_id: access.principal.id,
        base_snapshot: 0,
        action: 'project_phase.updated',
        payload: { name: updated.name, status: updated.status },
      };
      assertAuditedChange(audit);
      await insertAudit(db, toAuditEvent(audit, createPublicCode(), changedAt));
      return { ok: true as const, data: toPhaseSummary(updated, access.project.code) };
    } catch (error) {
      return fail(error);
    }
  }

  async function listMilestones(cmd: { projectCode: string; principalCode: string }) {
    try {
      const access = await mustAccessProject(db, cmd.projectCode, cmd.principalCode);
      const rows = await db.select().from(schema.projectMilestones)
        .where(eq(schema.projectMilestones.project_id, access.project.id))
        .orderBy(asc(schema.projectMilestones.sort_order), asc(schema.projectMilestones.id));
      const phaseIds = [...new Set(rows.map((row) => row.phase_id))];
      const ownerIds = [...new Set(rows.map((row) => row.owner_principal_id).filter((value): value is bigint => value !== null))];
      const featureRows = rows.length === 0
        ? []
        : await db.select().from(schema.features).where(inArray(schema.features.milestone_id, rows.map((row) => row.id)));
      const featureIds = featureRows.map((row) => row.id);
      const taskRows = featureIds.length === 0
        ? []
        : await db.select({ feature_id: schema.tasks.feature_id, status: schema.tasks.status }).from(schema.tasks)
          .where(inArray(schema.tasks.feature_id, featureIds));
      const [phaseMap, ownerMap] = await Promise.all([
        phasesByIds(db, phaseIds),
        usersByIds(db, ownerIds),
      ]);
      const counts = new Map<bigint, { feature_count: number; delivered_feature_count: number; task_total: number; closed_task_count: number }>();
      for (const milestone of rows) {
        counts.set(milestone.id, { feature_count: 0, delivered_feature_count: 0, task_total: 0, closed_task_count: 0 });
      }
      const featureToMilestone = new Map(featureRows.map((row) => [row.id, row.milestone_id]));
      for (const feature of featureRows) {
        if (feature.milestone_id === null) continue;
        const current = counts.get(feature.milestone_id);
        if (!current) continue;
        current.feature_count += 1;
        if (feature.status === 'delivered') current.delivered_feature_count += 1;
      }
      for (const task of taskRows) {
        const milestoneId = featureToMilestone.get(task.feature_id);
        if (!milestoneId) continue;
        const current = counts.get(milestoneId);
        if (!current) continue;
        current.task_total += 1;
        if (task.status === 'closed') current.closed_task_count += 1;
      }
      return {
        ok: true as const,
        data: rows.map((row) => toMilestoneSummary(
          row,
          access.project.code,
          phaseMap.get(row.phase_id),
          row.owner_principal_id ? ownerMap.get(row.owner_principal_id) : undefined,
          counts.get(row.id) ?? { feature_count: 0, delivered_feature_count: 0, task_total: 0, closed_task_count: 0 },
        )),
      };
    } catch (error) {
      return fail(error);
    }
  }

  async function createMilestone(cmd: {
    projectCode: string;
    principalCode: string;
    phaseCode: string;
    name: string;
    goal?: string;
    startDate?: string | null;
    targetDate?: string | null;
    sortOrder?: number;
    status?: MilestoneStatus;
    ownerPrincipalCode?: string | null;
  }) {
    try {
      const access = await mustAccessProject(db, cmd.projectCode, cmd.principalCode);
      await assertProjectAccess(db, access.project.id, access.principal.id, 'manage');
      if (!isProjectManager(access.membership.role)) {
        return fail(new DomainError('project_forbidden', '只有项目 Owner 可以创建里程碑'));
      }
      const [phase, owner] = await Promise.all([
        findProjectPhaseByCode(db, cmd.phaseCode),
        cmd.ownerPrincipalCode ? findUserByCode(db, cmd.ownerPrincipalCode) : Promise.resolve(undefined),
      ]);
      if (!phase || phase.project_id !== access.project.id) {
        return fail(new DomainError('phase_not_found', `阶段不存在：${cmd.phaseCode}`));
      }
      if (owner) {
        const ownerMembership = await memberInProject(db, access.project.id, owner.id);
        if (!ownerMembership || ownerMembership.role === 'viewer') {
          return fail(new DomainError('milestone_owner_invalid', '里程碑负责人必须是项目成员'));
        }
      }
      const name = cmd.name.trim();
      if (!name) return fail(new DomainError('milestone_name_required', '里程碑名称不能为空'));
      const startDate = normalizeScheduleDate(cmd.startDate, 'start_date');
      const targetDate = normalizeScheduleDate(cmd.targetDate, 'target_date');
      // docs/30 P2-2：新建里程碑不允许直接以 completed 起步——
      // 完成必须来自交付事实（updateMilestone 的门槛校验），不能凭空创建。
      if (cmd.status === 'completed') {
        return fail(new DomainError('milestone_completion_blocked', '里程碑不能直接创建为 completed；请先关联并交付 Feature 后再更新状态'));
      }
      assertScheduleOrder(startDate, targetDate, 'milestone');
      const changedAt = now();
      const [milestone] = await db.insert(schema.projectMilestones).values({
        code: createPublicCode(),
        project_id: access.project.id,
        phase_id: phase.id,
        name,
        goal: cmd.goal?.trim() || null,
        start_date: startDate,
        target_date: targetDate,
        sort_order: cmd.sortOrder ?? 0,
        status: cmd.status ?? 'planned',
        owner_principal_id: owner?.id ?? null,
        created_at: changedAt,
        updated_at: changedAt,
      }).returning();
      if (!milestone) return fail(new DomainError('internal_error', '里程碑创建失败'));
      const audit = {
        entity_type: 'project_milestone',
        entity_id: milestone.id,
        principal_id: access.principal.id,
        base_snapshot: 0,
        action: 'project_milestone.created',
        payload: { project_code: access.project.code, phase_code: phase.code, name },
      };
      assertAuditedChange(audit);
      await insertAudit(db, toAuditEvent(audit, createPublicCode(), changedAt));
      return {
        ok: true as const,
        data: toMilestoneSummary(
          milestone,
          access.project.code,
          phase,
          owner,
          { feature_count: 0, delivered_feature_count: 0, task_total: 0, closed_task_count: 0 },
        ),
      };
    } catch (error) {
      return fail(error);
    }
  }

  async function updateMilestone(cmd: {
    milestoneCode: string;
    principalCode: string;
    phaseCode?: string;
    name?: string;
    goal?: string | null;
    startDate?: string | null;
    targetDate?: string | null;
    sortOrder?: number;
    status?: MilestoneStatus;
    ownerPrincipalCode?: string | null;
  }) {
    try {
      const milestone = await findProjectMilestoneByCode(db, cmd.milestoneCode);
      const access = await mustAccessProjectOwnerByEntity(db, milestone, cmd.principalCode, 'milestone_not_found', `里程碑不存在：${cmd.milestoneCode}`);
      if (!milestone) return fail(new DomainError('milestone_not_found', `里程碑不存在：${cmd.milestoneCode}`));
      const [existingPhase, requestedPhase, requestedOwner] = await Promise.all([
        db.select().from(schema.projectPhases).where(eq(schema.projectPhases.id, milestone.phase_id)).limit(1).then((rows) => rows[0]),
        cmd.phaseCode ? findProjectPhaseByCode(db, cmd.phaseCode) : Promise.resolve(undefined),
        cmd.ownerPrincipalCode === undefined
          ? Promise.resolve(undefined)
          : (cmd.ownerPrincipalCode ? findUserByCode(db, cmd.ownerPrincipalCode) : Promise.resolve(null)),
      ]);
      const phase = requestedPhase ?? existingPhase;
      if (!phase || phase.project_id !== milestone.project_id) {
        return fail(new DomainError('phase_not_found', `阶段不存在：${cmd.phaseCode ?? existingPhase?.code ?? ''}`));
      }
      if (requestedOwner) {
        const ownerMembership = await memberInProject(db, milestone.project_id, requestedOwner.id);
        if (!ownerMembership || ownerMembership.role === 'viewer') {
          return fail(new DomainError('milestone_owner_invalid', '里程碑负责人必须是项目成员'));
        }
      }
      const nextName = cmd.name === undefined ? milestone.name : cmd.name.trim();
      if (!nextName) return fail(new DomainError('milestone_name_required', '里程碑名称不能为空'));
      const startDate = cmd.startDate === undefined ? milestone.start_date : normalizeScheduleDate(cmd.startDate, 'start_date');
      const targetDate = cmd.targetDate === undefined ? milestone.target_date : normalizeScheduleDate(cmd.targetDate, 'target_date');
      assertScheduleOrder(startDate, targetDate, 'milestone');
      const nextStatus = cmd.status ?? milestone.status;
      const milestoneFeatures = await db.select().from(schema.features).where(eq(schema.features.milestone_id, milestone.id));
      // docs/30 P2-2：里程碑标记 completed 必须先有交付事实——
      // 至少关联一个 Feature，且所有未归档 Feature 均已 delivered。
      if (cmd.status === 'completed' && nextStatus === 'completed' && milestone.status !== 'completed') {
        const activeOrDelivered = milestoneFeatures.filter((feature) => feature.status !== 'archived');
        if (activeOrDelivered.length === 0 || activeOrDelivered.some((feature) => feature.status !== 'delivered')) {
          return fail(new DomainError('milestone_completion_blocked', '里程碑完成前，其下必须存在至少一个未归档 Feature 且全部处于 delivered 状态', {
            feature_total: milestoneFeatures.length,
            delivered: milestoneFeatures.filter((feature) => feature.status === 'delivered').length,
          }));
        }
      }
      const conflictingFeature = milestoneFeatures.find((feature) => (
        feature.start_date || feature.end_date
      ) && (
        !startDate
        || !targetDate
        || !feature.start_date
        || !feature.end_date
        || feature.start_date < startDate
        || feature.end_date > targetDate
      ));
      if (conflictingFeature) {
        return fail(new DomainError('milestone_feature_schedule_conflict', '里程碑日期范围不能排除已安排的 Feature', {
          feature_code: conflictingFeature.code,
          feature_start_date: conflictingFeature.start_date,
          feature_end_date: conflictingFeature.end_date,
          milestone_start_date: startDate,
          milestone_target_date: targetDate,
        }));
      }
      const changedAt = now();
      const updated = await db.transaction(async (tx): Promise<typeof schema.projectMilestones.$inferSelect> => {
        const [updatedRow] = await tx.update(schema.projectMilestones).set({
          phase_id: phase.id,
          name: nextName,
          goal: cmd.goal === undefined ? milestone.goal : (cmd.goal?.trim() || null),
          start_date: startDate,
          target_date: targetDate,
          sort_order: cmd.sortOrder ?? milestone.sort_order,
          status: nextStatus,
          owner_principal_id: cmd.ownerPrincipalCode === undefined
            ? milestone.owner_principal_id
            : (requestedOwner?.id ?? null),
          updated_at: changedAt,
        }).where(eq(schema.projectMilestones.id, milestone.id)).returning();
        if (!updatedRow) throw new DomainError('internal_error', '里程碑更新失败');
        // 审计与更新同事务：审计缺失即整体回滚（与 closeTask/changePassword 约定一致）。
        const audit = {
          entity_type: 'project_milestone',
          entity_id: milestone.id,
          principal_id: access.principal.id,
          base_snapshot: 0,
          action: 'project_milestone.updated',
          payload: { name: updatedRow.name, status: updatedRow.status, phase_code: phase.code },
        };
        assertAuditedChange(audit);
        await insertAudit(tx, toAuditEvent(audit, createPublicCode(), changedAt));
        return updatedRow;
      });
      const owner = updated.owner_principal_id
        ? (await usersByIds(db, [updated.owner_principal_id])).get(updated.owner_principal_id)
        : undefined;
        return {
          ok: true as const,
          data: toMilestoneSummary(
            updated,
            access.project.code,
            phase,
            owner,
          { feature_count: 0, delivered_feature_count: 0, task_total: 0, closed_task_count: 0 },
        ),
      };
    } catch (error) {
      return fail(error);
    }
  }

  return {
    listModules,
    createModule,
    updateModule,
    reorderModules,
    listPhases,
    createPhase,
    updatePhase,
    listMilestones,
    createMilestone,
    updateMilestone,
  };
}

export type ProjectStructureUseCases = ReturnType<typeof createProjectStructureUseCases>;
