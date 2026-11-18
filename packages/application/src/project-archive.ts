import { and, eq, inArray } from 'drizzle-orm';
import { DomainError } from '@team-synergy/domain';
import { schema, type Db } from '@team-synergy/persistence';

/** Check while holding the project write fence and row lock. */
export async function assertNoProjectArchiveRuns(db: Pick<Db, 'select'>, projectId: bigint) {
  const activeRuns = await db.select({ code: schema.runs.code }).from(schema.runs)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.runs.task_id))
    .innerJoin(schema.features, eq(schema.features.id, schema.tasks.feature_id))
    .where(and(eq(schema.features.project_id, projectId), inArray(schema.runs.status, ['active', 'preparing', 'suspended']))).limit(20);
  if (activeRuns.length) throw new DomainError('project_has_active_runs', '项目仍有运行或交接中的任务，请先完成交接或结束运行', { run_codes: activeRuns.map(row => row.code) });
}
