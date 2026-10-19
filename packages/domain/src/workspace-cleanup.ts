import { DomainError } from './errors.js';

/**
 * 架构不变量 7：工作区清理必须经过引用检查、未提交变更检查和可恢复删除。
 * 未提交代码应先生成 Patch 或明确提示，而不是静默删除。
 */
export interface CleanupContext {
  referencedByActive: string[]; // 被活动任务、正式发布、事故或人工固定项引用
  hasUncommittedChanges: boolean;
  patchSaved: boolean;
}

export type CleanupDecision = 'block' | 'require_patch' | 'recyclable';

export function cleanupDecision(ctx: CleanupContext): CleanupDecision {
  if (ctx.referencedByActive.length > 0) {
    return 'block';
  }
  if (ctx.hasUncommittedChanges && !ctx.patchSaved) {
    return 'require_patch';
  }
  return 'recyclable';
}

export function assertRecyclable(ctx: CleanupContext): void {
  const decision = cleanupDecision(ctx);
  if (decision === 'block') {
    throw new DomainError('cleanup_blocked', '工作区仍被引用，禁止清理（架构不变量 7）', {
      refs: ctx.referencedByActive,
    });
  }
  if (decision === 'require_patch') {
    throw new DomainError('cleanup_patch_required', '存在未提交变更：先生成 Patch 或明确提示，禁止静默删除（架构不变量 7）');
  }
}
