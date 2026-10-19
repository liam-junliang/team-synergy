import { useProjectAccess } from './useProjectAccess';
import { useLocale } from './useLocale';
import { t } from './i18n.ts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type DragEvent as ReactDragEvent, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import {
  createFeature,
  createProjectModule,
  listFeatures,
  listProjectModules,
  reorderFeatures,
  reorderProjectModules,
  updateFeature,
  updateProjectModule,
  type CreateFeatureInput,
  type CreateProjectModuleInput,
  type Feature,
  type ProjectModule,
  type UpdateFeatureInput,
  type UpdateProjectModuleInput,
} from './api';
import { useProjectDisplayNames } from './ProjectDisplayNames';
import { moveItemByCode, moveItemByOffset } from './projectManagement';

type ModuleDialogState = { mode: 'create' } | { mode: 'edit'; module: ProjectModule; activeFeatureCount: number };
type FeatureDialogState = { mode: 'create'; moduleCode?: string | null } | { mode: 'edit'; feature: Feature };

const FEATURE_STATUS_OPTIONS = [
  { value: 'active', get label() { return t("进行中"); } },
  { value: 'delivered', get label() { return t("已交付"); } },
] as const;

export function initializeModuleSelection(selection: string | null | undefined, modules: ProjectModule[]): string | null {
  if (selection !== undefined) return selection;
  return modules[0]?.code ?? null;
}

export function ProjectStructureWorkbench({ projectCode }: { projectCode: string }) {
  useLocale();
  const queryClient = useQueryClient();
  const { canManage } = useProjectAccess(projectCode);
  const { projectName, moduleName } = useProjectDisplayNames();
  const [search, setSearch] = useState('');
  const [selectedModuleCode, setSelectedModuleCode] = useState<string | null | undefined>(undefined);
  const [moduleDialog, setModuleDialog] = useState<ModuleDialogState | null>(null);
  const [featureDialog, setFeatureDialog] = useState<FeatureDialogState | null>(null);
  const [notice, setNotice] = useState<Parameters<typeof t> | null>(null);
  const [draggingModuleCode, setDraggingModuleCode] = useState<string | null>(null);
  const [moduleDropTargetCode, setModuleDropTargetCode] = useState<string | null>(null);
  const [draggingFeatureCode, setDraggingFeatureCode] = useState<string | null>(null);
  const [featureDropTargetCode, setFeatureDropTargetCode] = useState<string | null>(null);

  const modulesQuery = useQuery({
    queryKey: ['project-modules', projectCode],
    queryFn: () => listProjectModules(projectCode),
    enabled: Boolean(projectCode),
  });
  const featuresQuery = useQuery({
    queryKey: ['features', projectCode],
    queryFn: () => listFeatures(projectCode),
    enabled: Boolean(projectCode),
  });
  const modules = modulesQuery.data ?? [];
  const features = featuresQuery.data ?? [];
  const moduleMap = useMemo(() => new Map(modules.map((item) => [item.code, item])), [modules]);

  useEffect(() => {
    setSelectedModuleCode(undefined);
  }, [projectCode]);

  useEffect(() => {
    if (modulesQuery.isLoading || selectedModuleCode !== undefined) return;
    setSelectedModuleCode(initializeModuleSelection(selectedModuleCode, modules));
  }, [modules, modulesQuery.isLoading, selectedModuleCode]);

  const filteredFeatures = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return features.filter((feature) => {
      const matchesModule = !selectedModuleCode || feature.module_code === selectedModuleCode || feature.module_name === moduleMap.get(selectedModuleCode)?.name;
      const matchesSearch = !needle || [
        feature.code,
        feature.title,
        feature.goal ?? '',
        feature.module_code ?? '',
        feature.module_name ?? '',
      ].join(' ').toLocaleLowerCase().includes(needle);
      return matchesModule && matchesSearch;
    });
  }, [features, moduleMap, search, selectedModuleCode]);

  const featureSortingEnabled = canManage && search.trim().length === 0 && filteredFeatures.length > 1;
  const moduleFeatureCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const feature of features) {
      if (feature.status === 'archived') continue;
      const key = feature.module_code ?? feature.module_name ?? '';
      if (!key) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [features]);

  const createModuleMutation = useMutation({
    mutationFn: (input: CreateProjectModuleInput) => createProjectModule(projectCode, input),
    onSuccess: (module) => {
      setSelectedModuleCode(module.code);
      setModuleDialog(null);
      setNotice(["模块「{p0}」已保存", { p0: module.name }]);
      void queryClient.invalidateQueries({ queryKey: ['project-modules', projectCode] });
    },
  });
  const updateModuleMutation = useMutation({
    mutationFn: ({ moduleCode, input }: { moduleCode: string; input: UpdateProjectModuleInput }) => updateProjectModule(projectCode, moduleCode, input),
    onSuccess: (module) => {
      setSelectedModuleCode(module.code);
      setModuleDialog(null);
      setNotice(["模块「{p0}」已更新", { p0: module.name }]);
      void queryClient.invalidateQueries({ queryKey: ['project-modules', projectCode] });
    },
  });
  const updateModuleLifecycleMutation = useMutation({
    mutationFn: ({ module, status }: { module: ProjectModule; status: 'active' | 'archived' }) => updateProjectModule(projectCode, module.code, { status }),
    onSuccess: (module) => {
      setModuleDialog(null);
      setNotice(module.status === 'archived' ? ['模块「{name}」已归档', { name: module.name }] : ['模块「{name}」已恢复', { name: module.name }]);
      void queryClient.invalidateQueries({ queryKey: ['project-modules', projectCode] });
    },
  });
  const createFeatureMutation = useMutation({
    mutationFn: (input: CreateFeatureInput) => createFeature(input),
    onSuccess: (feature) => {
      setFeatureDialog(null);
      setNotice(["Feature「{p0}」已保存", { p0: feature.title }]);
      void queryClient.invalidateQueries({ queryKey: ['features', projectCode] });
      void queryClient.invalidateQueries({ queryKey: ['project-modules', projectCode] });
    },
  });
  const updateFeatureMutation = useMutation({
    mutationFn: ({ featureCode, input }: { featureCode: string; input: UpdateFeatureInput }) => updateFeature(featureCode, input, projectCode),
    onSuccess: (feature) => {
      setFeatureDialog(null);
      setNotice(["Feature「{p0}」已更新", { p0: feature.title }]);
      void queryClient.invalidateQueries({ queryKey: ['features', projectCode] });
      void queryClient.invalidateQueries({ queryKey: ['project-modules', projectCode] });
    },
  });
  const reorderModulesMutation = useMutation({
    mutationFn: (moduleCodes: string[]) => reorderProjectModules(projectCode, moduleCodes),
    onMutate: async (moduleCodes) => {
      const queryKey = ['project-modules', projectCode] as const;
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<ProjectModule[]>(queryKey) ?? [];
      const byCode = new Map(previous.map((module) => [module.code, module]));
      queryClient.setQueryData(queryKey, moduleCodes.map((code, order) => ({ ...byCode.get(code)!, order })));
      return { previous };
    },
    onError: (_error, _moduleCodes, context) => {
      if (context?.previous) queryClient.setQueryData(['project-modules', projectCode], context.previous);
    },
    onSuccess: () => setNotice(["模块顺序已保存"]),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['project-modules', projectCode] }),
  });
  const reorderFeaturesMutation = useMutation({
    mutationFn: (featureCodes: string[]) => reorderFeatures(projectCode, featureCodes),
    onMutate: async (featureCodes) => {
      const queryKey = ['features', projectCode] as const;
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<Feature[]>(queryKey) ?? [];
      const byCode = new Map(previous.map((feature) => [feature.code, feature]));
      queryClient.setQueryData(queryKey, featureCodes.map((code, order) => ({ ...byCode.get(code)!, order })));
      return { previous };
    },
    onError: (_error, _featureCodes, context) => {
      if (context?.previous) queryClient.setQueryData(['features', projectCode], context.previous);
    },
    onSuccess: () => setNotice(["Feature 顺序已保存"]),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['features', projectCode] }),
  });

  function openCreateModule() {
    if (!canManage) return;
    createModuleMutation.reset();
    setModuleDialog({ mode: 'create' });
  }

  function openEditModule(module: ProjectModule) {
    if (!canManage) return;
    updateModuleMutation.reset();
    updateModuleLifecycleMutation.reset();
    setModuleDialog({ mode: 'edit', module, activeFeatureCount: moduleFeatureCounts.get(module.code) ?? moduleFeatureCounts.get(module.name) ?? 0 });
  }

  function openCreateFeature(moduleCode?: string | null) {
    if (!canManage) return;
    createFeatureMutation.reset();
    setFeatureDialog({ mode: 'create', moduleCode: moduleCode ?? selectedModuleCode ?? null });
  }

  function openEditFeature(feature: Feature) {
    if (!canManage) return;
    updateFeatureMutation.reset();
    setFeatureDialog({ mode: 'edit', feature });
  }

  function commitModuleOrder(nextModules: ProjectModule[]) {
    if (!canManage) return;
    if (reorderModulesMutation.isPending || nextModules.every((module, index) => module.code === modules[index]?.code)) return;
    reorderModulesMutation.mutate(nextModules.map((module) => module.code));
  }

  function commitFeatureOrder(nextVisibleFeatures: Feature[]) {
    if (!canManage) return;
    if (reorderFeaturesMutation.isPending || nextVisibleFeatures.every((feature, index) => feature.code === filteredFeatures[index]?.code)) return;
    const visibleCodes = new Set(nextVisibleFeatures.map((feature) => feature.code));
    let visibleIndex = 0;
    const nextFeatures = features.map((feature) => visibleCodes.has(feature.code) ? nextVisibleFeatures[visibleIndex++]! : feature);
    reorderFeaturesMutation.mutate(nextFeatures.map((feature) => feature.code));
  }

  function dropModule(event: ReactDragEvent, targetCode: string) {
    event.preventDefault();
    if (draggingModuleCode) commitModuleOrder(moveItemByCode(modules, draggingModuleCode, targetCode));
    setDraggingModuleCode(null);
    setModuleDropTargetCode(null);
  }

  function dropFeature(event: ReactDragEvent, targetCode: string) {
    event.preventDefault();
    if (draggingFeatureCode) commitFeatureOrder(moveItemByCode(filteredFeatures, draggingFeatureCode, targetCode));
    setDraggingFeatureCode(null);
    setFeatureDropTargetCode(null);
  }

  function moveModuleWithKeyboard(event: ReactKeyboardEvent, moduleCode: string) {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    commitModuleOrder(moveItemByOffset(modules, moduleCode, event.key === 'ArrowUp' ? -1 : 1));
  }

  function moveFeatureWithKeyboard(event: ReactKeyboardEvent, featureCode: string) {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    commitFeatureOrder(moveItemByOffset(filteredFeatures, featureCode, event.key === 'ArrowUp' ? -1 : 1));
  }

  if (!projectCode) return <WorkbenchError error={t("缺少项目编码")} />;
  if (modulesQuery.isLoading || featuresQuery.isLoading) return <WorkbenchLoading label={t("正在加载功能模块…")} />;
  if (modulesQuery.error || featuresQuery.error) return <WorkbenchError error={modulesQuery.error ?? featuresQuery.error} />;

  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-slate-50 p-5 lg:p-7">
      <section className="mx-auto max-w-[1600px]">
        <header className="mb-5">
          <div>
            <p className="text-xs font-bold tracking-[0.18em] text-cyan-700">FUNCTION MODULES</p>
            <h1 className="mt-1 text-2xl font-bold text-slate-950">{projectName || t("项目")} {t("· 功能模块")}</h1>
          </div>
        </header>

        {notice && <NoticeBar notice={notice} onClose={() => setNotice(null)} />}

        <section className="mb-4 grid gap-px overflow-hidden rounded-2xl border border-slate-200 bg-slate-200 shadow-sm sm:grid-cols-3">
          <SummaryCell label={t("模块")} value={t("{p0} 个", { p0: modules.length })} />
          <SummaryCell label="Feature" value={t("{p0} 条", { p0: features.length })} />
          <SummaryCell label={t("未归属 Feature")} value={t("{p0} 条", { p0: features.filter((feature) => !feature.module_code && !feature.module_name).length })} tone="text-amber-700" />
        </section>

        <section className="grid gap-5 xl:grid-cols-[320px_minmax(0,1fr)]">
          <aside className="space-y-4">
            <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
              <div className="border-b border-slate-200 px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h2 className="text-sm font-bold text-slate-900">{t("模块列表")}</h2>
                    <p className="mt-0.5 text-[11px] text-slate-400">{t("点击聚焦对应 Feature")}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button type="button" onClick={() => setSelectedModuleCode(null)} aria-pressed={selectedModuleCode === null} className={`ui-context-action ${selectedModuleCode === null ? 'ui-context-action-selected' : ''}`}><StructureModulesIcon />{t("全部")}</button>
                    {canManage && <button type="button" onClick={openCreateModule} className="ui-button ui-button-secondary ui-button-compact"><StructurePlusIcon />{t("新增模块")}</button>}
                  </div>
                </div>
              </div>
              <div className="space-y-2 p-3">
                {modules.map((module) => (
                  <article
                    key={module.code}
                    onDragEnter={() => setModuleDropTargetCode(module.code)}
                    onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }}
                    onDrop={(event) => dropModule(event, module.code)}
                    className={`group/module relative rounded-xl border transition ${selectedModuleCode === module.code ? 'border-cyan-300 bg-cyan-50/60' : 'border-slate-200 bg-white hover:bg-slate-50'} ${draggingModuleCode === module.code ? 'opacity-45' : ''} ${draggingModuleCode && moduleDropTargetCode === module.code ? 'ring-2 ring-cyan-300 ring-offset-1' : ''}`}
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedModuleCode(module.code)}
                      aria-pressed={selectedModuleCode === module.code}
                      aria-label={t("筛选模块：{p0}", { p0: module.name })}
                      className="block w-full rounded-xl p-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-500"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h3 className="truncate text-sm font-semibold text-slate-900">{module.name}</h3>
                          <code className="mt-1 block break-all text-[11px] text-slate-400">{module.code}</code>
                        </div>
                        <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600">
                          {moduleFeatureCounts.get(module.code) ?? 0}
                        </span>
                      </div>
                      {module.summary && <p className="mt-2 line-clamp-3 text-xs leading-5 text-slate-500">{module.summary}</p>}
                      <div className="mt-3 pr-24">
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${module.status === 'archived' ? 'bg-slate-100 text-slate-500' : 'bg-emerald-100 text-emerald-700'}`}>{module.status === 'archived' ? t("已归档") : t("启用中")}</span>
                      </div>
                    </button>
                    <div className="absolute bottom-3 right-3 flex items-center gap-1">
                      {canManage && <button type="button" draggable={modules.length > 1 && !reorderModulesMutation.isPending} disabled={modules.length < 2 || reorderModulesMutation.isPending} onDragStart={(event) => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', module.code); setDraggingModuleCode(module.code); }} onDragEnd={() => { setDraggingModuleCode(null); setModuleDropTargetCode(null); }} onKeyDown={(event) => moveModuleWithKeyboard(event, module.code)} aria-label={t("调整模块顺序：{p0}", { p0: module.name })} title={modules.length > 1 ? t("拖动排序；聚焦后按上下方向键移动") : t("当前只有一个模块")} className="grid h-7 w-7 cursor-grab place-items-center rounded-md text-slate-300 opacity-0 transition hover:bg-white hover:text-slate-600 hover:shadow-sm focus:cursor-grabbing focus:bg-white focus:text-cyan-700 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-cyan-400 group-hover/module:opacity-100 disabled:cursor-default disabled:opacity-0"><StructureDragHandleIcon /></button>}
                      {canManage && <button type="button" onClick={() => openEditModule(module)} aria-label={t("编辑模块：{p0}", { p0: module.name })} title={t("编辑模块")} className="ui-context-action"><StructureEditIcon />{t("编辑")}</button>}
                    </div>
                  </article>
                ))}
                {modules.length === 0 && <EmptyHint title={t("还没有模块")} description={t("先创建模块，再把 Feature 归入结构树。")} action={(canManage && <button type="button" onClick={openCreateModule} className="ui-button ui-button-primary mt-4">{t("新建模块")}</button>)} />}
              </div>
              {reorderModulesMutation.error && <p role="alert" className="border-t border-red-100 bg-red-50 px-4 py-2 text-xs text-red-700">{t("模块排序保存失败：")}{reorderModulesMutation.error.message}</p>}
            </div>
          </aside>

          <section className="min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
              <div className="min-w-0">
                <h2 className="text-sm font-bold text-slate-900">{t("Feature 列表")}</h2>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <input value={search} onChange={(event) => setSearch(event.target.value)} aria-label={t("搜索 Feature")} placeholder={t("搜索 Feature、模块")} className="h-8 w-64 rounded-lg border border-slate-200 bg-white px-3 !text-[12px] !font-medium !leading-4 text-slate-700 shadow-sm outline-none placeholder:!text-[12px] placeholder:!font-medium placeholder:text-slate-500 placeholder:opacity-100 focus:border-cyan-400 focus:ring-2 focus:ring-cyan-100" />
                {canManage && <button type="button" onClick={() => openCreateFeature(selectedModuleCode)} className="ui-button ui-button-secondary"><StructurePlusIcon />{t("新增 Feature")}</button>}
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="min-w-[760px] w-full border-collapse text-left text-sm">
                <thead className="bg-slate-50 text-[11px] font-bold uppercase tracking-wider text-slate-400">
                  <tr>
                    <th className="w-12 px-3 py-3"><span className="sr-only">{t("排序")}</span></th>
                    <th className="px-5 py-3">Feature</th>
                    <th className="px-4 py-3">{t("模块")}</th>
                    <th className="px-4 py-3">{t("状态")}</th>
                    <th className="px-5 py-3 text-right">{t("操作")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredFeatures.map((feature) => {
                    const moduleLabel = feature.module_name ?? (moduleName(feature.module_code) || feature.module_code || t("未归属模块"));
                    return (
                      <tr
                        key={feature.code}
                        onDragEnter={() => setFeatureDropTargetCode(feature.code)}
                        onDragOver={(event) => { if (featureSortingEnabled) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } }}
                        onDrop={(event) => dropFeature(event, feature.code)}
                        className={`group/feature align-top transition hover:bg-slate-50/70 ${draggingFeatureCode === feature.code ? 'opacity-45' : ''} ${draggingFeatureCode && featureDropTargetCode === feature.code ? 'bg-cyan-50 ring-2 ring-inset ring-cyan-300' : ''}`}
                      >
                        <td className="px-3 py-4 align-middle">
                          {canManage && <button type="button" draggable={featureSortingEnabled && !reorderFeaturesMutation.isPending} disabled={!featureSortingEnabled || reorderFeaturesMutation.isPending} onDragStart={(event) => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', feature.code); setDraggingFeatureCode(feature.code); }} onDragEnd={() => { setDraggingFeatureCode(null); setFeatureDropTargetCode(null); }} onKeyDown={(event) => moveFeatureWithKeyboard(event, feature.code)} aria-label={t("调整 Feature 顺序：{p0}", { p0: feature.title })} title={search.trim() ? t("清除搜索后可调整顺序") : featureSortingEnabled ? t("拖动排序；聚焦后按上下方向键移动") : t("当前列表不足两项")} className="mx-auto grid h-7 w-7 cursor-grab place-items-center rounded-md text-slate-300 opacity-50 transition hover:bg-white hover:text-slate-600 hover:shadow-sm focus:cursor-grabbing focus:text-cyan-700 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-cyan-400 group-hover/feature:opacity-100 disabled:cursor-default disabled:opacity-20"><StructureDragHandleIcon /></button>}
                        </td>
                        <td className="px-5 py-4">
                          <div className="font-semibold text-slate-900">{feature.title}</div>
                          <code className="mt-1 block text-[11px] text-slate-400">{feature.code}</code>
                          {feature.goal && <p className="mt-2 line-clamp-2 max-w-2xl text-xs leading-5 text-slate-500">{feature.goal}</p>}
                        </td>
                        <td className="px-4 py-4">
                          <div className="min-w-0">
                            <div className="text-sm font-semibold text-slate-700">{moduleLabel}</div>
                            <code className="mt-1 block text-[11px] text-slate-400">{feature.module_code ?? '—'}</code>
                          </div>
                        </td>
                        <td className="px-4 py-4">
                          <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${feature.status === 'delivered' ? 'bg-emerald-100 text-emerald-700' : feature.status === 'archived' ? 'bg-slate-100 text-slate-500' : 'bg-cyan-100 text-cyan-700'}`}>
                            {feature.status === 'archived' ? t("已归档") : FEATURE_STATUS_OPTIONS.find((option) => option.value === feature.status)?.label ?? feature.status}
                          </span>
                        </td>
                        <td className="px-5 py-4 text-right">
                          {canManage && <button type="button" onClick={() => openEditFeature(feature)} aria-label={t("编辑 Feature：{p0}", { p0: feature.title })} title={t("编辑 Feature")} className="ui-context-action ml-auto"><StructureEditIcon />{t("编辑")}</button>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {reorderFeaturesMutation.error && <p role="alert" className="border-t border-red-100 bg-red-50 px-5 py-2 text-xs text-red-700">{t("Feature 排序保存失败：")}{reorderFeaturesMutation.error.message}</p>}

            {filteredFeatures.length === 0 && (
              <div className="px-6 py-20 text-center text-sm text-slate-400">
                {features.length === 0 ? t("当前项目还没有 Feature。") : t("没有匹配的 Feature。")}
              </div>
            )}
          </section>
        </section>
      </section>

      {canManage && moduleDialog && (
        <ModuleDialog
          key={moduleDialog.mode === 'edit' ? moduleDialog.module.code : 'module-create'}
          state={moduleDialog}
          pending={createModuleMutation.isPending || updateModuleMutation.isPending || updateModuleLifecycleMutation.isPending}
          error={createModuleMutation.error ?? updateModuleMutation.error ?? updateModuleLifecycleMutation.error}
          onClose={() => setModuleDialog(null)}
          onLifecycleChange={() => {
            if (moduleDialog.mode === 'edit') updateModuleLifecycleMutation.mutate({ module: moduleDialog.module, status: moduleDialog.module.status === 'archived' ? 'active' : 'archived' });
          }}
          onSubmit={(input) => {
            if (moduleDialog.mode === 'create') createModuleMutation.mutate(input as CreateProjectModuleInput);
            else updateModuleMutation.mutate({ moduleCode: moduleDialog.module.code, input: input as UpdateProjectModuleInput });
          }}
        />
      )}

      {canManage && featureDialog && (
        <FeatureDialog
          key={featureDialog.mode === 'edit' ? featureDialog.feature.code : `feature-create-${featureDialog.moduleCode ?? 'all'}`}
          state={featureDialog}
          projectCode={projectCode}
          modules={modules}
          pending={createFeatureMutation.isPending || updateFeatureMutation.isPending}
          error={createFeatureMutation.error ?? updateFeatureMutation.error}
          onClose={() => setFeatureDialog(null)}
          onLifecycleChange={() => {
            if (featureDialog.mode === 'edit') updateFeatureMutation.mutate({ featureCode: featureDialog.feature.code, input: { status: featureDialog.feature.status === 'archived' ? 'active' : 'archived' } });
          }}
          onSubmit={(input) => {
            if (featureDialog.mode === 'create') createFeatureMutation.mutate(input as CreateFeatureInput);
            else updateFeatureMutation.mutate({ featureCode: featureDialog.feature.code, input: input as UpdateFeatureInput });
          }}
        />
      )}
    </main>
  );
}

function ModuleDialog({ state, pending, error, onClose, onSubmit, onLifecycleChange }: {
  state: ModuleDialogState;
  pending: boolean;
  error: Error | null;
  onClose: () => void;
  onSubmit: (input: CreateProjectModuleInput | UpdateProjectModuleInput) => void;
  onLifecycleChange: () => void;
}) {
  useLocale();
  const initial = state.mode === 'edit' ? state.module : null;
  const [name, setName] = useState(initial?.name ?? '');
  const [summary, setSummary] = useState(initial?.summary ?? '');

  useEffect(() => {
    setName(initial?.name ?? '');
    setSummary(initial?.summary ?? '');
  }, [initial?.code]);

  function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit({ name: name.trim(), summary: summary.trim() || undefined });
  }

  return (
    <ModalShell title={state.mode === 'create' ? t("新建模块") : t("编辑模块")} eyebrow="MODULE" description={t("模块在结构树中位于 Feature 之上。名称优先，编码作为辅助。")} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="space-y-5 p-6">
          <Field label={t("模块名称")}><input autoFocus required value={name} onChange={(event) => setName(event.target.value)} className="form-control" /></Field>
          <Field label={t("模块摘要")}><textarea rows={4} value={summary} onChange={(event) => setSummary(event.target.value)} className="form-control resize-y leading-6" /></Field>
          {error && <ErrorMessage prefix={t("保存失败")} error={error} />}
        </div>
        <ModalFooter
          onClose={onClose}
          pending={pending}
          submitLabel={state.mode === 'create' ? t("创建模块") : t("保存模块")}
          disabled={!name.trim()}
          leading={state.mode === 'edit' ? (
            <div className="flex min-w-0 items-center gap-2">
              <button
                type="button"
                onClick={onLifecycleChange}
                disabled={pending || (state.module.status !== 'archived' && state.activeFeatureCount > 0)}
                className={`ui-button ${state.module.status === 'archived' ? 'ui-button-secondary' : 'ui-button-danger'}`}
              >
                {state.module.status === 'archived' ? <StructureRestoreIcon /> : <StructureArchiveIcon />}
                {state.module.status === 'archived' ? t("恢复模块") : t("归档模块")}
              </button>
              {state.module.status !== 'archived' && state.activeFeatureCount > 0 && <span className="truncate text-xs text-slate-500">{t("仍有 {count} 个未归档 Feature", { count: state.activeFeatureCount })}</span>}
            </div>
          ) : undefined}
        />
      </form>
    </ModalShell>
  );
}

function FeatureDialog({ state, projectCode, modules, pending, error, onClose, onSubmit, onLifecycleChange }: {
  state: FeatureDialogState;
  projectCode: string;
  modules: ProjectModule[];
  pending: boolean;
  error: Error | null;
  onClose: () => void;
  onSubmit: (input: CreateFeatureInput | UpdateFeatureInput) => void;
  onLifecycleChange: () => void;
}) {
  useLocale();
  const moduleLookup = useMemo(() => new Map(modules.map((item) => [item.code, item])), [modules]);
  const initial = state.mode === 'edit' ? state.feature : null;
  const [title, setTitle] = useState(initial?.title ?? '');
  const [goal, setGoal] = useState(initial?.goal ?? '');
  const [status, setStatus] = useState(initial?.status ?? 'active');
  const [moduleCode, setModuleCode] = useState(initial?.module_code ?? (state.mode === 'create' ? state.moduleCode ?? '' : ''));

  useEffect(() => {
    setTitle(initial?.title ?? '');
    setGoal(initial?.goal ?? '');
    setStatus(initial?.status ?? 'active');
    setModuleCode(initial?.module_code ?? (state.mode === 'create' ? state.moduleCode ?? '' : ''));
  }, [initial?.code, state.mode, state.mode === 'create' ? state.moduleCode : null]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const module = moduleLookup.get(moduleCode) ?? null;
    onSubmit({
      project_code: projectCode,
      title: title.trim(),
      goal: goal.trim() || undefined,
      status,
      module_code: module?.code ?? null,
      module_name: module?.name ?? null,
    } as CreateFeatureInput & UpdateFeatureInput);
  }

  const selectedModule = moduleLookup.get(moduleCode) ?? null;

  return (
    <ModalShell title={state.mode === 'create' ? t("新建 Feature") : t("编辑 Feature")} eyebrow="FEATURE" description={t("维护 Feature 的名称、目标、所属模块和状态。")} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="space-y-5 p-6">
          <Field label={t("Feature 名称")}><input autoFocus required value={title} onChange={(event) => setTitle(event.target.value)} className="form-control" /></Field>
          <Field label={t("目标 / 说明")}><textarea rows={4} value={goal} onChange={(event) => setGoal(event.target.value)} className="form-control resize-y leading-6" /></Field>
          <Field label={t("所属模块")}><select value={moduleCode} onChange={(event) => setModuleCode(event.target.value)} className="form-control bg-white"><option value="">{t("暂不归属")}</option>{modules.map((module) => <option key={module.code} value={module.code}>{module.name} · {module.code}</option>)}</select></Field>
          {selectedModule && <p className="rounded-lg bg-cyan-50 px-3 py-2 text-xs text-cyan-800">{t("当前模块：")}<strong>{selectedModule.name}</strong> · {selectedModule.code}</p>}
          {status !== 'archived' && <Field label={t("交付状态")}><select value={status} onChange={(event) => setStatus(event.target.value)} className="form-control bg-white">{FEATURE_STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></Field>}
          {error && <ErrorMessage prefix={t("保存失败")} error={error} />}
        </div>
        <ModalFooter
          onClose={onClose}
          pending={pending}
          submitLabel={state.mode === 'create' ? t("创建 Feature") : t("保存 Feature")}
          disabled={!title.trim()}
          leading={state.mode === 'edit' ? (
            <button type="button" onClick={onLifecycleChange} disabled={pending} className={`ui-button ${state.feature.status === 'archived' ? 'ui-button-secondary' : 'ui-button-danger'}`}>
              {state.feature.status === 'archived' ? <StructureRestoreIcon /> : <StructureArchiveIcon />}
              {state.feature.status === 'archived' ? t("恢复 Feature") : t("归档 Feature")}
            </button>
          ) : undefined}
        />
      </form>
    </ModalShell>
  );
}

function ModalShell({ title, eyebrow, description, children, onClose }: { title: string; eyebrow: string; description: string; children: ReactNode; onClose?: () => void }) {
  useLocale();
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/55 p-4" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose?.(); }}>
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

function ModalFooter({ onClose, pending, submitLabel, disabled, leading }: { onClose: () => void; pending: boolean; submitLabel: string; disabled: boolean; leading?: ReactNode }) {
  useLocale();
  return <footer className="sticky bottom-0 flex items-center gap-2 border-t border-slate-200 bg-white px-6 py-4">{leading}<div className="ml-auto flex items-center gap-2"><button type="button" onClick={onClose} className="ui-button ui-button-secondary">{t("取消")}</button><button disabled={pending || disabled} className="ui-button ui-button-primary">{pending ? t("保存中…") : submitLabel}</button></div></footer>;
}

function StructurePlusIcon() {
  return <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5 shrink-0"><path d="M10 4v12M4 10h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>;
}

function StructureModulesIcon() {
  return <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5 shrink-0" stroke="currentColor" strokeWidth="1.6"><rect x="3.5" y="4" width="5" height="5" rx="1" /><rect x="11.5" y="4" width="5" height="5" rx="1" /><rect x="3.5" y="12" width="5" height="4" rx="1" /><rect x="11.5" y="12" width="5" height="4" rx="1" /></svg>;
}

function StructureEditIcon() {
  return <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5 shrink-0" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M4 16h3l8.5-8.5a2.1 2.1 0 0 0-3-3L4 13v3Z" /><path d="m11.5 5.5 3 3" /></svg>;
}

function StructureDragHandleIcon() {
  return <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5 shrink-0"><circle cx="7" cy="5" r="1.2" /><circle cx="13" cy="5" r="1.2" /><circle cx="7" cy="10" r="1.2" /><circle cx="13" cy="10" r="1.2" /><circle cx="7" cy="15" r="1.2" /><circle cx="13" cy="15" r="1.2" /></svg>;
}

function StructureArchiveIcon() {
  return <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5 shrink-0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6.5h12v9H4z" /><path d="M3 3.5h14v3H3zM8 10h4" /></svg>;
}

function StructureRestoreIcon() {
  return <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5 shrink-0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M5.2 7.2A6 6 0 1 1 4 11" /><path d="M5.2 3.8v3.4H1.8" /></svg>;
}

function SummaryCell({ label, value, tone = 'text-slate-900' }: { label: string; value: string; tone?: string }) {
  useLocale();
  return <div className="bg-white px-5 py-4"><div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">{label}</div><div className={`mt-1 text-lg font-bold ${tone}`}>{value}</div></div>;
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
