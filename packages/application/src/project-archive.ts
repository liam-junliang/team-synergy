import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { DomainError } from '@team-synergy/domain';
import { schema, type Db } from '@team-synergy/persistence';
import { UNRESOLVED_HANDOVER_STATUSES } from './execution-guard.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
const liveRunStatuses = ['active', 'preparing', 'suspended'] as const;

/** Check while holding the project write fence and row lock. */
export async function assertNoProjectArchiveRuns(db: Pick<Db, 'select'>, projectId: bigint) {
  const activeRuns = await db.select({ code: schema.runs.code }).from(schema.runs)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.runs.task_id))
    .innerJoin(schema.features, eq(schema.features.id, schema.tasks.feature_id))
    .where(and(eq(schema.features.project_id, projectId), inArray(schema.runs.status, [...liveRunStatuses]))).limit(20);
  if (activeRuns.length) throw new DomainError('project_has_active_runs', '项目仍有运行或交接中的任务，请先完成交接或结束运行', { run_codes: activeRuns.map(row => row.code) });
}


/** Caller holds the exclusive project fence and project row lock. */
export async function stopProjectExecutionForArchive(tx: Tx, projectId: bigint) {
  const { agentSessions, features, runLeases, runs, taskHandovers, tasks } = schema;
  const projectTasks = () => tx.select({ id: tasks.id }).from(tasks)
    .innerJoin(features, eq(features.id, tasks.feature_id)).where(eq(features.project_id, projectId));

  // Project claims, session writes, and handover share the project fence.
  // Submit and verify lock their task before checking execution permission.
  // Recheck run and task state after locking so completed submissions survive.
  await projectTasks().orderBy(asc(tasks.id)).for('update', { of: tasks });
  const archivedAt = new Date().toISOString();
  const scope = projectTasks();
  const liveRuns = and(inArray(runs.task_id, scope), inArray(runs.status, [...liveRunStatuses]));
  const openHandovers = and(inArray(taskHandovers.task_id, scope),
    inArray(taskHandovers.status, [...UNRESOLVED_HANDOVER_STATUSES]));
  const interrupted = inArray(tasks.status, ['running', 'self_tested']);
  const touchedTasks = or(interrupted,
    inArray(tasks.id, tx.select({ id: runs.task_id }).from(runs).where(liveRuns)),
    inArray(tasks.id, tx.select({ id: taskHandovers.task_id }).from(taskHandovers).where(openHandovers)));
  await tx.update(tasks).set({
    execution_epoch: sql`${tasks.execution_epoch} + 1`,
    base_snapshot: sql`${tasks.base_snapshot} + 1`,
  }).where(and(inArray(tasks.id, scope), touchedTasks));
  const reset = await tx.update(tasks).set({
    status: sql`case when ${tasks.assignee_principal_id} is null then 'ready' else 'assigned' end`,
  }).where(and(inArray(tasks.id, scope), interrupted));

  // A terminal Run may still have an unacknowledged local session or lease.
  const projectRunIds = tx.select({ id: runs.id }).from(runs).where(inArray(runs.task_id, scope));
  await tx.update(runLeases).set({ revoked_at: archivedAt })
    .where(and(inArray(runLeases.run_id, projectRunIds), isNull(runLeases.revoked_at)));
  const sessions = await tx.update(agentSessions).set({
    status: 'cancelled', finished_at: archivedAt, last_error: '项目已由系统管理员强制归档',
  }).where(and(inArray(agentSessions.run_id, projectRunIds), inArray(agentSessions.status, ['starting', 'running'])));
  const handovers = await tx.update(taskHandovers).set({
    status: 'cancelled', updated_at: archivedAt, preparation_expires_at: archivedAt,
    version: sql`${taskHandovers.version} + 1`,
  }).where(openHandovers);
  const cancelled = await tx.update(runs).set({ status: 'cancelled', finished_at: archivedAt }).where(liveRuns);

  return {
    cancelled_runs: cancelled.rowCount ?? 0, cancelled_handovers: handovers.rowCount ?? 0,
    cancelled_sessions: sessions.rowCount ?? 0, reset_tasks: reset.rowCount ?? 0,
  };
}
