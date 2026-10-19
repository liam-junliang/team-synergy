import { useQuery } from '@tanstack/react-query';
import { listProjects, listTeams, type AuthUser, type ProjectSummary } from './api';
import { agentWorkspacePath, type WorkspaceRoute } from './workspaceRouting';
import { navigateWorkspace } from './workspaceNavigation';
import { t } from './i18n';
import { useLocale } from './useLocale';
import { DeviceManagement } from './DeviceManagement';
import { DeviceAuthorization } from './DeviceAuthorization';
import { CliInstaller } from './CliInstaller';
import { SkillsWorkbench } from './SkillsWorkbench';
import { CopyCommand, SkillError } from './SkillShared';
import { clientConnectionUrls, cliLoginCommand, getPlatformClientConfig, PLATFORM_CLIENT_CONFIG_QUERY_KEY } from './platformClientConfig';

export function CliConnectionGuide({ user, project }: { user: AuthUser; project?: ProjectSummary }) {
  const settings = useQuery({ queryKey: PLATFORM_CLIENT_CONFIG_QUERY_KEY, queryFn: getPlatformClientConfig, retry: false });
  if (settings.isPending) return <p role="status" className="p-6 text-sm text-slate-500">{t('正在读取平台接入配置…')}</p>;
  if (settings.isError) return <div className="space-y-3"><SkillError error={settings.error} /><button type="button" className="ui-button ui-button-secondary" onClick={() => void settings.refetch()}>{t('重新读取接入配置')}</button></div>;
  const currentOrigin = typeof window === 'undefined' ? 'https://platform.example.com' : window.location.origin;
  const { apiUrl } = clientConnectionUrls(settings.data, currentOrigin);
  const projectCode = project?.code ?? '<PROJECT_CODE>';
  return <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_300px]">
    <div className="space-y-5">
      <CliInstaller apiUrl={apiUrl} />
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><h2 className="text-base font-bold">2. {t('授权本机设备')}</h2><p className="mb-4 mt-2 text-sm leading-6 text-slate-500">{t('执行后会打开浏览器。登录平台、核对终端中的授权码并确认，即可授权当前 CLI；无需管理员签发令牌。')}</p><CopyCommand command={cliLoginCommand(settings.data, currentOrigin)} /><p className="mt-3 text-xs leading-5 text-slate-500">{t('接入地址由系统管理员统一配置；未配置时使用当前站点地址。')}</p><p className="mt-2 text-xs leading-5 text-slate-500">{t('无法自动打开浏览器时，添加 --no-browser，并在浏览器打开终端提供的授权地址。')}</p></section>
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><h2 className="text-base font-bold">3. {t('绑定项目与检查连接')}</h2><p className="mb-4 mt-2 text-sm leading-6 text-slate-500">{project ? t('在项目工作目录执行以下命令，绑定仅保存在本机。') : t('先在右上角选择项目，再复制对应的绑定命令。')}</p><CopyCommand command={`tsp project bind ${projectCode}\ntsp project current\ntsp docs list --project ${projectCode}\ntsp task list --assigned-to me`} /></section>
      <section className="rounded-2xl border border-cyan-200 bg-cyan-50/50 p-5"><h2 className="text-base font-bold">4. {t('同步项目技能')}</h2><p className="mb-4 mt-2 text-sm leading-6 text-slate-600">{t('项目管理员在技能库固定采用的版本；本机同步只下载已启用且当前仍有授权的技能。')}</p><CopyCommand command={`tsp skill list --project ${projectCode}\ntsp skill sync --project ${projectCode} --check\ntsp skill sync --project ${projectCode}`} /><p className="text-xs leading-5 text-slate-500">{t('同步不会执行包内脚本；遇到本地修改或同名文件会报告冲突并保留原文件。')}</p></section>
      <section className="rounded-2xl border border-slate-200 bg-white p-5"><h2 className="text-base font-bold">{t('常见问题')}</h2><dl className="mt-4 space-y-4 text-sm"><div><dt className="font-semibold">{t('找不到 tsp 命令')}</dt><dd className="mt-1 text-slate-500">{t('重开终端以加载 PATH；仍不可用时，按安装脚本输出的路径运行 tsp，或重新执行安装脚本。')}</dd></div><div><dt className="font-semibold">{t('认证或项目访问失败')}</dt><dd className="mt-1 text-slate-500">{t('先执行 tsp auth whoami 核对账号，再检查 API 地址、设备授权和项目成员权限。初始密码需要先修改。')}</dd></div><div><dt className="font-semibold">{t('技能不可同步')}</dt><dd className="mt-1 text-slate-500">{t('检查项目是否启用该版本、共享是否有效，以及新增外部成员后是否需要源管理员扩大授权。')}</dd></div></dl></section>
    </div>
    <aside className="space-y-4 xl:sticky xl:top-0"><section className="rounded-2xl border border-slate-200 bg-white p-5"><p className="text-xs font-semibold text-cyan-700">{t('当前身份')}</p><h2 className="mt-2 font-bold">{user.display_name}</h2><p className="text-xs text-slate-500">@{user.account}</p><p className="mt-4 text-xs text-slate-500">{t('当前项目')}</p><p className="mt-1 break-words font-semibold">{project?.name ?? t('尚未选择项目')}</p></section><section className="rounded-2xl border border-slate-200 bg-white p-5"><DeviceManagement userCode={user.code} /></section></aside>
  </div>;
}

export function AgentWorkspace({ route, user }: { route: WorkspaceRoute; user: AuthUser }) {
  useLocale();
  if (route.agentTab === 'authorize') return <DeviceAuthorization key={route.authorizationCode ?? ''} user={user} code={route.authorizationCode} />;
  return <AgentLibraryWorkspace route={route} user={user} />;
}

function AgentLibraryWorkspace({ route, user }: { route: WorkspaceRoute; user: AuthUser }) {
  const projects = useQuery({ queryKey: ['projects', 'agent', user.code], queryFn: () => listProjects() });
  const teams = useQuery({ queryKey: ['teams'], queryFn: listTeams });
  const project = projects.data?.find(item => item.code === route.projectCode);
  // Only explicit team membership provides a team-library context. External project membership does not.
  const team = teams.data?.find(item => item.code === route.teamCode) ?? teams.data?.find(item => item.code === project?.team_code) ?? (!route.projectCode && !route.teamCode ? teams.data?.[0] : undefined);
  return <main className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-slate-50"><section className="mx-auto max-w-[1440px] p-4 sm:p-6"><header className="mb-6 flex flex-wrap items-end justify-between gap-4"><div><p className="text-xs font-bold tracking-[0.16em] text-cyan-700">AGENT WORKSPACE</p><h1 className="mt-1 text-2xl font-bold text-slate-950">{t(route.agentTab === 'skills' ? '技能库' : 'CLI 接入')}</h1><p className="mt-2 text-sm text-slate-500">{t(route.agentTab === 'skills' ? '团队维护技能，项目固定版本，授权后同步到本机。' : '让本机 Agent 使用当前账号接入项目。')}</p></div>{route.agentTab === 'skills' && <label className="text-xs font-medium text-slate-600">{t('团队范围')}<select aria-label={t('团队范围')} className="form-control ml-2 max-w-56" value={team?.code ?? ''} onChange={event => navigateWorkspace(agentWorkspacePath('skills', { ...route, teamCode: event.target.value || undefined }))}><option value="">{t('无团队范围')}</option>{teams.data?.map(item => <option key={item.code} value={item.code}>{item.name}</option>)}</select></label>}</header><SkillError error={projects.error || teams.error} />{route.projectCode && projects.isSuccess && !project ? <SkillError error={t('无法访问所选项目，请切换到有权限的项目。')} /> : projects.isPending || teams.isPending ? <p role="status" className="p-6 text-sm text-slate-500">{t('正在加载…')}</p> : route.agentTab === 'skills' ? <SkillsWorkbench key={`${project?.code ?? ''}:${team?.code ?? ''}`} project={project} team={team} /> : <CliConnectionGuide user={user} project={project} />}</section></main>;
}
