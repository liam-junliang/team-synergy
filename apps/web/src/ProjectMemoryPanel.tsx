import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { t } from './i18n';
import { useLocale } from './useLocale';
import { projectDocumentWorkspacePath, projectHomeWorkspacePath, requirementWorkspacePath, testingWorkspacePath } from './workspaceRouting';
import { getProjectMemoryManagement, projectMemoryMatches, projectMemoryQueryKey,
  type ProjectMemoryAction, type ProjectMemoryManagementView, type ProjectMemoryProjectionStatus } from './memoryManagementApi';

type Tone = 'neutral' | 'ready' | 'pending' | 'error';
export function projectMemoryPresentation(value: ProjectMemoryManagementView): { label: string; message: string; tone: Tone } {
  if (!value.enabled && value.bindingState !== 'not_enabled') return { label: '索引维护已暂停', message: '平台已暂停后台索引，项目资料原文与版本继续保留。', tone: 'neutral' };
  if (!value.serviceConfigured) return { label: '索引服务未配置', message: '项目资料仍可按需读取，后台索引服务待平台配置。', tone: 'neutral' };
  if (!value.enabled || value.bindingState === 'provisioning') return { label: '正在准备索引', message: '后台正在自动建立资料索引，无需成员启用。', tone: 'pending' };
  if (value.bindingState === 'failed' || !value.retrievalEnabled) return { label: '索引连接待恢复', message: '项目资料已保留，后台将继续重试索引连接。', tone: 'error' };
  if (value.counts.needsReconcile > 0) return { label: '部分索引待恢复', message: '部分当前版本的索引尚未就绪，后台将继续重试。', tone: 'error' };
  if (value.counts.pending + value.counts.processing + value.counts.notQueued > 0) return { label: '索引更新中', message: '正在更新当前资料的目录、引用和有界摘要。', tone: 'pending' };
  if (!value.counts.total) return { label: '等待项目资料', message: '添加项目、需求、架构或测试资料后会自动建立索引。', tone: 'ready' };
  return { label: '索引可用', message: 'Agent 先检索目录和摘要，需要正文时再读取当前项目资料。', tone: 'ready' };
}
const tones: Record<Tone, string> = { neutral: 'bg-slate-100 text-slate-600', ready: 'bg-emerald-50 text-emerald-800',
  pending: 'bg-cyan-50 text-cyan-800', error: 'bg-amber-50 text-amber-900' };
const statuses: Record<ProjectMemoryProjectionStatus, string> = {
  not_queued: '等待索引', pending: '排队中', processing: '索引更新中', synced: '索引就绪', needs_reconcile: '索引待恢复' };
const kinds = { project: '项目资料', requirement: '需求资料', architecture: '架构资料', testing: '测试资料' } as const;
type Material = ProjectMemoryManagementView['documents'][number];
export function projectMaterialWorkspacePath(project: string, material: Material) {
  if (material.sourceKind === 'requirement') return requirementWorkspacePath(project, { documentCode: material.documentCode });
  if (material.sourceKind === 'architecture') return projectHomeWorkspacePath(project, 'architecture', material.documentCode);
  if (material.sourceKind === 'testing') return testingWorkspacePath(project, 'assets', material.documentCode);
  return projectDocumentWorkspacePath(project, material.documentCode);
}

export function ProjectMemoryPanel({ projectCode, onSelectDocument }: { projectCode: string; onSelectDocument?: (code: string) => boolean }) {
  useLocale();
  const [expanded, setExpanded] = useState(false);
  const query = useQuery({ queryKey: projectMemoryQueryKey(projectCode), queryFn: () => getProjectMemoryManagement(projectCode),
    enabled: Boolean(projectCode), retry: false, retryOnMount: false,
    refetchInterval: request => request.state.status === 'success' ? 10000 : false });
  const value = !query.error && projectMemoryMatches(query.data, projectCode) ? query.data : undefined;
  if (!value) return <section aria-label={t('资料检索索引')} className="mb-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5">
    <div className="flex items-center justify-between gap-2"><h2 className="text-sm font-semibold text-slate-800">{t('资料检索索引')}</h2>
      <span role="status" className="text-xs text-slate-500">{t(query.isPending ? '正在读取状态…' : '状态暂不可用')}</span>
      {!query.isPending && <button type="button" disabled={query.isFetching} onClick={() => void query.refetch()} className="ui-context-action">{t('刷新状态')}</button>}</div>
    {!query.isPending && <p role="alert" className="mt-1 text-xs text-slate-500">{t('资料索引状态暂时无法读取，原文仍保留在项目资料中。')}</p>}
  </section>;
  return <ProjectMemorySummary value={value} expanded={expanded} pending={query.isFetching} onToggle={() => setExpanded(open => !open)}
    onRefresh={() => void query.refetch()} onSelectDocument={onSelectDocument} />;
}

export function ProjectMemorySummary({ value, expanded, pending, onToggle, onRefresh, onSelectDocument }: {
  value: ProjectMemoryManagementView; expanded: boolean; pending: boolean; actionFailed?: boolean;
  onToggle: () => void; onAction?: (action: ProjectMemoryAction) => void; onRefresh: () => void; onSelectDocument?: (code: string) => boolean;
}) {
  const status = projectMemoryPresentation(value), detailsId = 'project-memory-documents';
  return <section aria-label={t('资料检索索引')} className="mb-2 overflow-hidden rounded-lg border border-slate-200 bg-white">
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 px-3 py-1.5">
      <div className="flex min-w-0 flex-wrap items-center gap-2"><h2 className="text-sm font-semibold text-slate-900">{t('资料检索索引')}</h2>
        <span role="status" className={`rounded-md px-2 py-0.5 text-xs font-medium ${tones[status.tone]}`}>{t(status.label)}</span>
        {value.counts.total > 0 && <span className="text-xs text-slate-500"><span className="sr-only sm:not-sr-only">{t('已索引 {ready}/{total} 份资料', { ready: value.counts.synced, total: value.counts.total })}</span><span aria-hidden="true" className="sm:hidden">{value.counts.synced}/{value.counts.total}</span></span>}</div>
      <div className="flex shrink-0 flex-wrap items-center gap-2"><button type="button" disabled={pending} onClick={onRefresh}
        aria-label={t('刷新资料索引状态')} className="ui-context-action">{t('刷新')}</button>
        <button type="button" onClick={onToggle} aria-expanded={expanded} aria-controls={detailsId} className="ui-context-action">{t(expanded ? '收起详情' : '查看来源状态')}</button></div>
    </div>
    {expanded && <div id={detailsId} className="border-t border-slate-200 bg-slate-50/50">
      <p className="px-3 pt-2 text-xs leading-5 text-slate-600">{t(status.message)}</p>
      <div className="flex flex-wrap gap-x-4 gap-y-1 px-4 py-2.5 text-xs text-slate-500"><span>{t('排队 {count}', { count: value.counts.pending + value.counts.notQueued })}</span>
        <span>{t('索引处理中 {count}', { count: value.counts.processing })}</span><span>{t('待恢复 {count}', { count: value.counts.needsReconcile })}</span></div>
      {value.documents.length ? <ul className="max-h-56 overflow-y-auto border-t border-slate-100 px-4" aria-label={t('当前资料索引状态')}>
        {value.documents.map(material => <li key={(material.sourceKind ?? 'project') + ':' + material.documentCode} className="flex items-center justify-between gap-3 border-b border-slate-100 py-2.5 last:border-0">
          <div className="min-w-0"><p className="truncate text-xs font-medium text-slate-800">{material.title}</p>
            <p className="mt-0.5 text-[11px] text-slate-400">{t(kinds[material.sourceKind ?? 'project'])} · {t('当前版本 r{revision}', { revision: material.currentRevision })}</p></div>
          <div className="flex shrink-0 items-center gap-3"><span className="text-xs text-slate-500">{t(statuses[material.projectionStatus])}</span>
            <a href={projectMaterialWorkspacePath(value.projectCode, material)} onClick={event => {
              if (material.sourceKind && material.sourceKind !== 'project' || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              if (onSelectDocument?.(material.documentCode)) event.preventDefault();
            }} className="ui-context-action">{t('查看资料')}</a></div>
        </li>)}</ul> : <p className="px-4 pb-3 text-xs text-slate-500">{t('项目资料会自动建立目录索引。')}</p>}
      {Boolean(value.legacyCleanupPending) && <p role="status" className="px-4 py-2 text-xs text-amber-800">{t('历史索引副本仍在清理，旧引用不能作为当前版本使用。')}</p>}
      <p className="px-4 py-2.5 text-[11px] leading-5 text-slate-400">{value.documentsTruncated && <>{t('这里只显示部分资料。')} </>}
        {t('索引只保存目录、引用与有界摘要；原文和版本由项目资料维护。索引就绪不代表方案已确认或工作已完成。')}</p>
    </div>}
  </section>;
}
