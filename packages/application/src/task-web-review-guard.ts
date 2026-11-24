import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { DomainError } from '@team-synergy/domain';
import { schema, type Db } from '@team-synergy/persistence';

type ReviewDb = Pick<Db, 'select'>;
const { auditEvents, taskWebReviews, taskWebSubmissions } = schema;

export function latestTaskSubmissionEvent(db: ReviewDb, taskId: bigint) {
  return db.select({ id: auditEvents.id, run_id: auditEvents.run_id, base_snapshot: auditEvents.base_snapshot, timestamp: auditEvents.timestamp })
    .from(auditEvents).where(and(eq(auditEvents.entity_type, 'task'),
      eq(auditEvents.entity_id, taskId), eq(auditEvents.action, 'task.submitted')))
    .orderBy(desc(auditEvents.id)).limit(1);
}

/** Both native verifier entry points call this while holding the task lock. */
export async function assertNativeReviewAvailable(db: ReviewDb, taskId: bigint, reviewerId: bigint) {
  const [event] = await latestTaskSubmissionEvent(db, taskId);
  if (event && event.run_id === null) {
    const [submission] = await db.select({ author: taskWebSubmissions.author_principal_id }).from(taskWebSubmissions)
      .where(and(eq(taskWebSubmissions.task_id, taskId), eq(taskWebSubmissions.submission_snapshot, event.base_snapshot + 1))).limit(1);
    if (!submission) throw new DomainError('task_review_submission_missing', '当前提交缺少可核验的网页交付');
    if (submission.author === reviewerId) throw new DomainError('task_review_self', '交付成果需要其他项目成员独立验收');
  }
  const [webReview] = await db.select({ id: taskWebReviews.id }).from(taskWebReviews)
    .where(and(eq(taskWebReviews.task_id, taskId), inArray(taskWebReviews.status, ['assigned', 'in_progress', 'needs_evidence']),
      event ? eq(taskWebReviews.submission_event_id, event.id) : isNull(taskWebReviews.submission_event_id))).limit(1);
  if (webReview) throw new DomainError('task_review_assigned', '当前提交已进入网页验收，请继续或由负责人改派');
}
