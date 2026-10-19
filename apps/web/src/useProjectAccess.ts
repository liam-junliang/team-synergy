import { useQuery } from '@tanstack/react-query';
import { getProject } from './api';
import { canProject } from './projectManagement';

/** Reuse the current project's server capabilities across workbenches. Unknown access is read-only. */
export function useProjectAccess(projectCode: string | undefined) {
  const project = useQuery({ queryKey: ['project', projectCode], queryFn: () => getProject(projectCode!), enabled: Boolean(projectCode) });
  return { project, canWrite: project.isSuccess && canProject(project.data, 'write'), canManage: project.isSuccess && canProject(project.data, 'manage') };
}
