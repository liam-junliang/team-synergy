import { and, eq, sql } from 'drizzle-orm';
import { schema, type Db } from '@team-synergy/persistence';
import { DomainError } from '@team-synergy/domain';
import { loadRequirementBaseline } from './baseline-use-cases.js';
import { assertNoPendingHandover } from './execution-guard.js';
import { createPublicCode } from './public-code.js';
import { fail, now } from './task-service.js';
import { assertProjectAccess, effectiveProjectMember, isProjectManager } from './project-access.js';

/** A baseline is an execution contract, so it can only be selected before any Run. */
export function createTaskBaselineUseCases(db: Db) {
  return {
    async bind(command: { taskCode: string; baselineCode: string; principalCode: string; baseSnapshot: number }) {
      try {
        const data = await db.transaction(async tx => {
          await tx.execute(sql`select pg_advisory_xact_lock_shared(1094930512)`);
          const [task] = await tx.select().from(schema.tasks).where(eq(schema.tasks.code, command.taskCode)).for('update').limit(1);
          if (!task) throw new DomainError('task_not_found', '任务不存在');
          const [feature] = await tx.select().from(schema.features).where(eq(schema.features.id, task.feature_id)).limit(1);
          const [principal] = await tx.select().from(schema.users).where(eq(schema.users.code, command.principalCode)).for('share').limit(1);
          const [project] = feature ? await tx.select().from(schema.projects).where(eq(schema.projects.id, feature.project_id)).for('share').limit(1) : [];
          const member = project && principal ? await effectiveProjectMember(tx, project.id, principal.id) : undefined;
          if (!project || project.status !== 'active' || principal?.status !== 'active' || !isProjectManager(member?.role)) {
            throw new DomainError('baseline_forbidden', '只有项目 Owner 可以绑定需求基线');
          }
          await assertProjectAccess(tx, project.id, principal.id, 'manage');
          if (task.base_snapshot !== command.baseSnapshot) throw new DomainError('base_snapshot_mismatch', '任务已变化，请刷新后重试');
          await assertNoPendingHandover(tx, task.id);
          const [run] = await tx.select({ id: schema.runs.id }).from(schema.runs).where(eq(schema.runs.task_id, task.id)).limit(1);
          if (!['draft', 'ready', 'assigned'].includes(task.status) || run) {
            throw new DomainError('baseline_task_started', '任务开始执行后不能更换需求基线，请创建后续任务');
          }
          const loaded = await loadRequirementBaseline(tx, project.id, command.baselineCode);
          if (!loaded) throw new DomainError('baseline_not_found', '需求基线不存在或不属于此项目');
          let revisionId = task.source_requirement_revision_id;
          if (task.requirement_id !== null) {
            const [requirement] = await tx.select().from(schema.requirements).where(eq(schema.requirements.id, task.requirement_id)).for('share').limit(1);
            const item = loaded.baseline.requirements.find(item => item.requirement_code === requirement?.code);
            if (!item) throw new DomainError('baseline_requirement_missing', '基线未包含此任务关联的需求');
            const [revision] = await tx.select().from(schema.requirementRevisions).where(and(
              eq(schema.requirementRevisions.code, item.revision_code), eq(schema.requirementRevisions.requirement_id, task.requirement_id),
            )).limit(1);
            if (!revision || (revisionId !== null && revisionId !== revision.id)) {
              throw new DomainError('baseline_revision_mismatch', '基线需求版本与任务固定的修订不一致，请选择匹配基线或创建后续任务');
            }
            revisionId = revision.id;
          }
          if (task.requirement_baseline_id === loaded.row.id) return {
            task_code: task.code, requirement_baseline_code: loaded.baseline.baseline_code, base_snapshot: task.base_snapshot,
          };
          await tx.update(schema.tasks).set({ requirement_baseline_id: loaded.row.id, source_requirement_revision_id: revisionId,
            base_snapshot: task.base_snapshot + 1 }).where(eq(schema.tasks.id, task.id));
          await tx.insert(schema.auditEvents).values({ code: createPublicCode(), timestamp: now(), principal_id: principal.id,
            entity_type: 'task', entity_id: task.id, base_snapshot: task.base_snapshot, action: 'task.baseline_bound',
            payload: JSON.stringify({ requirement_baseline_code: loaded.baseline.baseline_code, previous_baseline_id: task.requirement_baseline_id?.toString() ?? null,
              content_hash: loaded.baseline.content_hash }) });
          return { task_code: task.code, requirement_baseline_code: loaded.baseline.baseline_code, base_snapshot: task.base_snapshot + 1 };
        });
        return { ok: true as const, data };
      } catch (error) { return fail(error); }
    },
  };
}
