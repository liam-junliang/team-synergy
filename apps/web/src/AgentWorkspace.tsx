import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { fetchEnvelope, listProjects, listTeams, type AuthUser, type ProjectSummary } from './api';
import { agentWorkspacePath, personalMemoryWorkspacePath, type WorkspaceRoute } from './workspaceRouting';
import { navigateWorkspace } from './workspaceNavigation';
import { t } from './i18n';
import { useLocale } from './useLocale';
import { DeviceAuthorization } from './DeviceAuthorization';
import { AgentUsageGuide } from './AgentUsageGuide';
import { CliInstaller } from './CliInstaller';
import { SkillsWorkbench, type SkillLibraryTab } from './SkillsWorkbench';
import { CopyCommand, SkillError } from './SkillShared';
import { clientConnectionUrls, cliLoginCommand, getPlatformClientConfig, PLATFORM_CLIENT_CONFIG_QUERY_KEY } from './platformClientConfig';
import { RemoteMcpConnectionGuide } from './RemoteMcpConnectionGuide';
import { McpConsentWorkspace } from './McpConsentWorkspace';

export function AgentConnectionWorkspace({ user, project, projects }: { user: AuthUser; project?: ProjectSummary; projects?: ProjectSummary[] }) {
  const [mode, setMode] = useState<'remote' | 'local'>(() => typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('setup') === 'capture' ? 'local' : 'remote');

  return <>
    <div aria-label={t('Agent 接入方式')} role="group" className="mb-5 inline-flex flex-wrap gap-1 rounded-xl border border-slate-200 bg-slate-100 p-1">
      {(['remote', 'local'] as const).map(value => <button key={value} type="button" aria-pressed={mode === value}
        className={`rounded-lg px-4 py-2 text-sm font-semibold focus-visible:outline-cyan-600 ${mode === value ? 'bg-white text-cyan-900 shadow-sm' : 'text-slate-600 hover:text-slate-950'}`}
        onClick={() => setMode(value)}>{t(value === 'remote' ? 'HTTP Connector（推荐）' : '本地 CLI')}</button>)}
    </div>
    {mode === 'remote' ? <RemoteMcpConnectionGuide key={user.code} accountCode={user.code} projects={projects} onLocalSetup={() => setMode('local')} />
      : <CliConnectionGuide user={user} project={project} />}
  </>;
}

export function CliConnectionGuide({ user, project }: { user: AuthUser; project?: ProjectSummary }) {
  const settings = useQuery({ queryKey: PLATFORM_CLIENT_CONFIG_QUERY_KEY, queryFn: getPlatformClientConfig, retry: false });
  if (settings.isPending) return <p role="status" className="p-6 text-sm text-slate-500">{t('正在读取平台接入配置…')}</p>;
  if (settings.isError) return <div className="space-y-3"><SkillError error={settings.error} /><button type="button" className="ui-button ui-button-secondary" onClick={() => void settings.refetch()}>{t('重新读取接入配置')}</button></div>;
  const currentOrigin = typeof window === 'undefined' ? 'https://platform.example.com' : window.location.origin;
  const { apiUrl } = clientConnectionUrls(settings.data, currentOrigin);
  const projectCode = project?.code;
  return <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_300px]">
    <div className="space-y-5">
      <CliInstaller apiUrl={apiUrl} />
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-base font-bold">2. {t('授权本机设备')}</h2>
        <p className="mb-4 mt-2 text-sm leading-6 text-slate-500">{t('执行后会打开浏览器。登录平台、核对终端中的授权码并确认，即可授权当前 CLI；无需管理员签发令牌。')}</p>
        <CopyCommand command={cliLoginCommand(settings.data, currentOrigin)} />
        <p className="mt-3 text-xs leading-5 text-slate-500">{t('接入地址由系统管理员统一配置；未配置时使用当前站点地址。')}</p>
        <p className="mt-2 text-xs leading-5 text-slate-500">{t('无法自动打开浏览器时，添加 --no-browser，并在浏览器打开终端提供的授权地址。')}</p>
      </section>
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-base font-bold">3. {t('选择项目与检查连接')}</h2>
        <p className="mb-4 mt-2 text-sm leading-6 text-slate-500">{project ? t('以下命令直接指定所选项目，无需先绑定工作目录。') : t('连接后先列出可访问项目，再为读取工具传入 projectCode。')}</p>
        <CopyCommand command={`tsp tools call get_connection_context\ntsp tools call list_projects${projectCode ? `\ntsp tools call read_code_catalog --project ${projectCode}` : ''}`} />
        <p className="mt-2 text-xs leading-5 text-slate-500">{t('CLI 按当前账号权限访问项目。projectCode 只影响本次工具调用，工作区绑定是可选默认值。')}</p>
        <details className="mt-4 rounded-xl border border-slate-200 bg-slate-50/60 p-3">
          <summary className="cursor-pointer text-sm font-semibold">{t('可选：绑定本机工作区')}</summary>
          <p className="mb-3 mt-2 text-xs leading-5 text-slate-500">{t('经常在同一目录使用 CLI 时，可保存默认项目；启用会话采集前必须核对工作区绑定。')}</p>
          {projectCode ? <CopyCommand command={`tsp project bind ${projectCode}\ntsp project current\ntsp docs index --limit 10`} /> : <p className="text-xs text-slate-500">{t('先在右上角选择项目，再复制对应的绑定命令。')}</p>}
        </details>
      </section>
      <LocalAgentSetup key={`${user.code}:${projectCode ?? ''}`} accountCode={user.code} projectCode={project?.status === 'active' ? projectCode : undefined} />
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm" aria-label={t('CLI 使用说明')}>
        <h2 className="text-base font-bold">{t('通过 CLI 调用工具')}</h2>
        <p className="mb-3 mt-2 text-sm leading-6 text-slate-500">{t('先查看工具目录和检索说明，再用 --project 或输入中的 projectCode 指定项目；已有工作区绑定时也可沿用默认项目。')}</p>
        <CopyCommand command={`tsp tools list\ntsp memory guidance\ntsp tools call ${projectCode ? `read_code_catalog --project ${projectCode}` : 'list_projects'}`} />
        <p className="mt-4 text-xs leading-5 text-slate-500">{t('接入后先检查项目资料目录或代码目录，确认返回的是当前项目。个人记忆仅本人可见，工作偏好不代表提交、推送或合并授权。')}</p>
      </section>
      <details className="rounded-2xl border border-cyan-200 bg-cyan-50/50 p-5">
        <summary className="cursor-pointer text-base font-bold">{t('可选：同步项目技能')}</summary>
        <p className="mb-4 mt-3 text-sm leading-6 text-slate-600">{t('项目管理员在技能库固定采用的版本；本机同步只下载已启用且当前仍有授权的技能。')}</p>
        {projectCode ? <CopyCommand command={`tsp skill list --project ${projectCode}\ntsp skill sync --project ${projectCode} --check\ntsp skill sync --project ${projectCode}`} /> : <p className="mb-3 text-sm text-slate-500">{t('先在右上角选择项目，再复制对应的绑定命令。')}</p>}
        <p className="text-xs leading-5 text-slate-500">{t('同步不会执行包内脚本；遇到本地修改或同名文件会报告冲突并保留原文件。')}</p>
      </details>
      <section className="rounded-2xl border border-slate-200 bg-white p-5">
        <h2 className="text-base font-bold">{t('常见问题')}</h2>
        <dl className="mt-4 space-y-4 text-sm">
          <div><dt className="font-semibold">{t('找不到 tsp 命令')}</dt><dd className="mt-1 text-slate-500">{t('重开终端以加载 PATH；仍不可用时，按安装脚本输出的路径运行 tsp，或重新执行安装脚本。')}</dd></div>
          <div><dt className="font-semibold">{t('认证或项目访问失败')}</dt><dd className="mt-1 text-slate-500">{t('先执行 tsp auth whoami 核对账号，再检查 API 地址、设备授权和项目成员权限。初始密码需要先修改。')}</dd></div>
          <div><dt className="font-semibold">{t('CLI 没有读到目标项目')}</dt><dd className="mt-1 text-slate-500">{t('先用 tsp tools call get_connection_context 核对账号，再用 tsp tools call list_projects 发现项目。每次调用用 --project 指定目标，或核对 tsp project current 中的默认项目。')}</dd></div>
          <div><dt className="font-semibold">{t('需要自动整理会话')}</dt><dd className="mt-1 text-slate-500">{t('HTTP Connector 和 CLI 提供按需调用的工具。会话采集需本人单独启用对应宿主的 Hook 或插件；连接成功不代表聊天已保存。')}</dd></div>
          <div><dt className="font-semibold">{t('技能不可同步')}</dt><dd className="mt-1 text-slate-500">{t('检查项目是否启用该版本、共享是否有效，以及新增外部成员后是否需要源管理员扩大授权。')}</dd></div>
        </dl>
      </section>
    </div>
    <aside className="space-y-4 xl:sticky xl:top-0"><section className="rounded-2xl border border-slate-200 bg-white p-5"><p className="text-xs font-semibold text-cyan-700">{t('当前身份')}</p><h2 className="mt-2 font-bold">{user.display_name}</h2><p className="text-xs text-slate-500">@{user.account}</p><p className="mt-4 text-xs text-slate-500">{t('当前项目')}</p><p className="mt-1 break-words font-semibold">{project?.name ?? t('尚未选择项目')}</p><a href="/account" className="ui-context-action mt-4 inline-block">{t('前往个人设置')}</a></section></aside>
  </div>;
}

const localHarnesses = [
  { value: 'codex', label: 'Codex' },
  { value: 'dsh', label: 'DSH' },
  { value: 'opencode', label: 'OpenCode' },
  { value: 'claudecode', label: 'Claude Code' },
] as const;

type CapturePreflight = { serviceEnabled: boolean; allowed: boolean; reason: 'memory_capture_disabled' | 'memory_forbidden' | null };

function LocalAgentSetup({ accountCode, projectCode }: { accountCode: string; projectCode?: string }) {
  const [harness, setHarness] = useState<(typeof localHarnesses)[number]['value']>('codex');
  const [capture, setCapture] = useState(false);
  const captureAvailable = harness !== 'claudecode';
  const checkRequested = Boolean(projectCode && capture && captureAvailable);
  const preflight = useQuery({
    queryKey: ['memory-capture-preflight', accountCode, projectCode],
    queryFn: ({ signal }) => fetchEnvelope<CapturePreflight>(`/projects/${encodeURIComponent(projectCode ?? '')}/memory/capture-preflight`, { signal }),
    enabled: checkRequested,
    retry: false,
  });
  const checking = preflight.isPending || preflight.isFetching;
  const ready = checkRequested && !checking && preflight.isSuccess &&
    preflight.data?.serviceEnabled === true && preflight.data.allowed === true && preflight.data.reason === null;
  let checkMessage = t('暂时无法核对采集条件，请重试。');
  if (checking) checkMessage = t('正在检查采集服务与项目权限…');
  else if (ready) checkMessage = t('服务与项目权限检查通过。请在本机继续安装。');
  else if (preflight.isSuccess && preflight.data?.reason === 'memory_capture_disabled') checkMessage = t('平台尚未开启会话采集服务。');
  else if (preflight.isSuccess && preflight.data?.reason === 'memory_forbidden') checkMessage = t('当前账号没有此项目的会话采集权限。');

  return <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm" aria-labelledby="local-agent-setup-title">
    <h2 id="local-agent-setup-title" className="text-base font-bold">4. {t('可选：配置会话采集')}</h2>
    <p className="mt-2 text-sm leading-6 text-slate-600">{t('Connector 读取记忆无需本地采集。只有你决定保存当前工作区的新会话时，才安装对应宿主的 Hook 或插件。')}</p>
    <label className="ui-field-label mt-3 block max-w-xs">{t('Agent 宿主')}
      <select className="form-control mt-2" value={harness} onChange={event => {
        const selected = localHarnesses.find(option => option.value === event.target.value);
        if (selected) { setHarness(selected.value); setCapture(false); }
      }}>{localHarnesses.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
    </label>
    {captureAvailable ? <label className="mt-3 flex items-start gap-2 text-sm text-slate-700">
      <input type="checkbox" className="mt-1 accent-cyan-700" checked={capture} disabled={!projectCode} onChange={event => setCapture(event.target.checked)} />
      <span>{t('检查当前工作区的采集接入条件')}</span>
    </label> : <p className="mt-3 text-sm text-slate-600">{t('Claude Code 可使用 HTTP Connector；会话采集暂未开放。')}</p>}
    {checkRequested && <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 p-3 text-sm text-slate-700">
      <p role="status">{checkMessage}</p>
      {!checking && !ready && <button type="button" className="ui-context-action" onClick={() => void preflight.refetch()}>{t('重新检查采集条件')}</button>}
    </div>}
    {ready && <div className="mt-3 space-y-2 text-sm leading-6 text-slate-600">
      <p>{t('在工作区根目录核对 CLI 登录账号与绑定项目 {project}。两项相符后再执行安装。', { project: projectCode ?? '' })}</p>
      <CopyCommand command={'tsp auth whoami\ntsp project current'} />
      <p>{t('重开宿主并开启新会话。采集会把该工作区中受支持的操作者输入发送到平台整理。')}
        {harness === 'codex' && <> {t('Codex 需在 /hooks 中审阅并信任采集定义。')}</>}</p>
      <CopyCommand command={`tsp memory native install --harness ${harness}`} />
    </div>}
    {projectCode && captureAvailable && <details className="mt-3 text-sm">
      <summary className="cursor-pointer font-semibold">{t('诊断或停止本机采集')}</summary>
      <div className="mt-2 space-y-2 text-slate-600">
        <p>{t('在对应设备的工作区根目录运行诊断。在记忆中心用采集编号核对服务回执。')}</p>
        <CopyCommand command={`tsp memory native doctor --harness ${harness}`} />
        <p>{t('停止当前工作区的采集')}</p>
        <CopyCommand command={`tsp memory native uninstall --harness ${harness}`} />
      </div>
    </details>}
    <a className="ui-context-action mt-3 inline-block" href={`${personalMemoryWorkspacePath()}?view=processing`}>{t('在记忆中心查看采集结果')}</a>
    {!projectCode && <p className="mt-3 text-sm text-slate-600">{t('先在页首选择一个已启用项目，再配置会话采集。')}</p>}
  </section>;
}

export function AgentWorkspace({ route, user, guideProject }: { route: WorkspaceRoute; user: AuthUser; guideProject?: ProjectSummary }) {
  useLocale();
  if (route.agentTab === 'authorize') return <DeviceAuthorization key={route.authorizationCode ?? ''} user={user} code={route.authorizationCode} />;
  if (route.agentTab === 'mcp-consent') return <McpConsentWorkspace key={`${user.code}:${route.mcpConsentRequest ?? ''}`} request={route.mcpConsentRequest} user={user} />;
  if (route.agentTab === 'guide') return <AgentUsageGuide route={route} project={guideProject} />;
  return <AgentLibraryWorkspace route={route} user={user} />;
}

export function skillLibraryContextPath(route: WorkspaceRoute, view: SkillLibraryTab) {
  const path = agentWorkspacePath('skills', route);
  return path + (path.includes('?') ? '&' : '?') + 'skill_view=' + view;
}

function AgentLibraryWorkspace({ route, user }: { route: WorkspaceRoute; user: AuthUser }) {
  const requestedView = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('skill_view');
  const initialTab: SkillLibraryTab = requestedView === 'owned' || requestedView === 'shared' || requestedView === 'project' ? requestedView : 'platform';

  const projects = useQuery({ queryKey: ['projects', 'agent', user.code], queryFn: () => listProjects() });
  const teams = useQuery({ queryKey: ['teams'], queryFn: listTeams });
  const project = projects.data?.find(item => item.code === route.projectCode);
  // Only explicit team membership provides a team-library context. External project membership does not.
  const team = teams.data?.find(item => item.code === route.teamCode) ?? (!route.teamCode ? teams.data?.find(item => item.code === project?.team_code) : undefined);
  const projectIssue = route.projectCode && projects.isSuccess && !project ? t('无法访问所选项目，请切换到有权限的项目。') : undefined;
  return <main className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-slate-50"><section className="mx-auto max-w-[1440px] p-4 sm:p-6">
    <header className="mb-6"><p className="text-xs font-bold tracking-[0.16em] text-cyan-700">AGENT WORKSPACE</p><h1 className="mt-1 text-2xl font-bold text-slate-950">{t(route.agentTab === 'skills' ? '技能库' : 'Agent 接入')}</h1><p className="mt-2 text-sm text-slate-500">{t(route.agentTab === 'skills' ? '管理可用技能、项目固定版本和本机同步。' : '日常查询和协作使用 HTTP Connector。需要本机工作树或会话采集时，选择本地接入。')}</p></header>
    <SkillError error={projects.error || teams.error} />
    {route.agentTab === 'skills' ? <SkillsWorkbench key={user.code} initialTab={initialTab} project={project} team={team} projects={projects.data} teams={teams.data} projectIssue={projectIssue}
      onProjectChange={(code, view) => navigateWorkspace(skillLibraryContextPath({ ...route, projectCode: code || undefined }, view))}
      onTeamChange={(code, view) => navigateWorkspace(skillLibraryContextPath({ ...route, teamCode: code || undefined }, view))} /> : <AgentConnectionWorkspace user={user} project={project} projects={projects.data} />}
  </section></main>;

}
