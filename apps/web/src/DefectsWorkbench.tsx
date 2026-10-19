import { useProjectAccess } from './useProjectAccess';
import { useLocale } from './useLocale';
import { t, getLocale } from './i18n.ts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from 'react';
import {
  createDefect,
  createTask,
  listDefects,
  listFeatures,
  listMembers,
  listRequirements,
  transitionDefect,
  type CreateDefectInput,
  type DefectSummary,
  type Feature,
  type Requirement,
} from './api';
import { STATUS_META } from './status';
import { projectWorkspacePath } from './workspaceRouting';

const DEFECT_STATUS: Record<string, { label: string; short: string; color: string; dot: string }> = {
  reported: { label: '待确认', short: '待确认', color: 'bg-orange-50 text-orange-700 ring-orange-200', dot: 'bg-orange-500' },
  triaged: { label: '待安排修复', short: '待修复', color: 'bg-violet-50 text-violet-700 ring-violet-200', dot: 'bg-violet-500' },
  fixing: { label: '修复中', short: '修复中', color: 'bg-blue-50 text-blue-700 ring-blue-200', dot: 'bg-blue-500' },
  retest: { label: '待回归', short: '待回归', color: 'bg-amber-50 text-amber-700 ring-amber-200', dot: 'bg-amber-500' },
  closed: { label: '已关闭', short: '已关闭', color: 'bg-emerald-50 text-emerald-700 ring-emerald-200', dot: 'bg-emerald-500' },
  rejected: { label: '不处理', short: '不处理', color: 'bg-slate-100 text-slate-600 ring-slate-200', dot: 'bg-slate-400' },
};

const SEVERITY: Record<string, { label: string; color: string; accent: string }> = {
  critical: { label: '致命', color: 'bg-rose-600 text-white', accent: 'border-l-rose-600' },
  high: { label: '高', color: 'bg-orange-100 text-orange-800', accent: 'border-l-orange-500' },
  medium: { label: '中', color: 'bg-amber-100 text-amber-800', accent: 'border-l-amber-400' },
  low: { label: '低', color: 'bg-slate-100 text-slate-600', accent: 'border-l-slate-300' },
};

const STATUS_FILTERS = [
  { value: 'active', label: '处理中' },
  { value: 'reported', label: '待确认' },
  { value: 'fixing', label: '修复中' },
  { value: 'retest', label: '待回归' },
  { value: 'closed', label: '已关闭' },
  { value: 'all', label: '全部' },
] as const;

const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 } as const;

export function DefectsWorkbench({ projectCode, projectId }: { projectCode?: string; projectId?: string } = {}) {
  useLocale();
  const activeProjectCode = projectCode ?? projectId ?? '';
  const { canWrite, canManage } = useProjectAccess(activeProjectCode);
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<(typeof STATUS_FILTERS)[number]['value']>('active');
  const [severityFilter, setSeverityFilter] = useState('');
  const [search, setSearch] = useState('');
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [repairDefect, setRepairDefect] = useState<DefectSummary | null>(null);
  const [notice, setNotice] = useState<{ message: string; taskCode?: string } | null>(null);

  const defectsQuery = useQuery({
    queryKey: ['defects', activeProjectCode],
    queryFn: () => listDefects('', activeProjectCode),
    enabled: Boolean(activeProjectCode),
  });
  const featuresQuery = useQuery({
    queryKey: ['features', activeProjectCode],
    queryFn: () => listFeatures(activeProjectCode),
    enabled: Boolean(activeProjectCode),
  });
  const requirementsQuery = useQuery({
    queryKey: ['requirements', activeProjectCode],
    queryFn: () => listRequirements(activeProjectCode),
    enabled: Boolean(activeProjectCode),
  });
  const membersQuery = useQuery({
    queryKey: ['members', activeProjectCode],
    queryFn: () => listMembers(activeProjectCode),
    enabled: Boolean(activeProjectCode),
  });

  const defects = defectsQuery.data ?? [];
  const features = featuresQuery.data ?? [];
  const requirements = requirementsQuery.data ?? [];
  const members = membersQuery.data ?? [];
  const featureMap = useMemo(() => new Map(features.map((feature) => [feature.code, feature.title])), [features]);
  const requirementMap = useMemo(() => new Map(requirements.map((requirement) => [requirement.code, requirement.title])), [requirements]);
  const memberMap = useMemo(() => new Map(members.map((member) => [member.code, member.display_name || member.code])), [members]);
  const isOwner = canManage;

  const filtered = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return [...defects]
      .filter((defect) => {
        if (statusFilter === 'active' && ['closed', 'rejected'].includes(defect.status)) return false;
        if (!['active', 'all'].includes(statusFilter) && defect.status !== statusFilter) return false;
        if (severityFilter && defect.severity !== severityFilter) return false;
        if (!needle) return true;
        return [defect.code, defect.title, defect.description, defect.found_in, featureMap.get(defect.feature_code)]
          .filter(Boolean).join(' ').toLocaleLowerCase().includes(needle);
      })
      .sort((left, right) => {
        const severity = SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity];
        if (severity !== 0) return severity;
        return (right.reported_at ?? '').localeCompare(left.reported_at ?? '');
      });
  }, [defects, featureMap, search, severityFilter, statusFilter]);

  useEffect(() => {
    if (!filtered.length) {
      setSelectedCode(null);
      return;
    }
    if (!filtered.some((defect) => defect.code === selectedCode)) setSelectedCode(filtered[0].code);
  }, [filtered, selectedCode]);

  const selected = defects.find((defect) => defect.code === selectedCode) ?? filtered[0];
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['defects', activeProjectCode] });
    void queryClient.invalidateQueries({ queryKey: ['tasks'] });
  };
  const reportMutation = useMutation({
    mutationFn: createDefect,
    onSuccess: (defect) => {
      refresh();
      setSelectedCode(defect.code);
      setStatusFilter('active');
      setReportOpen(false);
      setNotice({ message: '缺陷已提交，正在等待项目 Owner 确认' });
    },
  });
  const repairMutation = useMutation({
    mutationFn: async ({ defect, title, brief, acceptance }: { defect: DefectSummary; title: string; brief: string; acceptance: string }) => {
      if (defect.status === 'reported') await transitionDefect(defect.code, { to: 'triaged' });
      const task = await createTask({
        feature_code: defect.feature_code,
        requirement_code: defect.related_requirement_code ?? undefined,
        defect_code: defect.code,
        title,
        brief,
        profile: 'builder',
        source: 'defect-fix',
        acceptance: [{ id: 'AC-1', text: acceptance }],
      });
      await transitionDefect(defect.code, { to: 'fixing', fix_task_code: task.code });
      return task;
    },
    onSuccess: (task) => {
      refresh();
      setRepairDefect(null);
      setNotice({ message: '修复任务 {value0} 已进入任务看板', taskCode: task.code });
    },
    onSettled: refresh,
  });
  const transitionMutation = useMutation({
    mutationFn: ({ defect, to, fixTaskCode }: { defect: DefectSummary; to: string; fixTaskCode?: string }) => transitionDefect(defect.code, { to, fix_task_code: fixTaskCode }),
    onSuccess: (result) => {
      refresh();
      const messages: Record<string, string> = {
        fixing: '修复任务已关联，缺陷进入修复中',
        retest: '缺陷已进入回归验证',
        triaged: '回归未通过，缺陷已重新打开',
        closed: '回归通过，缺陷已关闭',
        rejected: '缺陷已标记为不处理',
      };
      setNotice({ message: messages[result.status] ?? '缺陷状态已更新' });
    },
  });

  if (!activeProjectCode) return <WorkbenchError error={t("缺少项目编码")} />;
  if (defectsQuery.isLoading || featuresQuery.isLoading || requirementsQuery.isLoading || membersQuery.isLoading) {
    return <div className="flex min-h-64 flex-1 items-center justify-center bg-slate-50 text-sm text-slate-500">{t("正在加载缺陷工作台…")}</div>;
  }
  const queryError = defectsQuery.error ?? featuresQuery.error ?? requirementsQuery.error ?? membersQuery.error;
  if (queryError) return <WorkbenchError error={queryError} />;

  const stats = {
    reported: defects.filter((defect) => defect.status === 'reported').length,
    fixing: defects.filter((defect) => ['triaged', 'fixing'].includes(defect.status)).length,
    retest: defects.filter((defect) => defect.status === 'retest').length,
    closed: defects.filter((defect) => defect.status === 'closed').length,
  };
  const actionError = repairMutation.error ?? transitionMutation.error;

  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-slate-50 p-4 lg:p-6">
      <section className="mx-auto max-w-[1480px]">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs font-bold tracking-[0.18em] text-rose-700">DEFECT WORKBENCH</p>
            <h1 className="mt-1 text-2xl font-bold text-slate-950">{t("缺陷")}</h1>
            <p className="mt-1 text-sm text-slate-500">{t("集中完成问题提交、确认、修复任务关联与回归关闭。")}</p>
          </div>
          {canWrite && <button type="button" onClick={() => setReportOpen(true)} className="ui-button ui-button-primary">{t("提交缺陷")}</button>}
        </header>

        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard label={t("待确认")} value={stats.reported} tone="orange" />
          <StatCard label={t("待修复 / 修复中")} value={stats.fixing} tone="blue" />
          <StatCard label={t("待回归")} value={stats.retest} tone="amber" />
          <StatCard label={t("本项目已关闭")} value={stats.closed} tone="green" />
        </div>

        {notice && <div role="status" className="mt-4 flex items-center justify-between rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800"><span>{t(notice.message, { value0: notice.taskCode ?? '' })}</span><button type="button" onClick={() => setNotice(null)} className="text-xs font-bold">{t("知道了")}</button></div>}

        <div className="mt-4 grid min-h-[650px] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm lg:grid-cols-[390px_minmax(0,1fr)]">
          <aside className="flex min-h-0 flex-col border-b border-slate-200 bg-slate-50/60 lg:border-b-0 lg:border-r">
            <div className="border-b border-slate-200 bg-white p-4">
              <div className="relative">
                <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="absolute left-3 top-2 h-4 w-4 text-slate-400"><circle cx="9" cy="9" r="5.5" stroke="currentColor" strokeWidth="1.5" /><path d="m13 13 4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
                <input aria-label={t("搜索缺陷")} value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("搜索标题、描述或版本")} className="form-control form-control-compact pl-9" />
              </div>
              <div className="mt-3 flex gap-2">
                <select aria-label={t("状态筛选")} value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)} className="form-control form-control-compact">
                  {STATUS_FILTERS.map((item) => <option key={item.value} value={item.value}>{t(item.label)}</option>)}
                </select>
                <select aria-label={t("严重度筛选")} value={severityFilter} onChange={(event) => setSeverityFilter(event.target.value)} className="form-control form-control-compact">
                  <option value="">{t("全部级别")}</option><option value="critical">{t("致命")}</option><option value="high">{t("高")}</option><option value="medium">{t("中")}</option><option value="low">{t("低")}</option>
                </select>
              </div>
            </div>
            <div className="flex items-center justify-between px-4 py-2.5 text-xs text-slate-500"><span>{t("缺陷数量：{count}", { count: filtered.length })}</span><span>{t("按严重度排序")}</span></div>
            <div className="max-h-[680px] flex-1 overflow-y-auto px-2 pb-2">
              {filtered.length === 0 && <div className="m-2 rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-400">{t("当前筛选下没有缺陷")}</div>}
              {filtered.map((defect) => {
                const status = DEFECT_STATUS[defect.status] ?? DEFECT_STATUS.reported;
                const severity = SEVERITY[defect.severity] ?? SEVERITY.low;
                const active = selected?.code === defect.code;
                return (
                  <button type="button" key={defect.code} onClick={() => setSelectedCode(defect.code)} aria-current={active ? 'true' : undefined} className={`mb-2 w-full border-l-4 p-3.5 text-left transition ${severity.accent} ${active ? 'rounded-xl bg-white shadow-sm ring-1 ring-cyan-300' : 'rounded-lg bg-transparent hover:bg-white'}`}>
                    <div className="flex items-center justify-between gap-2"><span className={`rounded px-2 py-0.5 text-[10px] font-bold ${severity.color}`}>{t(severity.label)}</span><span className={`inline-flex items-center gap-1.5 text-[11px] font-semibold ${status.color.split(' ')[1]}`}><span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />{t(status.short)}</span></div>
                    <h3 className="mt-2 text-sm font-bold leading-5 text-slate-900" style={{ display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2, overflow: 'hidden' }}>{defect.title}</h3>
                    <p className="mt-1 truncate text-xs text-slate-500">{featureMap.get(defect.feature_code) ?? t('未命名 Feature')}</p>
                    <div className="mt-3 flex items-center justify-between text-[11px] text-slate-400"><span>{memberMap.get(defect.reported_by) ?? t('未知成员')}</span><span>{formatDate(defect.reported_at)}</span></div>
                  </button>
                );
              })}
            </div>
          </aside>

          <section className="min-w-0 bg-white">
            {!selected ? <EmptyDetail onReport={() => setReportOpen(true)} /> : (
              <DefectDetail
                defect={selected}
                featureName={featureMap.get(selected.feature_code) ?? selected.feature_code}
                requirementName={selected.related_requirement_code ? requirementMap.get(selected.related_requirement_code) : undefined}
                reporterName={memberMap.get(selected.reported_by) ?? selected.reported_by}
                memberMap={memberMap}
                isOwner={isOwner}
                canWrite={canWrite}
                projectCode={activeProjectCode}
                pending={repairMutation.isPending || transitionMutation.isPending}
                error={actionError instanceof Error ? actionError : null}
                onCreateRepair={() => setRepairDefect(selected)}
                onStartExisting={(taskCode) => transitionMutation.mutate({ defect: selected, to: 'fixing', fixTaskCode: taskCode })}
                onRetest={() => transitionMutation.mutate({ defect: selected, to: 'retest' })}
                onClose={() => transitionMutation.mutate({ defect: selected, to: 'closed' })}
                onReopen={() => transitionMutation.mutate({ defect: selected, to: 'triaged' })}
                onReject={() => { if (window.confirm(t('确认该问题无需处理？此操作会结束当前缺陷流程。'))) transitionMutation.mutate({ defect: selected, to: 'rejected' }); }}
              />
            )}
          </section>
        </div>
      </section>

      {canWrite && reportOpen && <ReportDefectDialog features={features} requirements={requirements} pending={reportMutation.isPending} error={reportMutation.error instanceof Error ? reportMutation.error : null} onClose={() => setReportOpen(false)} onSubmit={(input) => reportMutation.mutate(input)} />}
      {canManage && repairDefect && <RepairTaskDialog defect={repairDefect} pending={repairMutation.isPending} error={repairMutation.error instanceof Error ? repairMutation.error : null} onClose={() => setRepairDefect(null)} onSubmit={(input) => repairMutation.mutate({ defect: repairDefect, ...input })} />}
    </main>
  );
}

function DefectDetail({ defect, featureName, requirementName, reporterName, memberMap, isOwner, canWrite, projectCode, pending, error, onCreateRepair, onStartExisting, onRetest, onClose, onReopen, onReject }: {
  defect: DefectSummary;
  featureName: string;
  requirementName?: string;
  reporterName: string;
  memberMap: Map<string, string>;
  isOwner: boolean;
  canWrite: boolean;
  projectCode: string;
  pending: boolean;
  error: Error | null;
  onCreateRepair: () => void;
  onStartExisting: (taskCode: string) => void;
  onRetest: () => void;
  onClose: () => void;
  onReopen: () => void;
  onReject: () => void;
}) {
  const status = DEFECT_STATUS[defect.status] ?? DEFECT_STATUS.reported;
  const severity = SEVERITY[defect.severity] ?? SEVERITY.low;
  const completedTask = defect.fix_tasks.some((task) => ['verified', 'closed'].includes(task.status));
  const activeLinkedTask = defect.fix_tasks.find((task) => !['verified', 'closed'].includes(task.status));

  return (
    <div className="flex h-full min-h-[650px] flex-col">
      <header className="border-b border-slate-200 px-5 py-5 lg:px-7">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2"><span className={`rounded px-2 py-1 text-[11px] font-bold ${severity.color}`}>{t("优先级：{severity}", { severity: t(severity.label) })}</span><span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ring-1 ${status.color}`}>{t(status.label)}</span><code className="text-[11px] text-slate-400">{defect.code}</code></div>
            <h2 className="mt-3 text-xl font-bold leading-8 text-slate-950">{defect.title}</h2>
            <p className="mt-2 text-sm text-slate-500">{featureName}</p>
          </div>
          <a href={projectWorkspacePath(projectCode, 'board')} className="ui-button ui-button-secondary">{t("打开任务看板")}</a>
        </div>
        <DefectLifecycle status={defect.status} />
      </header>

      <div className="grid flex-1 gap-0 xl:grid-cols-[minmax(0,1fr)_310px]">
        <div className="min-w-0 px-5 py-6 lg:px-7">
          <section>
            <p className="text-xs font-bold tracking-[0.14em] text-slate-400">{t("问题描述与复现信息")}</p>
            <div className="mt-3 whitespace-pre-wrap rounded-xl border border-slate-200 bg-slate-50 p-5 text-sm leading-7 text-slate-700">{defect.description || t('未填写问题描述。')}</div>
          </section>

          <section className="mt-7">
            <div className="flex items-center justify-between gap-3"><div><p className="text-xs font-bold tracking-[0.14em] text-slate-400">{t("修复任务")}</p><h3 className="mt-1 text-base font-bold text-slate-900">{t("与任务看板保持同一条执行链")}</h3></div><span className="text-xs text-slate-400">{t("任务数量：{count}", { count: defect.fix_tasks.length })}</span></div>
            <div className="mt-3 space-y-3">
              {defect.fix_tasks.length === 0 && <div className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-400">{t("确认问题后，修复任务会显示在这里并同步进入任务看板。")}</div>}
              {defect.fix_tasks.map((task) => {
                const taskStatus = STATUS_META[task.status] ?? { label: task.status, color: 'bg-slate-100 text-slate-600' };
                return <article key={task.task_code} className="rounded-xl border border-slate-200 p-4"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><div className="flex items-center gap-2"><span className="rounded bg-cyan-50 px-2 py-0.5 text-[10px] font-bold text-cyan-700">{t("缺陷修复")}</span><span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${taskStatus.color}`}>{t(taskStatus.label)}</span></div><h4 className="mt-2 text-sm font-bold text-slate-900">{task.title}</h4><p className="mt-2 text-xs text-slate-400">{t("负责人：")}{task.assignee_principal_code ? memberMap.get(task.assignee_principal_code) ?? task.assignee_principal_code : t('未分派')} · {formatDate(task.created_at)}</p></div><code className="shrink-0 text-[10px] text-slate-400">{task.task_code}</code></div></article>;
              })}
            </div>
          </section>
          {error && <p role="alert" className="mt-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{t("操作失败：")}{t(error.message)}</p>}
        </div>

        <aside className="border-t border-slate-200 bg-slate-50/70 p-5 xl:border-l xl:border-t-0">
          <h3 className="text-sm font-bold text-slate-900">{t("当前处理")}</h3>
          <p className="mt-1 text-xs leading-5 text-slate-500">{actionHint(defect.status, isOwner, completedTask)}</p>
          <div className="mt-4 space-y-2">
            {['reported', 'triaged'].includes(defect.status) && isOwner && !activeLinkedTask && (canWrite && <button type="button" disabled={pending} onClick={onCreateRepair} className="ui-button ui-button-strong ui-button-block">{t("确认问题并创建修复任务")}</button>)}
            {defect.status === 'triaged' && activeLinkedTask && (canWrite && <button type="button" disabled={pending} onClick={() => onStartExisting(activeLinkedTask.task_code)} className="ui-button ui-button-strong ui-button-block">{t("关联已有任务并开始修复")}</button>)}
            {defect.status === 'fixing' && (canWrite && <button type="button" disabled={pending || !completedTask} onClick={onRetest} className="ui-button ui-button-warning ui-button-block">{t("进入回归验证")}</button>)}
            {defect.status === 'retest' && isOwner && <>{canWrite && <button type="button" disabled={pending} onClick={onClose} className="ui-button ui-button-success ui-button-block">{t("回归通过并关闭")}</button>}{canWrite && <button type="button" disabled={pending} onClick={onReopen} className="ui-button ui-button-danger ui-button-block">{t("回归未通过，重新修复")}</button>}</>}
            {['reported', 'triaged'].includes(defect.status) && isOwner && (canWrite && <button type="button" disabled={pending} onClick={onReject} className="ui-button ui-button-danger ui-button-block">{t("标记为无需处理")}</button>)}
          </div>
          {defect.status === 'fixing' && !completedTask && <p className="mt-3 rounded-lg bg-blue-50 px-3 py-2 text-xs leading-5 text-blue-700">{t("关联任务完成验收后，才可进入回归验证。")}</p>}
          {!isOwner && ['reported', 'triaged', 'retest'].includes(defect.status) && <p className="mt-3 rounded-lg bg-white px-3 py-2 text-xs leading-5 text-slate-500 ring-1 ring-slate-200">{t("此阶段由项目 Owner 决策；你仍可查看修复进展。")}</p>}

          <dl className="mt-7 space-y-4 border-t border-slate-200 pt-5 text-xs">
            <MetaRow label={t("上报人")} value={reporterName} />
            <MetaRow label={t("上报时间")} value={formatDateTime(defect.reported_at)} />
            <MetaRow label={t("发现版本 / 环境")} value={defect.found_in || t('未填写')} />
            <MetaRow label={t("关联需求")} value={requirementName || t('未关联')} title={defect.related_requirement_code ?? undefined} />
          </dl>
        </aside>
      </div>
    </div>
  );
}

function DefectLifecycle({ status }: { status: string }) {
  const steps = [{ id: 'reported', label: t('提交') }, { id: 'triaged', label: t('确认') }, { id: 'fixing', label: t('修复') }, { id: 'retest', label: t('回归') }, { id: 'closed', label: t('关闭') }];
  const activeIndex = Math.max(0, steps.findIndex((step) => step.id === status));
  if (status === 'rejected') return <div className="mt-5 rounded-lg bg-slate-100 px-4 py-2 text-xs font-semibold text-slate-500">{t("该问题已确认无需处理，流程结束。")}</div>;
  return <ol aria-label={t("缺陷处理进度")} className="mt-5 grid grid-cols-5"><>{steps.map((step, index) => <li key={step.id} className="relative text-center"><div className={`absolute left-0 right-0 top-2 h-px ${index <= activeIndex ? 'bg-cyan-500' : 'bg-slate-200'} ${index === 0 ? 'left-1/2' : ''} ${index === steps.length - 1 ? 'right-1/2' : ''}`} /><span className={`relative mx-auto block h-4 w-4 rounded-full border-4 border-white ring-1 ${index <= activeIndex ? 'bg-cyan-600 ring-cyan-600' : 'bg-slate-200 ring-slate-300'}`} /><span className={`mt-1.5 block text-[11px] font-semibold ${index === activeIndex ? 'text-cyan-700' : 'text-slate-400'}`}>{step.label}</span></li>)}</></ol>;
}

function ReportDefectDialog({ features, requirements, pending, error, onClose, onSubmit }: { features: Feature[]; requirements: Requirement[]; pending: boolean; error: Error | null; onClose: () => void; onSubmit: (input: CreateDefectInput) => void }) {
  const [featureCode, setFeatureCode] = useState(features[0]?.code ?? '');
  const [title, setTitle] = useState('');
  const [severity, setSeverity] = useState<CreateDefectInput['severity']>('medium');
  const [foundIn, setFoundIn] = useState('');
  const [requirementCode, setRequirementCode] = useState('');
  const [description, setDescription] = useState('');
  const availableRequirements = requirements.filter((requirement) => !requirement.feature_code || requirement.feature_code === featureCode);
  function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit({ feature_code: featureCode, title: title.trim(), severity, found_in: foundIn.trim() || undefined, related_requirement_code: requirementCode || undefined, description: description.trim() });
  }
  return <ModalShell title={t("提交缺陷")} eyebrow="REPORT DEFECT" description={t("记录可复现的问题；提交后由项目 Owner 确认是否进入修复。")} onClose={onClose}><form onSubmit={submit}><div className="grid gap-5 p-6 md:grid-cols-2"><Field label={t("所属 Feature")}><select required value={featureCode} onChange={(event) => { setFeatureCode(event.target.value); setRequirementCode(''); }} className="form-control bg-white"><option value="">{t("选择 Feature")}</option>{features.map((feature) => <option key={feature.code} value={feature.code}>{feature.title}</option>)}</select></Field><Field label={t("严重度")}><select value={severity} onChange={(event) => setSeverity(event.target.value as typeof severity)} className="form-control bg-white"><option value="critical">{t("致命 · 核心流程不可用")}</option><option value="high">{t("高 · 主要能力受阻")}</option><option value="medium">{t("中 · 有替代路径")}</option><option value="low">{t("低 · 轻微问题")}</option></select></Field><div className="md:col-span-2"><Field label={t("缺陷标题")}><input autoFocus required value={title} onChange={(event) => setTitle(event.target.value)} placeholder={t("一句话描述可观察到的问题")} className="form-control" /></Field></div><Field label={t("发现版本 / 环境")} hint={t("选填")}><input value={foundIn} onChange={(event) => setFoundIn(event.target.value)} placeholder={t("例如：v0.3.1 · Chrome 127")} className="form-control" /></Field><Field label={t("关联需求")} hint={t("选填")}><select value={requirementCode} onChange={(event) => setRequirementCode(event.target.value)} className="form-control bg-white"><option value="">{t("不关联需求")}</option>{availableRequirements.map((requirement) => <option key={requirement.code} value={requirement.code}>{requirement.title}</option>)}</select></Field><div className="md:col-span-2"><Field label={t("复现与预期")}><textarea required rows={10} value={description} onChange={(event) => setDescription(event.target.value)} placeholder={t('复现步骤：\n1. ...\n2. ...\n\n实际结果：\n...\n\n预期结果：\n...')} className="form-control resize-y font-mono text-sm leading-6" /></Field></div>{error && <div className="md:col-span-2"><ErrorMessage prefix={t("缺陷提交失败")} error={error} /></div>}</div><ModalFooter onClose={onClose} pending={pending} submitLabel={t("提交缺陷")} disabled={!featureCode || !title.trim() || !description.trim()} /></form></ModalShell>;
}

function RepairTaskDialog({ defect, pending, error, onClose, onSubmit }: { defect: DefectSummary; pending: boolean; error: Error | null; onClose: () => void; onSubmit: (input: { title: string; brief: string; acceptance: string }) => void }) {
  const [title, setTitle] = useState(t("修复：{value0}", { value0: defect.title }));
  const [brief, setBrief] = useState(() => t("## 缺陷背景\n- 缺陷：{value0}\n- 严重度：{value1}\n- 发现版本 / 环境：{value2}\n\n## 复现与预期\n{value3}\n\n## 交付要求\n修复根因，补充相应回归测试，并在提交时提供覆盖验收标准的自测证据。", { value0: defect.code, value1: SEVERITY[defect.severity]?.label ?? defect.severity, value2: defect.found_in || '未填写', value3: defect.description }));
  const [acceptance, setAcceptance] = useState(() => t('按原复现步骤无法再次复现该缺陷，且相关回归测试通过'));
  function submit(event: FormEvent) { event.preventDefault(); onSubmit({ title: title.trim(), brief: brief.trim(), acceptance: acceptance.trim() }); }
  return <ModalShell title={t("创建修复任务")} eyebrow={defect.code} description={t("任务将绑定当前缺陷并立即出现在任务看板，Agent 领取后可读取完整任务上下文。")} onClose={onClose}><form onSubmit={submit}><div className="space-y-5 p-6"><Field label={t("任务标题")}><input autoFocus required value={title} onChange={(event) => setTitle(event.target.value)} className="form-control" /></Field><Field label={t("任务说明")}><textarea required rows={12} value={brief} onChange={(event) => setBrief(event.target.value)} className="form-control resize-y font-mono text-sm leading-6" /></Field><Field label={t("验收标准")}><textarea required rows={3} value={acceptance} onChange={(event) => setAcceptance(event.target.value)} className="form-control resize-y" /></Field><p className="rounded-xl bg-cyan-50 px-4 py-3 text-xs leading-5 text-cyan-800">{t("来源固定为“缺陷修复”，执行 Profile 为 builder；后续仍需在任务看板分派、领取、提交和验收。")}</p>{error && <ErrorMessage prefix={t("修复任务创建失败")} error={error} />}</div><ModalFooter onClose={onClose} pending={pending} submitLabel={t("创建并开始修复")} disabled={!title.trim() || !brief.trim() || !acceptance.trim()} /></form></ModalShell>;
}

function ModalShell({ title, eyebrow, description, onClose, children }: { title: string; eyebrow: string; description: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => { const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); }; window.addEventListener('keydown', onKeyDown); return () => window.removeEventListener('keydown', onKeyDown); }, [onClose]);
  return <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/60 p-4 backdrop-blur-[2px]" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}><section role="dialog" aria-modal="true" aria-labelledby="defect-modal-title" className="max-h-[94vh] w-full max-w-3xl overflow-y-auto rounded-2xl bg-white shadow-2xl"><header className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-slate-200 bg-white px-6 py-5"><div><p className="text-xs font-bold tracking-[0.16em] text-cyan-700">{eyebrow}</p><h2 id="defect-modal-title" className="mt-1 text-xl font-bold text-slate-950">{title}</h2><p className="mt-1 text-sm text-slate-500">{description}</p></div><button type="button" onClick={onClose} aria-label={t("关闭弹窗")} className="ui-button ui-button-secondary">{t("关闭")}</button></header>{children}</section></div>;
}

function ModalFooter({ onClose, pending, submitLabel, disabled }: { onClose: () => void; pending: boolean; submitLabel: string; disabled: boolean }) { return <footer className="sticky bottom-0 flex justify-end gap-2 border-t border-slate-200 bg-white px-6 py-4"><button type="button" onClick={onClose} className="ui-button ui-button-secondary">{t("取消")}</button><button disabled={pending || disabled} className="ui-button ui-button-primary">{pending ? t('处理中…') : submitLabel}</button></footer>; }
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) { return <label className="ui-field-label block">{label}{hint && <span className="ml-2 text-xs font-normal text-slate-400">{hint}</span>}<div className="mt-1.5">{children}</div></label>; }
function ErrorMessage({ prefix, error }: { prefix: string; error: Error }) { return <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{prefix}：{t(error.message)}</p>; }
function MetaRow({ label, value, title }: { label: string; value: string; title?: string }) { return <div><dt className="text-slate-400">{label}</dt><dd title={title} className="mt-1 font-semibold leading-5 text-slate-700">{value}</dd></div>; }
function StatCard({ label, value, tone }: { label: string; value: number; tone: 'orange' | 'blue' | 'amber' | 'green' }) { const tones = { orange: 'bg-orange-50 text-orange-700 ring-orange-100', blue: 'bg-blue-50 text-blue-700 ring-blue-100', amber: 'bg-amber-50 text-amber-700 ring-amber-100', green: 'bg-emerald-50 text-emerald-700 ring-emerald-100' }; return <div className={`rounded-xl px-4 py-3 ring-1 ${tones[tone]}`}><p className="text-xs font-semibold opacity-75">{label}</p><p className="mt-1 text-2xl font-bold">{value}</p></div>; }
function EmptyDetail({ onReport }: { onReport: () => void }) { return <div className="grid min-h-[650px] place-items-center p-8 text-center"><div><div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-rose-50 text-2xl text-rose-700">!</div><h2 className="mt-4 text-lg font-bold text-slate-900">{t("没有需要处理的缺陷")}</h2><p className="mt-2 text-sm text-slate-500">{t("调整筛选条件，或提交一个新发现的问题。")}</p><button type="button" onClick={onReport} className="ui-button ui-button-primary mt-5">{t("提交缺陷")}</button></div></div>; }
function WorkbenchError({ error }: { error: unknown }) { return <div className="m-7 rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-700">{t("无法加载缺陷工作台：")}{error instanceof Error ? error.message : String(error)}</div>; }
function actionHint(status: string, isOwner: boolean, completedTask: boolean): string { if (!isOwner && ['reported', 'triaged', 'retest'].includes(status)) return t('等待项目 Owner 做出当前阶段决策。'); if (status === 'reported') return t('确认这是需要修复的问题，并生成一条有完整上下文的修复任务。'); if (status === 'triaged') return t('安排新的修复任务，或继续已绑定但尚未开始的任务。'); if (status === 'fixing') return completedTask ? t('修复任务已完成验证，可以开始回归。') : t('跟踪修复任务，完成验收后再进入回归。'); if (status === 'retest') return t('根据回归结果关闭缺陷，或重新打开进入下一轮修复。'); return t('此缺陷流程已经结束。'); }
function formatDate(value: string | null): string { if (!value) return t('时间未知'); const date = new Date(value); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(getLocale(), { month: 'numeric', day: 'numeric' }).format(date); }
function formatDateTime(value: string | null): string { if (!value) return t('时间未知'); const date = new Date(value); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(getLocale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date); }
