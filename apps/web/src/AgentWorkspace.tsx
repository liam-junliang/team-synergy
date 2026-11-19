import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { listProjects, listTeams, type AuthUser, type ProjectSummary } from './api';
import { agentWorkspacePath, type WorkspaceRoute } from './workspaceRouting';
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
  const [mode, setMode] = useState<'remote' | 'local'>('remote');

  return <>
    <div aria-label={t('Agent 接入方式')} role="group" className="mb-5 inline-flex flex-wrap gap-1 rounded-xl border border-slate-200 bg-slate-100 p-1">
      {(['remote', 'local'] as const).map(value => <button key={value} type="button" aria-pressed={mode === value}
        className={`rounded-lg px-4 py-2 text-sm font-semibold focus-visible:outline-cyan-600 ${mode === value ? 'bg-white text-cyan-900 shadow-sm' : 'text-slate-600 hover:text-slate-950'}`}
        onClick={() => setMode(value)}>{t(value === 'remote' ? 'HTTP Connector（推荐）' : '本地 CLI / MCP')}</button>)}
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
        <p className="mt-2 text-xs leading-5 text-slate-500">{t('CLI 与 MCP 共用当前账号和访问权限。projectCode 只影响本次工具调用，工作区绑定是可选默认值。')}</p>
        <details className="mt-4 rounded-xl border border-slate-200 bg-slate-50/60 p-3">
          <summary className="cursor-pointer text-sm font-semibold">{t('可选：绑定本机工作区')}</summary>
          <p className="mb-3 mt-2 text-xs leading-5 text-slate-500">{t('经常在同一目录使用 CLI 或采集接入时，可保存本机项目绑定。MCP 启动不要求此步骤。')}</p>
          {projectCode ? <CopyCommand command={`tsp project bind ${projectCode}\ntsp project current\ntsp docs index --limit 10`} /> : <p className="text-xs text-slate-500">{t('先在右上角选择项目，再复制对应的绑定命令。')}</p>}
        </details>
      </section>
      <LocalAgentSetup projectCode={project?.status === 'active' ? projectCode : undefined} />
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm" aria-label={t('CLI 与 MCP 接入说明')}>
        <h2 className="text-base font-bold">{t('手动配置 CLI 与 MCP')}</h2>
        <p className="mt-2 text-sm leading-6 text-slate-500">{t('可使用 CLI 从终端调用，也可通过 MCP 让 Agent 直接选择工具。两种方式提供相同的项目资料、记忆和代码查询能力。')}</p>
        <div className="mt-4 grid min-w-0 gap-4 lg:grid-cols-2">
          <div className="min-w-0 rounded-xl border border-slate-200 bg-slate-50/60 p-4">
            <h3 className="font-semibold">{t('CLI：通过终端调用')}</h3>
            <p className="mb-3 mt-2 text-sm leading-6 text-slate-500">{t('先查看工具目录和检索说明，再用 --project 或输入中的 projectCode 指定项目；已有工作区绑定时也可沿用默认项目。')}</p>
            <CopyCommand command={`tsp tools list\ntsp memory guidance\ntsp tools call ${projectCode ? `read_code_catalog --project ${projectCode}` : 'list_projects'}`} />
          </div>
          <McpConnectionGuide projectCode={projectCode} />
        </div>
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
          <div><dt className="font-semibold">{t('MCP 没有读到当前项目')}</dt><dd className="mt-1 text-slate-500">{t('先调用 get_connection_context 核对账号和默认项目。没有默认项目时用 list_projects 发现项目，再在工具调用中传入 projectCode。修改启动参数、默认工作区绑定或登录账号后，重启 MCP 连接。')}</dd></div>
          <div><dt className="font-semibold">{t('需要自动整理会话')}</dt><dd className="mt-1 text-slate-500">{t('MCP 提供按需调用的工具。会话自动采集需另行配置对应宿主的采集接入，不能仅凭 MCP 已连接判断聊天已保存。')}</dd></div>
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

function LocalAgentSetup({ projectCode }: { projectCode?: string }) {
  const [harness, setHarness] = useState<(typeof localHarnesses)[number]['value']>('codex');
  const [capture, setCapture] = useState(false);
  const captureAvailable = harness !== 'claudecode';
  const connect = projectCode ? `tsp agent connect --harness ${harness} --project ${projectCode}${capture && captureAvailable ? ' --capture' : ''}` : null;

  return <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm" aria-labelledby="local-agent-setup-title">
    <h2 id="local-agent-setup-title" className="text-base font-bold">4. {t('配置本地 Agent')}</h2>
    <p className="mt-2 text-sm leading-6 text-slate-600">{t('安装并授权 CLI 后，在实际项目工作区根目录执行下方命令。记忆可查询，任务协作遵循项目权限。')}</p>
    <label className="ui-field-label mt-3 block max-w-xs">{t('Agent 宿主')}
      <select className="form-control mt-2" value={harness} onChange={event => {
        const selected = localHarnesses.find(option => option.value === event.target.value);
        if (selected) { setHarness(selected.value); setCapture(false); }
      }}>{localHarnesses.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
    </label>
    {captureAvailable ? <label className="mt-3 flex items-start gap-2 text-sm text-slate-700">
      <input type="checkbox" className="mt-1 accent-cyan-700" checked={capture} disabled={!projectCode} onChange={event => setCapture(event.target.checked)} />
      <span>{t('启用当前工作区的新会话采集')}</span>
    </label> : <p className="mt-3 text-sm text-slate-600">{t('Claude Code 可配置 MCP。会话采集暂未开放。')}</p>}
    {capture && captureAvailable && <p className="mt-2 text-xs leading-5 text-slate-600">{t('先用 tsp project current 核对本机已绑定到这个项目。配置后重开宿主，用新会话验证。')}
      {harness === 'codex' && <> {t('Codex 需在 /hooks 中审阅并信任采集定义。')}</>}</p>}
    {connect ? <div className="mt-3"><CopyCommand command={connect} /></div>
      : <p className="mt-3 text-sm text-slate-600">{t('先在页首选择一个已启用项目，再生成本地接入命令。')}</p>}
  </section>;
}

function McpConnectionGuide({ projectCode }: { projectCode?: string }) {
  const projectArgs = projectCode ? ['--project', projectCode] : [];
  const configurations = [
    { platform: 'Windows', server: { command: 'cmd', args: ['/d', '/c', 'tsp', 'mcp', ...projectArgs] } },
    { platform: 'macOS / Linux', server: { command: 'tsp', args: ['mcp', ...projectArgs] } },
  ];
  return <div className="min-w-0 rounded-xl border border-cyan-200 bg-cyan-50/40 p-4">
    <h3 className="font-semibold">{t('MCP：在 Agent 内调用工具')}</h3>
    <p className="mt-2 text-sm leading-6 text-slate-600">{t('在宿主中添加本机 stdio MCP 服务。以下为支持 mcpServers 的客户端配置示例，其他宿主按其配置格式填写相同启动命令。')}</p>
    <p className="mt-3 rounded-lg border border-cyan-200 bg-white/80 p-3 text-sm leading-6 text-slate-700"><strong>{t('项目选择')}</strong><br />{projectCode ? t('下面的配置已把所选项目设为默认项目。单次调用仍可用 projectCode 指定其他有权限的项目。') : t('不设置工作目录或项目也能启动 MCP。先调用 get_connection_context 和 list_projects，再传入 projectCode 读取具体项目。')}</p>
    {configurations.map(configuration => <details key={configuration.platform} className="mt-3 rounded-lg border border-slate-200 bg-white p-3">
      <summary className="cursor-pointer text-sm font-semibold">{configuration.platform}</summary>
      <div className="mt-3"><CopyCommand command={JSON.stringify({ mcpServers: { team_synergy: configuration.server } }, null, 2)} /></div>
    </details>)}
    <p className="mt-3 text-xs leading-5 text-slate-600">{t('启用后检查工具列表：')}</p>
    <ul className="mt-1 space-y-1 text-xs leading-5 text-slate-600"><li><code>get_connection_context / list_projects</code> · {t('检查账号并发现项目')}</li><li><code>read_memory_brief / search_memory</code> · {t('按问题读取记忆')}</li><li><code>list_project_materials / read_project_material</code> · {t('查目录并读取项目资料')}</li><li><code>read_code_catalog / query_code_graph</code> · {t('定位代码背景与来源')}</li></ul>
    <p className="mt-3 text-xs leading-5 text-slate-600">{t('DSH 使用原生 profile 配置。Windows 宿主若无法启动示例命令，请改用本机 Node 可执行文件和已安装 CLI 入口的绝对路径。')}</p>
  </div>;
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
