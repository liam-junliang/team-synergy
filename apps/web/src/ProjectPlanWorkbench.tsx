import { useProjectAccess } from './useProjectAccess';
import { useLocale } from './useLocale';
import { t, translate, formatDate, formatNumber, getLocale, type Locale } from './i18n.ts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Gantt, Willow, type IColumnConfig, type ITask } from '@svar-ui/react-gantt';
import { useEffect, useMemo, useState, type FormEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import '@svar-ui/react-gantt/all.css';
import {
  createProjectMilestone,
  createProjectPhase,
  listFeatures,
  listProjectMilestones,
  listProjectPhases,
  updateFeature,
  updateProjectMilestone,
  updateProjectPhase,
  type CreateProjectMilestoneInput,
  type CreateProjectPhaseInput,
  type Feature,
  type ProjectMilestone,
  type ProjectPhase,
  type UpdateProjectMilestoneInput,
  type UpdateProjectPhaseInput,
  type UpdateFeatureInput,
} from './api';
import { useProjectDisplayNames } from './ProjectDisplayNames';
import {
  deriveTimelineRange,
  formatTimelineDate,
} from './projectPlanTimeline';
import { buildPlanGanttTasks, decodeGanttDomTaskId, parseGanttTaskId, type PlanGanttTask } from './projectPlanGantt';
import './project-plan-gantt.css';

type PhaseDialogState = { mode: 'create' } | { mode: 'edit'; phase: ProjectPhase };
type MilestoneDialogState = { mode: 'create'; phaseCode?: string | null } | { mode: 'edit'; milestone: ProjectMilestone };
type AssignmentDialogState = { feature: Feature };

const PHASE_STATUS_OPTIONS = [
  { value: 'planned', get label() { return t("规划中"); } },
  { value: 'active', get label() { return t("进行中"); } },
  { value: 'completed', get label() { return t("已完成"); } },
  { value: 'archived', get label() { return t("已归档"); } },
] as const;

const MILESTONE_STATUS_OPTIONS = [
  { value: 'planned', get label() { return t("规划中"); } },
  { value: 'active', get label() { return t("进行中"); } },
  { value: 'at_risk', get label() { return t("有风险"); } },
  { value: 'completed', get label() { return t("已完成"); } },
  { value: 'cancelled', get label() { return t("已取消"); } },
] as const;

type TimelineScale = 'day' | 'week' | 'month';

export function ProjectPlanWorkbench({ projectCode }: { projectCode: string }) {
  const locale = useLocale();
  const queryClient = useQueryClient();
  const { canManage } = useProjectAccess(projectCode);
  const { projectName } = useProjectDisplayNames();
  const [search, setSearch] = useState('');
  const [selectedPhaseCode, setSelectedPhaseCode] = useState<string | null>(null);
  const [timelineScale, setTimelineScale] = useState<TimelineScale>('week');
  const [backlogOpen, setBacklogOpen] = useState(false);
  const [backlogSearch, setBacklogSearch] = useState('');
  const [phaseDialog, setPhaseDialog] = useState<PhaseDialogState | null>(null);
  const [milestoneDialog, setMilestoneDialog] = useState<MilestoneDialogState | null>(null);
  const [assignmentDialog, setAssignmentDialog] = useState<AssignmentDialogState | null>(null);
  const [notice, setNotice] = useState<Parameters<typeof t> | null>(null);

  const phasesQuery = useQuery({
    queryKey: ['project-phases', projectCode],
    queryFn: () => listProjectPhases(projectCode),
    enabled: Boolean(projectCode),
  });
  const milestonesQuery = useQuery({
    queryKey: ['project-milestones', projectCode],
    queryFn: () => listProjectMilestones(projectCode),
    enabled: Boolean(projectCode),
  });
  const featuresQuery = useQuery({
    queryKey: ['features', projectCode],
    queryFn: () => listFeatures(projectCode),
    enabled: Boolean(projectCode),
  });

  const phases = useMemo(() => phasesQuery.data ?? [], [phasesQuery.data]);
  const milestones = useMemo(() => milestonesQuery.data ?? [], [milestonesQuery.data]);
  const features = useMemo(() => featuresQuery.data ?? [], [featuresQuery.data]);
  const phaseMap = useMemo(() => new Map(phases.map((phase) => [phase.code, phase])), [phases]);
  const milestoneMap = useMemo(() => new Map(milestones.map((milestone) => [milestone.code, milestone])), [milestones]);
  const timeline = useMemo(() => deriveTimelineRange(phases, milestones, undefined, locale), [phases, milestones, locale]);
  const unplannedFeatures = useMemo(() => features.filter((feature) => (
    !feature.milestone_code
    || !milestoneMap.has(feature.milestone_code)
    || !feature.start_at
    || !feature.end_at
  )), [features, milestoneMap]);
  const filteredUnplannedFeatures = useMemo(() => {
    const needle = backlogSearch.trim().toLocaleLowerCase();
    if (!needle) return unplannedFeatures;
    return unplannedFeatures.filter((feature) => [feature.title, feature.goal ?? '', feature.code, feature.module_name ?? '', feature.module_code ?? ''].join(' ').toLocaleLowerCase().includes(needle));
  }, [backlogSearch, unplannedFeatures]);
  const ganttTasks = useMemo(() => buildPlanGanttTasks(phases, milestones, features, {
    phaseCode: selectedPhaseCode,
    search,
    locale,
  }), [features, milestones, phases, search, selectedPhaseCode, locale]);
  const plannedFeatureCount = features.filter((feature) => feature.milestone_code && feature.start_at && feature.end_at).length;
  const unscheduledPhaseCount = phases.filter((phase) => !phase.start_at && !phase.end_at).length;
  const scales = useMemo(() => ganttScales(timelineScale, timeline.start, locale), [timeline.start, timelineScale, locale]);
  const columns = useMemo<IColumnConfig[]>(() => [
    { id: 'text', header: translate(locale, '计划结构'), flexgrow: 1 },
    { id: 'scheduleLabel', header: translate(locale, '排期'), width: 132, align: 'center' },
    { id: 'statusLabel', header: translate(locale, '状态'), width: 82, align: 'center' },
  ], [locale]);
  const createPhaseMutation = useMutation({
    mutationFn: (input: CreateProjectPhaseInput) => createProjectPhase(projectCode, input),
    onSuccess: (phase) => {
      setPhaseDialog(null);
      setNotice(["阶段「{p0}」已保存", { p0: phase.name }]);
      void queryClient.invalidateQueries({ queryKey: ['project-phases', projectCode] });
    },
  });
  const updatePhaseMutation = useMutation({
    mutationFn: ({ phaseCode, input }: { phaseCode: string; input: UpdateProjectPhaseInput }) => updateProjectPhase(projectCode, phaseCode, input),
    onSuccess: (phase) => {
      setPhaseDialog(null);
      setNotice(["阶段「{p0}」已更新", { p0: phase.name }]);
      void queryClient.invalidateQueries({ queryKey: ['project-phases', projectCode] });
    },
  });
  const createMilestoneMutation = useMutation({
    mutationFn: (input: CreateProjectMilestoneInput) => createProjectMilestone(projectCode, input),
    onSuccess: (milestone) => {
      setMilestoneDialog(null);
      setNotice(["里程碑「{p0}」已保存", { p0: milestone.name }]);
      void queryClient.invalidateQueries({ queryKey: ['project-milestones', projectCode] });
    },
  });
  const updateMilestoneMutation = useMutation({
    mutationFn: ({ milestoneCode, input }: { milestoneCode: string; input: UpdateProjectMilestoneInput }) => updateProjectMilestone(projectCode, milestoneCode, input),
    onSuccess: (milestone) => {
      setMilestoneDialog(null);
      setNotice(["里程碑「{p0}」已更新", { p0: milestone.name }]);
      void queryClient.invalidateQueries({ queryKey: ['project-milestones', projectCode] });
    },
  });
  const assignFeatureMutation = useMutation({
    mutationFn: ({ feature, input }: { feature: Feature; input: UpdateFeatureInput }) => updateFeature(feature.code, input, projectCode),
    onSuccess: (feature) => {
      setAssignmentDialog(null);
      setNotice(["Feature「{p0}」已更新排期", { p0: feature.title }]);
      void queryClient.invalidateQueries({ queryKey: ['features', projectCode] });
    },
  });

  function openCreatePhase() {
    if (!canManage) return;
    createPhaseMutation.reset();
    setPhaseDialog({ mode: 'create' });
  }

  function openEditPhase(phase: ProjectPhase) {
    if (!canManage) return;
    updatePhaseMutation.reset();
    setPhaseDialog({ mode: 'edit', phase });
  }

  function openCreateMilestone(phaseCode?: string | null) {
    if (!canManage) return;
    createMilestoneMutation.reset();
    setMilestoneDialog({ mode: 'create', phaseCode: phaseCode ?? selectedPhaseCode ?? null });
  }

  function openEditMilestone(milestone: ProjectMilestone) {
    if (!canManage) return;
    updateMilestoneMutation.reset();
    setMilestoneDialog({ mode: 'edit', milestone });
  }

  function handleGanttDoubleClick(event: ReactMouseEvent<HTMLDivElement>) {
    if (!canManage) return;
    if (!(event.target instanceof Element) || event.target.closest('[data-action]')) return;
    const row = event.target.closest<HTMLElement>('[data-task-id], [data-id]');
    const taskId = decodeGanttDomTaskId(row?.dataset.taskId ?? row?.dataset.id);
    const entity = resolveSelectedEntity(taskId, phaseMap, milestoneMap, features);
    if (entity?.kind === 'phase') openEditPhase(entity.value);
    else if (entity?.kind === 'milestone') openEditMilestone(entity.value);
    else if (entity?.kind === 'feature') setAssignmentDialog({ feature: entity.value });
  }

  if (!projectCode) return <WorkbenchError error={t("缺少项目编码")} />;
  if (phasesQuery.isLoading || milestonesQuery.isLoading || featuresQuery.isLoading) return <WorkbenchLoading label={t("正在加载计划…")} />;
  if (phasesQuery.error || milestonesQuery.error || featuresQuery.error) return <WorkbenchError error={phasesQuery.error ?? milestonesQuery.error ?? featuresQuery.error} />;

  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-slate-50 p-4 lg:p-6">
      <section className="mx-auto max-w-[1840px]">
        <header className="mb-4 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-[11px] font-bold tracking-[0.2em] text-cyan-700">PROJECT ROADMAP</p>
            <h1 className="mt-1 text-2xl font-bold text-slate-950">{projectName || t("项目")} {t("· 计划")}</h1>
            <p className="mt-1 text-sm text-slate-500">{t("用一个路线图查看阶段、里程碑与 Feature 的交付节奏。")}</p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <div className="mr-1 hidden h-8 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-[12px] font-medium leading-4 text-slate-500 shadow-sm lg:flex">
              <Metric value={phases.length} label={t("阶段")} />
              <span className="h-4 w-px bg-slate-200" />
              <Metric value={milestones.length} label={t("里程碑")} />
              <span className="h-4 w-px bg-slate-200" />
              <Metric value={plannedFeatureCount} label={t("已规划")} />
            </div>
            {canManage && <button type="button" onClick={openCreatePhase} className="ui-button ui-button-secondary"><PlusIcon />{t("新建阶段")}</button>}
            {canManage && <button type="button" onClick={() => openCreateMilestone(selectedPhaseCode)} className="ui-button ui-button-primary"><PlusIcon />{t("新建里程碑")}</button>}
          </div>
        </header>

        {notice && <NoticeBar notice={notice} onClose={() => setNotice(null)} />}

        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm" aria-label={t("项目路线图")}>
          <div className="border-b border-slate-200 bg-white px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-slate-950 text-white" aria-hidden="true">
                  <RoadmapIcon />
                </div>
                <div className="min-w-0">
                  <h2 className="text-sm font-bold text-slate-950">{t("交付路线图")}</h2>
                  <p className="truncate text-[11px] text-slate-400">
                    {formatTimelineDate(timeline.startKey)}—{formatTimelineDate(timeline.endKey)} · {formatNumber(timeline.dayCount)} {t("天")} {unscheduledPhaseCount > 0 ? t(" · {p0} 个阶段待补日期", { p0: unscheduledPhaseCount }) : ''}
                  </p>
                </div>
              </div>

              <div className="flex flex-1 flex-wrap items-center justify-end gap-1.5">
                <label className="relative min-w-[220px] max-w-sm flex-1 lg:flex-none">
                  <span className="sr-only">{t("搜索计划项")}</span>
                  <SearchIcon />
                  <input value={search} onChange={(event) => setSearch(event.target.value)} aria-label={t("搜索计划项")} placeholder={t("搜索阶段、里程碑或 Feature")} className="h-8 w-full rounded-lg border border-slate-200 bg-white pl-9 pr-3 !text-[12px] !font-medium !leading-4 text-slate-700 shadow-sm outline-none transition placeholder:!text-[12px] placeholder:!font-medium placeholder:text-slate-500 placeholder:opacity-100 focus:border-cyan-400 focus:ring-2 focus:ring-cyan-100 lg:w-72" />
                </label>
                <select value={selectedPhaseCode ?? ''} onChange={(event) => setSelectedPhaseCode(event.target.value || null)} aria-label={t("筛选阶段")} className="h-8 min-w-[132px] rounded-lg border border-slate-200 bg-white px-2.5 text-[12px] font-medium leading-4 text-slate-600 shadow-sm outline-none transition hover:border-slate-300 focus:border-cyan-400">
                  <option value="">{t("全部阶段")}</option>
                  {phases.map((phase) => <option key={phase.code} value={phase.code}>{phase.name}</option>)}
                </select>
                <ScaleSwitcher value={timelineScale} onChange={setTimelineScale} />
                <button type="button" onClick={() => setBacklogOpen(true)} className={`ui-button ${unplannedFeatures.length > 0 ? 'ui-button-warning' : 'ui-button-secondary'}`}> {t("待规划")} <span className="grid h-4 min-w-4 place-items-center rounded-full bg-white px-1 text-[10px] font-medium shadow-sm">{unplannedFeatures.length}</span>
                </button>
              </div>
            </div>
          </div>

          <div className="acp-plan-gantt h-[clamp(520px,68vh,780px)] min-h-[520px]" data-scale={timelineScale} onDoubleClickCapture={handleGanttDoubleClick}>
            {ganttTasks.length === 0 ? (
              <div className="grid h-full place-items-center p-8">
                <EmptyHint title={t("没有匹配的计划项")} description={phases.length === 0 ? t("先创建阶段，再为里程碑安排时间。") : t("调整搜索或阶段筛选后再试。")} action={phases.length === 0 ? (canManage && <button type="button" onClick={openCreatePhase} className="ui-button ui-button-primary mt-4">{t("新建阶段")}</button>) : undefined} />
              </div>
            ) : (
              <Willow fonts={false}>
                <Gantt
                  tasks={ganttTasks}
                  taskTypes={PLAN_TASK_TYPES}
                  taskTemplate={PlanTaskBar}
                  columns={columns}
                  scales={scales}
                  start={timeline.start}
                  end={timeline.end}
                  autoScale={false}
                  cellWidth={timelineScale === 'day' ? 38 : timelineScale === 'week' ? 72 : 116}
                  cellHeight={48}
                  scaleHeight={34}
                  gridWidth={560}
                  readonly
                  unscheduledTasks
                  cellBorders="full"
                  highlightTime={highlightTimelineCell}
                />
              </Willow>
            )}
          </div>

          <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-slate-50/70 px-4 py-2.5 text-[11px] text-slate-500">
            <div className="flex flex-wrap items-center gap-4">
              <Legend color="bg-cyan-600" label={t("阶段")} />
              <Legend color="bg-indigo-600" label={t("里程碑")} />
              <Legend color="bg-slate-500" label="Feature" />
            </div>
            {canManage && <span>{t("双击阶段、里程碑或 Feature 行可编辑；排期条保持只读。")}</span>}
          </footer>
        </section>
      </section>

      {backlogOpen && (
        <UnplannedFeatureDrawer
          canManage={canManage}
          features={filteredUnplannedFeatures}
          total={unplannedFeatures.length}
          search={backlogSearch}
          onSearch={setBacklogSearch}
          onClose={() => setBacklogOpen(false)}
          onAssign={(feature) => {
            setBacklogOpen(false);
            setAssignmentDialog({ feature });
          }}
        />
      )}

      {canManage && phaseDialog && (
        <PhaseDialog
          state={phaseDialog}
          pending={createPhaseMutation.isPending || updatePhaseMutation.isPending}
          error={(createPhaseMutation.error ?? updatePhaseMutation.error) as Error | null}
          onClose={() => setPhaseDialog(null)}
          onSubmit={(input) => {
            if (phaseDialog.mode === 'create') createPhaseMutation.mutate(input);
            else updatePhaseMutation.mutate({ phaseCode: phaseDialog.phase.code, input });
          }}
        />
      )}
      {canManage && milestoneDialog && (
        <MilestoneDialog
          state={milestoneDialog}
          phases={phases}
          pending={createMilestoneMutation.isPending || updateMilestoneMutation.isPending}
          error={(createMilestoneMutation.error ?? updateMilestoneMutation.error) as Error | null}
          onClose={() => setMilestoneDialog(null)}
          onSubmit={(input) => {
            if (milestoneDialog.mode === 'create') createMilestoneMutation.mutate(input);
            else updateMilestoneMutation.mutate({ milestoneCode: milestoneDialog.milestone.code, input });
          }}
        />
      )}
      {canManage && assignmentDialog && (
        <AssignmentDialog
          feature={assignmentDialog.feature}
          milestones={milestones}
          phase={assignmentDialog.feature.milestone_code ? phaseMap.get(milestoneMap.get(assignmentDialog.feature.milestone_code)?.phase_code ?? '') ?? null : selectedPhaseCode ? phaseMap.get(selectedPhaseCode) ?? null : null}
          pending={assignFeatureMutation.isPending}
          error={assignFeatureMutation.error as Error | null}
          onClose={() => setAssignmentDialog(null)}
          onSubmit={(input) => assignFeatureMutation.mutate({ feature: assignmentDialog.feature, input })}
        />
      )}
    </main>
  );
}

const PLAN_TASK_TYPES = [
  { id: 'phase', get label() { return t("阶段"); } },
  { id: 'milestone-group', get label() { return t("里程碑"); } },
  { id: 'feature', label: 'Feature' },
];

export function ganttScales(scale: TimelineScale, rangeStart = new Date(), locale: Locale = getLocale()) {
  if (scale === 'day') {
    return [
      { unit: 'month', step: 1, format: (date: Date) => formatDate(date, { year: 'numeric', month: 'long' }, locale) },
      { unit: 'day', step: 1, format: (date: Date) => formatDate(date, { day: 'numeric' }, locale) },
    ];
  }
  if (scale === 'month') {
    return [
      { unit: 'year', step: 1, format: (date: Date) => formatDate(date, { year: 'numeric' }, locale) },
      { unit: 'month', step: 1, format: (date: Date) => formatDate(date, { month: 'long' }, locale) },
    ];
  }
  const firstVisibleWeek = startOfCalendarWeek(rangeStart);
  return [
    {
      unit: 'week',
      step: 1,
      format: (date: Date) => isMonthMarkerWeek(date, firstVisibleWeek)
        ? formatDate(date, { year: 'numeric', month: 'long' }, locale)
        : '',
    },
    { unit: 'week', step: 1, format: (date: Date) => formatDate(date, { month: 'numeric', day: 'numeric' }, locale) },
  ];
}

function startOfCalendarWeek(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate() - value.getDay());
}

function isMonthMarkerWeek(date: Date, firstVisibleWeek: Date): boolean {
  return date.getTime() === firstVisibleWeek.getTime() || date.getDate() <= 7;
}

function PlanTaskBar({ data }: { data: ITask }) {
  useLocale();
  const task = data as PlanGanttTask;
  return (
    <div className="acp-gantt-bar-content" title={`${task.text ?? ''} · ${task.scheduleLabel}`}>
      <span className="truncate">{task.text}</span>
    </div>
  );
}

function ScaleSwitcher({ value, onChange }: { value: TimelineScale; onChange: (value: TimelineScale) => void }) {
  useLocale();
  return (
    <div className="ui-segmented" role="group" aria-label={t("时间尺度")}>
      {([['day', t("日")], ['week', t("周")], ['month', t("月")]] as const).map(([id, label]) => (
        <button key={id} type="button" onClick={() => onChange(id)} aria-pressed={value === id} className="ui-segmented-item min-w-8">
          {label}
        </button>
      ))}
    </div>
  );
}

function UnplannedFeatureDrawer({ canManage, features, total, search, onSearch, onClose, onAssign }: {
  canManage: boolean;
  features: Feature[];
  total: number;
  search: string;
  onSearch: (value: string) => void;
  onClose: () => void;
  onAssign: (feature: Feature) => void;
}) {
  useLocale();
  return (
    <div className="fixed inset-0 z-50 bg-slate-950/35" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside role="dialog" aria-modal="true" aria-labelledby="unplanned-title" className="ml-auto flex h-full w-full max-w-md flex-col bg-white shadow-2xl">
        <header className="border-b border-slate-200 px-5 py-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-amber-700">PLAN INBOX</p>
              <h2 id="unplanned-title" className="mt-1 text-xl font-bold text-slate-950">{t("待规划 Feature")}</h2>
              <p className="mt-1 text-xs text-slate-500">{t("把尚未进入路线图的 Feature 安排到里程碑。")}</p>
            </div>
            <button type="button" onClick={onClose} className="ui-button ui-button-secondary">{t("关闭")}</button>
          </div>
          <div className="relative mt-4">
            <SearchIcon />
            <input value={search} onChange={(event) => onSearch(event.target.value)} placeholder={t("搜索待规划 Feature")} className="w-full rounded-lg border border-slate-300 py-2.5 pl-9 pr-3 text-sm outline-none focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100" />
          </div>
        </header>
        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          {features.map((feature) => (
            <article key={feature.code} className="rounded-xl border border-slate-200 p-4 transition hover:border-cyan-200 hover:bg-cyan-50/30">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-slate-900">{feature.title}</h3>
                  <p className="mt-1 text-xs text-slate-500">{feature.module_name ?? t("未归属模块")}</p>
                </div>
                {canManage && <button type="button" onClick={() => onAssign(feature)} className="ui-button ui-button-strong ui-button-compact shrink-0">{t("安排")}</button>}
              </div>
              {feature.goal && <p className="mt-3 line-clamp-2 text-xs leading-5 text-slate-500">{feature.goal}</p>}
            </article>
          ))}
          {features.length === 0 && <EmptyHint title={total === 0 ? t("没有待规划 Feature") : t("没有匹配结果")} description={total === 0 ? t("所有 Feature 都已进入里程碑。") : t("换一个关键词再试。")} />}
        </div>
        <footer className="border-t border-slate-200 bg-slate-50 px-5 py-3 text-xs text-slate-500">{t("共 {count} 条待规划 Feature", { count: total })}</footer>
      </aside>
    </div>
  );
}

function Metric({ value, label }: { value: number; label: string }) {
  useLocale();
  return <span className="inline-flex items-baseline gap-1"><strong className="font-semibold text-slate-800">{value}</strong>{label}</span>;
}

function Legend({ color, label }: { color: string; label: string }) {
  useLocale();
  return <span className="inline-flex items-center gap-1.5"><span className={`h-2.5 w-2.5 rounded-sm ${color}`} />{label}</span>;
}

function RoadmapIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M5 5v14M9 8h10l-2 3 2 3H9z" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function PlusIcon() {
  return <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5 shrink-0"><path d="M10 4v12M4 10h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>;
}

function SearchIcon() {
  return <svg className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" strokeLinecap="round" /></svg>;
}

function highlightTimelineCell(date: Date): string {
  const today = new Date();
  if (date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate()) return 'acp-gantt-today';
  if (date.getDay() === 0 || date.getDay() === 6) return 'acp-gantt-weekend';
  return '';
}

type SelectedPlanEntity =
  | { kind: 'phase'; name: string; schedule: string; value: ProjectPhase }
  | { kind: 'milestone'; name: string; schedule: string; value: ProjectMilestone }
  | { kind: 'feature'; name: string; schedule: string; value: Feature };

function resolveSelectedEntity(
  selectedTaskId: string | null,
  phaseMap: Map<string, ProjectPhase>,
  milestoneMap: Map<string, ProjectMilestone>,
  features: Feature[],
): SelectedPlanEntity | null {
  const parsed = parseGanttTaskId(selectedTaskId);
  if (!parsed) return null;
  if (parsed.kind === 'phase') {
    const phase = phaseMap.get(parsed.code);
    return phase ? { kind: 'phase', name: phase.name, schedule: `${formatTimelineDate(phase.start_at)}—${formatTimelineDate(phase.end_at)}`, value: phase } : null;
  }
  if (parsed.kind === 'milestone') {
    const milestone = milestoneMap.get(parsed.code);
    return milestone ? { kind: 'milestone', name: milestone.name, schedule: `${formatTimelineDate(milestone.start_at)}—${formatTimelineDate(milestone.target_at)}`, value: milestone } : null;
  }
  const feature = features.find((item) => item.code === parsed.code);
  return feature ? { kind: 'feature', name: feature.title, schedule: feature.start_at && feature.end_at ? `${formatTimelineDate(feature.start_at)}—${formatTimelineDate(feature.end_at)}` : t("待安排"), value: feature } : null;
}

function PhaseDialog({
  state,
  pending,
  error,
  onClose,
  onSubmit,
}: {
  state: PhaseDialogState;
  pending: boolean;
  error: Error | null;
  onClose: () => void;
  onSubmit: (input: CreateProjectPhaseInput) => void;
}) {
  useLocale();
  const initial = state.mode === 'edit' ? state.phase : null;
  const [name, setName] = useState(initial?.name ?? '');
  const [summary, setSummary] = useState(initial?.summary ?? '');
  const [order, setOrder] = useState(initial?.order ? String(initial.order) : '');
  const [status, setStatus] = useState(initial?.status ?? 'planned');
  const [startAt, setStartAt] = useState(initial?.start_at ?? '');
  const [endAt, setEndAt] = useState(initial?.end_at ?? '');

  useEffect(() => {
    setName(initial?.name ?? '');
    setSummary(initial?.summary ?? '');
    setOrder(initial?.order ? String(initial.order) : '');
    setStatus(initial?.status ?? 'planned');
    setStartAt(initial?.start_at ?? '');
    setEndAt(initial?.end_at ?? '');
  }, [initial?.code, initial?.name, initial?.summary, initial?.order, initial?.status, initial?.start_at, initial?.end_at]);

  function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit({
      name: name.trim(),
      summary: summary.trim() || undefined,
      status,
      order: Number(order) || undefined,
      start_at: startAt.trim() || null,
      end_at: endAt.trim() || null,
    });
  }

  return (
    <ModalShell title={state.mode === 'create' ? t("新建阶段") : t("编辑阶段")} eyebrow="PHASE" description={t("阶段是计划甘特图的一级排期容器。")} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="space-y-5 p-6">
          <Field label={t("阶段名称")}><input autoFocus required value={name} onChange={(event) => setName(event.target.value)} className="form-control" /></Field>
          <Field label={t("阶段摘要")}><textarea rows={4} value={summary} onChange={(event) => setSummary(event.target.value)} className="form-control resize-y leading-6" /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("开始日期")}><input type="date" value={startAt} onChange={(event) => setStartAt(event.target.value)} className="form-control" /></Field>
            <Field label={t("结束日期")}><input type="date" value={endAt} onChange={(event) => setEndAt(event.target.value)} className="form-control" /></Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("排序")}><input type="number" min={0} value={order} onChange={(event) => setOrder(event.target.value)} className="form-control" /></Field>
            <Field label={t("状态")}><select value={status} onChange={(event) => setStatus(event.target.value)} className="form-control bg-white">{PHASE_STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></Field>
          </div>
          {error && <ErrorMessage prefix={t("保存失败")} error={error} />}
        </div>
        <ModalFooter onClose={onClose} pending={pending} submitLabel={state.mode === 'create' ? t("创建阶段") : t("保存阶段")} disabled={!name.trim()} />
      </form>
    </ModalShell>
  );
}

function MilestoneDialog({
  state,
  phases,
  pending,
  error,
  onClose,
  onSubmit,
}: {
  state: MilestoneDialogState;
  phases: ProjectPhase[];
  pending: boolean;
  error: Error | null;
  onClose: () => void;
  onSubmit: (input: CreateProjectMilestoneInput) => void;
}) {
  useLocale();
  const initial = state.mode === 'edit' ? state.milestone : null;
  const [name, setName] = useState(initial?.name ?? '');
  const [summary, setSummary] = useState(initial?.summary ?? '');
  const [phaseCode, setPhaseCode] = useState(initial?.phase_code ?? (state.mode === 'create' ? state.phaseCode ?? '' : ''));
  const [order, setOrder] = useState(initial?.order ? String(initial.order) : '');
  const [status, setStatus] = useState(initial?.status ?? 'planned');
  const [startAt, setStartAt] = useState(initial?.start_at ?? '');
  const [targetAt, setTargetAt] = useState(initial?.target_at ?? '');

  useEffect(() => {
    setName(initial?.name ?? '');
    setSummary(initial?.summary ?? '');
    setPhaseCode(initial?.phase_code ?? (state.mode === 'create' ? state.phaseCode ?? '' : ''));
    setOrder(initial?.order ? String(initial.order) : '');
    setStatus(initial?.status ?? 'planned');
    setStartAt(initial?.start_at ?? '');
    setTargetAt(initial?.target_at ?? '');
  }, [initial?.code, initial?.name, initial?.summary, initial?.phase_code, initial?.order, initial?.status, initial?.start_at, initial?.target_at, state.mode, state.mode === 'create' ? state.phaseCode : null]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const phase = phases.find((item) => item.code === phaseCode) ?? null;
    onSubmit({
      name: name.trim(),
      summary: summary.trim() || undefined,
      phase_code: phaseCode || null,
      phase_name: phase?.name ?? null,
      order: Number(order) || undefined,
      start_at: startAt.trim() || null,
      target_at: targetAt.trim() || null,
      status,
    });
  }

  return (
    <ModalShell title={state.mode === 'create' ? t("新建里程碑") : t("编辑里程碑")} eyebrow="MILESTONE" description={t("里程碑承接阶段排期，并汇聚对应的 Feature。")} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="space-y-5 p-6">
          <Field label={t("里程碑名称")}><input autoFocus required value={name} onChange={(event) => setName(event.target.value)} className="form-control" /></Field>
          <Field label={t("里程碑摘要")}><textarea rows={4} value={summary} onChange={(event) => setSummary(event.target.value)} className="form-control resize-y leading-6" /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("所属阶段")}><select value={phaseCode} onChange={(event) => setPhaseCode(event.target.value)} className="form-control bg-white"><option value="">{t("暂不归属")}</option>{phases.map((phase) => <option key={phase.code} value={phase.code}>{phase.name} · {phase.code}</option>)}</select></Field>
            <Field label={t("排序")}><input type="number" min={0} value={order} onChange={(event) => setOrder(event.target.value)} className="form-control" /></Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label={t("开始日期")}><input type="date" value={startAt} onChange={(event) => setStartAt(event.target.value)} className="form-control" /></Field>
            <Field label={t("目标日期")}><input type="date" value={targetAt} onChange={(event) => setTargetAt(event.target.value)} className="form-control" /></Field>
            <Field label={t("状态")}><select value={status} onChange={(event) => setStatus(event.target.value)} className="form-control bg-white">{MILESTONE_STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></Field>
          </div>
          {error && <ErrorMessage prefix={t("保存失败")} error={error} />}
        </div>
        <ModalFooter onClose={onClose} pending={pending} submitLabel={state.mode === 'create' ? t("创建里程碑") : t("保存里程碑")} disabled={!name.trim()} />
      </form>
    </ModalShell>
  );
}

function AssignmentDialog({
  feature,
  milestones,
  phase,
  pending,
  error,
  onClose,
  onSubmit,
}: {
  feature: Feature;
  milestones: ProjectMilestone[];
  phase: ProjectPhase | null;
  pending: boolean;
  error: Error | null;
  onClose: () => void;
  onSubmit: (input: UpdateFeatureInput) => void;
}) {
  useLocale();
  const [milestoneCode, setMilestoneCode] = useState(feature.milestone_code ?? '');
  const [startDate, setStartDate] = useState(feature.start_at ?? '');
  const [endDate, setEndDate] = useState(feature.end_at ?? '');

  useEffect(() => {
    setMilestoneCode(feature.milestone_code ?? '');
    setStartDate(feature.start_at ?? '');
    setEndDate(feature.end_at ?? '');
  }, [feature.code, feature.end_at, feature.milestone_code, feature.start_at]);

  const selectedMilestone = milestones.find((milestone) => milestone.code === milestoneCode) ?? null;

  function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit({
      milestone_code: selectedMilestone?.code ?? null,
      milestone_name: selectedMilestone?.name ?? null,
      start_date: selectedMilestone ? (startDate || null) : null,
      end_date: selectedMilestone ? (endDate || null) : null,
    });
  }

  const incompleteDates = Boolean(startDate) !== Boolean(endDate);
  const hasMilestoneWindow = Boolean(selectedMilestone?.start_at && selectedMilestone?.target_at);

  return (
    <ModalShell title={t("安排 Feature 排期")} eyebrow={feature.code} description={t("Feature 使用自己的起止日期，并且必须落在目标里程碑窗口内。")} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="space-y-5 p-6">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <h3 className="text-sm font-bold text-slate-900">{feature.title}</h3>
            <code className="mt-1 block text-[11px] text-slate-400">{feature.code}</code>
            <div className="mt-3 flex flex-wrap gap-1.5 text-[10px] font-semibold">
              <span className="rounded-full bg-white px-2 py-1 text-slate-600 ring-1 ring-slate-200">{feature.module_name ?? feature.module_code ?? t("未归属模块")}</span>
              <span className="rounded-full bg-white px-2 py-1 text-slate-600 ring-1 ring-slate-200">{feature.milestone_name ?? feature.milestone_code ?? t("未规划里程碑")}</span>
            </div>
            {phase && <p className="mt-3 text-xs text-cyan-800">{t("当前阶段：")}{phase.name}</p>}
          </div>

          <Field label={t("目标里程碑")}>
            <select value={milestoneCode} onChange={(event) => {
              setMilestoneCode(event.target.value);
              if (!event.target.value) {
                setStartDate('');
                setEndDate('');
              }
            }} className="form-control bg-white">
              <option value="">{t("取消规划")}</option>
              {milestones.map((milestone) => <option key={milestone.code} value={milestone.code}>{milestone.name} · {milestone.code}</option>)}
            </select>
          </Field>
          {selectedMilestone && (
            <div className={`rounded-lg px-3 py-2 text-xs ${hasMilestoneWindow ? 'bg-cyan-50 text-cyan-800' : 'bg-amber-50 text-amber-800'}`}>
              <p>{t("里程碑窗口：")}<strong>{selectedMilestone.name}</strong>{selectedMilestone.phase_name ? ` · ${selectedMilestone.phase_name}` : ''}</p>
              <p className="mt-1 font-semibold">{hasMilestoneWindow ? `${formatTimelineDate(selectedMilestone.start_at)}—${formatTimelineDate(selectedMilestone.target_at)}` : t("请先为该里程碑设置完整日期")}</p>
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("Feature 开始日期")}><input type="date" value={startDate} min={selectedMilestone?.start_at ?? undefined} max={selectedMilestone?.target_at ?? undefined} disabled={!selectedMilestone || !hasMilestoneWindow} onChange={(event) => setStartDate(event.target.value)} className="form-control disabled:bg-slate-100" /></Field>
            <Field label={t("Feature 结束日期")}><input type="date" value={endDate} min={startDate || selectedMilestone?.start_at || undefined} max={selectedMilestone?.target_at ?? undefined} disabled={!selectedMilestone || !hasMilestoneWindow} onChange={(event) => setEndDate(event.target.value)} className="form-control disabled:bg-slate-100" /></Field>
          </div>
          {incompleteDates && <p className="text-xs font-semibold text-amber-700">{t("开始日期和结束日期需要同时填写；两项都留空表示暂未排期。")}</p>}
          {error && <ErrorMessage prefix={t("保存失败")} error={error} />}
        </div>
        <ModalFooter onClose={onClose} pending={pending} submitLabel={t("保存排期")} disabled={incompleteDates} />
      </form>
    </ModalShell>
  );
}

function ModalShell({ title, eyebrow, description, children, onClose }: { title: string; eyebrow: string; description: string; children: ReactNode; onClose?: () => void }) {
  useLocale();
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/55 p-4" role="presentation">
      <section role="dialog" aria-modal="true" aria-labelledby="modal-title" className="max-h-[94vh] w-full max-w-5xl overflow-y-auto rounded-2xl bg-white shadow-2xl">
        <header className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-slate-200 bg-white px-6 py-5">
          <div>
            <p className="text-xs font-bold tracking-[0.16em] text-cyan-700">{eyebrow}</p>
            <h2 id="modal-title" className="mt-1 text-xl font-bold text-slate-950">{title}</h2>
            <p className="mt-1 text-xs text-slate-500">{description}</p>
          </div>
          <button type="button" onClick={onClose} aria-label={t("关闭弹窗")} className="ui-button ui-button-secondary">{t("关闭")}</button>
        </header>
        {children}
      </section>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  useLocale();
  return <label className="block text-sm font-semibold text-slate-700">{label}<div className="mt-1.5">{children}</div></label>;
}

function ModalFooter({ onClose, pending, submitLabel, disabled }: { onClose: () => void; pending: boolean; submitLabel: string; disabled: boolean }) {
  useLocale();
  return <footer className="sticky bottom-0 flex justify-end gap-2 border-t border-slate-200 bg-white px-6 py-4"><button type="button" onClick={onClose} className="ui-button ui-button-secondary">{t("取消")}</button><button disabled={pending || disabled} className="ui-button ui-button-primary">{pending ? t("保存中…") : submitLabel}</button></footer>;
}

function NoticeBar({ notice, onClose }: { notice: Parameters<typeof t>; onClose: () => void }) {
  useLocale();
  return <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700"><span>{t(...notice)}</span><button type="button" onClick={onClose} className="text-xs font-bold">{t("关闭")}</button></div>;
}

function EmptyHint({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  useLocale();
  return <div className="rounded-xl border border-dashed border-slate-300 px-5 py-8 text-center"><h3 className="text-sm font-bold text-slate-800">{title}</h3><p className="mt-2 text-xs leading-5 text-slate-500">{description}</p>{action}</div>;
}

function ErrorMessage({ prefix, error }: { prefix: string; error: Error }) {
  useLocale();
  return <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{prefix}：{error.message}</p>;
}

function WorkbenchLoading({ label }: { label: string }) {
  useLocale();
  return <div className="flex min-h-56 flex-1 items-center justify-center bg-slate-50 text-sm text-slate-500">{label}</div>;
}

function WorkbenchError({ error }: { error: unknown }) {
  useLocale();
  return <div className="m-7 rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-700">{t("无法连接 core-api：")}{error instanceof Error ? error.message : String(error)}</div>;
}
