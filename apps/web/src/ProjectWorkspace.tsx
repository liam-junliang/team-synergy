import { useLocale } from './useLocale';
import { t } from './i18n.ts';
import { lazy, Suspense } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listProjectModules } from './api';
import { projectHomeWorkspacePath, type ProjectWorkspaceTab } from './workspaceRouting';

const ProjectOverviewWorkbench = lazy(() => import('./ProjectOverviewWorkbench').then((module) => ({ default: module.ProjectOverviewWorkbench })));
const ProjectStructureWorkbench = lazy(() => import('./ProjectStructureWorkbench').then((module) => ({ default: module.ProjectStructureWorkbench })));
const ArchitectureWorkbench = lazy(() => import('./ArchitectureWorkbench').then((module) => ({ default: module.ArchitectureWorkbench })));
const IntakeWorkbench = lazy(() => import('./IntakeWorkbench').then((module) => ({ default: module.IntakeWorkbench })));

export function ProjectWorkspaceNavigation({ projectCode, tab, moduleCount }: { projectCode: string; tab: ProjectWorkspaceTab; moduleCount?: number }) {
  useLocale();
  return <div className="shrink-0 border-b border-slate-200 bg-white px-4 sm:px-6">
    <nav aria-label={t("项目工作台视图")} className="mx-auto flex max-w-[1360px] gap-6 overflow-x-auto">
      {([{ id: 'overview', label: t("概览") }, { id: 'structure', label: t("功能模块") }, { id: 'architecture', label: t("架构设计") }, { id: 'intake', label: t("代码规格") }] as const).map((item) => <a key={item.id} href={projectHomeWorkspacePath(projectCode, item.id)} aria-current={tab === item.id ? 'page' : undefined} className={`shrink-0 whitespace-nowrap border-b-2 px-1 py-3 text-sm font-semibold ${tab === item.id ? 'border-cyan-600 text-cyan-700' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>{item.label}{item.id === 'structure' && moduleCount !== undefined && <span className="ml-2 text-xs font-normal text-slate-400">{moduleCount}</span>}</a>)}
    </nav>
  </div>;
}

export function ProjectWorkspace({ projectCode, tab = 'overview', documentCode }: { projectCode: string; tab?: ProjectWorkspaceTab; documentCode?: string }) {
  useLocale();
  const modulesQuery = useQuery({ queryKey: ['project-modules', projectCode], queryFn: () => listProjectModules(projectCode) });
  return <section className="flex min-h-0 min-w-0 flex-1 flex-col">
    <ProjectWorkspaceNavigation projectCode={projectCode} tab={tab} moduleCount={modulesQuery.data?.length} />
    <Suspense fallback={<div className="flex flex-1 items-center justify-center p-8 text-sm text-slate-500">{t("正在加载项目内容…")}</div>}>
      {tab === 'overview' ? <ProjectOverviewWorkbench projectCode={projectCode} /> : tab === 'structure' ? <ProjectStructureWorkbench projectCode={projectCode} /> : tab === 'intake' ? <IntakeWorkbench projectCode={projectCode} /> : <ArchitectureWorkbench projectCode={projectCode} documentCode={documentCode} />}
    </Suspense>
  </section>;
}
