import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { TaskWebExecutionCommand } from '@team-synergy/contracts';
import { DomainError, toAuditEvent } from '@team-synergy/domain';
import { schema, type Db } from '@team-synergy/persistence';
import { lockAggregate } from './aggregate-lock.js';
import { assertNoPendingHandover, UNRESOLVED_HANDOVER_STATUSES } from './execution-guard.js';
import { assertProjectAccess, isProjectManager } from './project-access.js';
import { createPublicCode, findTaskByCode, findUserByCode } from './public-code.js';
import { insertAudit, parseAcceptance } from './task-service.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type ReadDb = Pick<Db, 'select'>;
type Task = typeof schema.tasks.$inferSelect;
type ExecutionRun = Pick<typeof schema.runs.$inferSelect,
  'id' | 'code' | 'status' | 'execution_epoch' | 'started_at' | 'workspace_id'>;
type ExecutionHealth = 'active' | 'expired' | 'unknown' | 'none';
const liveRunStatuses = ['active', 'preparing', 'suspended'] as const;

interface ExecutionResult {
  task_code: string;
  status: 'draft' | 'ready' | 'assigned';
  base_snapshot: number;
  assignee_principal_code: string | null;
  execution_epoch: number;
  stopped_run_codes: string[];
}

async function loadTaskScope(db: Db, taskCode: string) {
  const task = await findTaskByCode(db, taskCode);
  if (!task) throw new DomainError('task_not_found', '任务不存在');
  const [project] = await db.select({ id: schema.projects.id, team_id: schema.projects.team_id, status: schema.projects.status })
    .from(schema.features).innerJoin(schema.projects, eq(schema.projects.id, schema.features.project_id))
    .where(eq(schema.features.id, task.feature_id)).limit(1);
  if (!project) throw new DomainError('project_not_found', '任务项目不存在');
  return { task, project };
}

function liveRuns(db: ReadDb, taskId: bigint) {
  const { runs } = schema;
  return db.select({
    id: runs.id, code: runs.code, status: runs.status, execution_epoch: runs.execution_epoch,
    started_at: runs.started_at, workspace_id: runs.workspace_id,
  }).from(runs).where(and(eq(runs.task_id, taskId), inArray(runs.status, liveRunStatuses)))
    .orderBy(desc(runs.started_at), desc(runs.id));
}

export function classifyWebTaskExecutionHealth(
  run: Pick<ExecutionRun, 'status' | 'execution_epoch'> | undefined,
  taskEpoch: number,
  lease: Pick<typeof schema.runLeases.$inferSelect, 'expires_at' | 'revoked_at'> | undefined,
  now = Date.now(),
): ExecutionHealth {
  if (!run) return 'none';
  if (run.execution_epoch !== taskEpoch) return 'expired';
  if (!lease) return 'unknown';
  const expiresAt = Date.parse(lease.expires_at);
  if (lease.revoked_at || expiresAt <= now) return 'expired';
  if (!Number.isFinite(expiresAt)) return 'unknown';
  return run.status === 'active' ? 'active' : 'unknown';
}

async function leaseHealth(db: ReadDb, run: ExecutionRun | undefined, task: Task) {
  if (!run) return { health: 'none' as const, expiresAt: null };
  if (run.execution_epoch !== task.execution_epoch) return { health: 'expired' as const, expiresAt: null };
  const { runLeases } = schema;
  const [lease] = await db.select({ expires_at: runLeases.expires_at, revoked_at: runLeases.revoked_at })
    .from(runLeases).where(and(eq(runLeases.run_id, run.id), eq(runLeases.epoch, run.execution_epoch)))
    .orderBy(desc(runLeases.created_at), desc(runLeases.id)).limit(1);
  return { health: classifyWebTaskExecutionHealth(run, task.execution_epoch, lease), expiresAt: lease?.expires_at ?? null };
}

export function isTaskWebExecutionRecoverable(status: Task['status'], hasLiveRun: boolean): boolean {
  return status === 'running' || status === 'self_tested'
    || (hasLiveRun && (status === 'blocked' || status === 'failed' || status === 'assigned'));
}

async function observedRun(db: ReadDb, run: ExecutionRun | undefined) {
  if (!run) return { lastHeartbeatAt: null, gitBase: null };
  const { agentSessions, auditEvents, workspaces } = schema;
  const sessions = db.select({ id: agentSessions.id }).from(agentSessions).where(and(
    eq(agentSessions.run_id, run.id), eq(agentSessions.execution_epoch, run.execution_epoch)));
  const [[heartbeat], [workspace]] = await Promise.all([
    db.select({ at: auditEvents.timestamp }).from(auditEvents).where(and(
      eq(auditEvents.entity_type, 'agent_session'), inArray(auditEvents.entity_id, sessions),
      eq(auditEvents.run_id, run.id), eq(auditEvents.action, 'agent_session.status'), eq(auditEvents.to_state, 'running')))
      .orderBy(desc(auditEvents.timestamp), desc(auditEvents.id)).limit(1),
    db.select({ gitBase: workspaces.git_base }).from(workspaces).where(eq(workspaces.id, run.workspace_id)).limit(1),
  ]);
  return { lastHeartbeatAt: heartbeat?.at ?? null, gitBase: workspace?.gitBase ?? null };
}

/** Serializes with execution writes, handover and governance on this task only. */
export function createTaskWebExecution(db: Db) {
  async function inspect(taskCode: string, principalCode: string) {
    const [{ task, project }, actor] = await Promise.all([loadTaskScope(db, taskCode), findUserByCode(db, principalCode)]);
    if (!actor) throw new DomainError('user_not_found', '操作账号不存在');
    const access = await assertProjectAccess(db, project.id, actor.id);
    const [runs, [pending]] = await Promise.all([
      liveRuns(db, task.id),
      db.select({ id: schema.taskHandovers.id }).from(schema.taskHandovers).where(and(
        eq(schema.taskHandovers.task_id, task.id),
        inArray(schema.taskHandovers.status, [...UNRESOLVED_HANDOVER_STATUSES])))
        .limit(1),
    ]);
    const active = runs.find(run => run.status === 'active');
    const run = active ?? runs[0];
    const [lease, observed] = await Promise.all([leaseHealth(db, run, task), observedRun(db, run)]);
    const canManage = project.status === 'active' && isProjectManager(access.role);
    const canRecover = canManage && !pending && isTaskWebExecutionRecoverable(task.status, run !== undefined);
    const canRelease = canManage && !pending && task.status === 'assigned' && !run;
    const reason = project.status !== 'active' ? 'project_archived'
      : !canManage ? 'project_forbidden'
        : pending ? 'task_handover_pending'
          : !canRecover && !canRelease ? 'task_recovery_unavailable' : undefined;
    return {
      base_snapshot: task.base_snapshot,
      can_manage: canManage,
      can_recover: canRecover,
      recovery_requires_confirmation: canRecover && active !== undefined && lease.health !== 'expired',
      can_release: canRelease,
      execution_health: lease.health,
      running_since: run?.started_at ?? null,
      run_code: run?.code ?? null,
      last_heartbeat_at: observed.lastHeartbeatAt,
      git_base: observed.gitBase,
      lease_expires_at: lease.expiresAt,
      ...(reason ? { reason } : {}),
    };
  }

  async function apply(taskCode: string, principalCode: string, command: TaskWebExecutionCommand): Promise<ExecutionResult> {
    const reason = command.reason.trim();
    if (!reason || reason.length > 2000) throw new DomainError('validation_failed', '请填写 1 至 2000 个字符的操作原因');
    if (!Number.isSafeInteger(command.base_snapshot) || command.base_snapshot < 0) {
      throw new DomainError('base_snapshot_required', '请提供当前任务快照版本');
    }
    const targetCode = command.action === 'recover_execution' ? command.assignee_principal_code : undefined;
    const [{ task, project }, actor, assignee] = await Promise.all([
      loadTaskScope(db, taskCode), findUserByCode(db, principalCode), targetCode ? findUserByCode(db, targetCode) : undefined,
    ]);
    if (!actor) throw new DomainError('user_not_found', '操作账号不存在');
    const confirmActive = command.action === 'recover_execution' && command.confirm_active === true;
    const requestHash = command.idempotency_key ? createHash('sha256').update(JSON.stringify({
      action: command.action, base_snapshot: command.base_snapshot, reason, targetCode, confirmActive,
    })).digest('hex') : null;

    return db.transaction(async (tx: Tx) => {
      await lockAggregate(tx, 'project', project.id, true);
      await tx.select({ id: schema.users.id }).from(schema.users)
        .where(inArray(schema.users.id, [...new Set([actor.id, ...(assignee ? [assignee.id] : [])])]))
        .orderBy(asc(schema.users.id)).for('share');
      await tx.select({ id: schema.teams.id }).from(schema.teams).where(eq(schema.teams.id, project.team_id)).for('share');
      await tx.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.id, project.id)).for('share');
      await assertProjectAccess(tx, project.id, actor.id, 'manage');
      const [currentTask] = await tx.select().from(schema.tasks).where(eq(schema.tasks.id, task.id)).for('update').limit(1);
      if (!currentTask || currentTask.feature_id !== task.feature_id) throw new DomainError('task_not_found', '任务不存在或所属功能已变化');

      const operation = 'task.web_execution.' + currentTask.code;
      if (command.idempotency_key) {
        const { commandReceipts } = schema;
        const [stored] = await tx.select({ hash: commandReceipts.request_hash, result: commandReceipts.result })
          .from(commandReceipts).where(and(eq(commandReceipts.principal_id, actor.id), eq(commandReceipts.operation, operation),
            eq(commandReceipts.key, command.idempotency_key))).limit(1);
        if (stored) {
          if (stored.hash !== requestHash) throw new DomainError('idempotency_conflict', '同一幂等键不能用于其他请求');
          return JSON.parse(stored.result) as ExecutionResult;
        }
      }
      if (currentTask.base_snapshot !== command.base_snapshot) {
        throw new DomainError('base_snapshot_mismatch', '任务已更新，请核对最新状态后重试', {
          current: currentTask.base_snapshot, provided: command.base_snapshot,
        });
      }
      await assertNoPendingHandover(tx, currentTask.id);
      if (targetCode) {
        if (!assignee) throw new DomainError('assignee_not_member', '所选成员不能执行此项目的任务');
        await assertProjectAccess(tx, project.id, assignee.id, 'write');
      }

      const runs = await liveRuns(tx, currentTask.id);
      const releasing = command.action === 'release_assignment';
      if (releasing) {
        if (currentTask.status !== 'assigned') throw new DomainError('task_recovery_unavailable', '只有待领取的任务可以收回分派');
        if (runs.length) throw new DomainError('task_run_active', '任务仍有未结束的执行，请先处理该 Run');
      } else {
        if (!isTaskWebExecutionRecoverable(currentTask.status, runs.length > 0)) {
          throw new DomainError('task_recovery_unavailable', '当前任务没有可收回的执行');
        }
        const active = runs.find(run => run.status === 'active');
        const lease = await leaseHealth(tx, active, currentTask);
        if (active && lease.health !== 'expired' && !confirmActive) {
          throw new DomainError('task_execution_confirmation_required', '当前执行仍可能在运行，请确认收回后再继续', { run_code: active.code });
        }
      }

      const acceptance = parseAcceptance(currentTask.acceptance);
      const hasAcceptance = Array.isArray(acceptance) && acceptance.length > 0;
      if (assignee && !hasAcceptance) throw new DomainError('acceptance_required', '请先收回到草稿，再补充验收标准并分派');
      const status = assignee ? 'assigned' : hasAcceptance ? 'ready' : 'draft';
      const updatedAt = new Date().toISOString();
      const executionEpoch = currentTask.execution_epoch + (releasing ? 0 : 1);
      if (!releasing) {
        const { agentSessions, runLeases, runs: runTable } = schema;
        const taskRunIds = tx.select({ id: runTable.id }).from(runTable).where(eq(runTable.task_id, currentTask.id));
        await tx.update(runLeases).set({ revoked_at: updatedAt })
          .where(and(inArray(runLeases.run_id, taskRunIds), isNull(runLeases.revoked_at)));
        await tx.update(agentSessions).set({
          status: 'cancelled', finished_at: updatedAt, last_error: '旧执行已由项目负责人在网页收回',
        }).where(and(inArray(agentSessions.run_id, taskRunIds), inArray(agentSessions.status, ['starting', 'running'])));
        await tx.update(runTable).set({ status: 'cancelled', finished_at: updatedAt })
          .where(and(eq(runTable.task_id, currentTask.id), inArray(runTable.status, liveRunStatuses)));
      }

      const [updated] = await tx.update(schema.tasks).set({
        status, assignee_principal_id: assignee?.id ?? null,
        execution_epoch: executionEpoch, base_snapshot: currentTask.base_snapshot + 1,
      }).where(and(eq(schema.tasks.id, currentTask.id), eq(schema.tasks.base_snapshot, currentTask.base_snapshot),
        eq(schema.tasks.status, currentTask.status))).returning({ snapshot: schema.tasks.base_snapshot });
      if (!updated) throw new DomainError('concurrent_modification', '任务已更新，请核对最新状态后重试');

      const [previousAssignee] = currentTask.assignee_principal_id !== null
        ? await tx.select({ code: schema.users.code }).from(schema.users)
          .where(eq(schema.users.id, currentTask.assignee_principal_id)).limit(1)
        : [];
      const result: ExecutionResult = {
        task_code: currentTask.code, status, base_snapshot: updated.snapshot,
        assignee_principal_code: assignee?.code ?? null, execution_epoch: executionEpoch,
        stopped_run_codes: runs.map(run => run.code),
      };
      await insertAudit(tx, toAuditEvent({
        entity_type: 'task', entity_id: currentTask.id, legacy_entity_code: currentTask.legacy_code ?? undefined,
        principal_id: actor.id, run_id: runs.find(run => run.status === 'active')?.id ?? runs[0]?.id,
        action: releasing ? 'task.assignment_released' : 'task.execution_recovered',
        base_snapshot: currentTask.base_snapshot, from: currentTask.status, to: status,
        payload: {
          source: 'web', reason, previous_assignee_code: previousAssignee?.code ?? null,
          assignee_code: result.assignee_principal_code, stopped_run_codes: result.stopped_run_codes,
          execution_epoch: executionEpoch,
        },
      }, createPublicCode(), updatedAt));
      if (command.idempotency_key && requestHash) {
        await tx.insert(schema.commandReceipts).values({
          code: createPublicCode(), principal_id: actor.id, operation, key: command.idempotency_key,
          request_hash: requestHash, result: JSON.stringify(result), created_at: updatedAt,
        });
      }
      return result;
    });
  }
  return { inspect, apply };
}
