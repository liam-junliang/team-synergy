import { DomainError } from './errors.js';
import type { Profile, TaskCode, RunCode } from '@team-synergy/contracts';

/**
 * 架构不变量 6：MCP 会话的 Run 身份在进程启动时绑定，不能由 Agent 请求参数覆盖。
 * 纯函数层面：任何请求携带的 run 参数与进程绑定身份不一致时必须拒绝。
 */
export interface RunIdentityContext {
  run_code: RunCode;
  task_code: TaskCode;
  profile: Profile;
}

export function assertIdentityImmutable(
  context: RunIdentityContext,
  requested: { run_code?: string },
): void {
  if (requested.run_code !== undefined && requested.run_code !== context.run_code) {
    throw new DomainError('run_identity_override', 'Run 身份在进程启动时绑定，不能由请求参数覆盖（架构不变量 6）', {
      bound_run_code: context.run_code,
      requested_run_code: requested.run_code,
    });
  }
}
