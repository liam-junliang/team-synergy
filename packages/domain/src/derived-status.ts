import type { TaskStatus, Evidence, Artifact } from '@team-synergy/contracts';

/**
 * 架构不变量 8：页面展示状态尽量从 Run、Artifact、Evidence、Git/CI 等事实派生，
 * 不重复维护相互冲突的状态字段。
 *
 * 本模块把 docs/02 建议的「运行视图」做成纯函数派生：
 * working / waiting_review / ci_failed 等视图状态不是权威字段，而是事实投影。
 */
export interface TaskFacts {
  status: TaskStatus;
  hasActiveRun: boolean;
  selfTestEvidence: Evidence[];
  verifierEvidence: Evidence[];
  artifacts: Artifact[];
  ciFailed?: boolean;
}

export type TaskDerivedView =
  | 'working'
  | 'waiting_review'
  | 'blocked'
  | 'ci_failed'
  | 'drafting'
  | 'ready'
  | 'closed';

export function deriveView(facts: TaskFacts): TaskDerivedView {
  if (facts.status === 'closed') return 'closed';
  if (facts.status === 'blocked') return 'blocked';
  // 验证失败/运行失败：独立视图，避免落入 drafting 兜底造成"看板分组=执行中、视图=草稿"矛盾
  if (facts.status === 'failed') return 'ci_failed';
  if (facts.hasActiveRun) return 'working';
  if (facts.status === 'submitted') return 'waiting_review';
  if (facts.status === 'verified' && facts.ciFailed === true) return 'ci_failed';
  if (facts.status === 'ready' || facts.status === 'assigned') return 'ready';
  return 'drafting';
}
