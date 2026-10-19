import type { ProjectSummary, TeamSummary } from './api';
import { PROJECT_SECTIONS, agentWorkspacePath, projectHomeWorkspacePath, projectWorkspacePath, requirementWorkspacePath, testingWorkspacePath, type WorkspaceRoute } from './workspaceRouting.ts';

/** Carry navigation context across projects, never identifiers owned by the previous project. */
export function projectSwitchPath(route: WorkspaceRoute, projectCode: string): string {
  if (route.view === 'agent') return agentWorkspacePath(route.agentTab === 'authorize' ? 'connect' : route.agentTab, { projectCode });
  if (route.view === 'overview') return projectHomeWorkspacePath(projectCode, route.projectTab);
  if (route.view === 'requirements') return requirementWorkspacePath(projectCode, { tab: route.requirementsTab });
  if (route.view === 'testing') return testingWorkspacePath(projectCode, route.testingTab);
  return projectWorkspacePath(projectCode, PROJECT_SECTIONS.includes(route.view as typeof PROJECT_SECTIONS[number])
    ? route.view as typeof PROJECT_SECTIONS[number] : 'overview');
}

/** The authorized project response can name an owning team that is not in the user's team list. */
export function projectTeamName(project: ProjectSummary, teams: TeamSummary[]): string {
  return project.team_name?.trim() || teams.find(team => team.code === project.team_code)?.name || project.team_code;
}

/** Missing team-list data does not establish that a project is external. */
export function isExternalProject(project: ProjectSummary, teams: TeamSummary[], teamMembershipKnown = false): boolean | undefined {
  if (typeof project.is_external === 'boolean') return project.is_external;
  if (teams.some(team => team.code === project.team_code)) return false;
  return teamMembershipKnown ? true : undefined;
}

/** Filter only the already authorized API result; names and codes remain user content. */
export function filterSwitchableProjects(projects: ProjectSummary[], teams: TeamSummary[], search: string): ProjectSummary[] {
  const needle = search.trim().toLocaleLowerCase();
  if (!needle) return projects;
  const teamNames = new Map(teams.map(team => [team.code, team.name]));
  return projects.filter(project => [project.name, project.code, project.team_code, project.team_name, teamNames.get(project.team_code)]
    .some(value => value?.toLocaleLowerCase().includes(needle)));
}
