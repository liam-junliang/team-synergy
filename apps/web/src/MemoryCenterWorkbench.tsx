import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { t, formatDateTime } from './i18n';
import { useLocale } from './useLocale';
import { PersonalMemoryWorkbench } from './PersonalMemoryWorkbench';
import { ProjectMemorySummary } from './ProjectMemoryPanel';
import { getMemoryCenter, memoryCenterKey, type MemoryCenterView } from './memoryCenterApi';
import { requirementWorkspacePath } from './workspaceRouting';

export type MemoryCenterTab = 'overview' | 'projects' | 'personal' | 'processing';
const tabs: Array<{ id: MemoryCenterTab; label: string }> = [
  { id: 'overview', label: '总览' }, { id: 'projects', label: '项目记忆' }, { id: 'personal', label: '个人记忆' }, { id: 'processing', label: '采集与处理' },
];
const captureLabels = { pending: '等待整理', processing: '正在整理', completed: '处理完成', skipped: '未形成长期记忆',
  needs_clarification: '需要澄清', failed: '处理失败' } as const;
const safeErrorMessages: Record<string, string> = {
  memory_model_unavailable: '模型整理服务暂不可用，可稍后重试。', memory_no_material: '此事件仅用于当次工作。',
  memory_needs_clarification: '需要分别说明个人偏好和项目讨论。', memory_source_changed: '来源版本已变化，需要重新核对。',
};
const date = (value?: string) => value ? formatDateTime(value) : t('暂无记录');
const card = 'rounded-xl border border-slate-200 bg-white p-4';

export function MemoryCenterTabs({ selected, onSelect, disabled = false }: { selected: MemoryCenterTab; onSelect: (value: MemoryCenterTab) => void; disabled?: boolean }) {
  return <nav aria-label={t('记忆中心视图')} className="flex flex-wrap gap-1 rounded-xl border border-slate-200 bg-white p-1">
    {tabs.map(tab => <button key={tab.id} type="button" disabled={disabled && selected !== tab.id} aria-pressed={selected === tab.id} onClick={() => onSelect(tab.id)}
      className={`min-h-10 flex-1 rounded-lg px-3 py-2 text-sm font-medium transition sm:flex-none ${selected === tab.id ? 'bg-cyan-50 text-cyan-900 ring-1 ring-inset ring-cyan-200' : 'text-slate-600 hover:bg-slate-50'}`}>{t(tab.label)}</button>)}
  </nav>;
}

export function MemoryCaptureSummary({ value }: { value: MemoryCenterView }) {
  return <section aria-label={t('本人的采集状态')} className={card}>
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-sm font-semibold text-slate-900">{t('服务收到的本人事件')}</h2>
      <p role="status" className="mt-2 text-sm font-medium text-slate-800">{t(value.captures.total === 0 ? '尚未收到事件' : '已收到 {count} 个事件', { count: value.captures.total })}</p></div>
      <span className="rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-600">{t('客户端接入状态：未知')}</span></div>
    <p className="mt-2 text-xs leading-5 text-slate-500">{t('服务器无法判断设备是否安装或信任 Hook。0 个事件不代表已启用，也不能据此断言未安装。')}</p>
    <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">{Object.entries(captureLabels).map(([status, label]) => <div key={status} className="rounded-lg bg-slate-50 px-3 py-2">
      <dt className="text-xs text-slate-500">{t(label)}</dt><dd className="mt-1 text-lg font-semibold tabular-nums text-slate-800">{value.captures.counts[status as keyof typeof captureLabels]}</dd></div>)}</dl>
    <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-slate-500"><span>{t('最近入队')}：{date(value.captures.lastReceivedAt)}</span><span>{t('最近处理')}：{date(value.captures.lastProcessedAt)}</span></div>
  </section>;
}

export function MemoryModelPanel({ value }: { value: MemoryCenterView }) {
  const { model } = value, observation = model.observation;
  return <section aria-label={t('模型整理与观测')} className={card}>
    <h2 className="text-sm font-semibold text-slate-900">{t('模型整理与观测')}</h2>
    <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2"><div><dt className="text-xs text-slate-500">{t('当前进程 provider')}</dt><dd className="mt-1 break-all text-slate-800">{model.provider} <span className="text-xs text-slate-500">· {t(model.providerSource === 'explicit' ? '显式配置' : '默认值')}</span></dd></div>
      <div><dt className="text-xs text-slate-500">{t('当前进程 model')}</dt><dd className="mt-1 break-all text-slate-800">{model.model} <span className="text-xs text-slate-500">· {t(model.modelSource === 'explicit' ? '显式配置' : '默认值')}</span></dd></div></dl>
    <p className="mt-3 text-xs leading-5 text-slate-500">{t('这是会话整理器的运行配置，和检索引擎内部模型是不同链路。处理完成不证明模型必然被调用，调用成功也不等于形成记忆或共识。')}</p>
    {observation ? <div className="mt-3 rounded-lg border border-amber-100 bg-amber-50/60 p-3 text-xs leading-5 text-amber-950">
      <p className="font-semibold">{t('管理员服务级观测：仅当前进程')}</p>
      <p>{t('实际请求 {attempts} · 响应解析成功 {successes} · 请求错误 {errors}', { attempts: observation.attempts, successes: observation.successes, errors: observation.errors })}</p>
      <p>{t('观测始于')} {date(observation.startedAt)} · {t('最近请求')} {date(observation.lastAttemptAt)}</p>
      <p>{t('这是全服务聚合，不是当前账号的调用历史；重启前和其他进程的调用未知。')}</p>
    </div> : <p className="mt-3 rounded-lg bg-slate-50 p-3 text-xs leading-5 text-slate-600">{t('服务级调用统计仅系统管理员可见。本人事件的真实状态以采集记录为准，服务器尚无逐事件模型调用证明。')}</p>}
  </section>;
}

export function MemoryCenterOverview({ value, onSelect }: { value: MemoryCenterView; onSelect: (tab: MemoryCenterTab) => void }) {
  const indexes = value.projects.reduce((total, project) => total + project.indexes, 0);
  const metrics = [
    { label: '有权项目', count: value.projects.length, detail: '项目权限决定可见范围', target: 'projects' as const },
    { label: '已登记资料索引', count: indexes, detail: '每份资料只计一次', target: 'projects' as const },
    { label: '本人个人记忆', count: value.personal.total, detail: '含使用中与已撤回', target: 'personal' as const },
    { label: '收到的本人事件', count: value.captures.total, detail: '当前有权项目的本人来源', target: 'processing' as const },
  ];
  return <div className="space-y-4"><section aria-label={t('可见范围与条目')} className="grid grid-cols-2 gap-3 lg:grid-cols-4">
    {metrics.map(metric => <button key={metric.label} type="button" onClick={() => onSelect(metric.target)} className={`${card} text-left hover:border-cyan-300 focus-visible:outline-2 focus-visible:outline-cyan-600`}>
      <h2 className="text-xs font-medium text-slate-500">{t(metric.label)}</h2><p className="mt-2 text-2xl font-semibold tabular-nums text-slate-900">{metric.count}</p><p className="mt-1 text-xs leading-5 text-slate-500">{t(metric.detail)}</p></button>)}
  </section><p className="text-xs leading-5 text-slate-500">{t('索引是资料目录与引用，Wiki/Core 是同一条目的检索副本。同步就绪不等于方案已确认或工作已落实。')}</p>
    <MemoryCaptureSummary value={value} />
    <div className="flex justify-end"><button type="button" className="ui-context-action" onClick={() => onSelect('processing')}>{t('查看采集与模型状态')}</button></div>
  </div>;
}

export function MemoryCenterWorkbench({ ownerCode, initialProject }: { ownerCode: string; initialProject?: string }) {
  useLocale();
  const [tab, setTab] = useState<MemoryCenterTab>(initialProject ? 'personal' : 'overview');
  const [project, setProject] = useState(initialProject ?? '');
  const [privateBusy, setPrivateBusy] = useState(false);
  const [projectExpanded, setProjectExpanded] = useState(true);
  const query = useQuery({ queryKey: memoryCenterKey(ownerCode), queryFn: () => getMemoryCenter(), retry: false, refetchInterval: 10000 });
  const detail = useQuery({ queryKey: memoryCenterKey(ownerCode, project), queryFn: () => getMemoryCenter(project),
    enabled: Boolean(project) && tab === 'projects', retry: false, refetchInterval: 10000 });
  const value = query.data?.ownerCode === ownerCode ? query.data : undefined;
  const selected = detail.data?.ownerCode === ownerCode && detail.data.selectedProject?.materials.projectCode === project ? detail.data.selectedProject : undefined;
  return <main className="min-h-0 flex-1 overflow-y-auto bg-slate-50 p-4 sm:p-6 lg:p-8"><div className="mx-auto max-w-6xl space-y-4">
    <header className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-semibold text-cyan-700">{t('个人与项目空间')}</p><h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-900">{t('记忆中心')}</h1>
      <p className="mt-1 text-sm leading-6 text-slate-500">{t('项目共享来源按权限可见，个人记忆与采集事件仅本人可见。')}</p></div>
      <div className="flex gap-3"><button type="button" disabled={query.isFetching} onClick={() => { void query.refetch(); if (project) void detail.refetch(); }} className="ui-context-action">{t('刷新')}</button><a href="/account" className="ui-context-action">{t('个人设置')}</a></div></header>
    <MemoryCenterTabs selected={tab} onSelect={setTab} disabled={privateBusy} />
    {tab === 'personal' ? <PersonalMemoryWorkbench ownerCode={ownerCode} initialProject={initialProject} embedded onBusyChange={setPrivateBusy} /> : query.isPending ? <p role="status" className={card}>{t('正在读取记忆中心…')}</p> : query.error || !value ?
      <div role="alert" className={card}><p className="text-sm text-rose-800">{t('记忆中心暂时无法读取，请重试。')}</p><button className="ui-context-action mt-3" onClick={() => void query.refetch()}>{t('重试')}</button></div> :
      tab === 'overview' ? <MemoryCenterOverview value={value} onSelect={setTab} /> : tab === 'projects' ? <div className="space-y-4">
        <label className="flex flex-wrap items-center gap-3 text-sm text-slate-700"><span>{t('查看有权项目')}</span><select aria-label={t('查看有权项目')} value={project} onChange={event => setProject(event.target.value)} className="max-w-full rounded-lg border border-slate-300 bg-white px-3 py-2"><option value="">{t('选择项目')}</option>{value.projects.map(item => <option key={item.code} value={item.code}>{item.name}</option>)}</select></label>
        {!project ? <p className={card}>{t(value.projects.length ? '选择一个有权项目查看资料索引与共享来源。' : '当前没有可读取的项目。')}</p> : detail.isPending ? <p role="status" className={card}>{t('正在读取项目记忆…')}</p> : detail.error || !selected ? <p role="alert" className={card}>{t('所选项目不可读取，请核对当前权限。')}</p> : <>
          <ProjectMemorySummary value={selected.materials} expanded={projectExpanded} pending={detail.isFetching} onToggle={() => setProjectExpanded(expanded => !expanded)} onRefresh={() => void detail.refetch()} />
          <section aria-label={t('项目共享来源')} className={card}><h2 className="text-sm font-semibold text-slate-900">{t('项目共享来源')}</h2><p className="mt-2 text-xs leading-5 text-slate-500">{t('讨论记录不是团队决定，确认方案也不证明已实施。已落实事实须核对原始任务、测试或发布证据。')}</p>
            {selected.shared.length ? <ul className="mt-3 divide-y divide-slate-100">{selected.shared.map(row => <li key={row.source} className="py-3"><details><summary className="cursor-pointer text-sm text-slate-700"><span className="mr-2 rounded bg-slate-100 px-2 py-1 text-xs">{t(row.state === 'confirmed' ? '已确认方案' : '讨论记录')}</span><span className="break-all font-mono text-xs">{row.source}</span></summary><p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-slate-700">{row.text}</p>{row.requirementCode && <a className="ui-context-action mt-2 inline-block" href={requirementWorkspacePath(project, { tab: 'topics' })}>{t('查看业务来源')}{row.sourceRevision ? ` · r${row.sourceRevision}` : ''}</a>}</details></li>)}</ul> : <p className="mt-4 text-sm text-slate-500">{t('暂无可读取的共享记忆来源。已有资料索引仍可单独查阅。')}</p>}
            {selected.sharedTruncated && <p className="mt-2 text-xs text-amber-800">{t('仅显示最近一部分来源，请到项目中核对完整记录。')}</p>}</section>
        </>}
      </div> : <div className="space-y-4"><MemoryCaptureSummary value={value} />
        <p className="text-xs leading-5 text-slate-500">{t(value.serviceEnabled ? '服务接收开关已开启，客户端是否安装、信任或启动仍未知。' : '服务接收开关未开启，已有记录仍可查阅。')}{' '}{t('本地队列状态需要在对应设备检查，服务端不能直接读取本地安装或待发送事件。')}</p>
        <MemoryModelPanel value={value} />
        <section aria-label={t('最近本人事件')} className={card}><h2 className="text-sm font-semibold text-slate-900">{t('最近本人事件')}</h2>
          {value.captures.recent.length ? <ul className="mt-3 divide-y divide-slate-100">{value.captures.recent.map(row => <li key={row.code} className="space-y-2 py-3 text-xs text-slate-600"><div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium text-slate-800">{row.projectName}</span><span>{t(captureLabels[row.status])} · {t('尝试 {count} 次', { count: row.attempts })}</span></div>
            <p className="break-all font-mono">{row.code}</p><p>{t('入队')} {date(row.receivedAt)} · {t('更新')} {date(row.updatedAt)}</p>
            {row.errorCode && <p className="text-amber-800">{t(safeErrorMessages[row.errorCode] ?? '请核对来源、权限或业务对象后重试。')} <code>{row.errorCode}</code></p>}
            <details><summary className="cursor-pointer">{t('来源标识')}</summary><dl className="mt-2 space-y-1 break-all font-mono"><div><dt className="inline">session：</dt><dd className="inline">{row.sessionId}</dd></div><div><dt className="inline">event：</dt><dd className="inline">{row.eventId}</dd></div>{row.receiptCode && <div><dt className="inline">receipt：</dt><dd className="inline">{row.receiptCode}</dd></div>}</dl></details></li>)}</ul> : <p className="mt-3 text-sm text-slate-500">{t('尚无事件。请先核对设备接入，不需要为填满页面创建测试偏好。')}</p>}
          {value.captures.truncated && <p className="mt-3 text-xs text-slate-500">{t('仅显示最近 40 个本人事件。')}</p>}</section>
      </div>}
  </div></main>;
}
