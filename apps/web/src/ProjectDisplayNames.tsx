import { useLocale } from './useLocale';
import { t, translate } from './i18n.ts';
import { useQuery } from '@tanstack/react-query';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { getProject, listFeatures, listMembers, listProjectMilestones, listProjectModules, listProjectPhases, listRequirements } from './api';

interface ProjectDisplayNames {
  projectName: string;
  featureName: (code?: string | null) => string;
  moduleName: (code?: string | null) => string;
  phaseName: (code?: string | null) => string;
  milestoneName: (code?: string | null) => string;
  memberName: (code?: string | null) => string;
  requirementName: (code?: string | null) => string;
}

const EMPTY_DISPLAY_NAMES: ProjectDisplayNames = {
  projectName: '',
  featureName: (code) => code ?? '',
  moduleName: (code) => code ?? '',
  phaseName: (code) => code ?? '',
  milestoneName: (code) => code ?? '',
  memberName: (code) => code ?? t("未分派"),
  requirementName: (code) => code ?? '',
};

export function ProjectDisplayNamesProvider({ projectCode, children }: {
  projectCode?: string;
  children: ReactNode;
}) {
  const locale = useLocale();
  const enabled = Boolean(projectCode);
  const projectQuery = useQuery({
    queryKey: ['project', projectCode],
    queryFn: () => getProject(projectCode as string),
    enabled,
  });
  const featuresQuery = useQuery({
    queryKey: ['features', projectCode],
    queryFn: () => listFeatures(projectCode),
    enabled,
  });
  const modulesQuery = useQuery({
    queryKey: ['project-modules', projectCode],
    queryFn: () => listProjectModules(projectCode as string),
    enabled,
  });
  const phasesQuery = useQuery({
    queryKey: ['project-phases', projectCode],
    queryFn: () => listProjectPhases(projectCode as string),
    enabled,
  });
  const milestonesQuery = useQuery({
    queryKey: ['project-milestones', projectCode],
    queryFn: () => listProjectMilestones(projectCode as string),
    enabled,
  });
  const membersQuery = useQuery({
    queryKey: ['members', projectCode],
    queryFn: () => listMembers(projectCode),
    enabled,
  });
  const requirementsQuery = useQuery({
    queryKey: ['requirements', projectCode],
    queryFn: () => listRequirements(projectCode),
    enabled,
  });

  const value = useMemo<ProjectDisplayNames>(() => {
    const featureNames = new Map((featuresQuery.data ?? []).map((feature) => [feature.code, feature.title]));
    const moduleNames = new Map((modulesQuery.data ?? []).map((module) => [module.code, module.name]));
    const phaseNames = new Map((phasesQuery.data ?? []).map((phase) => [phase.code, phase.name]));
    const milestoneNames = new Map((milestonesQuery.data ?? []).map((milestone) => [milestone.code, milestone.name]));
    const memberNames = new Map((membersQuery.data ?? []).map((member) => [member.code, member.display_name]));
    const requirementNames = new Map((requirementsQuery.data ?? []).map((requirement) => [requirement.code, requirement.title]));
    return {
      projectName: projectQuery.data?.name ?? projectCode ?? '',
      featureName: (code) => code ? featureNames.get(code) || code : '',
      moduleName: (code) => code ? moduleNames.get(code) || code : '',
      phaseName: (code) => code ? phaseNames.get(code) || code : '',
      milestoneName: (code) => code ? milestoneNames.get(code) || code : '',
      memberName: (code) => code ? memberNames.get(code) || code : translate(locale, '未分派'),
      requirementName: (code) => code ? requirementNames.get(code) || code : '',
    };
  }, [locale, featuresQuery.data, membersQuery.data, milestonesQuery.data, modulesQuery.data, phasesQuery.data, projectCode, projectQuery.data?.name, requirementsQuery.data]);

  return <ProjectDisplayNamesContext.Provider value={value}>{children}</ProjectDisplayNamesContext.Provider>;
}

const ProjectDisplayNamesContext = createContext<ProjectDisplayNames>(EMPTY_DISPLAY_NAMES);

export function useProjectDisplayNames(): ProjectDisplayNames {
  return useContext(ProjectDisplayNamesContext);
}
