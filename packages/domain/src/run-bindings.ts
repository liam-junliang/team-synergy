import { DomainError } from './errors.js';
import type { Profile, RunId, TaskId, WorkspaceId } from '@team-synergy/contracts';

/**
 * 架构不变量 3：Run 必须绑定一个 Task、一个 Profile 和一个 Workspace。
 */
export interface RunBindings {
  run_id: RunId;
  task_id: TaskId;
  profile: Profile;
  workspace_id: WorkspaceId;
}

export function assertRunBindings(bindings: RunBindings): void {
  if (!bindings.task_id || bindings.task_id <= 0n) {
    throw new DomainError('run_task_required', 'Run 必须绑定一个 Task（架构不变量 3）');
  }
  if (!bindings.profile) {
    throw new DomainError('run_profile_required', 'Run 必须绑定一个 Profile（架构不变量 3）');
  }
  if (!bindings.workspace_id || bindings.workspace_id <= 0n) {
    throw new DomainError('run_workspace_required', 'Run 必须绑定一个 Workspace（架构不变量 3）');
  }
}
