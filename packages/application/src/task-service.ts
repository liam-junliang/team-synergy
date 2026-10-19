import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Db } from '@team-synergy/persistence';
import { schema } from '@team-synergy/persistence';
import {
  DomainError,
  transitionOrThrow,
  assertAuditedChange,
  toAuditEvent,
  deriveView,
} from '@team-synergy/domain';
import type { ArtifactKind, Profile, TaskStatus, RequirementBaseline } from '@team-synergy/contracts';
import { loadRequirementBaseline } from './baseline-use-cases.js';
import {
  createPublicCode,
  findProjectByCode,
  findRunByCode,
  findTaskByCode,
  findUserByCode,
} from './public-code.js';
import { assertExecutionWrite, assertNoPendingHandover, executionDeviceId } from './execution-guard.js';
import { designPrototypeContentMetadata, type DesignPrototypeContentMetadata } from './design-prototype-content.js';
import { assertProjectAccess, effectiveProjectMember, isProjectManager, resolveProjectAccess } from './project-access.js';
import { captureRunSkills } from './skills-run.js';

export type TaskResult<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string; details?: unknown } };

export function fail<T>(e: unknown): TaskResult<T> {
  if (e instanceof DomainError) {
    return { ok: false, error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) } };
  }
  return { ok: false, error: { code: 'internal_error', message: e instanceof Error ? e.message : String(e) } };
}

export interface ListTasksFilter {
  principalCode?: string;
  assignedTo?: string;
  status?: TaskStatus;
  projectCode?: string;
}

export interface AssignCommand {
  taskCode: string;
  assigneePrincipalCode: string;
  principalCode: string;
  baseSnapshot: number;
}

export interface ClaimCommand {
  taskCode: string;
  runCode: string;
  workspaceCode: string;
  principalCode: string;
  profile: Profile;
  baseSnapshot: number;
  workspacePath: string;
  gitBase: string;
}

export interface SubmitCommand {
  taskCode: string;
  runCode: string;
  principalCode: string;
  baseSnapshot: number;
  deviceCode?: string;
  executionEpoch?: number;
  leaseToken?: string;
  artifact: { kind: ArtifactKind; uri: string; contentHash: string };
  evidence: {
    type: 'self_test' | 'verifier_review' | 'deployment' | 'manual';
    result: 'pass' | 'fail' | 'inconclusive';
    acceptanceRefs: string[];
    command?: string;
    summary?: string;
  };
}

export interface UpdateTaskContractCommand {
  taskCode: string;
  principalCode: string;
  baseSnapshot: number;
  title: string;
  brief?: string;
  acceptance: Array<{ id: string; text: string }>;
  validationSeams?: string[];
  scope?: { writable_paths: string[] } | null;
}

export interface CancelTaskCommand {
  taskCode: string;
  principalCode: string;
  baseSnapshot: number;
  reason?: string;
}

export function now(): string {
  return new Date().toISOString();
}

type DbTx = Parameters<Parameters<Db['transaction']>[0]>[0];

export async function insertAudit(tx: Db | DbTx, evt: ReturnType<typeof toAuditEvent>): Promise<void> {
  await tx.insert(schema.auditEvents).values({
    code: evt.code,
    timestamp: evt.timestamp,
    principal_id: evt.principal_id,
    run_id: evt.run_id,
    action: evt.action,
    entity_type: evt.entity_type,
    entity_id: evt.entity_id,
    legacy_entity_code: evt.legacy_entity_code,
    base_snapshot: evt.base_snapshot,
    from_state: evt.from,
    to_state: evt.to,
    payload: evt.payload ? JSON.stringify(evt.payload) : undefined,
  });
}

export function parseAcceptance(raw: string): Array<{ id: string; text: string }> {
  try {
    return JSON.parse(raw);
  } catch {
    throw new DomainError('acceptance_invalid', 'Task 的 acceptance 不是合法 JSON');
  }
}

async function usersByIds(db: Db | DbTx, ids: bigint[]) {
  if (ids.length === 0) return new Map<bigint, typeof schema.users.$inferSelect>();
  const rows = await db.select().from(schema.users).where(inArray(schema.users.id, ids));
  return new Map(rows.map((row) => [row.id, row]));
}

async function featuresByIds(db: Db | DbTx, ids: bigint[]) {
  if (ids.length === 0) return new Map<bigint, typeof schema.features.$inferSelect>();
  const rows = await db.select().from(schema.features).where(inArray(schema.features.id, ids));
  return new Map(rows.map((row) => [row.id, row]));
}

async function lockTaskProject(tx: DbTx, projectId: bigint) {
  const [project] = await tx.select({ team_id: schema.projects.team_id }).from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1);
  if (!project) throw new DomainError('project_not_found', '任务项目不存在');
  // Match governance mutations: users -> team -> project -> task. Hold these
  // locks through the write so archive, policy and membership changes cannot
  // invalidate a permission check while this operation waits for the task.
  await tx.select({ id: schema.teams.id }).from(schema.teams).where(eq(schema.teams.id, project.team_id)).for('share');
  await tx.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.id, projectId)).for('share');
}

async function defectsByIds(db: Db | DbTx, ids: bigint[]) {
  if (ids.length === 0) return new Map<bigint, typeof schema.defects.$inferSelect>();
  const rows = await db.select().from(schema.defects).where(inArray(schema.defects.id, ids));
  return new Map(rows.map((row) => [row.id, row]));
}

function parseStringArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function parseScope(raw: string | null): { writable_paths: string[] } | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object') return null;
    const candidate = value as { writable_paths?: unknown };
    return {
      writable_paths: Array.isArray(candidate.writable_paths)
        ? candidate.writable_paths.filter((item): item is string => typeof item === 'string')
        : [],
    };
  } catch {
    return null;
  }
}

let workspacePlaceholderSequence = 0n;

function nextWorkspacePlaceholderRunId(): bigint {
  workspacePlaceholderSequence += 1n;
  return -workspacePlaceholderSequence;
}

export function createTaskService(db: Db) {
  async function createRunWorkspace(
    tx: DbTx,
    cmd: Pick<ClaimCommand, 'runCode' | 'workspaceCode' | 'workspacePath' | 'gitBase'>,
    options: {
      taskId: bigint;
      projectId: bigint;
      principalId: bigint;
      profile: Profile;
      baseSnapshot: number;
      startedAt: string;
    },
  ) {
    const runCode = cmd.runCode.trim();
    const workspaceCode = cmd.workspaceCode.trim();
    const workspacePath = cmd.workspacePath.trim();
    const gitBase = cmd.gitBase.trim();
    if (!runCode) throw new DomainError('run_code_required', 'claim 必须提供 run_code');
    if (!workspaceCode) throw new DomainError('workspace_code_required', 'claim 必须提供 workspace_code');
    if (!workspacePath) throw new DomainError('workspace_path_required', 'claim 必须提供 workspace_path');
    if (!gitBase) throw new DomainError('git_base_required', 'claim 必须提供 git_base');

    const [existingRun, existingWorkspace] = await Promise.all([
      tx.select().from(schema.runs).where(eq(schema.runs.code, runCode)).limit(1).then((rows) => rows[0]),
      tx.select().from(schema.workspaces).where(eq(schema.workspaces.code, workspaceCode)).limit(1).then((rows) => rows[0]),
    ]);
    if (existingRun) throw new DomainError('run_code_exists', `run_code 已存在：${runCode}`);
    if (existingWorkspace) throw new DomainError('workspace_code_exists', `workspace_code 已存在：${workspaceCode}`);

    const [workspace] = await tx.insert(schema.workspaces).values({
      code: workspaceCode,
      run_id: nextWorkspacePlaceholderRunId(),
      path: workspacePath,
      git_base: gitBase,
      created_at: options.startedAt,
    }).returning();
    if (!workspace) throw new DomainError('internal_error', '工作区创建失败');

    const [run] = await tx.insert(schema.runs).values({
      code: runCode,
      task_id: options.taskId,
      principal_id: options.principalId,
      profile: options.profile,
      workspace_id: workspace.id,
      status: 'active',
      execution_epoch: (await tx.select({ epoch: schema.tasks.execution_epoch }).from(schema.tasks).where(eq(schema.tasks.id, options.taskId)).limit(1))[0]?.epoch ?? 0,
      base_snapshot: options.baseSnapshot,
      started_at: options.startedAt,
    }).returning();
    if (!run) throw new DomainError('internal_error', 'Run 创建失败');

    await captureRunSkills(tx, { projectId: options.projectId, principalId: options.principalId, runId: run.id });

    await tx.update(schema.workspaces).set({ run_id: run.id }).where(eq(schema.workspaces.id, workspace.id));
    return { workspace, run };
  }

  async function listTasks(filter: ListTasksFilter = {}) {
    const principal = filter.principalCode ? await findUserByCode(db, filter.principalCode) : undefined;
    if (!principal) return [];
    const project = filter.projectCode ? await findProjectByCode(db, filter.projectCode) : undefined;
    if (filter.projectCode && !project) return [];
    const assignee = filter.assignedTo ? await findUserByCode(db, filter.assignedTo) : undefined;
    if (filter.assignedTo && !assignee) return [];
    const projects = project ? [project] : await db.select().from(schema.projects);
    const visibleProjects = (await Promise.all(projects.map(async candidate =>
      await resolveProjectAccess(db, candidate.id, principal.id) ? candidate.id : null,
    ))).filter((id): id is bigint => id !== null);
    if (!visibleProjects.length) return [];
    const featureIds = (await db.select({ id: schema.features.id }).from(schema.features)
      .where(inArray(schema.features.project_id, visibleProjects))).map(row => row.id);
    if (!featureIds.length) return [];

    const rows = await db.select().from(schema.tasks).where(and(
      assignee ? eq(schema.tasks.assignee_principal_id, assignee.id) : undefined,
      filter.status ? eq(schema.tasks.status, filter.status) : undefined,
      featureIds ? inArray(schema.tasks.feature_id, featureIds) : undefined,
    ));
    const featureMap = await featuresByIds(db, [...new Set(rows.map((row) => row.feature_id))]);
    const userMap = await usersByIds(
      db,
      [...new Set(rows.map((row) => row.assignee_principal_id).filter((value): value is bigint => value !== null))],
    );
    const defectMap = await defectsByIds(
      db,
      [...new Set(rows.map((row) => row.defect_id).filter((value): value is bigint => value !== null))],
    );
    const closedAtMap = new Map<bigint, string>();
    const cancelledAtMap = new Map<bigint, string>();
    if (rows.length > 0) {
      const terminalEvents = await db.select({
        taskId: schema.auditEvents.entity_id,
        action: schema.auditEvents.action,
        timestamp: schema.auditEvents.timestamp,
      }).from(schema.auditEvents).where(and(
        eq(schema.auditEvents.entity_type, 'task'),
        inArray(schema.auditEvents.action, ['task.closed', 'task.cancelled']),
        inArray(schema.auditEvents.entity_id, rows.map((row) => row.id)),
      ));
      for (const event of terminalEvents) {
        if (event.taskId === null) continue;
        const target = event.action === 'task.cancelled' ? cancelledAtMap : closedAtMap;
        const current = target.get(event.taskId);
        if (!current || event.timestamp > current) target.set(event.taskId, event.timestamp);
      }
    }

    return rows.map((task) => ({
      task_code: task.code,
      feature_code: featureMap.get(task.feature_id)?.code ?? '',
      defect_code: task.defect_id ? (defectMap.get(task.defect_id)?.code ?? null) : null,
      title: task.title,
      brief: task.brief,
      profile: task.profile,
      source: task.source,
      status: task.status,
      assignee_principal_code: task.assignee_principal_id ? (userMap.get(task.assignee_principal_id)?.code ?? null) : null,
      acceptance: parseAcceptance(task.acceptance),
      base_snapshot: task.base_snapshot,
      created_at: task.created_at,
      completed_at: closedAtMap.get(task.id) ?? null,
      cancelled_at: cancelledAtMap.get(task.id) ?? null,
    }));
  }

  async function assignTask(cmd: AssignCommand) {
    try {
      const [task, actor, assignee] = await Promise.all([
        findTaskByCode(db, cmd.taskCode),
        findUserByCode(db, cmd.principalCode),
        findUserByCode(db, cmd.assigneePrincipalCode),
      ]);
      if (!task) return fail<TaskServiceAssignResult>(new DomainError('task_not_found', `任务不存在：${cmd.taskCode}`));
      if (!actor) return fail<TaskServiceAssignResult>(new DomainError('user_not_found', `用户不存在：${cmd.principalCode}`));
      if (!assignee) return fail<TaskServiceAssignResult>(new DomainError('user_not_found', `用户不存在：${cmd.assigneePrincipalCode}`));
      const [feature] = await db.select().from(schema.features).where(eq(schema.features.id, task.feature_id)).limit(1);
      if (!feature) return fail<TaskServiceAssignResult>(new DomainError('feature_not_found', `Feature 不存在：${task.feature_id}`));
      const [actorMember, assigneeMember] = await Promise.all([
        effectiveProjectMember(db, feature.project_id, actor.id),
        effectiveProjectMember(db, feature.project_id, assignee.id),
      ]);
      if (!actorMember || !isProjectManager(actorMember.role)) {
        return fail<TaskServiceAssignResult>(new DomainError('assign_forbidden', '只有 Owner 可以分派任务', { principal: cmd.principalCode }));
      }
      if (!assigneeMember || assigneeMember.role === 'viewer') {
        return fail<TaskServiceAssignResult>(new DomainError('assignee_not_member', '被分派人不是项目成员', { assignee: cmd.assigneePrincipalCode }));
      }

      const result = await db.transaction(async (tx) => {
        // Serialize assignment against closure and role removal before locking the task.
        for (const userId of [...new Set([actor.id, assignee.id])].sort((a, b) => a < b ? -1 : 1)) {
          await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, userId)).for('share');
        }
        await lockTaskProject(tx, feature.project_id);
        await assertProjectAccess(tx, feature.project_id, actor.id, 'manage');
        await assertProjectAccess(tx, feature.project_id, assignee.id, 'write');
        const [currentTask] = await tx.select().from(schema.tasks).where(eq(schema.tasks.id, task.id)).for('update').limit(1);
        if (!currentTask) throw new DomainError('task_not_found', `任务不存在：${cmd.taskCode}`);
        await assertNoPendingHandover(tx, currentTask.id);
        const fromStatus = currentTask.status as TaskStatus;
        const guardCtx = {
          task: { acceptance: parseAcceptance(currentTask.acceptance) },
          evidence: { selfTestEvidence: [], verifierEvidence: [], artifactCount: 0 },
          profile: currentTask.profile as Profile,
        };
        // draft 与 failed 都需要先经过 ready（验收标准门槛/返工重入）。
        if (fromStatus === 'draft' || fromStatus === 'failed') transitionOrThrow(fromStatus, 'ready', guardCtx);
        transitionOrThrow(fromStatus === 'draft' || fromStatus === 'failed' ? 'ready' : fromStatus, 'assigned', guardCtx);
        if (currentTask.base_snapshot !== cmd.baseSnapshot) {
          throw new DomainError('base_snapshot_mismatch', '任务基线快照已变化，请刷新后重试（乐观并发）', {
            current: currentTask.base_snapshot,
            provided: cmd.baseSnapshot,
          });
        }

        const updated = await tx.update(schema.tasks).set({
          assignee_principal_id: assignee.id,
          status: 'assigned',
          base_snapshot: cmd.baseSnapshot + 1,
        }).where(and(
          eq(schema.tasks.id, currentTask.id),
          eq(schema.tasks.status, fromStatus),
          eq(schema.tasks.base_snapshot, cmd.baseSnapshot),
        )).returning({ id: schema.tasks.id });
        if (updated.length === 0) {
          throw new DomainError('concurrent_modification', '任务已被并发修改，请刷新后重试', { task_code: currentTask.code });
        }

        const audit = {
          entity_type: 'task',
          entity_id: currentTask.id,
          legacy_entity_code: currentTask.legacy_code ?? undefined,
          from: fromStatus,
          to: 'assigned',
          principal_id: actor.id,
          base_snapshot: cmd.baseSnapshot,
          action: 'task.assigned',
          payload: { assignee_code: assignee.code },
        };
        assertAuditedChange(audit);
        await insertAudit(tx, toAuditEvent(audit, createPublicCode(), now()));
        return {
          task_code: currentTask.code,
          status: 'assigned' as const,
          assignee_principal_code: assignee.code,
          base_snapshot: cmd.baseSnapshot + 1,
        };
      });
      return { ok: true as const, data: result };
    } catch (error) {
      return fail<TaskServiceAssignResult>(error);
    }
  }

  async function claimTask(cmd: ClaimCommand) {
    try {
      const [task, principal] = await Promise.all([findTaskByCode(db, cmd.taskCode), findUserByCode(db, cmd.principalCode)]);
      if (!task) return fail<TaskServiceClaimResult>(new DomainError('task_not_found', `任务不存在：${cmd.taskCode}`));
      if (!principal) return fail<TaskServiceClaimResult>(new DomainError('user_not_found', `用户不存在：${cmd.principalCode}`));

      const result = await db.transaction(async (tx) => {
        await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, principal.id)).for('share');
        const [feature] = await tx.select().from(schema.features).where(eq(schema.features.id, task.feature_id)).limit(1);
        if (!feature) throw new DomainError('feature_not_found', '任务项目不存在');
        await lockTaskProject(tx, feature.project_id);
        await assertProjectAccess(tx, feature.project_id, principal.id, 'write');
        const [currentTask] = await tx.select().from(schema.tasks).where(eq(schema.tasks.id, task.id)).for('update').limit(1);
        if (!currentTask) throw new DomainError('task_not_found', `任务不存在：${cmd.taskCode}`);
        await assertNoPendingHandover(tx, currentTask.id);

        const [activeRun] = await tx.select().from(schema.runs).where(and(
          eq(schema.runs.task_id, currentTask.id),
          eq(schema.runs.status, 'active'),
        )).limit(1);
        if (activeRun) {
          throw new DomainError('claim_run_conflict', '该任务已有进行中的 Run，不能重复 Claim', {
            active_run_code: activeRun.code,
          });
        }

        if (cmd.profile === 'verifier' && currentTask.status === 'submitted') {
          if (currentTask.base_snapshot !== cmd.baseSnapshot) {
            throw new DomainError('base_snapshot_mismatch', '任务基线快照已变化，请刷新后重试（乐观并发）', {
              current: currentTask.base_snapshot,
              provided: cmd.baseSnapshot,
            });
          }
          const startedAt = now();
          const { workspace, run } = await createRunWorkspace(tx, cmd, {
            taskId: currentTask.id,
            projectId: feature.project_id,
            principalId: principal.id,
            profile: 'verifier',
            baseSnapshot: cmd.baseSnapshot,
            startedAt,
          });
          const audit = {
            entity_type: 'task',
            entity_id: currentTask.id,
            legacy_entity_code: currentTask.legacy_code ?? undefined,
            from: 'submitted',
            to: 'submitted',
            principal_id: principal.id,
            run_id: run.id,
            base_snapshot: cmd.baseSnapshot,
            action: 'task.verification_claimed',
          };
          assertAuditedChange(audit);
          await insertAudit(tx, toAuditEvent(audit, createPublicCode(), startedAt));
          return {
            task_code: currentTask.code,
            run_code: run.code,
            workspace_code: workspace.code,
            status: 'submitted' as const,
            verification_run: true,
          };
        }

        if (currentTask.status !== 'assigned') {
          throw new DomainError('claim_not_assigned', `任务当前状态 ${currentTask.status}，必须先分派（assigned）才能 Claim`, {
            status: currentTask.status,
          });
        }
        if (currentTask.assignee_principal_id !== principal.id) {
          throw new DomainError('claim_assignee_mismatch', '只有 Assignee 可以 Claim 此任务', {
            principal_code: principal.code,
          });
        }
        if (currentTask.profile !== cmd.profile) {
          throw new DomainError('claim_profile_mismatch', `任务要求 Profile ${currentTask.profile}，与 ${cmd.profile} 不符`, {
            required: currentTask.profile,
            provided: cmd.profile,
          });
        }
        if (currentTask.base_snapshot !== cmd.baseSnapshot) {
          throw new DomainError('base_snapshot_mismatch', '任务基线快照已变化，请刷新后重试（乐观并发）', {
            current: currentTask.base_snapshot,
            provided: cmd.baseSnapshot,
          });
        }

        const dependencies = await tx.select().from(schema.taskDependencies).where(eq(schema.taskDependencies.task_id, currentTask.id));
        if (dependencies.length > 0) {
          const depRows = await tx.select().from(schema.tasks)
            .where(inArray(schema.tasks.id, dependencies.map((dependency) => dependency.depends_on_task_id)));
          const unsatisfied = depRows.filter((row) => row.status !== 'closed');
          if (unsatisfied.length > 0) {
            throw new DomainError('claim_dependencies_unsatisfied', '依赖任务未完成，不能 Claim', {
              unsatisfied: unsatisfied.map((row) => `${row.code}:${row.status}`),
            });
          }
        }

        transitionOrThrow('assigned', 'running', {
          task: { acceptance: parseAcceptance(currentTask.acceptance) },
          evidence: { selfTestEvidence: [], verifierEvidence: [], artifactCount: 0 },
          profile: cmd.profile,
          activeRun: true,
        });

        const updated = await tx.update(schema.tasks).set({
          status: 'running',
          base_snapshot: cmd.baseSnapshot + 1,
        }).where(and(
          eq(schema.tasks.id, currentTask.id),
          eq(schema.tasks.status, 'assigned'),
          eq(schema.tasks.base_snapshot, cmd.baseSnapshot),
        )).returning({ id: schema.tasks.id });
        if (updated.length === 0) {
          throw new DomainError('concurrent_modification', '任务已被并发修改，请刷新后重试', { task_code: currentTask.code });
        }

        const startedAt = now();
        const { workspace, run } = await createRunWorkspace(tx, cmd, {
          taskId: currentTask.id,
          projectId: feature.project_id,
          principalId: principal.id,
          profile: cmd.profile,
          baseSnapshot: cmd.baseSnapshot + 1,
          startedAt,
        });

        const audit = {
          entity_type: 'task',
          entity_id: currentTask.id,
          legacy_entity_code: currentTask.legacy_code ?? undefined,
          from: 'assigned',
          to: 'running',
          principal_id: principal.id,
          run_id: run.id,
          base_snapshot: cmd.baseSnapshot,
          action: 'task.claimed',
        };
        assertAuditedChange(audit);
        await insertAudit(tx, toAuditEvent(audit, createPublicCode(), startedAt));
        return {
          task_code: currentTask.code,
          run_code: run.code,
          workspace_code: workspace.code,
          status: 'running' as const,
        };
      });

      return { ok: true as const, data: result };
    } catch (error) {
      return fail<TaskServiceClaimResult>(error);
    }
  }

  async function getTaskStatus(taskCode: string, principalCode?: string) {
    const task = await findTaskByCode(db, taskCode);
    if (!task) return fail<TaskServiceStatusResult>(new DomainError('task_not_found', `任务不存在：${taskCode}`));
    const principal = principalCode ? await findUserByCode(db, principalCode) : undefined;
    const [taskFeature] = await db.select().from(schema.features).where(eq(schema.features.id, task.feature_id)).limit(1);
    if (!principal || !taskFeature || !await resolveProjectAccess(db, taskFeature.project_id, principal.id)) {
      return fail<TaskServiceStatusResult>(new DomainError('project_forbidden', '当前用户无权访问此任务'));
    }
    const [feature, requirement, requirementRevision, designPrototypes, defect, runs, evidences, artifacts, assigneeRows] = await Promise.all([
      db.select().from(schema.features).where(eq(schema.features.id, task.feature_id)).limit(1).then((rows) => rows[0]),
      task.requirement_id !== null
        ? db.select().from(schema.requirements).where(eq(schema.requirements.id, task.requirement_id)).limit(1).then((rows) => rows[0])
        : Promise.resolve(undefined),
      task.source_requirement_revision_id !== null
        ? db.select().from(schema.requirementRevisions)
          .where(eq(schema.requirementRevisions.id, task.source_requirement_revision_id))
          .limit(1).then((rows) => rows[0])
        : task.requirement_id !== null
          ? db.select().from(schema.requirementRevisions)
            .where(eq(schema.requirementRevisions.requirement_id, task.requirement_id))
            .orderBy(desc(schema.requirementRevisions.revision))
            .limit(1)
            .then((rows) => rows[0])
        : Promise.resolve(undefined),
      task.requirement_id !== null
        ? db.select({
          prototype_code: schema.designPrototypes.code,
          title: schema.designPrototypes.title,
          summary: schema.designPrototypes.summary,
          status: schema.designPrototypes.status,
          current_revision: schema.designPrototypes.current_revision,
          html_content: schema.designPrototypeRevisions.html_content,
          content_kind: schema.designPrototypeRevisions.content_kind,
          external_url: schema.designPrototypeRevisions.external_url,
          file_name: schema.designPrototypeRevisions.file_name,
          file_mime_type: schema.designPrototypeRevisions.file_mime_type,
          file_size: schema.designPrototypeRevisions.file_size,
          file_sha256: schema.designPrototypeRevisions.file_sha256,
          notes_markdown: schema.designPrototypeRevisions.notes_markdown,
          change_summary: schema.designPrototypeRevisions.change_summary,
          updated_at: schema.designPrototypes.updated_at,
        })
          .from(schema.designPrototypeRequirements)
          .innerJoin(
            schema.designPrototypes,
            eq(schema.designPrototypeRequirements.prototype_id, schema.designPrototypes.id),
          )
          .innerJoin(
            schema.designPrototypeRevisions,
            and(
              eq(schema.designPrototypeRevisions.prototype_id, schema.designPrototypes.id),
              eq(schema.designPrototypeRevisions.revision, schema.designPrototypes.current_revision),
            ),
          )
          .where(eq(schema.designPrototypeRequirements.requirement_id, task.requirement_id))
          .orderBy(desc(schema.designPrototypes.updated_at))
        : Promise.resolve([]),
      task.defect_id !== null
        ? db.select().from(schema.defects).where(eq(schema.defects.id, task.defect_id)).limit(1).then((rows) => rows[0])
        : Promise.resolve(undefined),
      db.select().from(schema.runs).where(eq(schema.runs.task_id, task.id)),
      db.select().from(schema.evidences).where(eq(schema.evidences.task_id, task.id)),
      db.select().from(schema.artifacts).where(eq(schema.artifacts.task_id, task.id)),
      task.assignee_principal_id
        ? db.select().from(schema.users).where(eq(schema.users.id, task.assignee_principal_id)).limit(1)
        : Promise.resolve([]),
    ]);
    if (!feature) return fail<TaskServiceStatusResult>(new DomainError('feature_not_found', `Feature 不存在：${task.feature_id}`));
    const [project, requirementDocument, projectDocument, workspaces, users, sourceDocumentRevision] = await Promise.all([
      db.select().from(schema.projects).where(eq(schema.projects.id, feature.project_id)).limit(1).then((rows) => rows[0]),
      requirement?.document_id !== null && requirement?.document_id !== undefined
        ? db.select().from(schema.requirementDocuments).where(eq(schema.requirementDocuments.id, requirement.document_id)).limit(1).then((rows) => rows[0])
        : Promise.resolve(undefined),
      db.select().from(schema.projectDocuments).where(eq(schema.projectDocuments.project_id, feature.project_id)).limit(1).then((rows) => rows[0]),
      runs.length
        ? db.select().from(schema.workspaces).where(inArray(schema.workspaces.id, runs.map((run) => run.workspace_id)))
        : Promise.resolve([]),
      usersByIds(
        db,
        [...new Set([
          ...runs.map((run) => run.principal_id),
          ...[task.assignee_principal_id].filter((value): value is bigint => value !== null),
        ])],
      ),
      task.source_document_revision_id !== null
        ? db.select().from(schema.requirementDocumentRevisions).where(eq(schema.requirementDocumentRevisions.id, task.source_document_revision_id)).limit(1).then((rows) => rows[0])
        : Promise.resolve(undefined),
    ]);
    if (!project) return fail<TaskServiceStatusResult>(new DomainError('project_not_found', `项目不存在：${feature.project_id}`));
    const [baselineRow] = task.requirement_baseline_id !== null ? await db.select().from(schema.requirementBaselines)
      .where(and(eq(schema.requirementBaselines.id, task.requirement_baseline_id), eq(schema.requirementBaselines.project_id, project.id))).limit(1) : [];
    const requirementBaseline = baselineRow ? (await loadRequirementBaseline(db, project.id, baselineRow.code))?.baseline ?? null : null;
    const frozenRequirement = requirementBaseline?.requirements.find(item => item.requirement_code === requirement?.code);
    const [module, milestone] = await Promise.all([
      feature.module_id !== null
        ? db.select().from(schema.projectModules).where(eq(schema.projectModules.id, feature.module_id)).limit(1).then((rows) => rows[0])
        : Promise.resolve(undefined),
      feature.milestone_id !== null
        ? db.select().from(schema.projectMilestones).where(eq(schema.projectMilestones.id, feature.milestone_id)).limit(1).then((rows) => rows[0])
        : Promise.resolve(undefined),
    ]);
    const phase = milestone?.phase_id !== null && milestone?.phase_id !== undefined
      ? await db.select().from(schema.projectPhases).where(eq(schema.projectPhases.id, milestone.phase_id)).limit(1).then((rows) => rows[0])
      : undefined;
    const workspaceMap = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
    const assignee = assigneeRows[0];
    const view = deriveView({
      status: task.status as TaskStatus,
      hasActiveRun: runs.some((run) => run.status === 'active'),
      selfTestEvidence: evidences.filter((evidence) => evidence.type === 'self_test').map((evidence) => ({
        evidence_code: evidence.code,
        task_code: task.code,
        run_code: evidence.run_id
          ? (runs.find((run) => run.id === evidence.run_id)?.code ?? '')
          : '',
        type: evidence.type,
        acceptance_refs: parseStringArray(evidence.acceptance_refs),
        result: evidence.result,
        command: evidence.command ?? undefined,
        summary: evidence.summary ?? undefined,
        recorded_at: evidence.recorded_at,
      })),
      verifierEvidence: evidences.filter((evidence) => evidence.type === 'verifier_review').map((evidence) => ({
        evidence_code: evidence.code,
        task_code: task.code,
        run_code: evidence.run_id
          ? (runs.find((run) => run.id === evidence.run_id)?.code ?? '')
          : '',
        type: evidence.type,
        acceptance_refs: parseStringArray(evidence.acceptance_refs),
        result: evidence.result,
        command: evidence.command ?? undefined,
        summary: evidence.summary ?? undefined,
        recorded_at: evidence.recorded_at,
      })),
      artifacts: artifacts.map((artifact) => ({
        artifact_code: artifact.code,
        project_code: project.code,
        task_code: task.code,
        run_code: artifact.run_id
          ? (runs.find((run) => run.id === artifact.run_id)?.code ?? '')
          : undefined,
        kind: artifact.kind,
        title: artifact.title ?? undefined,
        summary: artifact.summary ?? undefined,
        uri: artifact.uri,
        content_hash: artifact.content_hash,
        published_at: artifact.published_at ?? now(),
      })),
    });
    return {
      ok: true as const,
      data: {
        task_code: task.code,
        feature_code: feature.code,
        feature_name: feature.title,
        module_code: module?.code ?? null,
        module_name: module?.name ?? null,
        milestone_code: milestone?.code ?? null,
        milestone_name: milestone?.name ?? null,
        phase_code: phase?.code ?? null,
        phase_name: phase?.name ?? null,
        project_code: project.code,
        project_document_code: projectDocument?.code ?? null,
        requirement_code: requirement?.code ?? null,
        requirement_baseline_code: requirementBaseline?.baseline_code ?? null,
        requirement_baseline_name: requirementBaseline?.name ?? null,
        requirement_baseline_version: requirementBaseline?.version ?? null,
        requirement_baseline: requirementBaseline,
        requirement_document_code: requirementDocument?.code ?? null,
        source_requirement_revision: requirementRevision?.revision ?? null,
        source_document_revision: sourceDocumentRevision?.revision ?? null,
        requirement_source_changed: Boolean(requirement && requirementRevision && requirement.current_revision !== requirementRevision.revision),
        requirement_document_source_changed: Boolean(requirementDocument && sourceDocumentRevision && requirementDocument.current_revision !== sourceDocumentRevision.revision),
        requirement_title: frozenRequirement?.title ?? requirement?.title ?? null,
        requirement_body: frozenRequirement?.body ?? requirementRevision?.summary ?? null,
        requirement_acceptance_criteria: frozenRequirement?.acceptance_criteria ?? (requirementRevision ? parseAcceptance(requirementRevision.acceptance_criteria) : []),
        requirement_open_questions: frozenRequirement?.open_questions ?? parseStringArray(requirementRevision?.open_questions ?? null),
        design_prototypes: designPrototypes.map((prototype) => ({ ...prototype,
          ...designPrototypeContentMetadata(prototype.prototype_code, { ...prototype, revision: prototype.current_revision }),
        })),
        defect_code: defect?.code ?? null,
        title: task.title,
        brief: task.brief,
        profile: task.profile,
        source: task.source,
        status: task.status,
        derived_view: view,
        assignee_principal_code: assignee?.code ?? null,
        acceptance: parseAcceptance(task.acceptance),
        validation_seams: parseStringArray(task.validation_seams),
        scope: parseScope(task.scope),
        base_snapshot: task.base_snapshot,
        execution_epoch: task.execution_epoch,
        runs: runs.map((run) => ({
          run_code: run.code,
          workspace_code: workspaceMap.get(run.workspace_id)?.code ?? '',
          workspace_path: workspaceMap.get(run.workspace_id)?.path ?? '',
          git_base: workspaceMap.get(run.workspace_id)?.git_base ?? '',
          status: run.status,
          profile: run.profile,
          principal_code: users.get(run.principal_id)?.code ?? '',
          base_snapshot: run.base_snapshot,
          execution_epoch: run.execution_epoch,
          continued_from_run_code: runs.find((sourceRun) => sourceRun.id === run.continued_from_run_id)?.code ?? null,
          started_at: run.started_at,
          finished_at: run.finished_at,
        })),
        evidences: evidences.map((evidence) => ({
          evidence_code: evidence.code,
          run_code: evidence.run_id
            ? (runs.find((run) => run.id === evidence.run_id)?.code ?? null)
            : null,
          type: evidence.type,
          acceptance_refs: parseStringArray(evidence.acceptance_refs),
          result: evidence.result,
          command: evidence.command,
          summary: evidence.summary,
          report_uri: evidence.report_uri,
          recorded_at: evidence.recorded_at,
        })),
        artifacts: artifacts.map((artifact) => ({
          artifact_code: artifact.code,
          project_code: project.code,
          run_code: artifact.run_id
            ? (runs.find((run) => run.id === artifact.run_id)?.code ?? null)
            : null,
          kind: artifact.kind,
          title: artifact.title,
          summary: artifact.summary,
          uri: artifact.uri,
          content_hash: artifact.content_hash,
          published: artifact.published,
          published_at: artifact.published_at,
        })),
        evidence_count: evidences.length,
        artifact_count: artifacts.length,
      },
    };
  }

  async function submitTask(cmd: SubmitCommand) {
    try {
      const [task, principal, run] = await Promise.all([
        findTaskByCode(db, cmd.taskCode),
        findUserByCode(db, cmd.principalCode),
        findRunByCode(db, cmd.runCode),
      ]);
      if (!task) return fail<TaskServiceSubmitResult>(new DomainError('task_not_found', `任务不存在：${cmd.taskCode}`));
      if (!principal) return fail<TaskServiceSubmitResult>(new DomainError('user_not_found', `用户不存在：${cmd.principalCode}`));
      if (!run) return fail<TaskServiceSubmitResult>(new DomainError('submit_run_mismatch', `Run 不存在：${cmd.runCode}`));

      const result = await db.transaction(async (tx) => {
        const [currentTask] = await tx.select().from(schema.tasks).where(eq(schema.tasks.id, task.id)).for('update').limit(1);
        const [currentRun] = await tx.select().from(schema.runs).where(eq(schema.runs.id, run.id)).limit(1);
        if (!currentTask) throw new DomainError('task_not_found', `任务不存在：${cmd.taskCode}`);
        await assertNoPendingHandover(tx, currentTask.id);
        if (!currentRun || currentRun.task_id !== currentTask.id) {
          throw new DomainError('submit_run_mismatch', 'Run 不存在或不属于该任务', { run_code: cmd.runCode });
        }
        if (currentRun.principal_id !== principal.id) {
          throw new DomainError('submit_identity_mismatch', 'Run 身份与当前 Principal 不匹配，拒绝冒用提交', {
            run_principal_code: currentRun.code,
            principal_code: principal.code,
          });
        }
        await assertExecutionWrite(tx, { taskId: currentTask.id, runId: currentRun.id, principalId: principal.id, deviceId: await executionDeviceId(tx, principal.id, cmd.deviceCode), epoch: cmd.executionEpoch, leaseToken: cmd.leaseToken });
        if (currentRun.status !== 'active') {
          throw new DomainError('submit_run_inactive', 'Run 已结束，不能提交', { status: currentRun.status });
        }
        if (currentTask.status !== 'running') {
          throw new DomainError('submit_task_not_running', `任务状态 ${currentTask.status}，不能提交`, { status: currentTask.status });
        }
        if (currentTask.base_snapshot !== cmd.baseSnapshot) {
          throw new DomainError('base_snapshot_mismatch', '任务基线快照已变化，请刷新后重试（乐观并发）', {
            current: currentTask.base_snapshot,
            provided: cmd.baseSnapshot,
          });
        }

        if (cmd.evidence.type !== 'self_test') {
          throw new DomainError('self_test_evidence_required', '提交需要 self_test 类型的自测 Evidence（架构不变量 5）', {
            provided: cmd.evidence.type,
          });
        }
        if (cmd.evidence.result !== 'pass') {
          throw new DomainError('evidence_not_passing', `自测 Evidence 必须为 pass，当前 ${cmd.evidence.result}`, {
            result: cmd.evidence.result,
          });
        }
        const acceptance = parseAcceptance(currentTask.acceptance);
        const acceptanceIds = new Set(acceptance.map((item) => item.id));
        if (cmd.evidence.acceptanceRefs.length === 0) {
          throw new DomainError('acceptance_refs_required', 'Evidence 必须声明覆盖的验收标准（acceptance_refs）');
        }
        const unknownRefs = cmd.evidence.acceptanceRefs.filter((id) => !acceptanceIds.has(id));
        if (unknownRefs.length > 0) {
          throw new DomainError('acceptance_refs_unknown', 'Evidence 引用了不存在的验收标准', { refs: unknownRefs });
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
        const evidenceCtx = { selfTestEvidence: [contractsEvidence], verifierEvidence: [], artifactCount: 1 };
        transitionOrThrow('running', 'self_tested', { task: { acceptance }, evidence: evidenceCtx, profile: 'builder' });
        transitionOrThrow('self_tested', 'submitted', { task: { acceptance }, evidence: evidenceCtx, profile: 'builder' });

        const updatedTask = await tx.update(schema.tasks).set({
          status: 'submitted',
          base_snapshot: cmd.baseSnapshot + 1,
        }).where(and(
          eq(schema.tasks.id, currentTask.id),
          eq(schema.tasks.status, 'running'),
          eq(schema.tasks.base_snapshot, cmd.baseSnapshot),
        )).returning({ id: schema.tasks.id });
        if (updatedTask.length === 0) {
          throw new DomainError('concurrent_modification', '任务已被并发修改，请刷新后重试', { task_code: currentTask.code });
        }
        const updatedRun = await tx.update(schema.runs).set({ status: 'completed', finished_at: now() })
          .where(and(eq(schema.runs.id, currentRun.id), eq(schema.runs.status, 'active')))
          .returning({ id: schema.runs.id });
        if (updatedRun.length === 0) throw new DomainError('run_not_active', 'Run 状态已变化，不能提交');

        const [feature] = await tx.select().from(schema.features).where(eq(schema.features.id, currentTask.feature_id)).limit(1);
        if (!feature) throw new DomainError('feature_not_found', `Feature 不存在：${currentTask.feature_id}`);
        const artifactCode = createPublicCode();
        const evidenceCode = createPublicCode();
        await tx.insert(schema.artifacts).values({
          code: artifactCode,
          project_id: feature.project_id,
          task_id: currentTask.id,
          run_id: currentRun.id,
          kind: cmd.artifact.kind,
          uri: cmd.artifact.uri,
          content_hash: cmd.artifact.contentHash,
          published: true,
          published_at: now(),
        });
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

        const auditSelfTested = {
          entity_type: 'task',
          entity_id: currentTask.id,
          legacy_entity_code: currentTask.legacy_code ?? undefined,
          from: 'running',
          to: 'self_tested',
          principal_id: principal.id,
          run_id: currentRun.id,
          base_snapshot: cmd.baseSnapshot,
          action: 'task.self_tested',
        };
        const auditSubmitted = {
          ...auditSelfTested,
          from: 'self_tested',
          to: 'submitted',
          action: 'task.submitted',
        };
        assertAuditedChange(auditSelfTested);
        assertAuditedChange(auditSubmitted);
        await insertAudit(tx, toAuditEvent(auditSelfTested, createPublicCode(), now()));
        await insertAudit(tx, toAuditEvent(auditSubmitted, createPublicCode(), now()));

        return {
          task_code: currentTask.code,
          run_code: currentRun.code,
          status: 'submitted' as const,
          artifact_code: artifactCode,
          evidence_code: evidenceCode,
          base_snapshot: cmd.baseSnapshot + 1,
        };
      });

      return { ok: true as const, data: result };
    } catch (error) {
      return fail<TaskServiceSubmitResult>(error);
    }
  }

  async function updateTaskContract(cmd: UpdateTaskContractCommand) {
    try {
      const [task, principal] = await Promise.all([
        findTaskByCode(db, cmd.taskCode),
        findUserByCode(db, cmd.principalCode),
      ]);
      if (!task) return fail<TaskServiceStatusResult>(new DomainError('task_not_found', `任务不存在：${cmd.taskCode}`));
      if (!principal || principal.status !== 'active') {
        return fail<TaskServiceStatusResult>(new DomainError('user_not_found', `用户不存在：${cmd.principalCode}`));
      }
      const [feature] = await db.select().from(schema.features).where(eq(schema.features.id, task.feature_id)).limit(1);
      if (!feature) return fail<TaskServiceStatusResult>(new DomainError('feature_not_found', `Feature 不存在：${task.feature_id}`));
      const member = await effectiveProjectMember(db, feature.project_id, principal.id);
      if (!member || !isProjectManager(member.role)) {
        return fail<TaskServiceStatusResult>(new DomainError('task_contract_forbidden', '只有项目 Owner 可以修改任务契约'));
      }
      if (!['draft', 'ready', 'assigned'].includes(task.status)) {
        return fail<TaskServiceStatusResult>(new DomainError('task_contract_locked', '任务进入执行后不能再修改契约', { status: task.status }));
      }
      const title = cmd.title.trim();
      if (!title) return fail<TaskServiceStatusResult>(new DomainError('task_title_required', '任务标题不能为空'));
      if (cmd.acceptance.length === 0) {
        return fail<TaskServiceStatusResult>(new DomainError('acceptance_required', '没有验收标准的 Task 不能创建（架构不变量 2）'));
      }

      const changedAt = now();
      const result = await db.transaction(async (tx) => {
        await assertProjectAccess(tx, feature.project_id, principal.id, 'manage');
        const [currentTask] = await tx.select().from(schema.tasks).where(eq(schema.tasks.id, task.id)).for('update').limit(1);
        if (!currentTask) throw new DomainError('task_not_found', `任务不存在：${cmd.taskCode}`);
        await assertNoPendingHandover(tx, currentTask.id);
        if (!['draft', 'ready', 'assigned'].includes(currentTask.status)) {
          throw new DomainError('task_contract_locked', '任务进入执行后不能再修改契约', { status: currentTask.status });
        }
        if (currentTask.base_snapshot !== cmd.baseSnapshot) {
          throw new DomainError('base_snapshot_mismatch', '任务基线快照已变化，请刷新后重试（乐观并发）', {
            current: currentTask.base_snapshot,
            provided: cmd.baseSnapshot,
          });
        }
        const [updatedTask] = await tx.update(schema.tasks).set({
          title,
          brief: cmd.brief?.trim() || '',
          acceptance: JSON.stringify(cmd.acceptance),
          validation_seams: cmd.validationSeams ? JSON.stringify(cmd.validationSeams) : null,
          scope: cmd.scope ? JSON.stringify(cmd.scope) : null,
          base_snapshot: cmd.baseSnapshot + 1,
        }).where(and(
          eq(schema.tasks.id, currentTask.id),
          eq(schema.tasks.base_snapshot, cmd.baseSnapshot),
        )).returning();
        if (!updatedTask) {
          throw new DomainError('concurrent_modification', '任务已被并发修改，请刷新后重试', { task_code: currentTask.code });
        }
        const audit = {
          entity_type: 'task',
          entity_id: currentTask.id,
          legacy_entity_code: currentTask.legacy_code ?? undefined,
          principal_id: principal.id,
          base_snapshot: cmd.baseSnapshot,
          action: 'task.contract_updated',
          payload: { title, brief: cmd.brief?.trim() || '', acceptance_count: cmd.acceptance.length },
        };
        assertAuditedChange(audit);
        await insertAudit(tx, toAuditEvent(audit, createPublicCode(), changedAt));
        return updatedTask;
      });
      return await getTaskStatus(result.code, principal.code);
    } catch (error) {
      return fail<TaskServiceStatusResult>(error);
    }
  }

  async function cancelTask(cmd: CancelTaskCommand) {
    try {
      const [task, principal] = await Promise.all([
        findTaskByCode(db, cmd.taskCode),
        findUserByCode(db, cmd.principalCode),
      ]);
      if (!task) return fail<TaskServiceStatusResult>(new DomainError('task_not_found', `任务不存在：${cmd.taskCode}`));
      if (!principal || principal.status !== 'active') {
        return fail<TaskServiceStatusResult>(new DomainError('user_not_found', `用户不存在：${cmd.principalCode}`));
      }
      const [feature] = await db.select().from(schema.features).where(eq(schema.features.id, task.feature_id)).limit(1);
      if (!feature) return fail<TaskServiceStatusResult>(new DomainError('feature_not_found', `Feature 不存在：${task.feature_id}`));
      const member = await effectiveProjectMember(db, feature.project_id, principal.id);
      if (!member || !isProjectManager(member.role)) {
        return fail<TaskServiceStatusResult>(new DomainError('task_cancel_forbidden', '只有项目 Owner 可以取消任务'));
      }
      if (!['draft', 'ready', 'assigned'].includes(task.status)) {
        return fail<TaskServiceStatusResult>(new DomainError('task_cancel_locked', '任务开始执行后不能取消', { status: task.status }));
      }

      const cancelledAt = now();
      const result = await db.transaction(async (tx) => {
        await assertProjectAccess(tx, feature.project_id, principal.id, 'manage');
        const [currentTask] = await tx.select().from(schema.tasks).where(eq(schema.tasks.id, task.id)).for('update').limit(1);
        if (!currentTask) throw new DomainError('task_not_found', `任务不存在：${cmd.taskCode}`);
        await assertNoPendingHandover(tx, currentTask.id);
        if (!['draft', 'ready', 'assigned'].includes(currentTask.status)) {
          throw new DomainError('task_cancel_locked', '任务开始执行后不能取消', { status: currentTask.status });
        }
        if (currentTask.base_snapshot !== cmd.baseSnapshot) {
          throw new DomainError('base_snapshot_mismatch', '任务基线快照已变化，请刷新后重试（乐观并发）', {
            current: currentTask.base_snapshot,
            provided: cmd.baseSnapshot,
          });
        }
        const fromStatus = currentTask.status as TaskStatus;
        transitionOrThrow(fromStatus, 'cancelled', {
          task: { acceptance: parseAcceptance(currentTask.acceptance) },
          evidence: { selfTestEvidence: [], verifierEvidence: [], artifactCount: 0 },
          profile: currentTask.profile as Profile,
        });
        const [updatedTask] = await tx.update(schema.tasks).set({
          status: 'cancelled',
          base_snapshot: cmd.baseSnapshot + 1,
        }).where(and(
          eq(schema.tasks.id, currentTask.id),
          eq(schema.tasks.status, fromStatus),
          eq(schema.tasks.base_snapshot, cmd.baseSnapshot),
        )).returning();
        if (!updatedTask) {
          throw new DomainError('concurrent_modification', '任务已被并发修改，请刷新后重试', { task_code: currentTask.code });
        }
        const audit = {
          entity_type: 'task',
          entity_id: currentTask.id,
          legacy_entity_code: currentTask.legacy_code ?? undefined,
          principal_id: principal.id,
          base_snapshot: cmd.baseSnapshot,
          from: fromStatus,
          to: 'cancelled',
          action: 'task.cancelled',
          payload: cmd.reason?.trim() ? { reason: cmd.reason.trim() } : undefined,
        };
        assertAuditedChange(audit);
        await insertAudit(tx, toAuditEvent(audit, createPublicCode(), cancelledAt));
        return updatedTask;
      });
      return await getTaskStatus(result.code, principal.code);
    } catch (error) {
      return fail<TaskServiceStatusResult>(error);
    }
  }

  return { listTasks, assignTask, claimTask, getTaskStatus, submitTask, updateTaskContract, cancelTask };
}

export interface TaskServiceAssignResult {
  task_code: string;
  status: 'assigned';
  assignee_principal_code: string;
  base_snapshot: number;
}

export interface TaskServiceClaimResult {
  task_code: string;
  run_code: string;
  workspace_code: string;
  status: 'running' | 'submitted';
  verification_run?: boolean;
}

export interface TaskServiceStatusResult {
  task_code: string;
  feature_code: string;
  feature_name: string;
  module_code: string | null;
  module_name: string | null;
  milestone_code: string | null;
  milestone_name: string | null;
  phase_code: string | null;
  phase_name: string | null;
  project_code: string;
  project_document_code: string | null;
  requirement_code: string | null;
  requirement_document_code: string | null;
  source_requirement_revision: number | null;
  requirement_baseline_code: string | null;
  requirement_baseline_name: string | null;
  requirement_baseline_version: number | null;
  requirement_baseline: RequirementBaseline | null;
  source_document_revision: number | null;
  requirement_source_changed: boolean;
  requirement_document_source_changed: boolean;
  requirement_title: string | null;
  requirement_body: string | null;
  requirement_acceptance_criteria: Array<{ id: string; text: string }>;
  requirement_open_questions: string[];
  design_prototypes: Array<DesignPrototypeContentMetadata & {
    prototype_code: string;
    title: string;
    summary: string;
    status: string;
    current_revision: number;
    html_content: string;
    notes_markdown: string;
    change_summary: string;
    updated_at: string;
  }>;
  defect_code: string | null;
  title: string;
  brief: string;
  profile: string;
  source: string;
  status: string;
  derived_view: string;
  assignee_principal_code: string | null;
  acceptance: Array<{ id: string; text: string }>;
  validation_seams: string[];
  scope: { writable_paths: string[] } | null;
  base_snapshot: number;
  runs: Array<{
    run_code: string;
    workspace_code: string;
    workspace_path: string;
    git_base: string;
    status: string;
    profile: string;
    principal_code: string;
    base_snapshot: number;
    started_at: string;
    finished_at: string | null;
  }>;
  evidences: Array<{
    evidence_code: string;
    run_code: string | null;
    type: string;
    acceptance_refs: string[];
    result: string;
    command: string | null;
    summary: string | null;
    report_uri: string | null;
    recorded_at: string;
  }>;
  artifacts: Array<{
    artifact_code: string;
    project_code: string;
    run_code: string | null;
    kind: string;
    title: string | null;
    summary: string | null;
    uri: string;
    content_hash: string;
    published: boolean;
    published_at: string | null;
  }>;
  evidence_count: number;
  artifact_count: number;
}

export interface TaskServiceSubmitResult {
  task_code: string;
  run_code: string;
  status: 'submitted';
  artifact_code: string;
  evidence_code: string;
  base_snapshot: number;
}

export type TaskService = ReturnType<typeof createTaskService>;
