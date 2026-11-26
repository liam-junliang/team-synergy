import { z } from 'zod';
import { PublicCodeSchema } from './schemas.js';

const snapshot = z.number().int().min(0).max(2_147_483_646);
const reason = z.string().trim().min(1).max(2_000);
const summary = z.string().trim().min(1).max(8_000);
const acceptanceRefs = z.array(z.string().trim().min(1).max(100)).max(100);
const httpsLink = z.string().trim().max(2_048).refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch { return false; }
}, '需要可访问的 HTTPS 链接');

const shared = { base_snapshot: snapshot };
const idempotencyKey = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u).optional();
const recoverExecution = z.strictObject({
  ...shared,
  action: z.literal('recover_execution'),
  assignee_principal_code: PublicCodeSchema.optional(),
  reason,
  confirm_active: z.boolean().optional(),
  idempotency_key: idempotencyKey,
});
const releaseAssignment = z.strictObject({
  ...shared, action: z.literal('release_assignment'), reason,
  idempotency_key: idempotencyKey,
});
export const TaskCancelExecutionCommandSchema = z.strictObject({
  ...shared, action: z.literal('cancel_execution'), reason,
  confirm_active: z.boolean().optional(), idempotency_key: idempotencyKey,
});

const recordDelivery = z.strictObject({
  ...shared,
  action: z.literal('record_delivery'),
  artifact_uri: httpsLink,
  content_hash: z.string().trim().toLowerCase().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u),
  author_principal_code: PublicCodeSchema.optional(),
  summary,
  acceptance_refs: acceptanceRefs.min(1),
});
const assignReview = z.strictObject({
  ...shared,
  action: z.literal('assign_review'),
  reviewer_principal_code: PublicCodeSchema,
  reason: reason.optional(),
  confirm_active: z.boolean().optional(),
});
export const TaskStartReviewCommandSchema = z.strictObject({ ...shared, action: z.literal('start_review') });
export const TaskFinishReviewCommandSchema = z.strictObject({
  ...shared,
  action: z.literal('finish_review'),
  submission_code: PublicCodeSchema,
  result: z.enum(['pass', 'return', 'request_evidence']),
  acceptance_refs: acceptanceRefs,
  summary,
  report_uri: httpsLink.optional(),
});

export const TaskWebWorkflowCommandSchema = z.discriminatedUnion('action', [
  recoverExecution, releaseAssignment, TaskCancelExecutionCommandSchema, recordDelivery, assignReview,
  TaskStartReviewCommandSchema, TaskFinishReviewCommandSchema,
]);

export type TaskWebWorkflowCommand = z.infer<typeof TaskWebWorkflowCommandSchema>;
export type TaskWebExecutionCommand = Extract<TaskWebWorkflowCommand, { action: 'recover_execution' | 'release_assignment' | 'cancel_execution' }>;
export type TaskWebDeliveryCommand = Exclude<TaskWebWorkflowCommand, TaskWebExecutionCommand>;
