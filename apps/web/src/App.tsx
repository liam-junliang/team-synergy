import { AdminNavigation } from './AdminNavigation';
import { AccountClosurePanel } from './AccountClosurePanel';
import { useProjectAccess } from './useProjectAccess';
import { t, getLocale, formatDateTime } from './i18n.ts';
import { useLocale } from './useLocale';
import LanguageSwitcher from './LanguageSwitcher';
import { ProjectSwitcher } from './ProjectSwitcher';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Component, lazy, Suspense, useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { cancelTask, getProject, hasWebAuthToken, listFeatures, listMembers, listTasks, getTask, logoutWebSession, restoreWebSession, storedAuthUser, taskHistory, updateTaskContract, type AuthUser, type Feature, type Member, type TaskDetail as TaskDetailData, type TaskSummary, type UpdateTaskContractInput } from './api';
import { STATUS_META, BOARD_COLUMNS, PROFILE_META, SOURCE_META, isStale } from './status';
import { agentWorkspacePath, safeAgentReturnPath, projectWorkspacePath, workspacePathAfterLogin, type ProjectSection, type WorkspaceRoute } from './workspaceRouting';
import { listenWorkspaceNavigation, navigateWorkspace, readWorkspaceRoute } from './workspaceNavigation';
import { LoginPage } from './LoginPage';
import { PasswordChangePage } from './PasswordChangePage';
import { ProjectDisplayNamesProvider, useProjectDisplayNames } from './ProjectDisplayNames';
import { summarizeTaskBrief } from './taskCardSummary';
import { DEFAULT_TASK_BOARD_FILTERS, filterBoardTasks, sortBoardTasks, type TaskBoardFilters } from './taskBoardFilters';
import { PersonSearchSelect } from './PersonSearchSelect';
import { TASK_BOARD_REFRESH_INTERVAL_MS } from './queryPolicy';

const TaskDetail = lazy(() => import('./TaskDetail').then((module) => ({ default: module.TaskDetail })));
const RequirementsWorkbench = lazy(() => import('./RequirementsWorkbench').then((module) => ({ default: module.RequirementsWorkbench })));
const DesignWorkbench = lazy(() => import('./DesignWorkbench').then((module) => ({ default: module.DesignWorkbench })));
const ProjectPlanWorkbench = lazy(() => import('./ProjectPlanWorkbench').then((module) => ({ default: module.ProjectPlanWorkbench })));
const DefectsWorkbench = lazy(() => import('./DefectsWorkbench').then((module) => ({ default: module.DefectsWorkbench })));
const TestingWorkbench = lazy(() => import('./TestingWorkbench').then((module) => ({ default: module.TestingWorkbench })));
const AdminWorkspace = lazy(() => import('./AdminWorkspace').then((module) => ({ default: module.AdminWorkspace })));
const TeamsWorkspace = lazy(() => import('./TeamsWorkspace').then((module) => ({ default: module.TeamsWorkspace })));
const ProjectDocumentsWorkbench = lazy(() => import('./ProjectDocumentsWorkbench').then((module) => ({ default: module.ProjectDocumentsWorkbench })));
const ProjectHandoversWorkbench = lazy(() => import('./ProjectHandoversWorkbench').then((module) => ({ default: module.ProjectHandoversWorkbench })));
const ProjectWorkspace = lazy(() => import('./ProjectWorkspace').then((module) => ({ default: module.ProjectWorkspace })));
const AgentWorkspace = lazy(() => import('./AgentWorkspace').then((module) => ({ default: module.AgentWorkspace })));

const TASK_CARD_BRIEF_STYLE: CSSProperties = {
  display: '-webkit-box',
  overflow: 'hidden',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  overflowWrap: 'anywhere',
  wordBreak: 'break-word',
};

/**
 * 项目任务看板（TASK-112/219）：
 * - 独立路径页面（/projects/:code/...），支持直达、刷新与前进后退
 * - 看板卡片按 Feature 阶段分组
 * - 任务详情点击后弹窗（不占用版面）
 * - 数据源：core-api（CLI/Agent 经 HTTP 同步的状态即时可见，10s 轮询）
 */

// ---- 轻量 History API 路由（不引入路由库） ----
export const PROJECT_VIEWS: Array<{ id: ProjectSection; label: string }> = [
  { id: 'overview', label: '项目' },
  { id: 'documents', label: '文档' },
  { id: 'plan', label: '计划' },
  { id: 'requirements', label: '需求' },
  { id: 'design', label: '设计' },
  { id: 'board', label: '任务' },
  { id: 'testing', label: '测试' },
  { id: 'defects', label: '缺陷' },
  { id: 'handovers', label: '交接' },
];

function useWorkspaceRoute(): WorkspaceRoute {
  const [route, setRoute] = useState<WorkspaceRoute>(() => readWorkspaceRoute(window.location));
  useEffect(() => listenWorkspaceNavigation(setRoute), []);
  return route;
}

/** 错误边界：单个页面崩溃不影响导航（TASK-219 AC-5 防御） */
function ErrorBoundary({ children }: { children: ReactNode }) {
  const [error, setError] = useState<Error | null>(null);
  if (error) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <div className="text-sm font-semibold text-rose-700">{t("页面渲染出错")}</div>
        <pre className="max-w-full overflow-auto rounded-lg bg-slate-100 p-3 text-left text-xs text-slate-600">{error.message}</pre>
        <button onClick={() => setError(null)} className="ui-button ui-button-secondary ui-button-compact">{t("重试")}</button>
      </div>
    );
  }
  return <CatchBoundary onError={setError}>{children}</CatchBoundary>;
}

class CatchBoundary extends Component<{ onError: (e: Error) => void; children: ReactNode }> {
  componentDidCatch(error: Error) {
    this.props.onError(error);
  }
  render() {
    return this.props.children;
  }
}

export function TaskCard({ task, onSelect }: { task: TaskSummary; onSelect: () => void }) {
  const meta = STATUS_META[task.status] ?? { label: task.status, color: 'bg-slate-200' };
  const { memberName } = useProjectDisplayNames();
  const assignee = task.assignee_code ? memberName(task.assignee_code) : null;
  const briefSummary = summarizeTaskBrief(task.brief);
  const taskTime = task.status === 'closed'
    ? task.completed_at ?? task.created_at
    : task.status === 'cancelled'
      ? task.cancelled_at ?? task.created_at
      : task.created_at;
  const taskTimeLabel = task.status === 'closed' ? t("完成") : task.status === 'cancelled' ? t("取消") : t("创建");
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={t("查看任务：{p0}", { p0: task.title })}
      className="group flex w-full min-w-0 flex-col gap-2.5 overflow-hidden rounded-xl border border-slate-200 bg-white p-3 text-left shadow-sm transition duration-150 hover:-translate-y-px hover:border-cyan-300 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 focus-visible:ring-offset-2"
    >
      <span className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
        <span className="min-w-0">
          <span className="block text-sm font-semibold leading-5 text-slate-800 [overflow-wrap:anywhere]">
            {task.title}
          </span>
          {briefSummary && (
            <span className="mt-1.5 block text-xs leading-5 text-slate-500 [overflow-wrap:anywhere]" style={TASK_CARD_BRIEF_STYLE}>
              {briefSummary}
            </span>
          )}
        </span>
        <span
          title={t(meta.label)}
          className={`inline-flex max-w-[7rem] shrink-0 items-center self-start truncate whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold leading-4 ${meta.color}`}
        >
          {t(meta.label)}
        </span>
      </span>

      <span className="flex w-full min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-slate-500">
        <code title={t("任务编码：{p0}", { p0: task.code })} className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-slate-400">{task.code}</code>
        <span>{t(PROFILE_META[task.profile] ?? task.profile)}</span>
        <span aria-hidden="true" className="text-slate-300">·</span>
        <span>{t(SOURCE_META[task.source] ?? task.source)}</span>
      </span>

      <span className="flex w-full min-w-0 items-center gap-2 border-t border-slate-100 pt-2">
        <span className="min-w-0 flex-1 truncate text-xs text-slate-500" title={task.assignee_code ?? t("未分派")}>
          {assignee ? <>{t("负责人 ")}<strong className="font-semibold text-slate-600">{assignee}</strong></> : t("未分派")}
        </span>
        {taskTime && (
          <time dateTime={taskTime} title={formatDateTime(taskTime)} className="shrink-0 text-[10px] tabular-nums text-slate-400">
            {taskTimeLabel} {new Intl.DateTimeFormat(getLocale(), { month: '2-digit', day: '2-digit' }).format(new Date(taskTime))}
          </time>
        )}
      </span>
    </button>
  );
}

type BoardSummaryColumn = {
  id: string;
  title: string;
  count: number;
};

const BOARD_STAGE_COLORS: Record<string, string> = {
  backlog: 'bg-slate-400',
  todo: 'bg-indigo-500',
  doing: 'bg-blue-500',
  review: 'bg-amber-500',
  done: 'bg-emerald-500',
};

export function BoardInsights({
  total,
  completed,
  columns,
  updatedAt,
  isFetching,
}: {
  total: number;
  completed: number;
  columns: BoardSummaryColumn[];
  updatedAt: number;
  isFetching: boolean;
}) {
  const completionRate = total === 0 ? 0 : Math.round((completed / total) * 100);
  const updatedDate = updatedAt > 0 ? new Date(updatedAt) : null;
  const updatedLabel = updatedDate
    ? new Intl.DateTimeFormat(getLocale(), { hour: '2-digit', minute: '2-digit', hour12: false }).format(updatedDate)
    : t("等待首次同步");

  return (
    <aside aria-label={t("看板交付概览")} className="w-[280px] shrink-0 space-y-3">
      <section className="overflow-hidden rounded-2xl bg-slate-900 p-4 text-white shadow-sm">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-bold tracking-[0.16em] text-cyan-300">{t("交付概览")}</p>
            <p className="mt-1 text-xs text-slate-400">{t("团队任务完成进度")}</p>
          </div>
          <span className="rounded-full bg-cyan-400/15 px-2.5 py-1 text-xs font-bold text-cyan-200">{completionRate}%</span>
        </div>
        <div className="mt-6 flex items-end gap-1.5">
          <strong className="text-4xl font-bold tracking-tight">{completed}</strong>
          <span className="mb-1 text-sm text-slate-400">/ {total}{t(" 已完成")}</span>
        </div>
        <div
          role="progressbar"
          aria-label={t("任务完成率")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={completionRate}
          className="mt-4 h-1.5 overflow-hidden rounded-full bg-white/10"
        >
          <div className="h-full rounded-full bg-cyan-400 transition-[width]" style={{ width: `${completionRate}%` }} />
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-bold text-slate-800">{t("阶段分布")}</h2>
            <p className="mt-0.5 text-[11px] text-slate-400">{t("当前任务所处阶段")}</p>
          </div>
          <span className="rounded-md bg-slate-100 px-2 py-1 text-[11px] font-semibold text-slate-500">{t('阶段：{count}', { count: columns.length })}</span>
        </div>
        <div className="mt-4 space-y-3">
          {columns.map((column) => {
            const share = total === 0 ? 0 : Math.round((column.count / total) * 100);
            const color = BOARD_STAGE_COLORS[column.id] ?? 'bg-slate-400';
            return (
              <div key={column.id}>
                <div className="mb-1.5 flex items-center justify-between gap-3 text-xs">
                  <span className="flex min-w-0 items-center gap-2 text-slate-600">
                    <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${color}`} />
                    <span className="truncate">{t(column.title)}</span>
                  </span>
                  <strong className="font-mono text-slate-700">{column.count}</strong>
                </div>
                <div className="h-1 overflow-hidden rounded-full bg-slate-100">
                  <div className={`h-full rounded-full ${color}`} style={{ width: `${share}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="rounded-2xl border border-cyan-100 bg-cyan-50/70 p-4">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white text-cyan-700 shadow-sm" aria-hidden="true">
            <svg viewBox="0 0 24 24" className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" strokeWidth="1.8">
              <path strokeLinecap="round" strokeLinejoin="round" d="M20 7h-5V2M4 17h5v5m10.2-11A8 8 0 0 0 5.4 7.2L4 9m16 6-1.4 1.8A8 8 0 0 1 4.8 13" />
            </svg>
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-bold text-slate-800">{t("数据同步")}</h2>
              <span className="flex items-center gap-1 text-[10px] font-semibold text-emerald-700">
                <span className={`h-1.5 w-1.5 rounded-full bg-emerald-500 ${isFetching ? 'animate-pulse' : ''}`} />
                {isFetching ? t("同步中") : t("已连接")}
              </span>
            </div>
            <p className="mt-1 text-xs font-semibold text-cyan-800">core-api</p>
            <p className="mt-0.5 text-[11px] leading-4 text-slate-500">{t("CLI / Agent 状态每 10 秒同步")}</p>
            <p className="mt-2 text-[10px] text-slate-400">{t("最近更新")}{' '}
              {updatedDate ? <time dateTime={updatedDate.toISOString()}>{updatedLabel}</time> : updatedLabel}
            </p>
          </div>
        </div>
      </section>
    </aside>
  );
}

export default function App() {
  useLocale();
  const route = useWorkspaceRoute();
  const { projectCode } = route;
  const queryClient = useQueryClient();
  const [accountOpen, setAccountOpen] = useState(false);
  const [session, setSession] = useState<AuthUser | null>(() => storedAuthUser());
  const [checkingSession, setCheckingSession] = useState(() => hasWebAuthToken());
  const view = session?.is_system_admin && route.view === 'teams' ? 'admin' : route.view;
  const inAdminConsole = Boolean(session?.is_system_admin && (view === 'admin' || view === 'account'));
  useEffect(() => {
    if (!checkingSession && session?.is_system_admin && route.view === 'teams') navigateWorkspace('/admin/teams', { replace: true });
  }, [checkingSession, session, route.view]);
  const projectQuery = useQuery({
    queryKey: ['project', projectCode],
    queryFn: () => getProject(projectCode as string),
    enabled: Boolean(projectCode && session),
  });

  useEffect(() => {
    let active = true;
    const expire = () => {
      queryClient.clear();
      setSession(null);
      setCheckingSession(false);
    };
    window.addEventListener('acp:auth-expired', expire);
    if (hasWebAuthToken()) {
      void restoreWebSession()
        .then((user) => { if (active) setSession(user); })
        .catch(() => { if (active) setSession(null); })
        .finally(() => { if (active) setCheckingSession(false); });
    } else {
      setCheckingSession(false);
    }
    return () => {
      active = false;
      window.removeEventListener('acp:auth-expired', expire);
    };
  }, [queryClient]);

  async function logout() {
    try {
      await logoutWebSession();
    } finally {
      queryClient.clear();
      setSession(null);
      navigateWorkspace('/teams', { replace: true });
    }
  }

  if (checkingSession) return <div className="grid min-h-screen place-items-center bg-slate-950 text-sm text-slate-400">{t("正在恢复登录状态…")}</div>;
  if (!session) return <LoginPage onLogin={(user) => { queryClient.clear(); setSession(user); navigateWorkspace(workspacePathAfterLogin(window.location.href, user.is_system_admin), { replace: true }); }} />;
  if (session.must_change_password) return <PasswordChangePage user={session} onChanged={(user) => { queryClient.clear(); setSession(user); navigateWorkspace(workspacePathAfterLogin(window.location.href, user.is_system_admin), { replace: true }); }} onLogout={() => void logout()} />;

  return (
    <ProjectDisplayNamesProvider projectCode={projectCode}>
    <div className="flex h-screen min-w-[320px] flex-col overflow-hidden">
      <header className="z-10 grid shrink-0 grid-cols-1 items-center gap-x-4 gap-y-2 border-b border-slate-200 bg-slate-950 px-4 py-2.5 text-white shadow-sm sm:grid-cols-[minmax(0,1fr)_auto] lg:px-6 xl:grid-cols-[auto_minmax(0,1fr)_auto]">
        <a href={session.is_system_admin ? "/admin/teams" : "/teams"} className="col-start-1 row-start-1 flex items-center gap-2 text-left" aria-label={t(session.is_system_admin ? "系统管理" : "返回团队与项目")}>
          <span className="grid h-8 w-8 grid-cols-2 gap-1 rounded-lg bg-cyan-600 p-1.5" aria-hidden="true"><i className="rounded-sm bg-white" /><i className="rounded-sm bg-cyan-200" /><i className="rounded-sm bg-cyan-200" /><i className="rounded-sm bg-white" /></span>
          <span><strong className="block text-sm leading-tight">Team Synergy</strong><span className="block text-[9px] font-semibold tracking-[0.16em] text-slate-400">{inAdminConsole ? 'SYSTEM ADMIN' : 'TEAM WORKSPACE'}</span></span>
        </a>
        <nav className="col-start-1 row-start-3 flex min-w-0 flex-wrap sm:col-span-2 sm:row-start-2 xl:col-span-1 xl:col-start-2 xl:row-start-1" aria-label={t("工作台导航")}>
          {inAdminConsole ? <AdminNavigation tab={route.adminTab ?? (view === 'admin' ? 'teams' : undefined)} /> : view === 'agent' ? <>
            <a href={session.is_system_admin ? '/admin/teams' : safeAgentReturnPath(route.agentReturnPath, projectCode)} className="shrink-0 border-b-2 border-transparent px-3 py-2 text-sm font-medium text-slate-400 hover:text-slate-100">← {t(session.is_system_admin ? '系统管理' : projectCode ? '返回项目' : '团队与项目')}</a>
            {route.agentTab !== 'authorize' && (['connect', 'skills'] as const).map(tab => <a key={tab} href={agentWorkspacePath(tab, route)} aria-current={route.agentTab === tab ? 'page' : undefined} className={`shrink-0 border-b-2 px-3 py-2 text-sm font-medium transition ${route.agentTab === tab ? 'border-cyan-400 text-white' : 'border-transparent text-slate-400 hover:text-slate-100'}`}>{t(tab === 'connect' ? 'CLI 接入' : '技能库')}</a>)}
          </> : <>
          <a href="/teams" aria-current={view === 'teams' ? 'page' : undefined} className={`shrink-0 border-b-2 px-3 py-2 text-sm font-medium transition ${view === 'teams' ? 'border-cyan-400 text-white' : 'border-transparent text-slate-400 hover:text-slate-100'}`}>{t("团队与项目")}</a>
        {projectCode && PROJECT_VIEWS.map((item) => (
            <a key={item.id} href={projectWorkspacePath(projectCode, item.id)} aria-current={view === item.id ? 'page' : undefined} className={`shrink-0 border-b-2 px-3 py-2 text-sm font-medium transition ${view === item.id ? 'border-cyan-400 text-white' : 'border-transparent text-slate-400 hover:text-slate-100'}`}>{t(item.label)}</a>
          ))}
          </>}
        </nav>
        <div className="col-start-1 row-start-2 flex w-full max-w-full items-center justify-self-end gap-2 text-xs sm:col-start-2 sm:row-start-1 sm:w-auto xl:col-start-3">
          {!inAdminConsole && <a href={agentWorkspacePath('connect', { projectCode, agentReturnPath: view === 'agent' ? route.agentReturnPath : `${window.location.pathname}${window.location.search}` })} aria-label={t('Agent 工作台')} title={t('Agent 工作台')} aria-current={view === 'agent' ? 'page' : undefined} className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg border outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 ${view === 'agent' ? 'border-cyan-500 bg-cyan-500/15 text-cyan-300' : 'border-slate-700 bg-slate-900 text-slate-300 hover:border-cyan-500 hover:text-cyan-300'}`}><svg aria-hidden="true" viewBox="0 0 24 24" className="h-4.5 w-4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="7" width="14" height="13" rx="3" /><path d="M12 3v4M9 12v1m6-1v1m-6 4h6M2 11v5m20-5v5" /><circle cx="12" cy="2.5" r=".5" /></svg></a>}
          {!inAdminConsole && (projectCode || view === 'agent') && <ProjectSwitcher route={route} currentProjectName={projectQuery.data?.name} />}
          <LanguageSwitcher />
          <button type="button" onClick={() => setAccountOpen(true)} title={t("我的账号")} aria-label={t("我的账号")} className="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1">
            <span className="grid h-7 w-7 place-items-center rounded-md bg-cyan-600 font-bold text-white" aria-hidden="true">{session.display_name.trim().charAt(0).toUpperCase()}</span>
            <span className="hidden text-left md:block"><strong className="block max-w-28 truncate text-xs text-slate-100">{session.display_name}</strong><code className="block max-w-28 truncate text-[10px] text-slate-400">@{session.account}</code></span>
          </button>
          <button type="button" onClick={() => void logout()} className="rounded-lg border border-slate-700 px-2.5 py-2 text-slate-300 transition hover:border-rose-500 hover:text-rose-300">{t("退出")}</button>
        </div>
      </header>
      {accountOpen && <AccountClosurePanel onClose={() => setAccountOpen(false)} onClosed={() => { setAccountOpen(false); queryClient.clear(); setSession(null); navigateWorkspace('/teams', { replace: true }); }} />}
      <ErrorBoundary>
        {view === 'admin' && <Suspense fallback={<div className="flex flex-1 items-center justify-center text-sm text-slate-500">{t('正在加载…')}</div>}><AdminWorkspace tab={route.adminTab} isSystemAdmin={session.is_system_admin} /></Suspense>}
        {view === 'agent' && <Suspense fallback={<div className="flex flex-1 items-center justify-center text-sm text-slate-500">{t('正在加载…')}</div>}><AgentWorkspace key={`${projectCode ?? ''}:${route.teamCode ?? ''}:${route.agentTab}`} route={route} user={session} /></Suspense>}
        {view === 'teams' && <Suspense fallback={<div className="flex flex-1 items-center justify-center text-sm text-slate-500">{t("正在加载团队…")}</div>}><TeamsWorkspace /></Suspense>}
        {projectCode && view === 'overview' && <Suspense fallback={<div className="flex flex-1 items-center justify-center text-sm text-slate-500">{t("正在加载项目…")}</div>}><ProjectWorkspace key={projectCode} projectCode={projectCode} tab={route.projectTab} documentCode={route.documentCode} /></Suspense>}
        {projectCode && view === 'board' && <TeamBoard key={projectCode} projectCode={projectCode} />}
        {projectCode && view === 'requirements' && <Suspense fallback={<div className="flex flex-1 items-center justify-center text-sm text-slate-500">{t("正在加载需求…")}</div>}><RequirementsWorkbench key={projectCode} projectCode={projectCode} documentCode={route.documentCode} initialTab={route.requirementsTab} /></Suspense>}
        {projectCode && view === 'design' && <Suspense fallback={<div className="flex flex-1 items-center justify-center text-sm text-slate-500">{t("正在加载设计原型…")}</div>}><DesignWorkbench key={projectCode} projectCode={projectCode} /></Suspense>}
        {projectCode && view === 'plan' && <Suspense fallback={<div className="flex flex-1 items-center justify-center text-sm text-slate-500">{t("正在加载计划…")}</div>}><ProjectPlanWorkbench key={projectCode} projectCode={projectCode} /></Suspense>}
        {projectCode && view === 'testing' && <Suspense fallback={<div className="flex flex-1 items-center justify-center text-sm text-slate-500">{t("正在加载…")}</div>}><TestingWorkbench key={projectCode} projectCode={projectCode} tab={route.testingTab} itemCode={route.testingCode} /></Suspense>}
        {projectCode && view === 'defects' && <Suspense fallback={<div className="flex flex-1 items-center justify-center text-sm text-slate-500">{t("正在加载…")}</div>}><DefectsWorkbench key={projectCode} projectCode={projectCode} /></Suspense>}
        {projectCode && view === 'documents' && <Suspense fallback={<div className="flex flex-1 items-center justify-center text-sm text-slate-500">{t("正在加载项目文档…")}</div>}><ProjectDocumentsWorkbench key={`${projectCode}:${route.documentCode ?? ''}:${route.folderCode ?? ''}:${route.createDocument ?? false}`} projectCode={projectCode} documentCode={route.documentCode} folderCode={route.folderCode} createDocument={route.createDocument} /></Suspense>}
        {projectCode && view === 'handovers' && <Suspense fallback={<div className="flex flex-1 items-center justify-center text-sm text-slate-500">{t("正在加载交接记录…")}</div>}><ProjectHandoversWorkbench key={projectCode} projectCode={projectCode} handoverCode={route.handoverCode} /></Suspense>}
        {view === 'account' && <main className="min-h-0 flex-1 overflow-y-auto bg-slate-50 p-5 lg:p-7"><section className="mx-auto max-w-2xl rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"><h1 className="text-xl font-bold text-slate-900">{t('我的账号')}</h1><p className="mt-4 text-sm text-slate-700">{session.display_name} <span className="text-slate-500">@{session.account}</span></p><button type="button" className="ui-button ui-button-secondary mt-5" onClick={() => setAccountOpen(true)}>{t('管理我的账号')}</button></section></main>}
      </ErrorBoundary>
    </div>
    </ProjectDisplayNamesProvider>
  );
}

/** 任务详情弹窗（点击卡片打开，不占用版面；TASK-219 AC-3） */
const PRE_EXECUTION_STATUSES = ['draft', 'ready', 'assigned'];

function TaskContractEditor({ task, onCancel, onSave, saving, error }: {
  task: TaskDetailData;
  onCancel: () => void;
  onSave: (input: UpdateTaskContractInput) => void;
  saving: boolean;
  error: string | null;
}) {
  const [title, setTitle] = useState(task.title);
  const [brief, setBrief] = useState(task.brief ?? '');
  const [acceptance, setAcceptance] = useState(task.acceptance.length > 0 ? task.acceptance : [{ id: 'AC-1', text: '' }]);
  const [validationSeams, setValidationSeams] = useState(task.validation_seams.join('\n'));
  const [writablePaths, setWritablePaths] = useState((task.scope?.writable_paths ?? []).join('\n'));
  const canSave = title.trim().length > 0 && acceptance.length > 0 && acceptance.every((item) => item.id.trim() && item.text.trim());
  return (
    <form
      aria-label={t("编辑任务契约")}
      className="space-y-5 p-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSave) return;
        onSave({
          base_snapshot: task.base_snapshot,
          title: title.trim(),
          brief: brief.trim(),
          acceptance: acceptance.map((item) => ({ id: item.id.trim(), text: item.text.trim() })),
          validation_seams: validationSeams.split('\n').map((item) => item.trim()).filter(Boolean),
          scope: writablePaths.trim() ? { writable_paths: writablePaths.split('\n').map((item) => item.trim()).filter(Boolean) } : null,
        });
      }}
    >
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <label className="block text-xs font-semibold text-slate-600">{t("任务标题")}<input value={title} onChange={(event) => setTitle(event.target.value)} className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm text-slate-800 outline-none focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100" />
          </label>
          <label className="block text-xs font-semibold text-slate-600">{t("执行简报")}<textarea value={brief} onChange={(event) => setBrief(event.target.value)} rows={10} className="mt-2 w-full resize-y rounded-xl border border-slate-200 px-3 py-2.5 font-mono text-xs leading-6 text-slate-700 outline-none focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100" />
          </label>
        </div>
        <div className="space-y-4">
          <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between"><h3 className="text-xs font-bold text-slate-700">{t("验收标准")}</h3><button type="button" onClick={() => setAcceptance((items) => [...items, { id: `AC-${items.length + 1}`, text: '' }])} className="text-xs font-semibold text-cyan-700 hover:text-cyan-900">{t("新增")}</button></div>
            <div className="mt-3 space-y-3">
              {acceptance.map((item, index) => (
                <div key={`${item.id}-${index}`} className="rounded-xl bg-slate-50 p-2.5">
                  <div className="flex gap-2"><input aria-label={t("验收标准 {p0} 编号", { p0: index + 1 })} value={item.id} onChange={(event) => setAcceptance((items) => items.map((current, currentIndex) => currentIndex === index ? { ...current, id: event.target.value } : current))} className="w-16 rounded-lg border border-slate-200 px-2 py-1.5 text-xs font-semibold" /><button type="button" aria-label={t("删除验收标准 {p0}", { p0: index + 1 })} disabled={acceptance.length === 1} onClick={() => setAcceptance((items) => items.filter((_, currentIndex) => currentIndex !== index))} className="ml-auto text-[11px] text-rose-600 disabled:text-slate-300">{t("删除")}</button></div>
                  <textarea aria-label={t("验收标准 {p0} 内容", { p0: index + 1 })} value={item.text} onChange={(event) => setAcceptance((items) => items.map((current, currentIndex) => currentIndex === index ? { ...current, text: event.target.value } : current))} rows={2} className="mt-2 w-full resize-y rounded-lg border border-slate-200 px-2 py-1.5 text-xs leading-5" />
                </div>
              ))}
            </div>
          </section>
          <label className="block rounded-2xl border border-slate-200 bg-white p-4 text-xs font-semibold text-slate-600 shadow-sm">{t("验证接缝 ")}<span className="font-normal text-slate-400">{t("（每行一个）")}</span><textarea value={validationSeams} onChange={(event) => setValidationSeams(event.target.value)} rows={3} className="mt-2 w-full rounded-lg border border-slate-200 px-2 py-1.5 font-mono text-[11px] font-normal" /></label>
          <label className="block rounded-2xl border border-slate-200 bg-white p-4 text-xs font-semibold text-slate-600 shadow-sm">{t("可写范围 ")}<span className="font-normal text-slate-400">{t("（每行一个）")}</span><textarea value={writablePaths} onChange={(event) => setWritablePaths(event.target.value)} rows={3} className="mt-2 w-full rounded-lg border border-slate-200 px-2 py-1.5 font-mono text-[11px] font-normal" /></label>
        </div>
      </div>
      {error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>}
      <div className="flex justify-end gap-2 border-t border-slate-200 pt-4"><button type="button" onClick={onCancel} className="ui-button ui-button-secondary">{t("返回详情")}</button><button type="submit" disabled={!canSave || saving} className="ui-button ui-button-strong">{saving ? t("保存中…") : t("保存修改")}</button></div>
    </form>
  );
}

function TaskDetailModal({ taskId, projectCode, onClose }: { taskId: string; projectCode: string; onClose: () => void }) {
  const detail = useQuery({ queryKey: ['task', taskId], queryFn: () => getTask(taskId), refetchInterval: TASK_BOARD_REFRESH_INTERVAL_MS });
  const history = useQuery({ queryKey: ['task-history', taskId], queryFn: () => taskHistory(taskId), refetchInterval: TASK_BOARD_REFRESH_INTERVAL_MS });
  const { canManage: canManageTask } = useProjectAccess(projectCode);
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const updateMutation = useMutation({
    mutationFn: (input: UpdateTaskContractInput) => updateTaskContract(taskId, input),
    onSuccess: (updated) => {
      queryClient.setQueryData(['task', taskId], updated);
      void queryClient.invalidateQueries({ queryKey: ['tasks', projectCode] });
      void queryClient.invalidateQueries({ queryKey: ['task-history', taskId] });
      setEditing(false);
    },
  });
  const cancelMutation = useMutation({
    mutationFn: () => cancelTask(taskId, { base_snapshot: detail.data?.base_snapshot ?? 0, reason: cancelReason.trim() || undefined }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tasks', projectCode] });
      onClose();
    },
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/55 p-0 backdrop-blur-[2px] sm:items-center sm:p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-detail-dialog-title"
        className="flex h-[min(94vh,900px)] w-full flex-col overflow-hidden rounded-t-2xl border border-slate-200 bg-slate-50 shadow-2xl sm:h-auto sm:max-h-[88vh] sm:max-w-4xl sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="z-10 flex shrink-0 items-center justify-between gap-4 border-b border-slate-200 bg-white/95 px-4 py-3 backdrop-blur sm:px-5">
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-cyan-50 text-cyan-700 ring-1 ring-cyan-100" aria-hidden="true">
              <span className="h-3.5 w-3.5 rounded-sm border-2 border-current" />
            </span>
            <div className="min-w-0">
              <h1 id="task-detail-dialog-title" className="text-sm font-semibold text-slate-800">{t("任务详情")}</h1>
              <p className="text-[10px] text-slate-400">{t("任务上下文与交付记录")}</p>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-1.5">
          {canManageTask && detail.data && PRE_EXECUTION_STATUSES.includes(detail.data.status) && !editing && !confirmingCancel && <>
            <button type="button" onClick={() => setEditing(true)} className="ui-button ui-button-secondary hover:!border-cyan-300 hover:!bg-cyan-50/60 hover:!text-cyan-700">
              <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5 shrink-0"><path d="M13.5 3.5 16.5 6.5M4 16l.7-3.2L13.8 3.7a1.2 1.2 0 0 1 1.7 0l.8.8a1.2 1.2 0 0 1 0 1.7l-9.1 9.1L4 16Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>{t("编辑任务")}</button>
            <button type="button" onClick={() => setConfirmingCancel(true)} className="ui-button ui-button-danger">
              <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5 shrink-0"><path d="M6.5 6.5 13.5 13.5M13.5 6.5l-7 7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>{t("取消任务")}</button>
            <span aria-hidden="true" className="mx-0.5 h-5 w-px bg-slate-200" />
          </>}
          <button
            type="button"
            autoFocus
            onClick={onClose}
            aria-label={t("关闭详情")}
            title={t("关闭任务详情（Esc）")}
            className="ui-icon-button !border-transparent !bg-transparent !shadow-none active:scale-[0.96]"
          >
            <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="h-4 w-4 shrink-0 transition-colors">
              <path d="M5 5l10 10M15 5 5 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {detail.isLoading || history.isLoading ? <div className="grid min-h-64 place-items-center p-6 text-sm text-slate-400">{t("加载详情…")}</div> : detail.error || !detail.data ? (
          <div className="m-5 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{t("详情加载失败，请稍后重试。")}</div>
        ) : editing && canManageTask ? (
          <TaskContractEditor task={detail.data} onCancel={() => setEditing(false)} onSave={(input) => updateMutation.mutate(input)} saving={updateMutation.isPending} error={updateMutation.error instanceof Error ? updateMutation.error.message : null} />
        ) : confirmingCancel && canManageTask ? (
          <div className="grid min-h-72 place-items-center p-6"><section className="w-full max-w-lg rounded-2xl border border-rose-200 bg-white p-6 text-center shadow-sm"><div className="mx-auto grid h-11 w-11 place-items-center rounded-full bg-rose-50 text-lg text-rose-700">×</div><h2 className="mt-4 text-base font-bold text-slate-900">{t("取消这个任务？")}</h2><p className="mt-2 text-sm leading-6 text-slate-500">{t("任务会保留在看板“已取消”列和审计记录中，但不能再被领取或执行。")}</p><label className="mt-5 block text-left text-xs font-semibold text-slate-600">{t("取消原因（可选）")}<textarea value={cancelReason} onChange={(event) => setCancelReason(event.target.value)} rows={3} className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-normal outline-none focus:border-rose-300 focus:ring-2 focus:ring-rose-100" /></label>{cancelMutation.error instanceof Error && <p role="alert" className="mt-3 rounded-lg bg-rose-50 p-2 text-xs text-rose-700">{cancelMutation.error.message}</p>}<div className="mt-5 flex justify-end gap-2"><button type="button" onClick={() => setConfirmingCancel(false)} className="ui-button ui-button-secondary">{t("返回")}</button><button type="button" disabled={cancelMutation.isPending} onClick={() => cancelMutation.mutate()} className="ui-button ui-button-danger">{cancelMutation.isPending ? t("取消中…") : t("确认取消任务")}</button></div></section></div>
        ) : (
          (() => {
            const task = detail.data;
            const events = history.data ?? [];
            const lastEvent = events[0]?.timestamp;
            const stale = isStale(lastEvent);
            return (
              <Suspense fallback={<div className="grid min-h-64 place-items-center p-6 text-sm text-slate-400">{t("加载详情…")}</div>}>
              <TaskDetail
                task={task}
                events={events}
                stale={stale}
                staleHint={stale && lastEvent ? t("最后活动 {p0}（超过 24h）", { p0: new Date(lastEvent).toLocaleString() }) : undefined}
              />
              </Suspense>
            );
          })()
        )}
        </div>
      </div>
    </div>
  );
}

type TaskBoardFilterSetter = (update: TaskBoardFilters | ((current: TaskBoardFilters) => TaskBoardFilters)) => void;

export function collectTaskBoardFeatureOptions(features: Pick<Feature, 'code'>[], tasks: Pick<TaskSummary, 'feature_code'>[], featureName: (code?: string | null) => string) {
  return [...new Set([
    ...features.map((feature) => feature.code),
    ...tasks.map((task) => task.feature_code).filter((code): code is string => Boolean(code)),
  ])].sort((left, right) => featureName(left).localeCompare(featureName(right), getLocale()));
}

export function collectTaskBoardAssigneeOptions(members: Pick<Member, 'code'>[], tasks: Pick<TaskSummary, 'assignee_code'>[], memberName: (code?: string | null) => string) {
  return [...new Set([
    ...members.map((member) => member.code),
    ...tasks.map((task) => task.assignee_code).filter((code): code is string => Boolean(code)),
  ])].sort((left, right) => memberName(left).localeCompare(memberName(right), getLocale()));
}

export function TaskBoardControls({
  filters,
  setFilters,
  featureOptions,
  assigneeOptions,
  sourceOptions,
  featureName,
  memberName,
}: {
  filters: TaskBoardFilters;
  setFilters: TaskBoardFilterSetter;
  featureOptions: string[];
  assigneeOptions: string[];
  sourceOptions: string[];
  featureName: (code?: string | null) => string;
  memberName: (code?: string | null) => string;
}) {
  const [filterOpen, setFilterOpen] = useState(false);
  const [featureQuery, setFeatureQuery] = useState('');
  const selectFilterCount = [filters.featureCode, filters.assigneeCode, filters.source].filter(Boolean).length;
  const hasChanges = Boolean(filters.keyword || selectFilterCount > 0 || filters.timeOrder !== 'newest');
  const updateFilters = (patch: Partial<TaskBoardFilters>) => setFilters((current) => ({ ...current, ...patch }));
  const closeFilterPanel = () => {
    setFilterOpen(false);
  };
  const toggleFilterPanel = () => setFilterOpen((open) => !open);
  const clearChoiceFilters = () => {
    setFeatureQuery('');
    updateFilters({ featureCode: '', assigneeCode: '', source: '' });
  };
  const resetFilters = () => {
    setFeatureQuery('');
    setFilters(DEFAULT_TASK_BOARD_FILTERS);
  };
  const normalizedFeatureQuery = featureQuery.trim().toLocaleLowerCase(getLocale());
  const visibleFeatureOptions = featureOptions.filter((code) => !normalizedFeatureQuery || `${featureName(code)} ${code}`.toLocaleLowerCase(getLocale()).includes(normalizedFeatureQuery));

  return (
    <section aria-label={t("任务筛选与排序")} className="flex min-w-0 items-center justify-end gap-1.5">
      {hasChanges && <button type="button" aria-label={t("重置筛选与排序")} title={t("重置筛选与排序")} onClick={resetFilters} className="ui-icon-button !border-transparent !bg-transparent !shadow-none">↺</button>}
      <div className="group relative w-[250px] shrink-0">
        <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400 transition-colors group-focus-within:text-cyan-600"><circle cx="9" cy="9" r="5.5" stroke="currentColor" strokeWidth="1.5"/><path d="m13 13 3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
        <input aria-label={t("搜索任务")} value={filters.keyword} onChange={(event) => updateFilters({ keyword: event.target.value })} placeholder={t("搜索任务")} className="form-control form-control-compact border-slate-200 pl-8 pr-8 shadow-sm" />
        {filters.keyword && <button type="button" aria-label={t("清空搜索")} title={t("清空搜索")} onClick={() => updateFilters({ keyword: '' })} className="absolute right-1.5 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded text-xs text-slate-400 hover:bg-slate-100 hover:text-slate-700">×</button>}
      </div>

      <div className="relative shrink-0">
        {filterOpen && <button type="button" aria-label={t("关闭筛选面板")} className="fixed inset-0 z-20 cursor-default" onClick={closeFilterPanel} />}
        <button type="button" aria-expanded={filterOpen} aria-controls="task-board-filter-popover" onClick={toggleFilterPanel} className={`ui-button relative z-30 ${filterOpen || selectFilterCount > 0 ? 'border-cyan-300 bg-cyan-50 text-cyan-800' : 'ui-button-secondary'}`}>
          <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5"><path d="M3.5 5h13M6 10h8m-5.5 5h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>{t("筛选")}{selectFilterCount > 0 && <span className="grid h-4 min-w-4 place-items-center rounded-full bg-cyan-700 px-1 text-[9px] text-white">{selectFilterCount}</span>}
        </button>
        {filterOpen && (
          <div id="task-board-filter-popover" role="dialog" aria-label={t("筛选任务")} className="absolute right-0 top-10 z-30 w-[320px] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl shadow-slate-900/10">
            <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3"><h2 className="text-xs font-bold text-slate-800">{t("筛选任务")}</h2>{selectFilterCount > 0 && <button type="button" onClick={clearChoiceFilters} className="rounded-md px-2 py-1 text-xs font-semibold text-cyan-700 hover:bg-cyan-50 hover:text-cyan-900">{t("清除")}</button>}</div>
            <div className="space-y-4 px-4 py-3">
              <section aria-labelledby="feature-filter-label">
                <div className="mb-1.5 flex items-center justify-between"><h3 id="feature-filter-label" className="text-xs font-semibold leading-5 text-slate-700">Feature</h3>{filters.featureCode && <span title={featureName(filters.featureCode)} className="max-w-[210px] truncate text-xs font-semibold text-cyan-700">{featureName(filters.featureCode)}</span>}</div>
                <div className="relative"><svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400"><circle cx="9" cy="9" r="5.5" stroke="currentColor" strokeWidth="1.5"/><path d="m13 13 3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg><input aria-label={t("搜索 Feature")} value={featureQuery} onChange={(event) => setFeatureQuery(event.target.value)} placeholder={t("搜索 Feature 名称")} className="h-8 w-full rounded-lg border border-slate-200 bg-slate-50 pl-8 pr-2.5 text-xs text-slate-700 outline-none transition focus:border-cyan-400 focus:bg-white focus:ring-2 focus:ring-cyan-100" /></div>
                <div role="listbox" aria-label={t("按 Feature 筛选")} className="mt-1.5 max-h-36 space-y-0.5 overflow-y-auto rounded-lg border border-slate-100 p-1">
                  {!featureQuery && <button type="button" role="option" aria-selected={!filters.featureCode} onClick={() => updateFilters({ featureCode: '' })} className={`flex h-8 w-full items-center justify-between rounded-md px-2.5 text-left text-xs transition ${!filters.featureCode ? 'bg-slate-900 font-semibold text-white' : 'text-slate-600 hover:bg-slate-50'}`}><span>{t("全部 Feature")}</span>{!filters.featureCode && <span aria-hidden="true">✓</span>}</button>}
                  {visibleFeatureOptions.map((code) => <button key={code} type="button" role="option" aria-selected={filters.featureCode === code} onClick={() => updateFilters({ featureCode: code })} className={`flex min-h-8 w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition ${filters.featureCode === code ? 'bg-cyan-50 font-semibold text-cyan-800' : 'text-slate-600 hover:bg-slate-50'}`}><span className="min-w-0 flex-1 truncate">{featureName(code)}</span>{filters.featureCode === code && <span aria-hidden="true" className="shrink-0 text-cyan-700">✓</span>}</button>)}
                  {visibleFeatureOptions.length === 0 && <div className="px-2.5 py-3 text-center text-xs text-slate-400">{t("没有匹配的 Feature")}</div>}
                </div>
              </section>
              <fieldset>
                <legend className="mb-1.5 text-xs font-semibold leading-5 text-slate-700">{t("负责人")}</legend>
                <PersonSearchSelect
                  value={filters.assigneeCode}
                  options={assigneeOptions.map((code) => ({ code, display_name: memberName(code) }))}
                  onChange={(assigneeCode) => updateFilters({ assigneeCode })}
                  ariaLabel={t("按负责人筛选")}
                  placeholder={t("全部负责人")}
                  searchPlaceholder={t("搜索项目成员")}
                  emptyMessage={t("没有匹配的负责人")}
                  emptyOptionLabel={t("全部负责人")}
                />
              </fieldset>
              <fieldset><legend className="mb-1.5 text-xs font-semibold leading-5 text-slate-700">{t("来源")}</legend><div aria-label={t("按任务来源筛选")} className="flex flex-wrap gap-1.5"><button type="button" aria-pressed={!filters.source} onClick={() => updateFilters({ source: '' })} className={`min-h-7 rounded-lg border px-2.5 py-1 text-xs leading-4 transition ${!filters.source ? 'border-slate-900 bg-slate-900 font-semibold text-white' : 'border-slate-200 text-slate-600 hover:border-slate-300'}`}>{t("全部")}</button>{sourceOptions.map((source) => <button key={source} type="button" aria-pressed={filters.source === source} onClick={() => updateFilters({ source })} className={`min-h-7 rounded-lg border px-2.5 py-1 text-xs leading-4 transition ${filters.source === source ? 'border-cyan-600 bg-cyan-50 font-semibold text-cyan-800' : 'border-slate-200 text-slate-600 hover:border-slate-300'}`}>{t(SOURCE_META[source] ?? source)}</button>)}</div></fieldset>
            </div>
            <div className="border-t border-slate-100 bg-slate-50/70 px-4 py-2.5"><button type="button" onClick={closeFilterPanel} className="ui-button ui-button-strong ui-button-block">{t("完成")}</button></div>
          </div>
        )}
      </div>

      <button
        type="button"
        aria-label={t("时间排序：{p0}，点击切换为{p1}", { p0: filters.timeOrder === 'newest' ? t("时间倒序") : t("时间正序"), p1: filters.timeOrder === 'newest' ? t("时间正序") : t("时间倒序") })}
        title={t("点击切换为{p0}", { p0: filters.timeOrder === 'newest' ? t("时间正序") : t("时间倒序") })}
        onClick={() => updateFilters({ timeOrder: filters.timeOrder === 'newest' ? 'oldest' : 'newest' })}
        className="ui-button ui-button-secondary min-w-[104px] shrink-0"
      >
        <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5 shrink-0 text-slate-400">
          <path d="M6.5 16.5v-13m0 0L3.5 6.5m3-3 3 3m4 10v-13m0 13 3-3m-3 3-3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {filters.timeOrder === 'newest' ? t("时间倒序") : t("时间正序")}
      </button>
    </section>
  );
}

function TeamBoard({ projectCode }: { projectCode: string }) {
  const { projectName, featureName, memberName } = useProjectDisplayNames();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filters, setFilters] = useState<TaskBoardFilters>(DEFAULT_TASK_BOARD_FILTERS);
  const closeModal = useCallback(() => setSelectedId(null), []);
  const { data: tasks, error, isLoading, isFetching, dataUpdatedAt } = useQuery({
    queryKey: ['tasks', projectCode],
    queryFn: () => listTasks('', projectCode),
    refetchInterval: TASK_BOARD_REFRESH_INTERVAL_MS,
  });
  const { data: projectFeatures } = useQuery({ queryKey: ['features', projectCode], queryFn: () => listFeatures(projectCode) });
  const { data: projectMembers } = useQuery({ queryKey: ['members', projectCode], queryFn: () => listMembers(projectCode) });

  if (isLoading) return <div className="flex flex-1 items-center justify-center text-slate-500">{t("加载项目任务看板…")}</div>;
  if (error) {
    return (
      <div className="flex-1 p-8">
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-700">{t("无法连接 core-api：")}{error instanceof Error ? error.message : String(error)}
        </div>
      </div>
    );
  }

  const allTasks = tasks ?? [];
  const filteredTasks = filterBoardTasks(allTasks, filters);
  const visibleColumns = BOARD_COLUMNS.filter((column) => column.id !== 'cancelled' || allTasks.some((task) => task.status === 'cancelled'));
  const board = visibleColumns.map((col) => ({
    ...col,
    tasks: sortBoardTasks(filteredTasks.filter((t) => col.statuses.includes(t.status)), col.id, filters.timeOrder),
  }));
  const total = allTasks.length;
  const visibleTotal = filteredTasks.length;
  const completed = board.find((column) => column.id === 'done')?.tasks.length ?? 0;
  const featureOptions = collectTaskBoardFeatureOptions(projectFeatures ?? [], allTasks, featureName);
  const assigneeOptions = collectTaskBoardAssigneeOptions(projectMembers ?? [], allTasks, memberName);
  const sourceOptions = [...new Set(allTasks.map((task) => task.source))];

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <main className="flex-1 overflow-x-auto p-6">
        <div className="mb-3 flex min-w-[980px] items-end justify-between gap-6">
          <div className="shrink-0"><p className="text-xs font-bold tracking-[0.18em] text-cyan-700">PROJECT DELIVERY</p><h1 className="mt-1 text-2xl font-bold">{projectName || t("项目")}{t(" · 任务看板")}</h1><code title={t("项目编码")} className="text-xs text-slate-400">{projectCode}</code></div>
          <div className="flex min-w-0 flex-1 items-center justify-end gap-1.5 pb-0.5">
            <TaskBoardControls filters={filters} setFilters={setFilters} featureOptions={featureOptions} assigneeOptions={assigneeOptions} sourceOptions={sourceOptions} featureName={featureName} memberName={memberName} />
            <span title={t("显示 {p0} / 共 {p1} 个任务", { p0: visibleTotal, p1: total })} className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-500 shadow-sm">
              <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5 text-slate-400"><path d="M5 5.5h10M5 10h10M5 14.5h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/><circle cx="2.5" cy="5.5" r=".75" fill="currentColor"/><circle cx="2.5" cy="10" r=".75" fill="currentColor"/><circle cx="2.5" cy="14.5" r=".75" fill="currentColor"/></svg>
              <strong className="font-medium text-slate-700">{visibleTotal}<span className="font-medium text-slate-400">/{total}</span></strong>
            </span>
            <span title={t("core-api 已连接")} className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-emerald-100 bg-emerald-50 px-2.5 text-xs font-medium text-emerald-700">
              <span className={`h-1.5 w-1.5 rounded-full bg-emerald-500 ${isFetching ? 'animate-pulse' : ''}`} />{t("已同步")}</span>
          </div>
        </div>
        <div className="flex items-start gap-4">
          <div className="grid shrink-0 grid-flow-col auto-cols-[300px] gap-4">
            {board.map((col) => {
            // 阶段分组（TASK-219 AC-1）：列内按 Feature 分组展示
            const byFeature = new Map<string, TaskSummary[]>();
            for (const t of col.tasks) {
              const key = t.feature_code ?? '其他';
              if (!byFeature.has(key)) byFeature.set(key, []);
              byFeature.get(key)!.push(t);
            }
            return (
              <section key={col.id} className="rounded-xl bg-slate-100/70 p-3">
                <header className="mb-2 flex items-center justify-between px-1">
                  <h2 className="text-sm font-semibold text-slate-600">{t(col.title)}</h2>
                  <span className="rounded-full bg-white px-2 py-0.5 text-xs text-slate-500">{col.tasks.length}</span>
                </header>
                {col.tasks.length === 0 && <div className="rounded-lg border border-dashed border-slate-300 p-4 text-center text-xs text-slate-400">{t("空")}</div>}
                {[...byFeature.entries()].map(([feature, featureTasks]) => (
                  <div key={feature} className="mb-2">
                    <div className="mb-1.5 flex items-center gap-1.5 px-1">
                      <span title={t("Feature 编码：{p0}", { p0: feature })} className="max-w-[240px] truncate rounded bg-cyan-100 px-1.5 py-0.5 text-[10px] font-bold text-cyan-800">{feature === '其他' ? t('其他') : featureName(feature)}</span>
                      <span className="text-[10px] text-slate-400">{t('任务：{count}', { count: featureTasks.length })}</span>
                    </div>
                    <div className="space-y-2">
                      {featureTasks.map((t) => (
                        <TaskCard key={t.code} task={t} onSelect={() => setSelectedId(t.code)} />
                      ))}
                    </div>
                  </div>
                ))}
              </section>
            );
            })}
          </div>
          <BoardInsights
            total={visibleTotal}
            completed={completed}
            columns={board.map((column) => ({ id: column.id, title: column.title, count: column.tasks.length }))}
            updatedAt={dataUpdatedAt}
            isFetching={isFetching}
          />
        </div>
      </main>
      {selectedId && <TaskDetailModal taskId={selectedId} projectCode={projectCode} onClose={closeModal} />}
    </div>
  );
}
