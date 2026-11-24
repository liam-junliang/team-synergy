import { DomainError } from '@team-synergy/domain';
import type { Db } from '@team-synergy/persistence';
import { assertProjectAccess } from './project-access.js';
import { findProjectByCode, findUserByCode } from './public-code.js';

interface BoardWorkflowRow {
  task_code: string;
  execution_health: 'active' | 'expired' | 'unknown' | 'none';
  last_heartbeat_at: string | null;
  submitted_at: string | null;
  review_updated_at: string | null;
  reviewer_code: string | null;
  review_status: 'waiting' | 'in_progress' | 'needs_evidence' | 'passed' | 'returned' | null;
}

export async function listTaskWebBoard(db: Db, projectCode: string, principalCode: string): Promise<BoardWorkflowRow[]> {
  const [project, actor] = await Promise.all([findProjectByCode(db, projectCode), findUserByCode(db, principalCode)]);
  if (!project) throw new DomainError('project_not_found', '项目不存在');
  if (!actor) throw new DomainError('project_forbidden', '需要项目成员权限');
  await assertProjectAccess(db, project.id, actor.id, 'read');
  const result = await db.$client.query<BoardWorkflowRow>(`
    SELECT t.code AS task_code,
      CASE WHEN r.id IS NULL THEN 'none'
        WHEN r.execution_epoch <> t.execution_epoch THEN 'expired'
        WHEN lease.revoked_at IS NOT NULL THEN 'expired'
        WHEN lease.expires_at IS NULL OR NOT pg_input_is_valid(lease.expires_at, 'timestamptz') THEN 'unknown'
        WHEN lease.expires_at::timestamptz <= now() THEN 'expired'
        WHEN r.status = 'active' THEN 'active'
        ELSE 'unknown' END AS execution_health,
      activity.last_heartbeat_at,
      submission.submitted_at,
      COALESCE(to_char(review.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        CASE WHEN r.profile = 'verifier' THEN r.started_at END) AS review_updated_at,
      reviewer.code AS reviewer_code,
      CASE
        WHEN review.status = 'assigned' THEN 'waiting'
        WHEN review.status IS NOT NULL THEN review.status
        WHEN t.status = 'submitted' AND r.profile = 'verifier' THEN 'in_progress'
        WHEN t.status = 'submitted' THEN 'waiting'
        WHEN t.status = 'verified' THEN 'passed'
        ELSE NULL END AS review_status
    FROM tasks t
    JOIN features f ON f.id = t.feature_id
    LEFT JOIN LATERAL (
      SELECT id, status, profile, principal_id, execution_epoch, started_at FROM runs
      WHERE task_id = t.id
        AND ((t.status = 'submitted' AND profile = 'verifier')
          OR (t.status IN ('assigned', 'running', 'self_tested', 'blocked', 'failed') AND profile <> 'verifier'))
        AND status IN ('active', 'suspended', 'preparing')
      ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, started_at DESC, id DESC LIMIT 1
    ) r ON true
    LEFT JOIN LATERAL (
      SELECT revoked_at, expires_at
      FROM run_leases WHERE run_id = r.id AND epoch = r.execution_epoch
      ORDER BY created_at DESC, id DESC LIMIT 1
    ) lease ON true
    LEFT JOIN LATERAL (
      SELECT to_char(max(a.timestamp) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_heartbeat_at
      FROM audit_events a JOIN agent_sessions session ON session.id = a.entity_id AND session.run_id = r.id
      WHERE a.run_id = r.id AND session.execution_epoch = r.execution_epoch
        AND a.entity_type = 'agent_session' AND a.action = 'agent_session.status' AND a.to_state = 'running'
    ) activity ON true
    LEFT JOIN LATERAL (
      SELECT id, to_char(timestamp AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS submitted_at FROM audit_events
      WHERE entity_type = 'task' AND entity_id = t.id AND action = 'task.submitted'
      ORDER BY id DESC LIMIT 1
    ) submission ON t.status = 'submitted'
    LEFT JOIN LATERAL (
      SELECT w.reviewer_principal_id, w.status, w.updated_at FROM task_web_reviews w
      JOIN artifacts a ON a.id = w.artifact_id AND a.task_id = t.id AND a.published
      WHERE w.task_id = t.id AND w.status IN ('assigned', 'in_progress', 'needs_evidence')
        AND w.submission_event_id IS NOT DISTINCT FROM submission.id
      ORDER BY w.id DESC LIMIT 1
    ) review ON t.status = 'submitted'
    LEFT JOIN users reviewer ON reviewer.id = COALESCE(review.reviewer_principal_id,
      CASE WHEN r.profile = 'verifier' THEN r.principal_id END)
    WHERE f.project_id = $1 AND t.status IN ('assigned', 'running', 'self_tested', 'blocked', 'failed', 'submitted', 'verified')
    ORDER BY t.id
  `, [project.id.toString()]);
  return result.rows;
}
