import { useLocale } from './useLocale';
import { t } from './i18n.ts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type DragEvent as ReactDragEvent, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  addTeamMember,
  createProjectRepository,
  createProject,
  createTeam,
  listProjects,
  listProjectRepositories,
  listTeamMembers,
  listTeams,
  listTeamProjectGovernance,
  getTeamMemberRemovalImpact,
  type Member,
  listUserDirectory,
  currentPrincipalCode,
  removeTeamMember,
  reorderProjects,
  reorderTeams,
  updateProject,
  updateProjectStatus,
  updateProjectRepository,
  renameTeam,
  updateTeamMemberRole,
  type AddTeamMemberInput,
  type ProjectMemberPolicy,
  type CreateProjectInput,
  type CreateTeamInput,
  type ProjectSummary,
  type ProjectRepository,
  type SaveProjectRepositoryInput,
  type TeamSummary,
} from './api';
import { canManageMember, canProject, moveItemByCode, moveItemByOffset, projectPolicyDescription, projectPolicyLabel, roleMeta } from './projectManagement';
import { projectWorkspacePath } from './workspaceRouting';
import { isExternalProject, projectTeamName } from './projectSwitching';
import { PersonSearchSelect } from './PersonSearchSelect';
import { WorkspaceDialog } from './WorkspaceDialog';
import { FormSelect } from './FormSelect';
import { OwnershipTransferPanel } from './OwnershipTransferPanel';

const EMPTY_TEAM = { name: '' } satisfies CreateTeamInput;
const EMPTY_PROJECT: CreateProjectInput = { team_code: '', name: '', description: '', member_policy: 'team_read' };
type TeamMemberForm = { user_code: string; role: AddTeamMemberInput['role'] };
const EMPTY_MEMBER: TeamMemberForm = { user_code: '', role: 'member' };
const EMPTY_REPOSITORY = { name: '', purpose: '', remote_url: '', default_branch: 'main' };
type ProjectScope = { kind: 'all' | 'external' } | { kind: 'team'; teamCode: string };

export function TeamsWorkspace() {
  useLocale();
  const queryClient = useQueryClient();
  const [scope, setScope] = useState<ProjectScope>({ kind: 'all' });
  const [teamForm, setTeamForm] = useState(EMPTY_TEAM);
  const [projectForm, setProjectForm] = useState(EMPTY_PROJECT);
  const [memberForm, setMemberForm] = useState<TeamMemberForm>(EMPTY_MEMBER);
  const [teamName, setTeamName] = useState('');
  const [editingProject, setEditingProject] = useState<ProjectSummary | null>(null);
  const [projectName, setProjectName] = useState('');
  const [projectDescription, setProjectDescription] = useState('');
  const [repositoryProject, setRepositoryProject] = useState<ProjectSummary | null>(null);
  const [editingRepository, setEditingRepository] = useState<ProjectRepository | null>(null);
  const [repositoryForm, setRepositoryForm] = useState(EMPTY_REPOSITORY);
  const [teamDialogOpen, setTeamDialogOpen] = useState(false);
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [teamManagementOpen, setTeamManagementOpen] = useState(false);
  const [removingMember, setRemovingMember] = useState<Member | null>(null);
  const [draggingTeamCode, setDraggingTeamCode] = useState<string | null>(null);
  const [teamDropTargetCode, setTeamDropTargetCode] = useState<string | null>(null);
  const [draggingProjectCode, setDraggingProjectCode] = useState<string | null>(null);
  const [projectDropTargetCode, setProjectDropTargetCode] = useState<string | null>(null);
  const teamsQuery = useQuery({ queryKey: ['teams'], queryFn: listTeams });
  const teams = useMemo(() => teamsQuery.data ?? [], [teamsQuery.data]);
  const selectedTeam = scope.kind === 'team' ? teams.find((team) => team.code === scope.teamCode) ?? null : null;
  const currentUserCode = currentPrincipalCode();

  useEffect(() => {
    if (teamsQuery.isSuccess && scope.kind === 'team' && !selectedTeam) setScope({ kind: 'all' });
  }, [teamsQuery.isSuccess, selectedTeam, scope]);

  const projectsQueryKey = ['projects', 'all', currentUserCode] as const;
  const projectsQuery = useQuery({
    queryKey: projectsQueryKey,
    queryFn: () => listProjects(),
  });
  const allProjects = useMemo(() => projectsQuery.data ?? [], [projectsQuery.data]);
  const externalProjects = allProjects.filter((project) => isExternalProject(project, teams, teamsQuery.isSuccess) === true);
  const externalIdentityUnknown = allProjects.some((project) => isExternalProject(project, teams, teamsQuery.isSuccess) === undefined);
  const projects = scope.kind === 'team' ? allProjects.filter((project) => project.team_code === scope.teamCode)
    : scope.kind === 'external' ? externalProjects : allProjects;
  const membersQuery = useQuery({
    queryKey: ['team-members', selectedTeam?.code],
    queryFn: () => listTeamMembers(selectedTeam!.code),
    enabled: teamManagementOpen && Boolean(selectedTeam),
  });
  const directoryQuery = useQuery({
    queryKey: ['user-directory'],
    queryFn: listUserDirectory,
    enabled: teamManagementOpen && isTeamManager(selectedTeam),
  });
  const repositoriesQuery = useQuery({
    queryKey: ['project-repositories', repositoryProject?.code],
    queryFn: () => listProjectRepositories(repositoryProject!.code),
    enabled: Boolean(repositoryProject),
  });
  const availableUsers = (directoryQuery.data ?? []).filter((user) =>
    !(membersQuery.data ?? []).some((member) => member.code === user.code));

  const createTeamMutation = useMutation({
    mutationFn: createTeam,
    onSuccess: (team) => {
      setTeamForm(EMPTY_TEAM);
      setTeamDialogOpen(false);
      queryClient.setQueryData<TeamSummary[]>(['teams'], (previous = []) => [...previous.filter((item) => item.code !== team.code), team]);
      setScope({ kind: 'team', teamCode: team.code });
      void queryClient.invalidateQueries({ queryKey: ['teams'] });
    },
  });
  const createProjectMutation = useMutation({
    mutationFn: createProject,
    onSuccess: () => {
      setProjectForm(EMPTY_PROJECT);
      setProjectDialogOpen(false);
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      void queryClient.invalidateQueries({ queryKey: ['teams'] });
    },
  });
  const renameTeamMutation = useMutation({
    mutationFn: (name: string) => renameTeam(selectedTeam!.code, name),
    onSuccess: (team) => {
      setTeamName(team.name);
      void queryClient.invalidateQueries({ queryKey: ['teams'] });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
  const updateProjectMutation = useMutation({
    mutationFn: ({ projectCode, name, description }: { projectCode: string; name: string; description: string | null }) => updateProject(projectCode, { name, description }),
    onSuccess: (project) => {
      setEditingProject(null);
      setProjectName('');
      setProjectDescription('');
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      void queryClient.invalidateQueries({ queryKey: ['project', project.code] });
    },
  });
  const updateProjectStatusMutation = useMutation({
    mutationFn: ({ projectCode, status }: { projectCode: string; status: 'active' | 'archived' }) => updateProjectStatus(projectCode, status),
    onSuccess: (project) => {
      setEditingProject(null);
      setProjectName('');
      setProjectDescription('');
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      void queryClient.invalidateQueries({ queryKey: ['project', project.code] });
    },
  });
  const saveRepositoryMutation = useMutation({
    mutationFn: (input: SaveProjectRepositoryInput) => editingRepository
      ? updateProjectRepository(editingRepository.code, input)
      : createProjectRepository(repositoryProject!.code, input),
    onSuccess: () => {
      setEditingRepository(null);
      setRepositoryForm(EMPTY_REPOSITORY);
      void queryClient.invalidateQueries({ queryKey: ['project-repositories', repositoryProject?.code] });
    },
  });
  const archiveRepositoryMutation = useMutation({
    mutationFn: ({ repositoryCode, status }: { repositoryCode: string; status: 'active' | 'archived' }) => updateProjectRepository(repositoryCode, { status }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['project-repositories', repositoryProject?.code] }),
  });
  const reorderTeamsMutation = useMutation({
    mutationFn: reorderTeams,
    onMutate: async (teamCodes) => {
      await queryClient.cancelQueries({ queryKey: ['teams'] });
      const previous = queryClient.getQueryData<TeamSummary[]>(['teams']) ?? [];
      const byCode = new Map(previous.map((team) => [team.code, team]));
      queryClient.setQueryData<TeamSummary[]>(['teams'], teamCodes.map((code) => byCode.get(code)).filter((team): team is TeamSummary => Boolean(team)));
      return { previous };
    },
    onError: (_error, _teamCodes, context) => {
      if (context?.previous) queryClient.setQueryData(['teams'], context.previous);
    },
  });
  const reorderProjectsMutation = useMutation({
    mutationFn: ({ teamCode, projectCodes }: { teamCode: string; projectCodes: string[] }) => reorderProjects(teamCode, projectCodes),
    onMutate: async ({ teamCode, projectCodes }) => {
      const queryKey = projectsQueryKey;
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<ProjectSummary[]>(queryKey) ?? [];
      const byCode = new Map(previous.map((project) => [project.code, project]));
      const reordered = projectCodes.map((code) => byCode.get(code)).filter((project): project is ProjectSummary => Boolean(project));
      let next = 0;
      queryClient.setQueryData<ProjectSummary[]>(queryKey, previous.map((project) => project.team_code === teamCode ? reordered[next++] ?? project : project));
      return { previous, queryKey };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) queryClient.setQueryData(context.queryKey, context.previous);
    },
    onSettled: () => { void queryClient.invalidateQueries({ queryKey: ['projects'] }); },
  });
  const addMemberMutation = useMutation({
    mutationFn: (input: AddTeamMemberInput) => addTeamMember(selectedTeam!.code, input),
    onSuccess: () => {
      setMemberForm(EMPTY_MEMBER);
      void queryClient.invalidateQueries({ queryKey: ['team-members', selectedTeam?.code] });
      void queryClient.invalidateQueries({ queryKey: ['teams'] });
    },
  });
  const updateMemberRoleMutation = useMutation({
    mutationFn: ({ memberCode, role }: { memberCode: string; role: AddTeamMemberInput['role'] }) => updateTeamMemberRole(selectedTeam!.code, memberCode, role),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['team-members', selectedTeam?.code] });
      void queryClient.invalidateQueries({ queryKey: ['teams'] });
    },
  });
  const removeTeamMemberMutation = useMutation({
    mutationFn: (memberCode: string) => removeTeamMember(selectedTeam!.code, memberCode),
    onSuccess: () => {
      setRemovingMember(null);
      void queryClient.invalidateQueries({ queryKey: ['team-members', selectedTeam?.code] });
      void queryClient.invalidateQueries({ queryKey: ['teams'] });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });

  function submitTeam(event: FormEvent) {
    event.preventDefault();
    createTeamMutation.mutate({ name: teamForm.name.trim() });
  }
  function submitProject(event: FormEvent) {
    event.preventDefault();
    if (!selectedTeam) return;
    createProjectMutation.mutate({
      team_code: selectedTeam.code,
      name: projectForm.name.trim(),
      description: projectForm.description?.trim() || undefined,
      member_policy: projectForm.member_policy ?? 'team_read',
    });
  }
  function submitMember(event: FormEvent) {
    event.preventDefault();
    if (!selectedTeam || !memberForm.user_code.trim()) return;
    addMemberMutation.mutate({ user_code: memberForm.user_code.trim(), role: memberForm.role });
  }
  function submitTeamName(event: FormEvent) {
    event.preventDefault();
    if (!selectedTeam || !isTeamManager(selectedTeam)) return;
    renameTeamMutation.mutate(teamName.trim());
  }
  function submitProjectInfo(event: FormEvent) {
    event.preventDefault();
    if (!editingProject || !canProject(editingProject, 'manage')) return;
    updateProjectMutation.mutate({
      projectCode: editingProject.code,
      name: projectName.trim(),
      description: projectDescription.trim() || null,
    });
  }

  function openTeamDialog() {
    createTeamMutation.reset();
    setTeamDialogOpen(true);
  }
  function closeTeamDialog() {
    createTeamMutation.reset();
    setTeamForm(EMPTY_TEAM);
    setTeamDialogOpen(false);
  }
  function openProjectDialog() {
    if (!selectedTeam || !isTeamManager(selectedTeam)) return;
    createProjectMutation.reset();
    setProjectDialogOpen(true);
  }
  function closeProjectDialog() {
    createProjectMutation.reset();
    setProjectForm(EMPTY_PROJECT);
    setProjectDialogOpen(false);
  }
  function openProjectEdit(project: ProjectSummary) {
    if (!canProject(project, 'manage') && !canProject(project, 'archive')) return;
    updateProjectMutation.reset();
    updateProjectStatusMutation.reset();
    setEditingProject(project);
    setProjectName(project.name);
    setProjectDescription(project.description ?? '');
  }
  function closeProjectEdit() {
    updateProjectMutation.reset();
    updateProjectStatusMutation.reset();
    setEditingProject(null);
    setProjectName('');
    setProjectDescription('');
  }

  function changeProjectStatus(project: ProjectSummary) {
    if (!canProject(project, 'archive')) return;
    const status = project.status === 'active' ? 'archived' : 'active';
    if (status === 'archived' && !window.confirm(t("确认归档项目「{p0}」？\n项目数据不会删除，之后可以随时恢复。", { p0: project.name }))) return;
    updateProjectStatusMutation.mutate({ projectCode: project.code, status });
  }

  function openRepositoryManagement(project: ProjectSummary) {
    setRepositoryProject(project);
    setEditingRepository(null);
    setRepositoryForm(EMPTY_REPOSITORY);
    saveRepositoryMutation.reset();
  }

  function closeRepositoryManagement() {
    setRepositoryProject(null);
    setEditingRepository(null);
    setRepositoryForm(EMPTY_REPOSITORY);
    saveRepositoryMutation.reset();
  }

  function editRepository(repository: ProjectRepository) {
    setEditingRepository(repository);
    setRepositoryForm({
      name: repository.name,
      purpose: repository.purpose ?? '',
      remote_url: repository.remote_url,
      default_branch: repository.default_branch ?? '',
    });
    saveRepositoryMutation.reset();
  }

  function submitRepository(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    saveRepositoryMutation.mutate({
      name: repositoryForm.name.trim(),
      purpose: repositoryForm.purpose.trim() || null,
      remote_url: repositoryForm.remote_url.trim(),
      default_branch: repositoryForm.default_branch.trim() || null,
      ...(editingRepository ? { status: editingRepository.status } : {}),
    });
  }
  function openTeamManagement() {
    renameTeamMutation.reset();
    addMemberMutation.reset();
    updateMemberRoleMutation.reset();
    removeTeamMemberMutation.reset();
    setTeamName(selectedTeam?.name ?? '');
    setTeamManagementOpen(true);
  }
  function closeTeamManagement() {
    renameTeamMutation.reset();
    addMemberMutation.reset();
    updateMemberRoleMutation.reset();
    removeTeamMemberMutation.reset();
    setMemberForm(EMPTY_MEMBER);
    setTeamManagementOpen(false);
  }

  function commitTeamOrder(nextTeams: TeamSummary[]) {
    if (reorderTeamsMutation.isPending || nextTeams.every((team, index) => team.code === teams[index]?.code)) return;
    reorderTeamsMutation.mutate(nextTeams.map((team) => team.code));
  }
  function commitProjectOrder(nextProjects: ProjectSummary[]) {
    if (!selectedTeam || reorderProjectsMutation.isPending || nextProjects.every((project, index) => project.code === projects[index]?.code)) return;
    reorderProjectsMutation.mutate({ teamCode: selectedTeam.code, projectCodes: nextProjects.map((project) => project.code) });
  }
  function dropTeam(event: ReactDragEvent, targetCode: string) {
    event.preventDefault();
    if (draggingTeamCode) commitTeamOrder(moveItemByCode(teams, draggingTeamCode, targetCode));
    setDraggingTeamCode(null);
    setTeamDropTargetCode(null);
  }
  function dropProject(event: ReactDragEvent, targetCode: string) {
    event.preventDefault();
    if (draggingProjectCode) commitProjectOrder(moveItemByCode(projects, draggingProjectCode, targetCode));
    setDraggingProjectCode(null);
    setProjectDropTargetCode(null);
  }
  function moveTeamWithKeyboard(event: ReactKeyboardEvent, teamCode: string) {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    commitTeamOrder(moveItemByOffset(teams, teamCode, event.key === 'ArrowUp' ? -1 : 1));
  }
  function moveProjectWithKeyboard(event: ReactKeyboardEvent, projectCode: string) {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    commitProjectOrder(moveItemByOffset(projects, projectCode, event.key === 'ArrowUp' ? -1 : 1));
  }

  return (
    <>
    <main className="min-h-0 flex-1 overflow-y-auto bg-slate-50 p-5 lg:p-7">
      <section className="mx-auto max-w-[1440px]">
        <header className="mb-5 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs font-bold tracking-[0.18em] text-cyan-700">TEAMS &amp; PROJECTS</p>
            <h1 className="mt-1 text-2xl font-bold text-slate-900">{t("团队与项目")}</h1>
            <p className="mt-1 text-sm text-slate-500">{t("访问你有权限的项目，或按团队和外部协作筛选。")}</p>
          </div>
        </header>

        <div className="grid gap-5 xl:grid-cols-[320px_minmax(0,1fr)]">
          <aside className="space-y-4">
            <nav aria-label={t('项目范围')} className="space-y-1 rounded-2xl border border-slate-200 bg-white p-2 shadow-sm">
              <button type="button" aria-label={t('全部项目')} aria-pressed={scope.kind === 'all'} onClick={() => setScope({ kind: 'all' })} className={`flex w-full items-center justify-between gap-3 rounded-xl px-3 py-3 text-left text-sm font-semibold ${scope.kind === 'all' ? 'bg-cyan-50 text-cyan-800' : 'text-slate-700 hover:bg-slate-50'}`}>
                <span>{t('全部项目')}</span><span className="text-xs font-normal">{projectsQuery.isSuccess ? allProjects.length : '—'}</span>
              </button>
              <button type="button" aria-label={t('外部协作')} aria-pressed={scope.kind === 'external'} onClick={() => setScope({ kind: 'external' })} className={`flex w-full items-center justify-between gap-3 rounded-xl px-3 py-3 text-left text-sm font-semibold ${scope.kind === 'external' ? 'bg-cyan-50 text-cyan-800' : 'text-slate-700 hover:bg-slate-50'}`}>
                <span>{t('外部协作')}</span><span className="text-xs font-normal">{projectsQuery.isSuccess && !externalIdentityUnknown ? externalProjects.length : '—'}</span>
              </button>
            </nav>
            <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
              <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-2.5">
                <h2 className="font-bold text-slate-800">{t("我的团队")}</h2>
                <div className="flex items-center gap-1.5">
                  {teamsQuery.isSuccess && <span className="inline-flex h-7 items-center rounded-lg bg-slate-100 px-2 text-[11px] font-medium text-slate-500">{t("{count} 个团队", { count: teams.length })}</span>}
                  <button type="button" onClick={openTeamDialog} className="ui-button ui-button-primary ui-button-compact"><PlusWorkspaceIcon />{t("创建团队")}</button>
                </div>
              </div>
              <div className="divide-y divide-slate-100">
                {teamsQuery.isLoading && <p className="p-4 text-sm text-slate-500">{t('正在加载团队…')}</p>}
                {teamsQuery.error && <div role="alert" className="space-y-2 p-4 text-sm text-red-700"><p>{t('团队加载失败：')}{teamsQuery.error.message}</p><button type="button" onClick={() => void teamsQuery.refetch()} className="ui-button ui-button-secondary">{t('重新读取团队')}</button></div>}
                {teamsQuery.isSuccess && teams.map((team) => (
                  <div
                    key={team.code}
                    onDragEnter={() => setTeamDropTargetCode(team.code)}
                    onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }}
                    onDrop={(event) => dropTeam(event, team.code)}
                    className={`group/team relative transition ${draggingTeamCode === team.code ? 'opacity-45' : ''} ${draggingTeamCode && teamDropTargetCode === team.code ? 'bg-cyan-50 ring-2 ring-inset ring-cyan-300' : ''}`}
                  >
                    <button type="button" aria-label={t('查看团队项目：{name}', { name: team.name })} aria-pressed={selectedTeam?.code === team.code} onClick={() => setScope({ kind: 'team', teamCode: team.code })} className={`w-full px-4 py-3 pr-12 text-left transition ${selectedTeam?.code === team.code ? 'bg-cyan-50' : 'hover:bg-slate-50'}`}>
                      <span className="block font-semibold text-slate-800">{team.name}</span>
                      <span className="mt-1 flex items-center justify-between text-[11px] text-slate-500"><code>{team.code}</code><span>{t("{projects} 项目 · {members} 成员", { projects: team.projects_count, members: team.members_count })}</span></span>
                    </button>
                    <button type="button" draggable={teams.length > 1 && !reorderTeamsMutation.isPending} disabled={teams.length < 2 || reorderTeamsMutation.isPending} onDragStart={(event) => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', team.code); setDraggingTeamCode(team.code); }} onDragEnd={() => { setDraggingTeamCode(null); setTeamDropTargetCode(null); }} onKeyDown={(event) => moveTeamWithKeyboard(event, team.code)} aria-label={t("调整团队顺序：{p0}", { p0: team.name })} title={t("拖动排序；聚焦后按上下方向键移动")} className="absolute right-2.5 top-2.5 grid h-7 w-7 cursor-grab place-items-center rounded-md text-slate-300 opacity-0 transition hover:bg-white hover:text-slate-600 hover:shadow-sm focus:cursor-grabbing focus:bg-white focus:text-cyan-700 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-cyan-400 group-hover/team:opacity-100 disabled:cursor-default disabled:opacity-0"><DragHandleIcon /></button>
                  </div>
                  ))}
                {teamsQuery.isSuccess && teams.length === 0 && <p className="p-5 text-sm leading-6 text-slate-500">{t('尚未加入团队，仍可访问获授权的项目。')}</p>}
              </div>
              {reorderTeamsMutation.error && <p role="alert" className="border-t border-red-100 bg-red-50 px-4 py-2 text-xs text-red-700">{t("团队排序保存失败：")}{reorderTeamsMutation.error.message}</p>}
            </section>
          </aside>

          <section className="space-y-5">
            {selectedTeam && teamsQuery.isSuccess && <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div><p className="text-xs font-bold text-cyan-700">{t("当前团队")}</p><h2 className="mt-1 text-xl font-bold text-slate-900">{selectedTeam?.name ?? t("请选择团队")}</h2>{selectedTeam && <code className="text-xs text-slate-400">{selectedTeam.code}</code>}</div>
                {selectedTeam && (
                  <div className="flex items-center gap-1.5">
                    <span className="inline-flex h-6 items-center rounded-full bg-amber-50 px-2.5 text-[11px] font-medium text-amber-700">{roleMeta(selectedTeam.role).label}</span>
                    <button type="button" onClick={openTeamManagement} className="ui-button ui-button-secondary"><ManageWorkspaceIcon />{t("团队管理")}</button>
                    <button type="button" onClick={openProjectDialog} disabled={!isTeamManager(selectedTeam)} title={isTeamManager(selectedTeam) ? t("在当前团队创建项目") : t("仅团队负责人和管理员可创建项目")} className="ui-button ui-button-strong"><PlusWorkspaceIcon />{t("创建项目")}</button>
                  </div>
                )}
              </div>
            </div>}

            <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-bold text-slate-900">{t(scope.kind === 'all' ? '全部项目' : scope.kind === 'external' ? '外部协作' : '项目')}</h2><p className="mt-1 text-xs leading-5 text-slate-500">{t(scope.kind === 'external' ? '你未加入所属团队，但已获授权访问这些项目。' : '点击项目进入需求、设计、计划、任务、缺陷与交接工作台。')}</p></div>{projectsQuery.isSuccess && <span className="text-xs text-slate-400">{t("{count} 个项目", { count: projects.length })}</span>}</div>
              {projectsQuery.isLoading && <p className="py-8 text-center text-sm text-slate-500">{t('正在加载项目…')}</p>}
              {projectsQuery.error && <div role="alert" className="mt-4 space-y-2 rounded-xl bg-red-50 p-4 text-sm text-red-700"><p>{t('项目列表读取失败')}: {projectsQuery.error.message}</p><button type="button" onClick={() => void projectsQuery.refetch()} className="ui-button ui-button-secondary">{t('重新读取项目')}</button></div>}
              {scope.kind === 'external' && projectsQuery.isSuccess && externalIdentityUnknown && <p role="status" className="mt-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-800">{t('部分项目的协作身份暂时无法确认，可在全部项目中访问。')}</p>}
              <div className="mt-4 grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
                {!projectsQuery.error && projects.map((project) => (
                  <article
                    key={project.code}
                    onDragEnter={() => setProjectDropTargetCode(project.code)}
                    onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }}
                    onDrop={(event) => dropProject(event, project.code)}
                    className={`group relative rounded-xl border transition hover:-translate-y-0.5 hover:shadow-md ${project.status === 'archived' ? 'border-slate-200 bg-slate-50/80 hover:border-slate-300' : 'border-slate-200 hover:border-cyan-300'} ${draggingProjectCode === project.code ? 'opacity-45' : ''} ${draggingProjectCode && projectDropTargetCode === project.code ? 'ring-2 ring-cyan-300 ring-offset-2' : ''}`}
                  >
                    <a href={projectWorkspacePath(project.code)} className="block rounded-xl p-4 pr-12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 focus-visible:ring-offset-2">
                      <div className="flex flex-wrap items-center gap-2"><h3 className={`break-words font-bold ${project.status === 'archived' ? 'text-slate-600' : 'text-slate-800 group-hover:text-cyan-800'}`}>{project.name}</h3>{project.status === 'archived' && <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-semibold text-slate-600">{t("已归档")}</span>}{isExternalProject(project, teams, teamsQuery.isSuccess) === true && <span className="rounded-md bg-cyan-50 px-2 py-0.5 text-xs font-medium text-cyan-800">{t('外部协作')}</span>}</div>
                      <p className="mt-2 break-words text-xs text-slate-500">{t('所属团队：{name}', { name: projectTeamName(project, teams) })}</p>
                      <code className="mt-2 block text-xs text-slate-400">{project.code}</code>
                      <p className="mt-3 line-clamp-2 min-h-10 text-xs leading-5 text-slate-500">{project.description || t("暂无项目简介")}</p>
                      <p className="mt-3 pr-12 text-xs text-slate-500">{t("{count} 名项目成员 · {role}", { count: project.members_count ?? 0, role: roleMeta(project.role).label })}</p>
                    </a>
                    {selectedTeam && <button type="button" draggable={projects.length > 1 && !reorderProjectsMutation.isPending} disabled={projects.length < 2 || reorderProjectsMutation.isPending} onDragStart={(event) => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', project.code); setDraggingProjectCode(project.code); }} onDragEnd={() => { setDraggingProjectCode(null); setProjectDropTargetCode(null); }} onKeyDown={(event) => moveProjectWithKeyboard(event, project.code)} aria-label={t("调整项目顺序：{p0}", { p0: project.name })} title={projects.length > 1 ? t("拖动排序；聚焦后按上下方向键移动") : t("当前只有一个项目")} className="absolute right-3 top-3 grid h-7 w-7 cursor-grab place-items-center rounded-md bg-white/90 text-slate-300 opacity-0 transition hover:text-slate-600 hover:shadow-sm focus:cursor-grabbing focus:text-cyan-700 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-cyan-400 group-hover:opacity-100 disabled:cursor-default disabled:opacity-30"><DragHandleIcon /></button>}
                    <div className="absolute bottom-3 right-3 flex items-center gap-1.5">
                      <button type="button" aria-label={t("代码仓库：{p0}", { p0: project.name })} title={t("查看和管理项目代码仓库")} onClick={() => openRepositoryManagement(project)} className="ui-button ui-button-secondary ui-button-compact"><RepositoryWorkspaceIcon />{t("仓库")}</button>
                      {(canProject(project, 'manage') || canProject(project, 'archive')) && <button type="button" aria-label={t("编辑项目：{p0}", { p0: project.name })} title={t("编辑项目信息")} onClick={() => openProjectEdit(project)} className="ui-button ui-button-secondary ui-button-compact"><EditWorkspaceIcon />{t("编辑")}</button>}
                    </div>
                  </article>
                ))}
                {projectsQuery.isSuccess && projects.length === 0 && !(scope.kind === 'external' && externalIdentityUnknown) && <div className="col-span-full rounded-xl border border-dashed border-slate-200 p-8 text-center text-sm text-slate-500"><p>{t(scope.kind === 'all' ? '还没有可访问的项目' : scope.kind === 'external' ? '暂无外部协作项目' : '该团队内暂无你可访问的项目。')}</p>{scope.kind === 'all' && <p className="mt-2 text-xs leading-5">{t('加入团队或由项目负责人授予访问权限后，项目会显示在这里。')}</p>}</div>}
              </div>
              {reorderProjectsMutation.error && <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{t("项目排序保存失败：")}{reorderProjectsMutation.error.message}</p>}
            </section>

          </section>
        </div>
      </section>
    </main>

    {teamDialogOpen && (
      <WorkspaceDialog id="create-team-dialog" title={t("创建团队")} description={t("创建者将自动成为团队的唯一负责人。")} onClose={closeTeamDialog}>
        <form onSubmit={submitTeam} className="space-y-4">
          <label className="block text-sm font-semibold text-slate-700">{t("团队名称")} <input required value={teamForm.name} onChange={(event) => setTeamForm((value) => ({ ...value, name: event.target.value }))} placeholder={t("例如：平台研发团队")} className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm outline-none focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100" />
          </label>
          {createTeamMutation.error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{createTeamMutation.error.message}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={closeTeamDialog} className="ui-button ui-button-secondary">{t("取消")}</button>
            <button disabled={createTeamMutation.isPending} className="ui-button ui-button-primary">{createTeamMutation.isPending ? t("创建中…") : t("创建团队")}</button>
          </div>
        </form>
      </WorkspaceDialog>
    )}

    {projectDialogOpen && selectedTeam && (
      <WorkspaceDialog id="create-project-dialog" title={t("创建项目")} description={t("项目将归属团队「{p0}」。", { p0: selectedTeam.name })} onClose={closeProjectDialog}>
        <form onSubmit={submitProject} className="space-y-4">
          <label className="block text-sm font-semibold text-slate-700">{t("项目名称")} <input required value={projectForm.name} onChange={(event) => setProjectForm((value) => ({ ...value, name: event.target.value }))} placeholder={t("例如：Team Synergy")} className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm outline-none focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100" />
          </label>
          <label className="block text-sm font-semibold text-slate-700">{t("项目简介")} <span className="font-normal text-slate-400">{t("（可选）")}</span>
            <textarea rows={3} value={projectForm.description ?? ''} onChange={(event) => setProjectForm((value) => ({ ...value, description: event.target.value }))} placeholder={t("简要说明项目目标、服务对象或协作范围")} className="mt-1.5 w-full resize-none rounded-lg border border-slate-300 px-3 py-2.5 text-sm leading-6 outline-none focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100" />
          </label>
          <div className="space-y-2"><label className="block text-sm font-semibold text-slate-700">{t('项目访问方式')}</label><FormSelect value={projectForm.member_policy ?? 'team_read'} options={(['private', 'team_read', 'team_write'] as const).map((value) => ({ value, label: projectPolicyLabel(value) }))} onChange={(value) => setProjectForm((form) => ({ ...form, member_policy: value as ProjectMemberPolicy }))} ariaLabel={t('项目访问方式')} placeholder={t('项目访问方式')} /><p className="ui-help">{projectPolicyDescription(projectForm.member_policy ?? 'team_read')}</p></div>
          {createProjectMutation.error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{createProjectMutation.error.message}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={closeProjectDialog} className="ui-button ui-button-secondary">{t("取消")}</button>
            <button disabled={createProjectMutation.isPending} className="ui-button ui-button-strong">{createProjectMutation.isPending ? t("创建中…") : t("创建项目")}</button>
          </div>
        </form>
      </WorkspaceDialog>
    )}

    {editingProject && (
      <WorkspaceDialog id="edit-project-dialog" title={t("编辑项目信息")} description={t("维护项目名称和简介；项目编码和所属团队不会改变。")} onClose={closeProjectEdit}>
        <form onSubmit={submitProjectInfo} className="space-y-4">
          <section className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
            <div className="flex items-center justify-between gap-3 text-xs"><span className="text-slate-500">{t("所属团队")}</span><strong className="text-slate-700">{projectTeamName(editingProject, teams)}</strong></div>
            <div className="mt-2 flex items-center justify-between gap-3 text-xs"><span className="text-slate-500">{t("项目编码")}</span><code className="text-slate-500">{editingProject.code}</code></div>
          </section>
          <label className="block text-sm font-semibold text-slate-700">{t("项目名称")} <input autoFocus required aria-label={t("项目名称")} value={projectName} onChange={(event) => { setProjectName(event.target.value); updateProjectMutation.reset(); }} className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm outline-none focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100" />
          </label>
          <label className="block text-sm font-semibold text-slate-700">{t("项目简介")} <span className="font-normal text-slate-400">{t("（可选）")}</span>
            <textarea rows={4} aria-label={t("项目简介")} value={projectDescription} onChange={(event) => { setProjectDescription(event.target.value); updateProjectMutation.reset(); }} placeholder={t("简要说明项目目标、服务对象或协作范围")} className="mt-1.5 w-full resize-none rounded-lg border border-slate-300 px-3 py-2.5 text-sm leading-6 outline-none focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100" />
          </label>
          {updateProjectMutation.error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{updateProjectMutation.error.message}</p>}
          {updateProjectStatusMutation.error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{updateProjectStatusMutation.error.message}</p>}
          <div className="flex items-center justify-between gap-3 pt-2">
            {canProject(editingProject, 'archive') && <button type="button" onClick={() => changeProjectStatus(editingProject)} disabled={updateProjectStatusMutation.isPending} className={`ui-button ${editingProject.status === 'active' ? 'ui-button-danger' : 'ui-button-success'}`}>{updateProjectStatusMutation.isPending ? t("处理中…") : editingProject.status === 'active' ? t("归档项目") : t("恢复项目")}</button>}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={closeProjectEdit} className="ui-button ui-button-secondary">{t("取消")}</button>
              <button disabled={!canProject(editingProject, 'manage') || updateProjectMutation.isPending || updateProjectStatusMutation.isPending || !projectName.trim() || (projectName.trim() === editingProject.name && (projectDescription.trim() || null) === editingProject.description)} className="ui-button ui-button-strong">{updateProjectMutation.isPending ? t("保存中…") : t("保存修改")}</button>
            </div>
          </div>
        </form>
      </WorkspaceDialog>
    )}

    {repositoryProject && (
      <WorkspaceDialog id="project-repositories-dialog" title={t("项目代码仓库")} description={t("为「{p0}」登记云端代码仓库；本地 Agent 可以按需检出。", { p0: repositoryProject.name })} onClose={closeRepositoryManagement} size="wide">
        <div className="space-y-5">
          <section>
            <div className="flex items-center justify-between gap-3"><div><h3 className="font-bold text-slate-900">{t("仓库目录")}</h3><p className="mt-1 text-xs text-slate-500">{t("项目可以包含任意数量的独立 Git 仓库，本机不需要全部拉取。")}</p></div><span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-500">{t("{count} 个仓库", { count: repositoriesQuery.data?.length ?? 0 })}</span></div>
            <div className="mt-3 max-h-64 space-y-2 overflow-y-auto pr-1">
              {repositoriesQuery.isLoading && <p className="rounded-xl bg-slate-50 p-4 text-sm text-slate-400">{t("正在读取代码仓库…")}</p>}
              {repositoriesQuery.error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{t("代码仓库加载失败：")}{repositoriesQuery.error.message}</p>}
              {(repositoriesQuery.data ?? []).map((repository) => (
                <article key={repository.code} className="rounded-xl border border-slate-200 p-3.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0"><div className="flex items-center gap-2"><h4 className="font-semibold text-slate-800">{repository.name}</h4><span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${repository.status === 'active' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>{repository.status === 'active' ? t("可用") : t("已归档")}</span></div><p className="mt-1 text-xs text-slate-500">{repository.purpose || t("未填写用途")} {t("· 默认分支")} {repository.default_branch || t("由 Git remote 决定")}</p></div>
                    {canProject(repositoryProject, 'manage') && <div className="flex shrink-0 items-center gap-1"><button type="button" onClick={() => editRepository(repository)} className="ui-button ui-button-secondary ui-button-compact">{t("编辑")}</button><button type="button" onClick={() => archiveRepositoryMutation.mutate({ repositoryCode: repository.code, status: repository.status === 'active' ? 'archived' : 'active' })} className={`ui-button ui-button-compact ${repository.status === 'active' ? 'ui-button-danger' : 'ui-button-success'}`}>{repository.status === 'active' ? t("归档") : t("启用仓库")}</button></div>}
                  </div>
                  <div className="mt-2 flex items-center gap-2 rounded-lg bg-slate-50 px-2.5 py-2"><code className="min-w-0 flex-1 truncate text-[11px] text-slate-500" title={repository.remote_url}>{repository.remote_url}</code><button type="button" onClick={() => void navigator.clipboard?.writeText(`tsp repository clone ${repository.code}`)} className="shrink-0 text-[11px] font-medium text-cyan-700 hover:text-cyan-900">{t("复制 CLI")}</button></div>
                </article>
              ))}
              {!repositoriesQuery.isLoading && !repositoriesQuery.error && (repositoriesQuery.data?.length ?? 0) === 0 && <p className="rounded-xl border border-dashed border-slate-200 p-6 text-center text-sm text-slate-400">{t("尚未配置代码仓库。产品与设计工作空间仍可正常使用。")}</p>}
            </div>
          </section>

          {canProject(repositoryProject, 'manage') && (
            <form onSubmit={submitRepository} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <div className="flex items-center justify-between gap-3"><div><h3 className="font-bold text-slate-900">{editingRepository ? t("编辑代码仓库") : t("新增代码仓库")}</h3><p className="mt-1 text-xs text-slate-500">{t("地址不能包含账号、密码或访问 Token。")}</p></div>{editingRepository && <button type="button" onClick={() => { setEditingRepository(null); setRepositoryForm(EMPTY_REPOSITORY); saveRepositoryMutation.reset(); }} className="text-xs font-medium text-slate-500 hover:text-slate-800">{t("取消编辑")}</button>}</div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <label className="text-xs font-semibold text-slate-700">{t("仓库名称")}<input required value={repositoryForm.name} onChange={(event) => setRepositoryForm((value) => ({ ...value, name: event.target.value }))} placeholder={t("例如：管理端 Web")} className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-cyan-600" /></label>
                <label className="text-xs font-semibold text-slate-700">{t("默认分支")}<input value={repositoryForm.default_branch} onChange={(event) => setRepositoryForm((value) => ({ ...value, default_branch: event.target.value }))} placeholder="main" className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-cyan-600" /></label>
                <label className="text-xs font-semibold text-slate-700 sm:col-span-2">{t("Git 地址")}<input required value={repositoryForm.remote_url} onChange={(event) => setRepositoryForm((value) => ({ ...value, remote_url: event.target.value }))} placeholder="git@host:team/repository.git" className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs outline-none focus:border-cyan-600" /></label>
                <label className="text-xs font-semibold text-slate-700 sm:col-span-2">{t("用途说明")}<input value={repositoryForm.purpose} onChange={(event) => setRepositoryForm((value) => ({ ...value, purpose: event.target.value }))} placeholder={t("说明该仓库在项目中承担的职责，不限制固定类型")} className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-cyan-600" /></label>
              </div>
              {saveRepositoryMutation.error && <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{saveRepositoryMutation.error.message}</p>}
              {archiveRepositoryMutation.error && <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{t("归档失败：")}{archiveRepositoryMutation.error.message}</p>}
              <div className="mt-3 flex justify-end"><button disabled={saveRepositoryMutation.isPending || !repositoryForm.name.trim() || !repositoryForm.remote_url.trim()} className="ui-button ui-button-strong">{saveRepositoryMutation.isPending ? t("保存中…") : editingRepository ? t("保存修改") : t("新增仓库")}</button></div>
            </form>
          )}
        </div>
      </WorkspaceDialog>
    )}

    {teamManagementOpen && selectedTeam && (
      <WorkspaceDialog id="team-management-dialog" title={t("团队管理")} description={t("管理「{p0}」的成员与权限。", { p0: selectedTeam.name })} onClose={closeTeamManagement} size="wide">
        <div className="space-y-5">
          {isTeamManager(selectedTeam) && <TeamProjectsGovernance teamCode={selectedTeam.code} />}
          <OwnershipTransferPanel scope="team" scopeCode={selectedTeam.code} teamCode={selectedTeam.code} ownerCode={selectedTeam.owner_code} createdByCode={selectedTeam.created_by_code} pending={selectedTeam.ownership_pending} mayTransfer={selectedTeam.capabilities?.transfer ?? (selectedTeam.role === 'owner' && !selectedTeam.ownership_pending)} actorRole={selectedTeam.role} members={membersQuery.data ?? []} />
          <section className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div><h3 className="font-bold text-slate-900">{t("团队信息")}</h3><p className="mt-1 text-xs text-slate-500">{t("团队编码创建后不可修改；负责人和管理员可以修改团队名称。")}</p></div>
                <code className="rounded-md bg-white px-2.5 py-1 text-xs text-slate-500">{selectedTeam.code}</code>
              </div>
            {isTeamManager(selectedTeam) ? (
              <form onSubmit={submitTeamName} className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
                <label className="min-w-0 flex-1 text-sm font-semibold text-slate-700">{t("团队名称")} <input autoFocus required aria-label={t("团队名称")} value={teamName} onChange={(event) => { setTeamName(event.target.value); renameTeamMutation.reset(); }} className="mt-1.5 h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm outline-none focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100" />
                </label>
                <button disabled={renameTeamMutation.isPending || !teamName.trim() || teamName.trim() === selectedTeam.name} className="ui-button ui-button-strong !h-10 self-end">{renameTeamMutation.isPending ? t("保存中…") : t("保存名称")}</button>
              </form>
            ) : (
              <p className="mt-3 text-sm font-semibold text-slate-700">{selectedTeam.name}</p>
            )}
            {renameTeamMutation.error && <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{renameTeamMutation.error.message}</p>}
            {renameTeamMutation.isSuccess && <p role="status" className="mt-3 text-xs font-semibold text-emerald-700">{t("团队名称已更新。")}</p>}
          </section>

          <section>
            <div className="flex items-center justify-between gap-3">
              <div><h3 className="font-bold text-slate-900">{t("团队成员")}</h3><p className="mt-1 text-xs text-slate-500">{t("负责人管理管理员；负责人和管理员可以管理普通成员。")}</p></div>
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">{t("{count} 人", { count: membersQuery.data?.length ?? 0 })}</span>
            </div>
            <div className="mt-3 divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200">
              {membersQuery.isLoading && <p className="p-5 text-center text-sm text-slate-400">{t("正在加载成员…")}</p>}
              {membersQuery.error && <p role="alert" className="p-4 text-sm text-red-700">{t("成员加载失败：")}{membersQuery.error.message}</p>}
              {(membersQuery.data ?? []).map((member) => {
                const nextRole = member.role === 'admin' ? 'member' : 'admin';
                const mayManageAdmins = selectedTeam.capabilities?.manage_admins ?? (selectedTeam.role === 'owner' && !selectedTeam.ownership_pending);
                const mayEdit = isTeamManager(selectedTeam) && canManageMember(mayManageAdmins ? 'owner' : 'admin', member);
                const updating = updateMemberRoleMutation.isPending && updateMemberRoleMutation.variables?.memberCode === member.code;
                const removing = removeTeamMemberMutation.isPending && removeTeamMemberMutation.variables === member.code;
                const account = member.account ?? directoryQuery.data?.find((user) => user.code === member.code)?.account;
                return (
                  <div key={member.code} className="flex flex-wrap items-center justify-between gap-3 bg-white px-4 py-3">
                    <div className="min-w-0"><p className="truncate text-sm font-semibold text-slate-800">{member.display_name}{account && <span className="ml-2 font-normal text-cyan-700">@{account}</span>}</p><code className="text-xs text-slate-400">{member.code}</code></div>
                    <div className="flex items-center gap-2">
                      <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${member.role === 'owner' ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-600'}`}>{roleMeta(member.role).label}</span>
                      {mayEdit && (
                        <>
                          {mayManageAdmins && <button type="button" disabled={updateMemberRoleMutation.isPending || removeTeamMemberMutation.isPending} onClick={() => updateMemberRoleMutation.mutate({ memberCode: member.code, role: nextRole })} className="ui-button ui-button-secondary ui-button-compact">{updating ? t("更新中…") : member.role === 'admin' ? t("设为成员") : t("设为管理员")}</button>}
                          {member.code !== currentUserCode && (
                            <button
                              type="button"
                              disabled={removeTeamMemberMutation.isPending || updateMemberRoleMutation.isPending}
                              onClick={() => {
                                removeTeamMemberMutation.reset(); setRemovingMember(member);
                              }}
                              className="ui-button ui-button-danger ui-button-compact"
                            >
                              {removing ? t("移出中…") : t("移出")}
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            {updateMemberRoleMutation.error && <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{updateMemberRoleMutation.error.message}</p>}
            {removeTeamMemberMutation.error && <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{t("移出成员失败：")}{removeTeamMemberMutation.error.message}</p>}
          </section>

          {isTeamManager(selectedTeam) ? (
            <form onSubmit={submitMember} className="rounded-xl bg-slate-50 p-4">
              <h3 className="font-bold text-slate-900">{t("新增团队成员")}</h3>
              <p className="mt-1 text-xs text-slate-500">{t("用户必须已在账号系统中创建。")}</p>
              <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_140px_auto]">
                <PersonSearchSelect
                  required
                  size="roomy"
                  showDetails
                  value={memberForm.user_code}
                  options={availableUsers}
                  onChange={(user_code) => setMemberForm((value) => ({ ...value, user_code }))}
                  ariaLabel={t("选择团队成员")}
                  placeholder={t("搜索并选择用户")}
                  searchPlaceholder={t("搜索姓名、账号或编码")}
                  emptyMessage={directoryQuery.isLoading ? t("正在加载用户目录…") : t("没有可添加的用户")}
                />
                <select aria-label={t("成员权限")} value={memberForm.role} onChange={(event) => setMemberForm((value) => ({ ...value, role: event.target.value as AddTeamMemberInput['role'] }))} className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm outline-none focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100">
                  <option value="member">{roleMeta("member").label}</option>
                  {(selectedTeam.capabilities?.manage_admins ?? (selectedTeam.role === 'owner' && !selectedTeam.ownership_pending)) && <option value="admin">{roleMeta("admin").label}</option>}
                </select>
                <button disabled={addMemberMutation.isPending || !memberForm.user_code} className="ui-button ui-button-primary !h-10">{addMemberMutation.isPending ? t("添加中…") : t("添加成员")}</button>
              </div>
              {directoryQuery.isLoading && <p className="mt-2 text-xs text-slate-400">{t("正在加载用户目录…")}</p>}
              {directoryQuery.error && <p role="alert" className="mt-2 text-xs text-red-700">{t("用户目录加载失败：")}{directoryQuery.error.message}</p>}
              {addMemberMutation.error && <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{addMemberMutation.error.message}</p>}
            </form>
          ) : (
            <p className="rounded-xl bg-slate-50 p-4 text-sm text-slate-500">{t("只有团队负责人和管理员可以添加成员或修改权限。")}</p>
          )}
        </div>
      </WorkspaceDialog>
    )}
    {removingMember && selectedTeam && <TeamMemberRemovalDialog teamCode={selectedTeam.code} member={removingMember} pending={removeTeamMemberMutation.isPending} error={removeTeamMemberMutation.error} onClose={() => { if (!removeTeamMemberMutation.isPending) setRemovingMember(null); }} onConfirm={() => removeTeamMemberMutation.mutate(removingMember.code)} />}
    </>
  );
}

function PlusWorkspaceIcon() {
  return <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5 shrink-0"><path d="M10 4v12M4 10h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>;
}

function ManageWorkspaceIcon() {
  return <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5 shrink-0"><circle cx="7" cy="7" r="2.5" stroke="currentColor" strokeWidth="1.5" /><path d="M2.5 15c.5-2.5 2-3.8 4.5-3.8S11 12.5 11.5 15M13 6.5h4m-2-2v4m-2 4h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>;
}

function EditWorkspaceIcon() {
  return <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5 shrink-0"><path d="M13.5 3.5 16.5 6.5M4 16l.7-3.2L13.8 3.7a1.2 1.2 0 0 1 1.7 0l.8.8a1.2 1.2 0 0 1 0 1.7l-9.1 9.1L4 16Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function RepositoryWorkspaceIcon() {
  return <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5 shrink-0"><path d="M4 5.5h12v3H4v-3Zm0 6h12v3H4v-3Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /><circle cx="6.5" cy="7" r=".7" fill="currentColor" /><circle cx="6.5" cy="13" r=".7" fill="currentColor" /></svg>;
}

function DragHandleIcon() {
  return <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4"><circle cx="7" cy="5" r="1.2" /><circle cx="13" cy="5" r="1.2" /><circle cx="7" cy="10" r="1.2" /><circle cx="13" cy="10" r="1.2" /><circle cx="7" cy="15" r="1.2" /><circle cx="13" cy="15" r="1.2" /></svg>;
}


export function isTeamManager(team: TeamSummary | null | undefined): boolean {
  return Boolean(team && (team.capabilities ? team.capabilities.manage : team.role === 'owner' || team.role === 'admin'));
}

function TeamMemberRemovalDialog({ teamCode, member, pending, error, onClose, onConfirm }: { teamCode: string; member: Member; pending: boolean; error: Error | null; onClose: () => void; onConfirm: () => void }) {
  useLocale();
  const impact = useQuery({ queryKey: ['team-member-removal-impact', teamCode, member.code], queryFn: () => getTeamMemberRemovalImpact(teamCode, member.code), staleTime: 0 });
  const blocked = (impact.data?.blocked_owned_projects.length ?? 0) > 0 || (impact.data?.open_tasks.length ?? 0) > 0 || (impact.data?.active_runs?.length ?? 0) > 0;
  return <WorkspaceDialog id="team-member-removal" title={t('移出团队成员')} description={member.display_name} onClose={onClose}>
    <div className="space-y-4"><p className="ui-help">{t('移出团队将撤销团队继承权限及本团队项目的单独授权。需要继续外部协作时，由项目负责人重新授权。')}</p>
      {impact.isPending && <p className="ui-help">{t('正在检查权限影响…')}</p>}{impact.error && <p role="alert" className="text-sm text-rose-700">{impact.error.message}</p>}
      {impact.data && <><h3 className="text-sm font-semibold text-slate-800">{t('受影响的项目')}</h3><ul className="max-h-56 space-y-2 overflow-y-auto">{impact.data.projects.map((project) => <li key={project.project_code} className="flex justify-between gap-3 rounded-lg bg-slate-50 p-3 text-sm"><span className="break-words">{project.name}</span><span className="shrink-0 text-xs text-slate-500">{roleMeta(project.role).label}</span></li>)}</ul>{impact.data.projects.length === 0 && <p className="ui-help">{t('没有需要撤销的项目权限。')}</p>}
        {impact.data.blocked_owned_projects.length > 0 && <div role="alert" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900"><p>{t('必须先转移以下项目的负责人：')}</p><ul className="mt-2 list-inside list-disc">{impact.data.blocked_owned_projects.map((project) => <li key={project.project_code}>{project.name}</li>)}</ul></div>}
        {impact.data.open_tasks.length > 0 && <div role="alert" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900"><p>{t('必须先交接以下进行中的工作：')}</p><ul className="mt-2 list-inside list-disc">{impact.data.open_tasks.map((task) => <li key={task.task_code}>{task.title ?? task.task_code}</li>)}</ul></div>}
        {(impact.data.active_runs?.length ?? 0) > 0 && <div role="alert" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900"><p>{t('必须先交接以下进行中的工作：')}</p><ul className="mt-2 list-inside list-disc">{impact.data.active_runs.map((run) => <li key={run.run_code}>{run.task_code} · {run.run_code}</li>)}</ul></div>}
      </>}
      {error && <p role="alert" className="text-sm text-rose-700">{error.message}</p>}
      <div className="flex justify-end gap-2"><button type="button" onClick={onClose} disabled={pending} className="ui-button ui-button-secondary">{t('取消')}</button><button type="button" disabled={pending || !impact.isSuccess || impact.isFetching || blocked} onClick={onConfirm} className="ui-button ui-button-danger">{pending ? t('移出中…') : t('确认移出')}</button></div>
    </div>
  </WorkspaceDialog>;
}


export function TeamProjectsGovernance({ teamCode }: { teamCode: string }) {
  const projects = useQuery({ queryKey: ['team-projects-governance', teamCode], queryFn: () => listTeamProjectGovernance(teamCode) });
  return <section className="space-y-3 rounded-xl border border-slate-200 p-4">
    <h3 className="text-sm font-bold text-slate-900">{t('团队项目归属')}</h3>
    <p className="ui-help">{t('团队管理权限可以查看项目归属；打开项目仍需相应的项目权限。')}</p>
    {projects.isPending && <p className="ui-help">{t('加载中…')}</p>}
    {projects.error && <p role="alert" className="text-xs text-rose-700">{projects.error.message}</p>}
    {projects.isSuccess && projects.data.length === 0 && <p className="ui-help">{t('此团队暂无项目。')}</p>}
    <ul className="max-h-64 divide-y divide-slate-100 overflow-y-auto">{(projects.data ?? []).map(project => <li key={project.project_code} className="flex items-center justify-between gap-3 py-3">
      <div className="min-w-0"><p className="break-words text-sm font-semibold text-slate-800">{project.name}{project.status === 'archived' && <span className="ml-2 text-xs font-normal text-slate-500">{t('已归档')}</span>}</p><p className="ui-help mt-1">{t('项目负责人：{name}', { name: project.owner_name || project.owner_user_code || t('待确认唯一负责人') })}</p></div>
      {project.can_access ? <a href={projectWorkspacePath(project.project_code)} className="ui-button ui-button-secondary ui-button-compact shrink-0">{t('打开项目')}</a> : <span className="shrink-0 text-xs text-slate-500">{t('未获项目访问权限')}</span>}
    </li>)}</ul>
  </section>;
}
