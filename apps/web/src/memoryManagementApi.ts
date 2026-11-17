import { fetchEnvelope } from './api';
import { ApiError } from './apiError';
import type { ProjectMemoryManagementView } from '../../../packages/contracts/src/memory';
export type { ProjectMemoryManagementView, ProjectMemoryBindingState, ProjectMemoryProjectionStatus } from '../../../packages/contracts/src/memory';
export type ProjectMemoryAction = 'enable' | 'pause' | 'retry';
export const projectMemoryQueryKey = (project: string) => ['project-memory-management', project] as const;
const base = (project: string) => `/projects/${encodeURIComponent(project)}/memory/management`;

export function projectMemoryMatches(value: ProjectMemoryManagementView | undefined, project: string): value is ProjectMemoryManagementView {
  return Boolean(value && value.projectCode === project);
}

async function read(project: string, path: string, init?: RequestInit) {
  const result = await fetchEnvelope<ProjectMemoryManagementView>(path, init);
  if (!projectMemoryMatches(result, project)) throw new ApiError('memory_project_mismatch', '项目记忆状态与当前项目不一致，请刷新。', 502);
  return result;
}

export const getProjectMemoryManagement = (project: string) => read(project, base(project));
export const enableProjectMemory = (project: string) => read(project, base(project) + '/enable', { method: 'POST', body: '{}' });
export const pauseProjectMemory = (project: string) => read(project, base(project) + '/pause', { method: 'POST', body: '{}' });
export const retryProjectMemory = (project: string) => read(project, base(project) + '/retry', { method: 'POST', body: '{}' });

export function projectMemoryActions(value: ProjectMemoryManagementView): ProjectMemoryAction[] {
  // Resource pause/recovery remains an operations API, not a member switch.
  void value;
  return [];
}
