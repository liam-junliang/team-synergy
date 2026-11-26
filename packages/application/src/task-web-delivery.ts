import { and, desc, eq, exists, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { Evidence, TaskWebDeliveryCommand } from '@team-synergy/contracts';
import { assertAuditedChange, assertEvidenceForStatus, DomainError, toAuditEvent, transitionOrThrow } from '@team-synergy/domain';
import { schema, type Db } from '@team-synergy/persistence';
import { lockTaskProject } from './aggregate-lock.js';
import { assertNoPendingHandover, UNRESOLVED_HANDOVER_STATUSES } from './execution-guard.js';
import { assertProjectAccess, isProjectManager } from './project-access.js';
import { codeCondition, createPublicCode } from './public-code.js';
import { insertAudit, parseAcceptance } from './task-service.js';
import { latestTaskSubmissionEvent } from './task-web-review-guard.js';

const { artifacts, evidences, features, projects, runs, taskDependencies, taskHandovers, tasks, taskWebReviews, taskWebSubmissions, users } = schema;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Task = typeof tasks.$inferSelect;
type Actor = typeof users.$inferSelect;
type Review = typeof taskWebReviews.$inferSelect;
type DeliveryCommand = Extract<TaskWebDeliveryCommand, { action: 'record_delivery' }>;
type ReviewAction = Exclude<TaskWebDeliveryCommand, DeliveryCommand>;
type ActionSource = 'web' | 'mcp' | 'cli';
const liveStatuses = ['active', 'suspended', 'preparing'] as const;
const manualDeliveryStates: ReadonlySet<Task['status']> = new Set(['assigned', 'running', 'self_tested']);
type Submission = {
  artifact: typeof artifacts.$inferSelect;
  authorId: bigint;
  registrarId: bigint;
  eventId: bigint | null;
};

async function findUserByCode(db: Pick<Db, 'select'>, code: string, lock = false) {
  const condition = codeCondition(users, code);
  if (!condition) return;
  const query = db.select().from(users).where(condition).limit(1);
  const [actor] = lock ? await query.for('share') : await query;
  return actor;
}

async function scope(db: Tx | Db, taskCode: string, principalCode: string, lock = false) {
  const [actor, [link]] = await Promise.all([
    findUserByCode(db, principalCode, lock),
    db.select({ taskId: tasks.id, projectId: features.project_id }).from(tasks)
      .innerJoin(features, eq(features.id, tasks.feature_id)).where(eq(tasks.code, taskCode)).limit(1),
  ]);
  if (!actor) throw new DomainError('user_not_found', '当前用户不存在');
  if (!link) throw new DomainError('task_not_found', '任务不存在');
  const access = await assertProjectAccess(db, link.projectId, actor.id, lock ? 'write' : 'read');
  const query = db.select().from(tasks).where(eq(tasks.id, link.taskId)).limit(1);
  const [task] = lock ? await query.for('update') : await query;
  if (!task) throw new DomainError('task_not_found', '任务不存在');
  return { actor, task, projectId: link.projectId, role: access.role };
}

/** Pin a human review to the actual submission event and artifact, including older CLI submissions. */
async function currentSubmission(db: Tx | Db, taskId: bigint): Promise<Submission | undefined> {
  const [event] = await latestTaskSubmissionEvent(db, taskId);
  if (event && event.run_id === null) {
    const [record] = await db.select({ entry: taskWebSubmissions, artifact: artifacts }).from(taskWebSubmissions)
      .innerJoin(artifacts, eq(artifacts.id, taskWebSubmissions.artifact_id))
      .where(and(eq(taskWebSubmissions.task_id, taskId), eq(taskWebSubmissions.submission_snapshot, event.base_snapshot + 1),
        eq(artifacts.task_id, taskId), eq(artifacts.published, true))).limit(1);
    if (!record) return;
    return { artifact: record.artifact, authorId: record.entry.author_principal_id, registrarId: record.entry.registrar_principal_id, eventId: event.id };
  }
  const [pinned] = await db.select({ artifactId: taskWebReviews.artifact_id }).from(taskWebReviews)
    .where(and(eq(taskWebReviews.task_id, taskId), pinnedEvent(event?.id ?? null))).orderBy(desc(taskWebReviews.id)).limit(1);
  const [record] = await db.select({ artifact: artifacts, authorId: runs.principal_id }).from(artifacts)
    .innerJoin(runs, eq(runs.id, artifacts.run_id))
    .where(and(eq(artifacts.task_id, taskId), eq(artifacts.published, true), eq(runs.task_id, taskId), eq(runs.status, 'completed'),
      event?.run_id != null ? eq(runs.id, event.run_id) : eq(runs.profile, 'builder'),
      pinned ? eq(artifacts.id, pinned.artifactId) : undefined,
      event ? or(isNull(artifacts.published_at), lte(artifacts.published_at, event.timestamp)) : undefined,
      exists(db.select({ id: evidences.id }).from(evidences).where(and(eq(evidences.task_id, taskId), eq(evidences.run_id, runs.id),
        eq(evidences.type, 'self_test'), eq(evidences.result, 'pass'))))))
    .orderBy(desc(artifacts.id)).limit(1);
  if (record) return { ...record, registrarId: record.authorId, eventId: event?.id ?? null };
}

function pinnedEvent(eventId: bigint | null) {
  return eventId === null ? isNull(taskWebReviews.submission_event_id) : eq(taskWebReviews.submission_event_id, eventId);
}

async function currentReview(db: Tx | Db, taskId: bigint, submission: Submission | undefined): Promise<Review | undefined> {
  if (!submission) return;
  const [review] = await db.select().from(taskWebReviews).where(and(eq(taskWebReviews.task_id, taskId),
    eq(taskWebReviews.artifact_id, submission.artifact.id), pinnedEvent(submission.eventId))).orderBy(desc(taskWebReviews.id)).limit(1);
  return review;
}

function outstandingRuns(db: Tx | Db, taskId: bigint) {
  return db.select({ id: runs.id, code: runs.code, profile: runs.profile, principalId: runs.principal_id }).from(runs)
    .where(and(eq(runs.task_id, taskId), inArray(runs.status, liveStatuses)));
}

async function hasUnfinishedDependencies(db: Tx | Db, taskId: bigint) {
  const [dependency] = await db.select({ id: tasks.id }).from(taskDependencies)
    .innerJoin(tasks, eq(tasks.id, taskDependencies.depends_on_task_id))
    .where(and(eq(taskDependencies.task_id, taskId), sql`${tasks.status} <> 'closed'`)).limit(1);
  return Boolean(dependency);
}

async function authorForDelivery(tx: Tx, projectId: bigint, task: Task, actor: Actor, manager: boolean, requestedCode?: string) {
  if (!manager && requestedCode && requestedCode !== actor.code) {
    throw new DomainError('task_delivery_author_forbidden', '只有项目管理者可以登记他人的交付');
  }
  const [author] = requestedCode
    ? [await findUserByCode(tx, requestedCode)]
    : task.assignee_principal_id
      ? await tx.select().from(users).where(eq(users.id, task.assignee_principal_id)).limit(1)
      : [actor];
  if (!author) throw new DomainError('task_delivery_author_missing', '请选择可确认的成果作者');
  if (!manager || task.assignee_principal_id !== author.id) {
    const [pastRun] = manager
      ? await tx.select({ id: runs.id }).from(runs).where(and(eq(runs.task_id, task.id), eq(runs.principal_id, author.id), eq(runs.profile, 'builder'))).limit(1)
      : [];
    if (!pastRun) await assertProjectAccess(tx, projectId, author.id, 'write');
  }
  return author;
}

function checkedRefs(task: Task, values: readonly string[], minimum: boolean, fullCoverage = false) {
  const acceptance = parseAcceptance(task.acceptance);
  const valid = new Set(acceptance.map(({ id }) => id));
  const refs = [...new Set(values)];
  if (refs.some(ref => !valid.has(ref))) {
    throw new DomainError('acceptance_refs_unknown', '证据引用了不存在的验收项');
  }
  if (minimum && refs.length === 0) {
    throw new DomainError('acceptance_refs_required', '请选择证据覆盖的验收项');
  }
  if (fullCoverage && (!valid.size || refs.length !== valid.size)) {
    throw new DomainError('acceptance_coverage_incomplete', '验收通过需要覆盖全部验收项');
  }
  return { acceptance, refs };
}

async function appendEvidence(tx: Tx, task: Task, evidence: Evidence) {
  const [row] = await tx.insert(evidences).values({
    code: evidence.evidence_code, task_id: task.id, run_id: null,
    type: evidence.type, result: evidence.result, acceptance_refs: JSON.stringify(evidence.acceptance_refs),
    summary: evidence.summary, report_uri: evidence.report_uri, recorded_at: evidence.recorded_at,
  }).returning({ id: evidences.id });
  if (!row) throw new DomainError('internal_error', '未能保存任务证据');
  return row.id;
}

async function recordChange(tx: Tx, task: Task, actor: Actor, action: string, status: Task['status'], payload: Record<string, unknown>, advanceEpoch = false) {
  const nextSnapshot = task.base_snapshot + 1;
  await tx.update(tasks).set({ status, base_snapshot: nextSnapshot, execution_epoch: task.execution_epoch + (advanceEpoch ? 1 : 0) })
    .where(eq(tasks.id, task.id));
  const audit = { entity_type: 'task', entity_id: task.id, legacy_entity_code: task.legacy_code ?? undefined,
    principal_id: actor.id, from: task.status, to: status, base_snapshot: task.base_snapshot, action,
    payload };
  assertAuditedChange(audit);
  await insertAudit(tx, toAuditEvent(audit, createPublicCode(), new Date().toISOString()));
  return { task_code: task.code, status, base_snapshot: nextSnapshot };
}

function requireIndependence(submission: Submission, reviewerId: bigint) {
  if (submission.authorId === reviewerId) {
    throw new DomainError('task_review_self', '交付成果需要其他项目成员独立验收');
  }
}

async function recordDelivery(tx: Tx, task: Task, actor: Actor, projectId: bigint, manager: boolean, command: DeliveryCommand, source: ActionSource) {
  if (!manager && task.assignee_principal_id !== actor.id) throw new DomainError('task_delivery_forbidden', '只有当前执行人或项目管理者可以登记交付');
  const { refs } = checkedRefs(task, command.acceptance_refs, true);
  if (task.status === 'assigned' && await hasUnfinishedDependencies(tx, task.id)) {
    throw new DomainError('claim_dependencies_unsatisfied', '依赖任务尚未完成，不能登记交付');
  }
  const evidence: Evidence = { evidence_code: createPublicCode(), task_code: task.code, type: 'self_test', result: 'pass',
    acceptance_refs: refs, summary: command.summary, recorded_at: new Date().toISOString() };

  if (task.status === 'submitted') {
    const submission = await currentSubmission(tx, task.id);
    const review = await currentReview(tx, task.id, submission);
    if (!submission || review?.status !== 'needs_evidence') {
      throw new DomainError('task_delivery_state_invalid', '只可为验收人请求补证的交付补录自测证据');
    }
    if (submission.artifact.uri !== command.artifact_uri || submission.artifact.content_hash.toLowerCase() !== command.content_hash
      || (command.author_principal_code && (await findUserByCode(tx, command.author_principal_code))?.id !== submission.authorId)) {
      throw new DomainError('task_delivery_version_changed', '补证需沿用原成果链接、内容校验值和作者');
    }
    await appendEvidence(tx, task, evidence);
    await tx.update(taskWebReviews).set({ status: 'assigned', started_at: null, reason: null, updated_at: evidence.recorded_at })
      .where(eq(taskWebReviews.id, review.id));
    return recordChange(tx, task, actor, 'task.web_evidence_supplemented', 'submitted',
      { source, artifact_code: submission.artifact.code, evidence_code: evidence.evidence_code });
  }

  if (!manualDeliveryStates.has(task.status)) throw new DomainError('task_delivery_state_invalid', '任务当前阶段不能登记交付');
  const author = await authorForDelivery(tx, projectId, task, actor, manager, command.author_principal_code);
  const evidenceContext = { selfTestEvidence: [evidence], verifierEvidence: [], artifactCount: 1 };
  assertEvidenceForStatus(evidenceContext, 'self_tested', 'builder');
  assertEvidenceForStatus(evidenceContext, 'submitted', 'builder');
  const [artifact] = await tx.insert(artifacts).values({
    code: createPublicCode(), project_id: projectId, task_id: task.id, run_id: null,
    kind: command.content_hash.length === 40 ? 'commit' : 'other',
    uri: command.artifact_uri, content_hash: command.content_hash, published: true, published_at: evidence.recorded_at,
  }).returning({ id: artifacts.id, code: artifacts.code });
  if (!artifact) throw new DomainError('internal_error', '未能保存交付成果');
  const evidenceId = await appendEvidence(tx, task, evidence);
  await tx.insert(taskWebSubmissions).values({ task_id: task.id, artifact_id: artifact.id, evidence_id: evidenceId,
    author_principal_id: author.id, registrar_principal_id: actor.id, submission_snapshot: task.base_snapshot + 1 });
  return recordChange(tx, task, actor, 'task.submitted', 'submitted',
    { source, artifact_code: artifact.code, evidence_code: evidence.evidence_code, author_code: author.code, registrar_code: actor.code });
}

async function applyReview(tx: Tx, task: Task, actor: Actor, manager: boolean, projectId: bigint, command: ReviewAction, source: ActionSource) {
  if (task.status !== 'submitted') throw new DomainError('task_review_state_invalid', '只有已提交的任务可以发起验收');
  const submission = await currentSubmission(tx, task.id);
  if (!submission) throw new DomainError('task_review_submission_missing', '当前提交缺少可核验的产物和自测记录');
  const review = await currentReview(tx, task.id, submission);
  const outstanding = await outstandingRuns(tx, task.id);
  const audit = { source, artifact_code: submission.artifact.code };

  if (command.action === 'assign_review') {
    if (!manager) throw new DomainError('task_review_manage_forbidden', '只有项目管理者可以指派验收人');
    const reviewer = await findUserByCode(tx, command.reviewer_principal_code);
    if (!reviewer) throw new DomainError('task_review_reviewer_missing', '所选验收人不存在');
    await assertProjectAccess(tx, projectId, reviewer.id, 'write');
    requireIndependence(submission, reviewer.id);
    if (review?.reviewer_principal_id === reviewer.id) throw new DomainError('task_review_assigned', '当前提交已指派给该验收人');
    if (outstanding.some(run => run.profile !== 'verifier')) throw new DomainError('task_run_active', '当前还有执行 Run，请先处理执行');
    const replacing = Boolean(review) || outstanding.length > 0;
    if ((replacing && !command.reason) ||
      ((review?.status === 'in_progress' || outstanding.length > 0) && !command.confirm_active)) {
      throw new DomainError('task_review_replacement_confirmation_required', '更换验收人需填写原因，进行中的验收还需确认结束');
    }
    const now = new Date().toISOString();
    if (review) {
      await tx.update(taskWebReviews).set({ status: 'replaced', updated_at: now }).where(eq(taskWebReviews.id, review.id));
    }
    if (outstanding.length > 0) {
      const ids = outstanding.map(run => run.id);
      await tx.update(runs).set({ status: 'cancelled', finished_at: now }).where(inArray(runs.id, ids));
      await tx.update(schema.runLeases).set({ revoked_at: now }).where(and(inArray(schema.runLeases.run_id, ids), isNull(schema.runLeases.revoked_at)));
      await tx.update(schema.agentSessions).set({ status: 'cancelled', finished_at: now, last_error: command.reason })
        .where(and(inArray(schema.agentSessions.run_id, ids), inArray(schema.agentSessions.status, ['starting', 'running'])));
    }
    await tx.insert(taskWebReviews).values({ task_id: task.id, artifact_id: submission.artifact.id, submission_event_id: submission.eventId,
      reviewer_principal_id: reviewer.id, status: 'assigned', reason: command.reason });
    return recordChange(tx, task, actor, 'task.web_review_assigned', 'submitted',
      { ...audit, reviewer_code: reviewer.code, reason: command.reason, cancelled_run_codes: outstanding.map(run => run.code) }, outstanding.length > 0);
  }

  requireIndependence(submission, actor.id);
  if (outstanding.length > 0) throw new DomainError('task_run_active', '当前还有 Run，请先由项目管理者处理');
  if (review && review.reviewer_principal_id !== actor.id) throw new DomainError('task_review_assigned', '本次验收已交给其他项目成员');

  if (command.action === 'start_review') {
    if (review && review.status !== 'assigned') throw new DomainError('task_review_state_invalid', '当前验收已开始，或仍在等待补充证据');
    const now = new Date().toISOString();
    if (review) await tx.update(taskWebReviews).set({ status: 'in_progress', started_at: now, updated_at: now }).where(eq(taskWebReviews.id, review.id));
    else await tx.insert(taskWebReviews).values({ task_id: task.id, artifact_id: submission.artifact.id, submission_event_id: submission.eventId,
      reviewer_principal_id: actor.id, status: 'in_progress', started_at: now, updated_at: now });
    return recordChange(tx, task, actor, 'task.web_review_started', 'submitted', { ...audit, reviewer_code: actor.code });
  }

  if (command.submission_code !== submission.artifact.code) {
    throw new DomainError('task_review_submission_changed', '审阅的交付版本已变化，请重新核对产物和验收证据');
  }
  if (review?.status !== 'in_progress') throw new DomainError('task_review_state_invalid', '请先开始验收');
  const { acceptance, refs } = checkedRefs(task, command.acceptance_refs, command.result !== 'request_evidence', command.result === 'pass');
  const evidence: Evidence = { evidence_code: createPublicCode(), task_code: task.code,
    type: 'verifier_review', result: command.result === 'pass' ? 'pass' : command.result === 'return' ? 'fail' : 'inconclusive',
    acceptance_refs: refs, summary: command.summary, report_uri: command.report_uri, recorded_at: new Date().toISOString() };
  const next = command.result === 'pass' ? 'verified' : command.result === 'return' ? 'failed' : 'submitted';
  if (next !== 'submitted') transitionOrThrow('submitted', next, {
    task: { acceptance }, evidence: { selfTestEvidence: [], verifierEvidence: [evidence], artifactCount: 1 }, profile: 'verifier',
  });
  const evidenceId = await appendEvidence(tx, task, evidence);
  await tx.update(taskWebReviews).set({ status: command.result === 'pass' ? 'passed' : command.result === 'return' ? 'returned' : 'needs_evidence',
    evidence_id: evidenceId, reason: command.summary, updated_at: evidence.recorded_at }).where(eq(taskWebReviews.id, review.id));
  const action = next === 'verified' ? 'task.verified' : next === 'failed' ? 'task.verification_failed' : 'task.web_evidence_requested';
  return recordChange(tx, task, actor, action, next,
    { ...audit, evidence_code: evidence.evidence_code, reviewer_code: actor.code, reason: command.summary });
}

export function createTaskWebDelivery(db: Db) {
  return {
    async inspect(taskCode: string, principalCode: string) {
      const { actor, task, projectId, role } = await scope(db, taskCode, principalCode);
      const manager = isProjectManager(role);
      const writable = role !== 'viewer';
      const [[project], [handover], outstanding, submission, dependencyOpen] = await Promise.all([
        db.select({ status: projects.status }).from(projects).where(eq(projects.id, projectId)).limit(1),
        db.select({ id: taskHandovers.id }).from(taskHandovers)
          .where(and(eq(taskHandovers.task_id, task.id), inArray(taskHandovers.status, UNRESOLVED_HANDOVER_STATUSES))).limit(1),
        outstandingRuns(db, task.id),
        ['submitted', 'verified', 'failed', 'closed'].includes(task.status) ? currentSubmission(db, task.id) : Promise.resolve(undefined),
        task.status === 'assigned' ? hasUnfinishedDependencies(db, task.id) : Promise.resolve(false),
      ]);
      const review = await currentReview(db, task.id, submission);
      const isSubmitted = task.status === 'submitted';
      const nativeReview = isSubmitted ? outstanding.find(run => run.profile === 'verifier') : undefined;
      const reviewerId = review?.reviewer_principal_id ?? nativeReview?.principalId;
      const relatedIds = [...new Set([reviewerId, submission?.authorId, submission?.registrarId].filter((id): id is bigint => id !== undefined))];
      const related = relatedIds.length === 0 ? [] : await db.select({ id: users.id, code: users.code }).from(users).where(inArray(users.id, relatedIds));
      const codeOf = (id?: bigint) => related.find(user => user.id === id)?.code ?? null;
      const unlocked = project?.status === 'active' && writable && !handover;
      const reviewable = unlocked && isSubmitted && Boolean(submission);
      const isIndependent = Boolean(submission && submission.authorId !== actor.id);
      let reason: string | undefined;
      if (!writable) reason = 'project_forbidden';
      else if (project?.status !== 'active') reason = 'project_archived';
      else if (handover) reason = 'task_handover_pending';
      else if (isSubmitted && !submission) reason = 'task_review_submission_missing';
      else if (outstanding.length > 0) reason = 'task_run_active';
      else if (dependencyOpen) reason = 'claim_dependencies_unsatisfied';
      else if (isSubmitted && submission?.authorId === actor.id) reason = 'task_review_self';
      else if (isSubmitted && review && review.reviewer_principal_id !== actor.id) reason = 'task_review_assigned';
      return {
        base_snapshot: task.base_snapshot,
        can_record_delivery: Boolean(unlocked && outstanding.length === 0 && !dependencyOpen && (manager || task.assignee_principal_id === actor.id)
          && (manualDeliveryStates.has(task.status) || (isSubmitted && review?.status === 'needs_evidence'))),
        can_assign_review: reviewable && manager && outstanding.every(run => run.profile === 'verifier'),
        can_start_review: reviewable && isIndependent && outstanding.length === 0
          && (!review || (review.reviewer_principal_id === actor.id && review.status === 'assigned')),
        can_finish_review: reviewable && isIndependent && outstanding.length === 0
          && review?.reviewer_principal_id === actor.id && review.status === 'in_progress',
        review_status: review?.status === 'assigned' ? 'waiting' as const : review?.status === 'replaced' ? null : review?.status
          ?? (nativeReview ? 'in_progress' as const : isSubmitted ? 'waiting' as const : null),
        reviewer_code: codeOf(reviewerId),
        submission_code: submission?.artifact.code ?? null,
        submission_uri: submission?.artifact.uri ?? null,
        submission_content_hash: submission?.artifact.content_hash ?? null,
        submission_author_code: codeOf(submission?.authorId),
        submission_registrar_code: codeOf(submission?.registrarId),
        review_reason: review?.reason ?? null,
        review_requires_confirmation: review?.status === 'in_progress' || outstanding.some(run => run.profile === 'verifier'),
        ...(reason ? { reason } : {}),
      };
    },
    async apply(taskCode: string, principalCode: string, command: TaskWebDeliveryCommand, source: ActionSource = 'web') {
      return db.transaction(async (tx) => {
        await lockTaskProject(tx, taskCode);
        const { actor, task, projectId, role } = await scope(tx, taskCode, principalCode, true);
        if (task.base_snapshot !== command.base_snapshot) {
          throw new DomainError('base_snapshot_mismatch', '任务已经更新，请重新核对版本');
        }
        await assertNoPendingHandover(tx, task.id);
        const manager = isProjectManager(role);
        if (command.action !== 'record_delivery') return applyReview(tx, task, actor, manager, projectId, command, source);
        if ((await outstandingRuns(tx, task.id)).length > 0) {
          throw new DomainError('task_run_active', '当前还有 Run，请先处理执行或验收');
        }
        return recordDelivery(tx, task, actor, projectId, manager, command, source);
      });
    },
  };
}
