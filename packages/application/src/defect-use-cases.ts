import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Db } from '@team-synergy/persistence';
import { schema } from '@team-synergy/persistence';
import { DomainError, assertAuditedChange, toAuditEvent } from '@team-synergy/domain';
import type { DefectEvidence, DefectEvidenceInput } from '@team-synergy/contracts';
import { fail, insertAudit, now, type TaskResult } from './task-service.js';
import { normalizeDefectReport } from './defect-report.js';
import { assertProjectAccess, effectiveProjectMember, isProjectManager, resolveProjectAccess } from './project-access.js';
import { assertRequirementInProject } from './project-use-cases.js';
import {
  createPublicCode,
  findDefectByCode,
  findFeatureByCode,
  findProjectByCode,
  findRequirementByCode,
  findTaskByCode,
  findUserByCode,
} from './public-code.js';

export type DefectSeverity = 'critical' | 'high' | 'medium' | 'low';
export type DefectStatus = 'reported' | 'triaged' | 'fixing' | 'retest' | 'closed' | 'rejected';

const SEVERITIES: DefectSeverity[] = ['critical', 'high', 'medium', 'low'];
const FLOW: Record<DefectStatus, DefectStatus[]> = {
  reported: ['triaged', 'rejected'],
  triaged: ['fixing', 'rejected'],
  fixing: ['retest', 'rejected'],
  retest: ['closed', 'triaged', 'rejected'],
  closed: [],
  rejected: [],
};

async function usersByIds(db: Db, ids: bigint[]) {
  if (ids.length === 0) return new Map<bigint, typeof schema.users.$inferSelect>();
  const rows = await db.select().from(schema.users).where(inArray(schema.users.id, ids));
  return new Map(rows.map((row) => [row.id, row]));
}

export function createDefectUseCases(db: Db) {
  async function reportDefect(cmd: {
    featureCode: string;
    title: string;
    severity: DefectSeverity;
    description?: string;
    actionSteps: string;
    expectedResult: string;
    actualResult: string;
    evidence: DefectEvidenceInput[];
    foundIn?: string;
    relatedRequirementCode?: string;
    principalCode: string;
  }) {
    try {
      const [feature, principal] = await Promise.all([
        findFeatureByCode(db, cmd.featureCode),
        findUserByCode(db, cmd.principalCode),
      ]);
      if (!feature) return fail(new DomainError('feature_not_found', `Feature 不存在：${cmd.featureCode}`));
      if (!principal || principal.status !== 'active') return fail(new DomainError('user_not_found', `用户不存在：${cmd.principalCode}`));
      if (!await resolveProjectAccess(db, feature.project_id, principal.id)) return fail(new DomainError('defect_forbidden', '只有当前项目成员可以报告缺陷'));
      await assertProjectAccess(db, feature.project_id, principal.id, 'write');
      if (!SEVERITIES.includes(cmd.severity)) {
        return fail(new DomainError('invalid_severity', `非法严重度：${cmd.severity}`, { valid: SEVERITIES }));
      }

      let relatedRequirementId: bigint | null = null;
      let relatedRequirementCode: string | null = null;
      if (cmd.relatedRequirementCode) {
        const requirement = await findRequirementByCode(db, cmd.relatedRequirementCode);
        if (!requirement) return fail(new DomainError('requirement_not_found', `需求不存在：${cmd.relatedRequirementCode}`));
        await assertRequirementInProject(db, requirement, feature.project_id);
        relatedRequirementId = requirement.id;
        relatedRequirementCode = requirement.code;
      }

      const defectCode = createPublicCode();
      const { facts, files } = normalizeDefectReport(cmd);
      await db.transaction(async tx => {
        const [defect] = await tx.insert(schema.defects).values({
          ...facts, code: defectCode, feature_id: feature.id, severity: cmd.severity, reported_by: principal.id,
          found_in: cmd.foundIn?.trim() || null, status: 'reported', related_requirement: relatedRequirementId,
        }).returning({ id: schema.defects.id });
        if (!defect) throw new DomainError('internal_error', '缺陷创建失败');
        if (files.length) await tx.insert(schema.defectEvidenceFiles).values(files.map(file => ({ ...file, defect_id: defect.id })));
        const audit = {
          entity_type: 'defect', entity_id: defect.id, principal_id: principal.id, base_snapshot: 0, action: 'defect.reported',
          payload: { severity: cmd.severity, feature_code: feature.code, related_requirement_code: relatedRequirementCode },
        };
        assertAuditedChange(audit);
        await insertAudit(tx, toAuditEvent(audit, createPublicCode(), now()));
      });
      return {
        ok: true as const,
        data: { defect_code: defectCode, status: 'reported' as const },
      };
    } catch (error) {
      return fail(error);
    }
  }

  async function listDefects(filter: { status?: DefectStatus; featureCode?: string; projectCode?: string; principalCode?: string } = {}) {
    const principal = filter.principalCode ? await findUserByCode(db, filter.principalCode) : undefined;
    if (!principal) return [];
    const feature = filter.featureCode ? await findFeatureByCode(db, filter.featureCode) : undefined;
    const project = filter.projectCode ? await findProjectByCode(db, filter.projectCode) : undefined;
    if (filter.featureCode && !feature) return [];
    if (filter.projectCode && !project) return [];
    const projects = project ? [project] : await db.select().from(schema.projects)
      .where(feature ? eq(schema.projects.id, feature.project_id) : eq(schema.projects.status, 'active'));
    const visibleProjects = (await Promise.all(projects.map(async candidate =>
      await resolveProjectAccess(db, candidate.id, principal.id) ? candidate.id : null,
    ))).filter((id): id is bigint => id !== null);
    if (!visibleProjects.length) return [];
    const projectFeatureIds = (await db.select({ id: schema.features.id }).from(schema.features)
      .where(inArray(schema.features.project_id, visibleProjects))).map(row => row.id);
    if (!projectFeatureIds.length) return [];
    const rows = await db.select().from(schema.defects).where(and(
      filter.status ? eq(schema.defects.status, filter.status) : undefined,
      feature ? eq(schema.defects.feature_id, feature.id) : undefined,
      projectFeatureIds ? inArray(schema.defects.feature_id, projectFeatureIds) : undefined,
    )).orderBy(desc(schema.defects.id));
    const featureIds = [...new Set(rows.map((row) => row.feature_id))];
    const requirementIds = [...new Set(rows.map((row) => row.related_requirement).filter((value): value is bigint => value !== null))];
    const defectIds = rows.map((row) => row.id);
    const fixTasks = defectIds.length
      ? await db.select().from(schema.tasks).where(inArray(schema.tasks.defect_id, defectIds)).orderBy(desc(schema.tasks.id))
      : [];
    const reportedEvents = defectIds.length
      ? await db.select().from(schema.auditEvents).where(and(
        eq(schema.auditEvents.entity_type, 'defect'),
        eq(schema.auditEvents.action, 'defect.reported'),
        inArray(schema.auditEvents.entity_id, defectIds),
      ))
      : [];
    const userIds = [...new Set([
      ...rows.map((row) => row.reported_by),
      ...fixTasks.map((task) => task.assignee_principal_id).filter((value): value is bigint => value !== null),
    ])];
    const [features, requirements, users] = await Promise.all([
      featureIds.length ? db.select().from(schema.features).where(inArray(schema.features.id, featureIds)) : Promise.resolve([]),
      requirementIds.length ? db.select().from(schema.requirements).where(inArray(schema.requirements.id, requirementIds)) : Promise.resolve([]),
      usersByIds(db, userIds),
    ]);
    const featureMap = new Map(features.map((row) => [row.id, row]));
    const requirementMap = new Map(requirements.map((row) => [row.id, row]));
    const reportedAtMap = new Map<bigint, string>();
    for (const event of reportedEvents) {
      if (event.entity_id !== null && (!reportedAtMap.has(event.entity_id) || event.timestamp < reportedAtMap.get(event.entity_id)!)) {
        reportedAtMap.set(event.entity_id, event.timestamp);
      }
    }
    return rows.map((defect) => ({
      defect_code: defect.code,
      feature_code: featureMap.get(defect.feature_id)?.code ?? '',
      title: defect.title,
      severity: defect.severity,
      status: defect.status,
      reported_by_user_code: users.get(defect.reported_by)?.code ?? '',
      description: defect.description,
      action_steps: defect.action_steps,
      expected_result: defect.expected_result,
      actual_result: defect.actual_result,
      evidence: JSON.parse(defect.evidence_json) as DefectEvidence[],
      found_in: defect.found_in,
      related_requirement_code: defect.related_requirement ? (requirementMap.get(defect.related_requirement)?.code ?? null) : null,
      reported_at: reportedAtMap.get(defect.id) ?? null,
      fix_tasks: fixTasks.filter((task) => task.defect_id === defect.id).map((task) => ({
        task_code: task.code,
        title: task.title,
        status: task.status,
        assignee_principal_code: task.assignee_principal_id ? (users.get(task.assignee_principal_id)?.code ?? null) : null,
        created_at: task.created_at,
      })),
    }));
  }

  async function getEvidenceFile(code: string, index: number, principalCode: string): Promise<TaskResult<{ file_name: string; bytes: Buffer }>> {
    try {
      const principal = await findUserByCode(db, principalCode);
      const defect = await findDefectByCode(db, code);
      if (!defect) throw new DomainError('defect_not_found', '缺陷不存在');
      const [feature] = await db.select({ project_id: schema.features.project_id }).from(schema.features).where(eq(schema.features.id, defect.feature_id));
      if (!principal || !feature) throw new DomainError('defect_forbidden', '无权读取此缺陷');
      await assertProjectAccess(db, feature.project_id, principal.id);
      const evidence = (JSON.parse(defect.evidence_json) as DefectEvidence[])[index];
      if (!Number.isSafeInteger(index) || index < 0 || evidence?.kind !== 'file') throw new DomainError('defect_file_not_found', '证据文件不存在');
      const [file] = await db.select({ content: schema.defectEvidenceFiles.content_base64 }).from(schema.defectEvidenceFiles)
        .where(and(eq(schema.defectEvidenceFiles.defect_id, defect.id), eq(schema.defectEvidenceFiles.evidence_index, index)));
      if (!file) throw new DomainError('defect_file_not_found', '证据文件不存在');
      return { ok: true, data: { file_name: evidence.file_name, bytes: Buffer.from(file.content, 'base64') } };
    } catch (error) { return fail(error); }
  }

  async function transitionDefect(cmd: {
    defectCode: string;
    to: DefectStatus;
    principalCode: string;
    fixTaskCode?: string;
  }) {
    try {
      const [defect, principal] = await Promise.all([
        findDefectByCode(db, cmd.defectCode),
        findUserByCode(db, cmd.principalCode),
      ]);
      if (!defect) return fail(new DomainError('defect_not_found', `缺陷不存在：${cmd.defectCode}`));
      if (!principal || principal.status !== 'active') return fail(new DomainError('user_not_found', `用户不存在：${cmd.principalCode}`));
      const [feature] = await db.select().from(schema.features).where(eq(schema.features.id, defect.feature_id)).limit(1);
      if (!feature) return fail(new DomainError('feature_not_found', `Feature 不存在：${defect.feature_id}`));
      const member = await effectiveProjectMember(db, feature.project_id, principal.id);
      await assertProjectAccess(db, feature.project_id, principal.id, 'write');
      const allowed = FLOW[defect.status as DefectStatus] ?? [];
      if (!allowed.includes(cmd.to)) {
        return fail(new DomainError('defect_transition_invalid', `非法流转：${defect.status} → ${cmd.to}`, { allowed }));
      }
      if (['triaged', 'closed', 'rejected'].includes(cmd.to) && !isProjectManager(member?.role)) {
        return fail(new DomainError('defect_forbidden', `只有项目 Owner 或 Admin 可以执行 ${cmd.to}`, { principal_code: principal.code }));
      }

      let fixTaskCode: string | undefined;
      if (cmd.to === 'fixing') {
        if (!cmd.fixTaskCode) return fail(new DomainError('fix_task_required', '进入 fixing 必须绑定修复任务（Task 来源 defect）'));
        const task = await findTaskByCode(db, cmd.fixTaskCode);
        if (!task) return fail(new DomainError('task_not_found', `修复任务不存在：${cmd.fixTaskCode}`));
        if (task.source !== 'defect-fix') {
          return fail(new DomainError('fix_task_source_mismatch', '修复任务的来源必须是 defect-fix', { source: task.source }));
        }
        if (task.defect_id !== defect.id) {
          return fail(new DomainError('fix_task_defect_mismatch', '修复任务没有绑定到当前缺陷', {
            task_code: task.code,
            defect_code: defect.code,
          }));
        }
        const [taskFeature] = await db.select().from(schema.features).where(eq(schema.features.id, task.feature_id)).limit(1);
        if (!taskFeature || taskFeature.project_id !== feature.project_id) {
          return fail(new DomainError('fix_task_project_mismatch', '修复任务必须属于同一项目'));
        }
        fixTaskCode = task.code;
      }

      if (cmd.to === 'retest') {
        const linkedTasks = await db.select().from(schema.tasks).where(eq(schema.tasks.defect_id, defect.id));
        if (!linkedTasks.some((task) => task.status === 'verified' || task.status === 'closed')) {
          return fail(new DomainError('fix_task_not_completed', '至少一个关联修复任务完成验证后，缺陷才能进入回归', {
            defect_code: defect.code,
            task_statuses: linkedTasks.map((task) => `${task.code}:${task.status}`),
          }));
        }
      }

      await db.update(schema.defects).set({ status: cmd.to }).where(eq(schema.defects.id, defect.id));
      const audit = {
        entity_type: 'defect',
        entity_id: defect.id,
        legacy_entity_code: defect.legacy_code ?? undefined,
        from: defect.status,
        to: cmd.to,
        principal_id: principal.id,
        base_snapshot: 0,
        action: `defect.${cmd.to}`,
        payload: fixTaskCode ? { fix_task_code: fixTaskCode } : undefined,
      };
      assertAuditedChange(audit);
      await insertAudit(db, toAuditEvent(audit, createPublicCode(), now()));
      return { ok: true as const, data: { defect_code: defect.code, status: cmd.to } };
    } catch (error) {
      return fail(error);
    }
  }

  return { reportDefect, listDefects, getEvidenceFile, transitionDefect };
}

export type DefectUseCases = ReturnType<typeof createDefectUseCases>;
