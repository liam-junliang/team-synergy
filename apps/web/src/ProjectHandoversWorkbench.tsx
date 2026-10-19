import { useLocale } from './useLocale';
import { t, formatDateTime } from './i18n.ts';
import { useDeferredValue, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { currentPrincipalCode, getTask, listProjectHandovers, type ProjectHandover } from './api';
import { HandoverPanel, HANDOVER_STATUS_LABELS } from './HandoverPanel';
import { useProjectDisplayNames } from './ProjectDisplayNames';
import { projectWorkspacePath } from './workspaceRouting';
import { navigateWorkspace } from './workspaceNavigation';
import { TASK_BOARD_REFRESH_INTERVAL_MS } from './queryPolicy';

type Queue = 'all' | 'mine' | 'active' | 'history';
const TERMINAL = new Set(['completed', 'cancelled', 'expired']);
const QUEUES: Array<{ id: Queue; label: string }> = [
  { id: 'all', label: '全部交接' }, { id: 'mine', label: '待我处理' },
  { id: 'active', label: '进行中' }, { id: 'history', label: '历史记录' },
];

export function needsHandoverAttention(item: ProjectHandover, principal: string): boolean {
  if (TERMINAL.has(item.status)) return false;
  return Boolean(item.can_publish || item.can_accept
    || (item.source_user_code === principal && item.status === 'preparing')
    || (item.target_user_code === principal && ['accepted', 'restoring', 'ready'].includes(item.status)));
}

export function filterProjectHandovers(items: ProjectHandover[], filters: { queue: Queue; status: string; search: string; principal: string }): ProjectHandover[] {
  const search = filters.search.trim().toLocaleLowerCase();
  return items.filter(item => {
    if (filters.queue === 'mine' && !needsHandoverAttention(item, filters.principal)) return false;
    if (filters.queue === 'active' && TERMINAL.has(item.status)) return false;
    if (filters.queue === 'history' && !TERMINAL.has(item.status)) return false;
    if (filters.status && item.status !== filters.status) return false;
    return !search || [item.task_title, item.handover_code, item.task_code, item.source_user_name,
      item.target_user_name, item.source_user_code, item.target_user_code].some(value => value?.toLocaleLowerCase().includes(search));
  });
}

export function ProjectHandoversWorkbench({ projectCode, handoverCode }: { projectCode: string; handoverCode?: string }) {
  useLocale();
  const { projectName, memberName } = useProjectDisplayNames();
  const [queue, setQueue] = useState<Queue>('all');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);
  const principal = currentPrincipalCode();
  const query = useQuery({ queryKey: ['project-handovers', projectCode], queryFn: () => listProjectHandovers(projectCode), refetchInterval: TASK_BOARD_REFRESH_INTERVAL_MS });
  const items = query.data ?? [];
  const filtered = filterProjectHandovers(items, { queue, status, search: deferredSearch, principal });
  const selected = filtered.find(item => item.handover_code === handoverCode) ?? filtered[0];
  const task = useQuery({ queryKey: ['task', selected?.task_code], queryFn: () => getTask(selected?.task_code ?? ''), enabled: Boolean(selected) });
  const counts: Record<Queue, number> = {
    all: items.length, mine: items.filter(item => needsHandoverAttention(item, principal)).length,
    active: items.filter(item => !TERMINAL.has(item.status)).length, history: items.filter(item => TERMINAL.has(item.status)).length,
  };
  const select = (code: string) => { navigateWorkspace(`${projectWorkspacePath(projectCode, 'handovers')}?handover=${encodeURIComponent(code)}`); };

  return <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-slate-50">
    <header className="shrink-0 space-y-4 border-b border-slate-200 bg-white px-4 py-5 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h1 className="text-2xl font-bold text-slate-950">{projectName || t('项目')} {t("· 交接")}</h1>
          <p className="mt-1 text-sm text-slate-500">{t("查看任务交接与共享上下文，让接手人在自己的电脑和 Agent 中继续工作。")}</p></div>
        <button type="button" className="ui-button ui-button-secondary" disabled={query.isFetching} onClick={() => void query.refetch()}>{query.isFetching ? t('刷新中…') : t('刷新')}</button>
      </div>
      <nav aria-label={t("交接队列")} className="flex flex-wrap gap-2">
        {QUEUES.map(item => <button key={item.id} type="button" aria-pressed={queue === item.id} className={`ui-button ui-button-compact ${queue === item.id ? 'ui-button-primary' : 'ui-button-secondary'}`} onClick={() => setQueue(item.id)}>{t(item.label)}<span className="ml-2 font-mono">{counts[item.id]}</span></button>)}
      </nav>
      <div className="flex flex-wrap gap-3">
        <label className="min-w-52 flex-1"><span className="sr-only">{t("搜索交接")}</span><input value={search} onChange={event => setSearch(event.target.value)} placeholder={t("搜索任务、交接人或接手人")} className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm" /></label>
        <label className="flex items-center gap-2 text-sm text-slate-600">{t("状态")}<select value={status} onChange={event => setStatus(event.target.value)} className="rounded-lg border border-slate-200 bg-white px-3 py-2"><option value="">{t("全部状态")}</option>{Object.entries(HANDOVER_STATUS_LABELS).filter(([key]) => key !== 'draft').map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}</select></label>
      </div>
    </header>
    {query.isPending ? <div className="grid flex-1 place-items-center text-sm text-slate-500">{t("正在加载项目交接…")}</div>
      : query.error ? <div role="alert" className="m-6 rounded-xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-700">{t("交接记录加载失败：")}{t(query.error.message)}</div>
      : items.length === 0 ? <div className="grid flex-1 place-items-center p-8 text-center"><div><h2 className="text-lg font-semibold text-slate-800">{t("还没有交接记录")}</h2><p className="mt-2 max-w-md text-sm leading-6 text-slate-500">{t("从正在执行的任务准备交接。发布后，接手人可在这里查看上下文、接收任务并获取本机恢复步骤。")}</p><a className="ui-button ui-button-primary mt-5" href={projectWorkspacePath(projectCode, 'board')}>{t("打开任务看板")}</a><p className="mt-4 text-xs text-slate-400">{t("接口、部署等资料请前往“文档”。")}</p></div></div>
      : <div className="grid min-h-0 flex-1 grid-cols-1 overflow-auto lg:grid-cols-[minmax(280px,340px)_minmax(0,1fr)] lg:overflow-hidden">
        <aside aria-label={t("项目交接记录")} className="border-b border-slate-200 bg-white p-3 lg:overflow-auto lg:border-b-0 lg:border-r">
          {filtered.length === 0 && <p className="p-5 text-center text-sm text-slate-500">{t("没有符合筛选条件的交接。")}</p>}
          <ul className="space-y-2">{filtered.map(item => <li key={item.handover_code}><button type="button" aria-pressed={selected?.handover_code === item.handover_code} onClick={() => select(item.handover_code)} className={`w-full rounded-xl border p-4 text-left transition ${selected?.handover_code === item.handover_code ? 'border-cyan-300 bg-cyan-50' : 'border-slate-200 hover:bg-slate-50'}`}>
            <span className="flex items-start justify-between gap-3"><span className="min-w-0 break-words text-sm font-semibold text-slate-800">{item.task_title}</span><span className="shrink-0 rounded-full bg-slate-100 px-2 py-1 text-xs text-slate-600">{t(HANDOVER_STATUS_LABELS[item.status] || item.status)}</span></span>
            <span className="mt-3 block break-words text-xs text-slate-600">{item.source_user_name || memberName(item.source_user_code)} → {item.target_user_name || memberName(item.target_user_code)}</span>
            {item.updated_at && <span className="mt-2 block text-xs text-slate-400">{t("更新于")}{formatDateTime(item.updated_at)}</span>}
          </button></li>)}</ul>
        </aside>
        <main className="min-w-0 p-4 sm:p-6 lg:overflow-auto">
          {!selected ? <p className="text-sm text-slate-500">{t("调整筛选条件以查看交接。")}</p> : <>
            <h2 className="mb-4 text-lg font-semibold text-slate-900">{selected.task_title}</h2>
            {task.isPending && <p className="text-sm text-slate-500">{t("正在加载任务上下文…")}</p>}
            {task.error && <p role="alert" className="text-sm text-rose-700">{t("任务加载失败：")}{t(task.error.message)}</p>}
            {task.data && <HandoverPanel key={selected.handover_code} task={task.data} initialHandoverCode={selected.handover_code} onSelectHandover={select} />}
          </>}
        </main>
      </div>}
  </div>;
}
