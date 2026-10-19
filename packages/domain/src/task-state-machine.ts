import { DomainError } from './errors.js';
import type { TaskStatus, TaskContract, Profile, Evidence } from '@team-synergy/contracts';

/**
 * 任务状态机（docs/02 权威状态图，邻接表仅含文档确认的转换）：
 * draft → ready → assigned → running → self_tested → submitted → verified → closed
 *                             ↘ blocked（可回到 ready）   ↘ failed（可回到 ready）
 * submitted --验证失败(fail/inconclusive)--> failed（可回到 ready 重新执行）
 * draft / ready / assigned → cancelled（执行前取消）
 *
 * guards（单入口 transitionOrThrow 统一校验，防止只调邻接断言绕过规则）：
 * - ready 需验收标准（架构不变量 2）；
 * - assigned → running 需 active Run；
 * - running → blocked 需原因（docs/02 状态约束）；
 * - self_tested/submitted/verified 的证据门槛（架构不变量 5）与 Builder 终态限制。
 */
export const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  draft: ['ready', 'cancelled'],
  ready: ['assigned', 'cancelled'],
  assigned: ['running', 'cancelled'],
  running: ['self_tested', 'blocked', 'failed'],
  self_tested: ['submitted'],
  submitted: ['verified', 'failed'],
  verified: ['closed'],
  blocked: ['ready'],
  failed: ['ready'],
  closed: [],
  cancelled: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** 结构化拒绝原因：状态转换被拒绝时返回原因（不抛异常） */
export function transitionError(from: TaskStatus, to: TaskStatus): { code: string; message: string } | null {
  if (canTransition(from, to)) return null;
  return {
    code: 'invalid_transition',
    message: `非法状态转换：${from} → ${to}（${from} 的合法后继：${TRANSITIONS[from].join(' / ') || '无（终态）'}）`,
  };
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  const err = transitionError(from, to);
  if (err) {
    throw new DomainError('invalid_transition', err.message, { from, to });
  }
}

export interface StatusTransitionEvidence {
  selfTestEvidence: Evidence[];
  verifierEvidence: Evidence[];
  artifactCount: number;
}

export interface TransitionContext {
  task: Pick<TaskContract, 'acceptance'>;
  evidence: StatusTransitionEvidence;
  profile: Profile;
  /** assigned → running 必须为 true */
  activeRun?: boolean;
  /** running → blocked 必须提供 */
  blockReason?: string;
}

/**
 * 单入口转换：邻接检查 + 全部上下文 guard。
 * 调用方不得绕过本入口单独使用 assertTransition（review 重要项 2）。
 */
export function transitionOrThrow(from: TaskStatus, to: TaskStatus, ctx: TransitionContext): void {
  assertTransition(from, to);

  // 架构不变量 2：没有验收标准的 Task 不能进入 ready
  if (to === 'ready' && ctx.task.acceptance.length === 0) {
    throw new DomainError('acceptance_required', '没有验收标准的 Task 不能进入 ready（架构不变量 2）');
  }
  // docs/02：没有活动 Run 不能进入 running
  if (from === 'assigned' && to === 'running' && ctx.activeRun !== true) {
    throw new DomainError('run_required', 'assigned → running 必须存在活动 Run（docs/02）');
  }
  // docs/02：blocked 必须包含原因和下一行动
  if (to === 'blocked' && !ctx.blockReason) {
    throw new DomainError('block_reason_required', 'blocked 必须包含原因和下一行动（docs/02 状态约束）');
  }
  // 架构不变量 5 + docs/02 证据门槛与 Builder 终态限制
  assertEvidenceForStatus(ctx.evidence, to, ctx.profile);
}

/** 架构不变量 2：没有验收标准的 Task 不能进入 ready */
export function assertAcceptanceBeforeReady(task: Pick<TaskContract, 'acceptance'>, to: TaskStatus): void {
  if (to === 'ready' && task.acceptance.length === 0) {
    throw new DomainError('acceptance_required', '没有验收标准的 Task 不能进入 ready（架构不变量 2）');
  }
}

/**
 * 架构不变量 5 + docs/02 状态约束：
 * - self_tested 必须关联自测 Evidence；
 * - submitted 必须关联 Artifact 和自测 Evidence；
 * - verified 必须有关联验证证据；
 * - Builder Run 不能自行进入 verified / closed。
 */
export function assertEvidenceForStatus(
  evidence: StatusTransitionEvidence,
  to: TaskStatus,
  profile: Profile,
): void {
  if (to === 'self_tested' && evidence.selfTestEvidence.length === 0) {
    throw new DomainError('self_test_evidence_required', '没有自测 Evidence 不能进入 self_tested（架构不变量 5）');
  }
  if (to === 'submitted') {
    if (evidence.artifactCount === 0) {
      throw new DomainError('artifact_required', '没有正式 Artifact 不能进入 submitted');
    }
    if (evidence.selfTestEvidence.length === 0) {
      throw new DomainError('self_test_evidence_required', '没有自测 Evidence 不能进入 submitted');
    }
  }
  if (to === 'verified' && evidence.verifierEvidence.length === 0) {
    throw new DomainError('verifier_evidence_required', '没有验证证据不能进入 verified（架构不变量 5）');
  }
  if (profile === 'builder' && (to === 'verified' || to === 'closed')) {
    throw new DomainError('builder_terminal_forbidden', 'Builder Run 不能自行进入 verified / closed（docs/02 状态约束）', {
      profile,
      to,
    });
  }
}
