import { writeFeature } from './intake-entity-writers.js';
import type { EvidenceType, Profile, TaskSource } from '@team-synergy/contracts';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '@team-synergy/persistence';
import { schema } from '@team-synergy/persistence';
import { DomainError, assertAuditedChange, toAuditEvent, transitionOrThrow } from '@team-synergy/domain';
import {
  fail,
  insertAudit,
  now,
  parseAcceptance,
} from './task-service.js';
import {
  createPublicCode,
  findDefectByCode,
  findFeatureByCode,
  findProjectMilestoneByCode,
  findProjectModuleByCode,
  findProjectByCode,
  findRequirementByCode,
  findRunByCode,
  findTaskByCode,
  findUserByCode,
} from './public-code.js';
import { assertExecutionWrite, assertNoPendingHandover, executionDeviceId } from './execution-guard.js';
import { assertFeatureScheduleWithinMilestone, normalizeScheduleDate } from './schedule.js';
import { loadRequirementBaseline } from './baseline-use-cases.js';
import { assertProjectAccess, effectiveProjectMember, isProjectManager, resolveProjectAccess, type AccessDb } from './project-access.js';

async function usersByIds(db: Db, ids: bigint[]) {
  if (ids.length === 0) return new Map<bigint, typeof schema.users.$inferSelect>();
  const rows = await db.select().from(schema.users).where(inArray(schema.users.id, ids));
  return new Map(rows.map((row) => [row.id, row]));
}

export const FEATURE_STATUSES = ['active', 'delivered', 'archived'] as const;
export type FeatureStatus = (typeof FEATURE_STATUSES)[number];

async function modulesByIds(db: Db, ids: bigint[]) {
  if (ids.length === 0) return new Map<bigint, typeof schema.projectModules.$inferSelect>();
  const rows = await db.select().from(schema.projectModules).where(inArray(schema.projectModules.id, ids));
  return new Map(rows.map((row) => [row.id, row]));
}

async function milestonesByIds(db: Db, ids: bigint[]) {
  if (ids.length === 0) return new Map<bigint, typeof schema.projectMilestones.$inferSelect>();
  const rows = await db.select().from(schema.projectMilestones).where(inArray(schema.projectMilestones.id, ids));
  return new Map(rows.map((row) => [row.id, row]));
}

async function memberInProject(db: Db, projectId: bigint, principalId: bigint) {
  return effectiveProjectMember(db, projectId, principalId);
}

export async function assertRequirementInProject(db: AccessDb, requirement: typeof schema.requirements.$inferSelect, projectId: bigint) {
  const [feature, module, document] = await Promise.all([
    requirement.feature_id === null ? undefined : db.select().from(schema.features).where(eq(schema.features.id, requirement.feature_id)).limit(1).then(rows => rows[0]),
    requirement.module_id === null ? undefined : db.select().from(schema.projectModules).where(eq(schema.projectModules.id, requirement.module_id)).limit(1).then(rows => rows[0]),
    requirement.document_id === null ? undefined : db.select().from(schema.requirementDocuments).where(eq(schema.requirementDocuments.id, requirement.document_id)).limit(1).then(rows => rows[0]),
  ]);
  const projectIds = [feature?.project_id, module?.project_id, document?.project_id].filter((id): id is bigint => id !== undefined);
  if (!projectIds.length || projectIds.some(id => id !== projectId)) throw new DomainError('requirement_cross_project', '关联的需求必须属于当前项目');
}

function toFeatureSummary(
  feature: typeof schema.features.$inferSelect,
  projectCode: string,
  module?: typeof schema.projectModules.$inferSelect,
  milestone?: typeof schema.projectMilestones.$inferSelect,
) {
  return {
    feature_code: feature.code,
    project_code: projectCode,
    module_code: module?.code ?? null,
    module_name: module?.name ?? null,
    milestone_code: milestone?.code ?? null,
    milestone_name: milestone?.name ?? null,
    name: feature.title,
    title: feature.title,
    goal: feature.goal,
    sort_order: feature.sort_order,
    start_date: feature.start_date,
    end_date: feature.end_date,
    status: feature.status,
  };
}

export function createProjectUseCases(db: Db) {
  async function createFeature(cmd: {
    projectCode: string;
    title?: string;
    name?: string;
    goal?: string;
    status?: FeatureStatus;
    moduleCode?: string | null;
    milestoneCode?: string | null;
    startDate?: string | null;
    endDate?: string | null;
    principalCode: string;
  }) {
    try {
      const [project, principal] = await Promise.all([
        findProjectByCode(db, cmd.projectCode),
        findUserByCode(db, cmd.principalCode),
      ]);
      if (!project) return fail(new DomainError('project_not_found', `项目不存在：${cmd.projectCode}`));
      if (!principal || principal.status !== 'active') return fail(new DomainError('user_not_found', `用户不存在：${cmd.principalCode}`));
      const membership = await memberInProject(db, project.id, principal.id);
      if (!membership || !isProjectManager(membership.role)) {
        return fail(new DomainError('feature_forbidden', '只有 Owner 可以创建 Feature', { principal_code: principal.code }));
      }

      const title = (cmd.name ?? cmd.title ?? '').trim();
      if (!title) return fail(new DomainError('feature_title_required', 'Feature 标题不能为空'));
      const status = cmd.status ?? 'active';
      let module: typeof schema.projectModules.$inferSelect | undefined;
      if (cmd.moduleCode) {
        module = await findProjectModuleByCode(db, cmd.moduleCode);
        if (!module || module.project_id !== project.id) {
          return fail(new DomainError('module_not_found', `功能模块不存在：${cmd.moduleCode}`));
        }
      }
      let milestone: typeof schema.projectMilestones.$inferSelect | undefined;
      if (cmd.milestoneCode) {
        milestone = await findProjectMilestoneByCode(db, cmd.milestoneCode);
        if (!milestone || milestone.project_id !== project.id) {
          return fail(new DomainError('milestone_not_found', `里程碑不存在：${cmd.milestoneCode}`));
        }
      }
      const startDate = normalizeScheduleDate(cmd.startDate, 'start_date');
      const endDate = normalizeScheduleDate(cmd.endDate, 'end_date');
      assertFeatureScheduleWithinMilestone(startDate, endDate, milestone);
      const feature = await db.transaction(tx => writeFeature(tx, {
        projectId: project.id, projectCode: project.code, principalId: principal.id,
      }, { title, goal: cmd.goal, moduleId: module?.id, milestoneId: milestone?.id, milestoneCode: milestone?.code,
        startDate, endDate, status }));
      return { ok: true as const, data: toFeatureSummary(feature, project.code, module, milestone) };
    } catch (error) {
      return fail(error);
    }
  }

  async function listFeatures(cmd: { projectCode: string; principalCode: string }) {
    try {
      const [project, principal] = await Promise.all([
        findProjectByCode(db, cmd.projectCode),
        findUserByCode(db, cmd.principalCode),
      ]);
      if (!project || !principal || principal.status !== 'active') {
        return fail(new DomainError('project_forbidden', '项目不存在或当前用户无权访问', { project_code: cmd.projectCode }));
      }
      const membership = await memberInProject(db, project.id, principal.id);
      if (!membership) {
        return fail(new DomainError('project_forbidden', '项目不存在或当前用户无权访问', { project_code: cmd.projectCode }));
      }
      const rows = await db.select().from(schema.features)
        .where(eq(schema.features.project_id, project.id))
        .orderBy(asc(schema.features.sort_order), asc(schema.features.id));
      const [moduleMap, milestoneMap] = await Promise.all([
        modulesByIds(db, [...new Set(rows.map((row) => row.module_id).filter((value): value is bigint => value !== null))]),
        milestonesByIds(db, [...new Set(rows.map((row) => row.milestone_id).filter((value): value is bigint => value !== null))]),
      ]);
      return {
        ok: true as const,
        data: rows.map((row) => toFeatureSummary(
          row,
          project.code,
          row.module_id ? moduleMap.get(row.module_id) : undefined,
          row.milestone_id ? milestoneMap.get(row.milestone_id) : undefined,
        )),
      };
    } catch (error) {
      return fail(error);
    }
  }

  async function reorderFeatures(cmd: { projectCode: string; principalCode: string; featureCodes: string[] }) {
    try {
      const [project, principal] = await Promise.all([
        findProjectByCode(db, cmd.projectCode),
        findUserByCode(db, cmd.principalCode),
      ]);
      if (!project) return fail(new DomainError('project_not_found', `项目不存在：${cmd.projectCode}`));
      if (!principal || principal.status !== 'active') return fail(new DomainError('user_not_found', `用户不存在：${cmd.principalCode}`));
      const membership = await memberInProject(db, project.id, principal.id);
      if (!membership || !isProjectManager(membership.role)) {
        return fail(new DomainError('feature_forbidden', '只有 Owner 可以调整 Feature 顺序', { principal_code: principal.code }));
      }
      const rows = await db.select({ id: schema.features.id, code: schema.features.code })
        .from(schema.features)
        .where(eq(schema.features.project_id, project.id));
      const uniqueCodes = new Set(cmd.featureCodes);
      const availableCodes = new Set(rows.map((row) => row.code));
      if (uniqueCodes.size !== cmd.featureCodes.length
        || cmd.featureCodes.length !== rows.length
        || cmd.featureCodes.some((code) => !availableCodes.has(code))) {
        return fail(new DomainError('feature_order_invalid', 'Feature 排序必须包含当前项目的全部 Feature 且不能重复'));
      }
      const rowByCode = new Map(rows.map((row) => [row.code, row]));
      await db.transaction(async (tx) => {
        await assertProjectAccess(tx, project.id, principal.id, 'manage');
        for (const [sortOrder, featureCode] of cmd.featureCodes.entries()) {
          await tx.update(schema.features).set({ sort_order: sortOrder })
            .where(eq(schema.features.id, rowByCode.get(featureCode)!.id));
        }
      });
      return { ok: true as const, data: { feature_codes: cmd.featureCodes } };
    } catch (error) {
      return fail(error);
    }
  }

  async function getFeature(cmd: { featureCode: string; principalCode: string }) {
    try {
      const [feature, principal] = await Promise.all([
        findFeatureByCode(db, cmd.featureCode),
        findUserByCode(db, cmd.principalCode),
      ]);
      if (!feature) return fail(new DomainError('feature_not_found', `Feature 不存在：${cmd.featureCode}`));
      if (!principal || principal.status !== 'active') {
        return fail(new DomainError('project_forbidden', '项目不存在或当前用户无权访问', { feature_code: cmd.featureCode }));
      }
      const membership = await memberInProject(db, feature.project_id, principal.id);
      if (!membership) {
        return fail(new DomainError('project_forbidden', '项目不存在或当前用户无权访问', { feature_code: cmd.featureCode }));
      }
      const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, feature.project_id)).limit(1);
      if (!project) return fail(new DomainError('project_not_found', `项目不存在：${feature.project_id}`));
      const [moduleMap, milestoneMap] = await Promise.all([
        modulesByIds(db, feature.module_id ? [feature.module_id] : []),
        milestonesByIds(db, feature.milestone_id ? [feature.milestone_id] : []),
      ]);
      return {
        ok: true as const,
        data: toFeatureSummary(
          feature,
          project.code,
          feature.module_id ? moduleMap.get(feature.module_id) : undefined,
          feature.milestone_id ? milestoneMap.get(feature.milestone_id) : undefined,
        ),
      };
    } catch (error) {
      return fail(error);
    }
  }

  async function updateFeature(cmd: {
    featureCode: string;
    principalCode: string;
    title?: string;
    name?: string;
    goal?: string | null;
    status?: FeatureStatus;
    moduleCode?: string | null;
    milestoneCode?: string | null;
    startDate?: string | null;
    endDate?: string | null;
  }) {
    try {
      const [feature, principal] = await Promise.all([
        findFeatureByCode(db, cmd.featureCode),
        findUserByCode(db, cmd.principalCode),
      ]);
      if (!feature) return fail(new DomainError('feature_not_found', `Feature 不存在：${cmd.featureCode}`));
      if (!principal || principal.status !== 'active') return fail(new DomainError('user_not_found', `用户不存在：${cmd.principalCode}`));

      const membership = await memberInProject(db, feature.project_id, principal.id);
      if (!membership || !isProjectManager(membership.role)) {
        return fail(new DomainError('feature_forbidden', '只有 Owner 可以更新 Feature', { principal_code: principal.code }));
      }
      const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, feature.project_id)).limit(1);
      if (!project) return fail(new DomainError('project_not_found', `项目不存在：${feature.project_id}`));
      await assertProjectAccess(db, project.id, principal.id, 'manage');

      let moduleId = feature.module_id;
      let milestoneId = feature.milestone_id;
      let module: typeof schema.projectModules.$inferSelect | undefined;
      let milestone: typeof schema.projectMilestones.$inferSelect | undefined;
      if (cmd.moduleCode !== undefined) {
        if (cmd.moduleCode) {
          module = await findProjectModuleByCode(db, cmd.moduleCode);
          if (!module || module.project_id !== feature.project_id) {
            return fail(new DomainError('module_not_found', `功能模块不存在：${cmd.moduleCode}`));
          }
          moduleId = module.id;
        } else {
          moduleId = null;
        }
      } else if (feature.module_id) {
        module = (await modulesByIds(db, [feature.module_id])).get(feature.module_id);
      }
      if (cmd.milestoneCode !== undefined) {
        if (cmd.milestoneCode) {
          milestone = await findProjectMilestoneByCode(db, cmd.milestoneCode);
          if (!milestone || milestone.project_id !== feature.project_id) {
            return fail(new DomainError('milestone_not_found', `里程碑不存在：${cmd.milestoneCode}`));
          }
          milestoneId = milestone.id;
        } else {
          milestoneId = null;
        }
      } else if (feature.milestone_id) {
        milestone = (await milestonesByIds(db, [feature.milestone_id])).get(feature.milestone_id);
      }

      const nextTitle = cmd.title === undefined && cmd.name === undefined
        ? feature.title
        : (cmd.name ?? cmd.title ?? '').trim();
      if (!nextTitle) return fail(new DomainError('feature_title_required', 'Feature 标题不能为空'));
      const nextGoal = cmd.goal === undefined ? feature.goal : (cmd.goal?.trim() || null);
      const nextStatus = cmd.status ?? feature.status;
      const startDate = cmd.startDate === undefined ? feature.start_date : normalizeScheduleDate(cmd.startDate, 'start_date');
      const endDate = cmd.endDate === undefined ? feature.end_date : normalizeScheduleDate(cmd.endDate, 'end_date');
      assertFeatureScheduleWithinMilestone(startDate, endDate, milestone);
      const changedAt = now();
      const [updated] = await db.update(schema.features).set({
        title: nextTitle,
        goal: nextGoal,
        status: nextStatus,
        module_id: moduleId,
        milestone_id: milestoneId,
        start_date: startDate,
        end_date: endDate,
      }).where(eq(schema.features.id, feature.id)).returning();
      if (!updated) return fail(new DomainError('internal_error', 'Feature 更新失败'));

      const audit = {
        entity_type: 'feature',
        entity_id: feature.id,
        legacy_entity_code: feature.legacy_code ?? undefined,
        principal_id: principal.id,
        base_snapshot: 0,
        action: 'feature.updated',
        payload: {
          title: nextTitle,
          status: nextStatus,
          module_code: moduleId ? (module?.code ?? null) : null,
          milestone_code: milestoneId ? (milestone?.code ?? null) : null,
          start_date: startDate,
          end_date: endDate,
        },
      };
      assertAuditedChange(audit);
      await insertAudit(db, toAuditEvent(audit, createPublicCode(), changedAt));

      if (!module && updated.module_id) {
        module = (await modulesByIds(db, [updated.module_id])).get(updated.module_id);
      }
      if (!milestone && updated.milestone_id) {
        milestone = (await milestonesByIds(db, [updated.milestone_id])).get(updated.milestone_id);
      }
      return { ok: true as const, data: toFeatureSummary(updated, project.code, module, milestone) };
    } catch (error) {
      return fail(error);
    }
  }

  async function createTask(cmd: {
    featureCode: string;
    title: string;
    brief?: string;
    profile: Profile;
    source: TaskSource;
    requirementCode?: string;
    requirementBaselineCode?: string;
    defectCode?: string;
    acceptance: Array<{ id: string; text: string }>;
    scope?: { writable_paths: string[] };
    validationSeams?: string[];
    dependsOnCodes?: string[];
    principalCode: string;
  }) {
    try {
      const [feature, principal] = await Promise.all([
        findFeatureByCode(db, cmd.featureCode),
        findUserByCode(db, cmd.principalCode),
      ]);
      if (!feature) return fail(new DomainError('feature_not_found', `Feature 不存在：${cmd.featureCode}`));
      if (!principal || principal.status !== 'active') return fail(new DomainError('user_not_found', `用户不存在：${cmd.principalCode}`));
      if (cmd.acceptance.length === 0) {
        return fail(new DomainError('acceptance_required', '没有验收标准的 Task 不能创建（架构不变量 2）'));
      }
      const actor = await effectiveProjectMember(db, feature.project_id, principal.id);
      if (!actor || actor.role === 'viewer' || (cmd.source !== 'ad-hoc' && !isProjectManager(actor.role))) {
        return fail(new DomainError('create_task_forbidden', `来源 ${cmd.source} 的任务仅 Owner 可创建（ad-hoc 临时任务任何人可提）`, {
          principal_code: principal.code,
        }));
      }

      let requirementId: bigint | null = null;
      let sourceRequirementRevisionId: bigint | null = null;
      let sourceDocumentRevisionId: bigint | null = null;
      if (cmd.requirementCode) {
        const requirement = await findRequirementByCode(db, cmd.requirementCode);
        if (!requirement) return fail(new DomainError('requirement_not_found', `需求不存在：${cmd.requirementCode}`));
        await assertRequirementInProject(db, requirement, feature.project_id);
        requirementId = requirement.id;
        const [sourceRequirementRevision] = await db.select().from(schema.requirementRevisions).where(and(
          eq(schema.requirementRevisions.requirement_id, requirement.id),
          eq(schema.requirementRevisions.revision, requirement.current_revision),
        )).limit(1);
        sourceRequirementRevisionId = sourceRequirementRevision?.id ?? null;
        if (requirement.document_id !== null) {
          const [document] = await db.select().from(schema.requirementDocuments).where(eq(schema.requirementDocuments.id, requirement.document_id)).limit(1);
          if (document) {
            const [sourceDocumentRevision] = await db.select().from(schema.requirementDocumentRevisions).where(and(
              eq(schema.requirementDocumentRevisions.document_id, document.id),
              eq(schema.requirementDocumentRevisions.revision, document.current_revision),
            )).limit(1);
            sourceDocumentRevisionId = sourceDocumentRevision?.id ?? null;
          }
        }
      }

      let defectId: bigint | null = null;
      if (cmd.source === 'defect-fix') {
        if (!cmd.defectCode) {
          return fail(new DomainError('defect_required', '缺陷修复任务必须绑定 defect_code'));
        }
        const defect = await findDefectByCode(db, cmd.defectCode);
        if (!defect) return fail(new DomainError('defect_not_found', `缺陷不存在：${cmd.defectCode}`));
        if (defect.feature_id !== feature.id) {
          return fail(new DomainError('defect_feature_mismatch', '修复任务必须与缺陷属于同一个 Feature', {
            defect_code: defect.code,
            feature_code: feature.code,
          }));
        }
        defectId = defect.id;
      } else if (cmd.defectCode) {
        return fail(new DomainError('defect_source_mismatch', '只有 defect-fix 来源的任务可以绑定缺陷'));
      }

      let dependencyTasks: typeof schema.tasks.$inferSelect[] = [];
      if (cmd.dependsOnCodes && cmd.dependsOnCodes.length > 0) {
        const resolved = await Promise.all(cmd.dependsOnCodes.map((code) => findTaskByCode(db, code)));
        const missing = cmd.dependsOnCodes.filter((_, index) => !resolved[index]);
        if (missing.length > 0) {
          return fail(new DomainError('dependency_missing', '依赖任务不存在', { missing_codes: missing }));
        }
        dependencyTasks = resolved.filter((task): task is NonNullable<typeof task> => Boolean(task));
        const dependencyFeatureIds = [...new Set(dependencyTasks.map((task) => task.feature_id))];
        const dependencyFeatures = await db.select().from(schema.features).where(inArray(schema.features.id, dependencyFeatureIds));
        if (dependencyFeatures.some((dependencyFeature) => dependencyFeature.project_id !== feature.project_id)) {
          return fail(new DomainError('dependency_cross_project', '任务依赖不能跨项目', { project_code: cmd.featureCode }));
        }
      }

      const taskCode = createPublicCode();
      await db.transaction(async (tx) => {
        await assertProjectAccess(tx, feature.project_id, principal.id, cmd.source === 'ad-hoc' ? 'write' : 'manage');
        let requirementBaselineId: bigint | null = null;
        if (cmd.requirementBaselineCode) {
          await tx.execute(sql`select pg_advisory_xact_lock_shared(1094930512)`);
          const [project] = await tx.select().from(schema.projects).where(eq(schema.projects.id, feature.project_id)).for('share').limit(1);
          const [activePrincipal] = await tx.select().from(schema.users).where(eq(schema.users.id, principal.id)).for('share').limit(1);
          const member = await effectiveProjectMember(tx, feature.project_id, principal.id);
          if (project?.status !== 'active' || activePrincipal?.status !== 'active' || !isProjectManager(member?.role)) {
            throw new DomainError('baseline_forbidden', '只有有效项目 Owner 可以为任务选择需求基线');
          }
          const loaded = await loadRequirementBaseline(tx, project.id, cmd.requirementBaselineCode);
          if (!loaded) throw new DomainError('baseline_not_found', '需求基线不存在或不属于此项目');
          requirementBaselineId = loaded.row.id;
          if (requirementId !== null) {
            const [requirement] = await tx.select().from(schema.requirements).where(eq(schema.requirements.id, requirementId)).for('share').limit(1);
            const item = loaded.baseline.requirements.find(item => item.requirement_code === requirement?.code);
            if (!requirement || !item) throw new DomainError('baseline_requirement_missing', '基线未包含此任务关联的需求');
            const [reqFeature] = requirement.feature_id === null ? [] : await tx.select().from(schema.features).where(eq(schema.features.id, requirement.feature_id)).limit(1);
            const [reqModule] = requirement.module_id === null ? [] : await tx.select().from(schema.projectModules).where(eq(schema.projectModules.id, requirement.module_id)).limit(1);
            const [reqDocument] = requirement.document_id === null ? [] : await tx.select().from(schema.requirementDocuments).where(eq(schema.requirementDocuments.id, requirement.document_id)).limit(1);
            const projectIds = [reqFeature?.project_id, reqModule?.project_id, reqDocument?.project_id].filter((id): id is bigint => id !== undefined);
            if (!projectIds.length || projectIds.some(id => id !== project.id)) {
              throw new DomainError('requirement_cross_project', '任务关联的需求不能跨项目');
            }
            const [revision] = await tx.select().from(schema.requirementRevisions).where(and(
              eq(schema.requirementRevisions.requirement_id, requirementId), eq(schema.requirementRevisions.code, item.revision_code),
            )).limit(1);
            if (!revision) throw new DomainError('baseline_revision_mismatch', '需求基线引用的修订不存在');
            sourceRequirementRevisionId = revision.id;
            // Baselines freeze requirement revisions, not today's requirement-document head.
            sourceDocumentRevisionId = null;
          }
        }
        await tx.insert(schema.tasks).values({
          code: taskCode,
          feature_id: feature.id,
          title: cmd.title.trim(),
          brief: cmd.brief?.trim() || '',
          profile: cmd.profile,
          source: cmd.source,
          requirement_id: requirementId,
          requirement_baseline_id: requirementBaselineId,
          source_requirement_revision_id: sourceRequirementRevisionId,
          source_document_revision_id: sourceDocumentRevisionId,
          defect_id: defectId,
          status: 'draft',
          acceptance: JSON.stringify(cmd.acceptance),
          validation_seams: cmd.validationSeams ? JSON.stringify(cmd.validationSeams) : null,
          scope: cmd.scope ? JSON.stringify(cmd.scope) : null,
          base_snapshot: 0,
          created_at: now(),
        });
        const [task] = await tx.select().from(schema.tasks).where(eq(schema.tasks.code, taskCode)).limit(1);
        if (!task) throw new DomainError('internal_error', '任务创建失败');
        for (const dependency of dependencyTasks) {
          await tx.insert(schema.taskDependencies).values({
            task_id: task.id,
            depends_on_task_id: dependency.id,
          });
        }
        const audit = {
          entity_type: 'task',
          entity_id: task.id,
          principal_id: principal.id,
          base_snapshot: 0,
          action: 'task.created',
          payload: {
            feature_code: feature.code,
            source: cmd.source,
            defect_code: cmd.defectCode ?? null,
            requirement_baseline_code: cmd.requirementBaselineCode ?? null,
            acceptance_count: cmd.acceptance.length,
          },
        };
        assertAuditedChange(audit);
        await insertAudit(tx, toAuditEvent(audit, createPublicCode(), now()));
      });

      return {
        ok: true as const,
        data: { task_code: taskCode, status: 'draft' as const, base_snapshot: 0 },
      };
    } catch (error) {
      return fail(error);
    }
  }

  return { createFeature, listFeatures, getFeature, updateFeature, reorderFeatures, createTask };
}

export function createVerificationUseCases(db: Db) {
  async function verifyTask(cmd: {
    taskCode: string;
    runCode: string;
    principalCode: string;
    baseSnapshot: number;
    deviceCode?: string;
    executionEpoch?: number;
    leaseToken?: string;
    evidence: {
      type: EvidenceType;
      result: 'pass' | 'fail' | 'inconclusive';
      acceptanceRefs: string[];
      command?: string;
      summary?: string;
    };
  }) {
    try {
      const [task, run, principal] = await Promise.all([
        findTaskByCode(db, cmd.taskCode),
        findRunByCode(db, cmd.runCode),
        findUserByCode(db, cmd.principalCode),
      ]);
      if (!task) return fail(new DomainError('task_not_found', `任务不存在：${cmd.taskCode}`));
      if (!run || run.task_id !== task.id) {
        return fail(new DomainError('verify_run_mismatch', 'Run 不存在或不属于该任务', { run_code: cmd.runCode }));
      }
      if (!principal) return fail(new DomainError('user_not_found', `用户不存在：${cmd.principalCode}`));

      const result = await db.transaction(async (tx) => {
        const [currentTask, currentRun] = await Promise.all([
          tx.select().from(schema.tasks).where(eq(schema.tasks.id, task.id)).for('update').limit(1).then((rows) => rows[0]),
          tx.select().from(schema.runs).where(eq(schema.runs.id, run.id)).limit(1).then((rows) => rows[0]),
        ]);
        if (!currentTask) throw new DomainError('task_not_found', `任务不存在：${cmd.taskCode}`);
        await assertNoPendingHandover(tx, currentTask.id);
        if (!currentRun || currentRun.task_id !== currentTask.id) {
          throw new DomainError('verify_run_mismatch', 'Run 不存在或不属于该任务', { run_code: cmd.runCode });
        }
        if (currentRun.principal_id !== principal.id) {
          throw new DomainError('verify_identity_mismatch', 'Run 身份与当前 Principal 不匹配，拒绝冒用验证', {
            run_code: currentRun.code,
            principal_code: principal.code,
          });
        }
        if (currentRun.profile !== 'verifier') {
          throw new DomainError('verify_profile_forbidden', `Run 的 Profile 是 ${currentRun.profile}，只有 verifier 可以验证（docs/02）`, {
            profile: currentRun.profile,
          });
        }
        if (currentRun.status !== 'active') throw new DomainError('verify_run_inactive', 'Run 已结束，不能验证', { status: currentRun.status });
        await assertExecutionWrite(tx, { taskId: currentTask.id, runId: currentRun.id, principalId: principal.id, deviceId: await executionDeviceId(tx, principal.id, cmd.deviceCode), epoch: cmd.executionEpoch, leaseToken: cmd.leaseToken });
        if (currentTask.status !== 'submitted') {
          throw new DomainError('verify_task_not_submitted', `任务状态 ${currentTask.status}，不能验证`, { status: currentTask.status });
        }
        if (currentTask.base_snapshot !== cmd.baseSnapshot) {
          throw new DomainError('base_snapshot_mismatch', '任务基线快照已变化，请刷新后重试（乐观并发）', {
            current: currentTask.base_snapshot,
            provided: cmd.baseSnapshot,
          });
        }
        if (cmd.evidence.type !== 'verifier_review') {
          throw new DomainError('verifier_evidence_required', '验证需要 verifier_review 类型证据（架构不变量 5）', {
            provided: cmd.evidence.type,
          });
        }

        const acceptance = parseAcceptance(currentTask.acceptance);
        const acceptanceIds = new Set(acceptance.map((item) => item.id));
        const unknownRefs = cmd.evidence.acceptanceRefs.filter((id) => !acceptanceIds.has(id));
        if (unknownRefs.length > 0) {
          throw new DomainError('acceptance_refs_unknown', 'Evidence 引用了不存在的验收标准', { refs: unknownRefs });
        }
        if (cmd.evidence.result === 'pass' && new Set(cmd.evidence.acceptanceRefs).size < acceptanceIds.size) {
          throw new DomainError('acceptance_coverage_incomplete', '验证证据未覆盖全部验收标准', {
            covered: new Set(cmd.evidence.acceptanceRefs).size,
            total: acceptance.length,
          });
        }

        const contractsEvidence = {
          evidence_code: createPublicCode(),
          task_code: currentTask.code,
          run_code: currentRun.code,
          type: cmd.evidence.type,
          acceptance_refs: cmd.evidence.acceptanceRefs,
          result: cmd.evidence.result,
          command: cmd.evidence.command,
          summary: cmd.evidence.summary,
          recorded_at: now(),
        };

        // pass → verified（正向闭环）；fail/inconclusive → failed（验证失败回退，
        // Owner 可重新 assign 让 Builder 返工；docs/30 P2-1）。
        const verificationPassed = cmd.evidence.result === 'pass';
        if (verificationPassed) {
          transitionOrThrow('submitted', 'verified', {
            task: { acceptance },
            evidence: { selfTestEvidence: [], verifierEvidence: [contractsEvidence], artifactCount: 1 },
            profile: 'verifier',
          });
        } else {
          transitionOrThrow('submitted', 'failed', {
            task: { acceptance },
            evidence: { selfTestEvidence: [], verifierEvidence: [contractsEvidence], artifactCount: 1 },
            profile: 'verifier',
          });
        }

        const nextStatus = verificationPassed ? 'verified' : 'failed';
        const updatedTask = await tx.update(schema.tasks).set({
          status: nextStatus,
          base_snapshot: cmd.baseSnapshot + 1,
        }).where(and(
          eq(schema.tasks.id, currentTask.id),
          eq(schema.tasks.status, 'submitted'),
          eq(schema.tasks.base_snapshot, cmd.baseSnapshot),
        )).returning({ id: schema.tasks.id });
        if (updatedTask.length === 0) {
          throw new DomainError('concurrent_modification', '任务已被并发修改，请刷新后重试', { task_code: currentTask.code });
        }

        await tx.update(schema.runs).set({ status: 'completed', finished_at: now() })
          .where(and(eq(schema.runs.id, currentRun.id), eq(schema.runs.status, 'active')));
        const evidenceCode = createPublicCode();
        await tx.insert(schema.evidences).values({
          code: evidenceCode,
          task_id: currentTask.id,
          run_id: currentRun.id,
          type: cmd.evidence.type,
          acceptance_refs: JSON.stringify(cmd.evidence.acceptanceRefs),
          result: cmd.evidence.result,
          command: cmd.evidence.command,
          summary: cmd.evidence.summary,
          recorded_at: now(),
        });
        const audit = {
          entity_type: 'task',
          entity_id: currentTask.id,
          legacy_entity_code: currentTask.legacy_code ?? undefined,
          from: 'submitted',
          to: nextStatus,
          principal_id: principal.id,
          run_id: currentRun.id,
          base_snapshot: cmd.baseSnapshot,
          action: verificationPassed ? 'task.verified' : 'task.verification_failed',
        };
        assertAuditedChange(audit);
        await insertAudit(tx, toAuditEvent(audit, createPublicCode(), now()));
        return {
          task_code: currentTask.code,
          status: nextStatus as 'verified' | 'failed',
          evidence_code: evidenceCode,
          base_snapshot: cmd.baseSnapshot + 1,
        };
      });
      return { ok: true as const, data: result };
    } catch (error) {
      return fail(error);
    }
  }

  async function closeTask(cmd: { taskCode: string; principalCode: string; baseSnapshot: number }) {
    try {
      const [task, principal] = await Promise.all([
        findTaskByCode(db, cmd.taskCode),
        findUserByCode(db, cmd.principalCode),
      ]);
      if (!task) return fail(new DomainError('task_not_found', `任务不存在：${cmd.taskCode}`));
      if (!principal) return fail(new DomainError('user_not_found', `用户不存在：${cmd.principalCode}`));
      const [feature] = await db.select().from(schema.features).where(eq(schema.features.id, task.feature_id)).limit(1);
      if (!feature) return fail(new DomainError('feature_not_found', `Feature 不存在：${task.feature_id}`));
      const actor = await effectiveProjectMember(db, feature.project_id, principal.id);
      if (!actor || !isProjectManager(actor.role)) {
        return fail(new DomainError('close_forbidden', '只有 Owner 可以关闭任务', { principal_code: principal.code }));
      }

      const result = await db.transaction(async (tx) => {
        await assertProjectAccess(tx, feature.project_id, principal.id, 'manage');
        const [currentTask] = await tx.select().from(schema.tasks).where(eq(schema.tasks.id, task.id)).for('update').limit(1);
        if (!currentTask) throw new DomainError('task_not_found', `任务不存在：${cmd.taskCode}`);
        await assertNoPendingHandover(tx, currentTask.id);
        if (currentTask.status !== 'verified') {
          throw new DomainError('close_not_verified', `任务状态 ${currentTask.status}，只有 verified 可以关闭`, { status: currentTask.status });
        }
        if (currentTask.base_snapshot !== cmd.baseSnapshot) {
          throw new DomainError('base_snapshot_mismatch', '任务基线快照已变化，请刷新后重试（乐观并发）', {
            current: currentTask.base_snapshot,
            provided: cmd.baseSnapshot,
          });
        }
        const verifierEvidenceShape = {
          evidence_code: createPublicCode(),
          task_code: currentTask.code,
          type: 'verifier_review' as const,
          acceptance_refs: ['*'],
          result: 'pass' as const,
          recorded_at: now(),
        };
        transitionOrThrow('verified', 'closed', {
          task: { acceptance: parseAcceptance(currentTask.acceptance) },
          evidence: { selfTestEvidence: [], verifierEvidence: [verifierEvidenceShape], artifactCount: 1 },
          profile: 'verifier',
        });
        const updated = await tx.update(schema.tasks).set({
          status: 'closed',
          base_snapshot: cmd.baseSnapshot + 1,
        }).where(and(
          eq(schema.tasks.id, currentTask.id),
          eq(schema.tasks.status, 'verified'),
          eq(schema.tasks.base_snapshot, cmd.baseSnapshot),
        )).returning({ id: schema.tasks.id });
        if (updated.length === 0) {
          throw new DomainError('concurrent_modification', '任务已被并发修改，请刷新后重试', { task_code: currentTask.code });
        }
        const audit = {
          entity_type: 'task',
          entity_id: currentTask.id,
          legacy_entity_code: currentTask.legacy_code ?? undefined,
          from: 'verified',
          to: 'closed',
          principal_id: principal.id,
          base_snapshot: cmd.baseSnapshot,
          action: 'task.closed',
        };
        assertAuditedChange(audit);
        await insertAudit(tx, toAuditEvent(audit, createPublicCode(), now()));

        // 交付事实投影（架构不变量 8）：Feature 下不存在未完结任务时，
        // 自动把 active 的 Feature 标记为 delivered；存在未完结任务则保持现状。
        // 该状态仍可被 Owner 手工调整（updateFeature），此处只做"事实→状态"单向推进。
        const featureTasks = await tx.select({ status: schema.tasks.status }).from(schema.tasks)
          .where(eq(schema.tasks.feature_id, currentTask.feature_id));
        const hasUnfinishedTask = featureTasks.some((row) => !['closed', 'cancelled'].includes(row.status));
        if (!hasUnfinishedTask) {
          const [featureRow] = await tx.select().from(schema.features)
            .where(eq(schema.features.id, currentTask.feature_id)).limit(1);
          if (featureRow && featureRow.status === 'active') {
            await tx.update(schema.features).set({
              status: 'delivered',
            }).where(eq(schema.features.id, featureRow.id));
            const featureAudit = {
              entity_type: 'feature',
              entity_id: featureRow.id,
              legacy_entity_code: featureRow.legacy_code ?? undefined,
              principal_id: principal.id,
              base_snapshot: 0,
              action: 'feature.delivered',
              payload: { derived_from_task: currentTask.code },
            };
            assertAuditedChange(featureAudit);
            await insertAudit(tx, toAuditEvent(featureAudit, createPublicCode(), now()));
          }
        }
        return { task_code: currentTask.code, status: 'closed' as const, base_snapshot: cmd.baseSnapshot + 1 };
      });
      return { ok: true as const, data: result };
    } catch (error) {
      return fail(error);
    }
  }

  async function taskHistory(taskCode: string, principalCode?: string) {
    const task = await findTaskByCode(db, taskCode);
    if (!task) return [];
    const principal = principalCode ? await findUserByCode(db, principalCode) : undefined;
    const [feature] = await db.select().from(schema.features).where(eq(schema.features.id, task.feature_id)).limit(1);
    if (!principal || !feature || !await resolveProjectAccess(db, feature.project_id, principal.id)) return [];
    const rows = await db.select().from(schema.auditEvents).where(and(
      eq(schema.auditEvents.entity_type, 'task'),
      eq(schema.auditEvents.entity_id, task.id),
    )).orderBy(desc(schema.auditEvents.timestamp));
    const principalIds = [...new Set(rows.map((row) => row.principal_id))];
    const runIds = [...new Set(rows.map((row) => row.run_id).filter((value): value is bigint => value !== null))];
    const [users, runs] = await Promise.all([
      usersByIds(db, principalIds),
      runIds.length ? db.select().from(schema.runs).where(inArray(schema.runs.id, runIds)) : Promise.resolve([]),
    ]);
    const runMap = new Map(runs.map((row) => [row.id, row]));
    return rows.map((row) => ({
      timestamp: row.timestamp,
      action: row.action,
      principal_code: users.get(row.principal_id)?.code ?? '',
      run_code: row.run_id ? (runMap.get(row.run_id)?.code ?? null) : null,
      from: row.from_state,
      to: row.to_state,
      base_snapshot: row.base_snapshot,
    }));
  }

  return { verifyTask, closeTask, taskHistory };
}
