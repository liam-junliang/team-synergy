import { fetchEnvelope } from './api';
import type { TaskWebWorkflowCommand } from '../../../packages/contracts/src/task-web-workflow';
export type { TaskWebWorkflowCommand } from '../../../packages/contracts/src/task-web-workflow';

export type TaskExecutionHealth = 'active' | 'expired' | 'unknown' | 'none';
export type TaskReviewStatus = 'waiting' | 'in_progress' | 'needs_evidence' | 'passed' | 'returned' | null;
export type TaskReviewResult = Extract<TaskWebWorkflowCommand, { action: 'finish_review' }>['result'];

export interface TaskWebWorkflow {
  execution: {
    base_snapshot?: number;
    can_manage: boolean;
    can_recover: boolean;
    recovery_requires_confirmation: boolean;
    can_release: boolean;
    execution_health: TaskExecutionHealth;
    running_since: string | null;
    run_code: string | null;
    last_heartbeat_at: string | null;
    git_base?: string | null;
    lease_expires_at?: string | null;
    reason?: string;
  };
  delivery: {
    base_snapshot?: number;
    can_record_delivery: boolean;
    can_assign_review: boolean;
    can_start_review: boolean;
    can_finish_review: boolean;
    review_status: TaskReviewStatus;
    reviewer_code: string | null;
    submission_code: string | null;
    submission_uri?: string | null;
    submission_content_hash?: string | null;
    submission_author_code?: string | null;
    submission_registrar_code?: string | null;
    review_reason?: string | null;
    review_requires_confirmation?: boolean;
    reason?: string;
  };
}

export interface TaskWebWorkflowSummary {
  task_code: string;
  execution_health: TaskExecutionHealth;
  last_heartbeat_at: string | null;
  reviewer_code: string | null;
  review_status: TaskReviewStatus;
  submitted_at?: string | null;
  review_updated_at?: string | null;
}

function taskWorkflowPath(taskCode: string) {
  return `/tasks/${encodeURIComponent(taskCode)}/web-workflow`;
}

export function getTaskWebWorkflow(taskCode: string) {
  return fetchEnvelope<TaskWebWorkflow>(taskWorkflowPath(taskCode));
}

export function getProjectTaskWorkflow(projectCode: string) {
  return fetchEnvelope<TaskWebWorkflowSummary[]>(`/projects/${encodeURIComponent(projectCode)}/task-workflow`);
}

export function applyTaskWebWorkflow(taskCode: string, command: TaskWebWorkflowCommand) {
  return fetchEnvelope<unknown>(taskWorkflowPath(taskCode), { method: 'POST', body: JSON.stringify(command) });
}

export const EXECUTION_HEALTH_LABELS: Record<TaskExecutionHealth, string> = {
  active: '执行已连接',
  expired: '执行租约已过期',
  unknown: '执行状态未知',
  none: '当前无执行',
};
