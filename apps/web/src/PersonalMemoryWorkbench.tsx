import { useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { t, formatDateTime } from './i18n.ts';
import { useLocale } from './useLocale';
import { navigateWorkspace } from './workspaceNavigation';
import { personalMemoryWorkspacePath } from './workspaceRouting';
import { listProjects } from './api';
import {
  editPersonalMemory, getPersonalMemory, listPersonalMemory, personalMemoryConflict,
  personalMemoryDetailKey, personalMemoryListKey, personalMemoryQueryKey, withdrawPersonalMemory,
  type PersonalMemoryEdit, type PersonalMemoryFilter, type PersonalMemoryView, type PersonalMemoryWithdraw,
} from './personalMemoryApi';

const stateLabel = { active: '使用中', withdrawn: '已撤回' } as const;
const syncLabel = { not_queued: '尚未同步', pending: '排队中', processing: '同步中', synced: '已同步', needs_reconcile: '同步待恢复' } as const;
const errorText = () => t('记忆操作未完成，请稍后重试。');
const date = (value: string) => formatDateTime(value);
const inputStyle = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100 disabled:bg-slate-100';

export function PersonalMemoryEditor({ value, onSave, onCancel, onRefresh }: {
  value: PersonalMemoryView; onSave: (input: PersonalMemoryEdit) => Promise<unknown>;
  onCancel: () => void; onRefresh: () => Promise<unknown>;
}) {
  const [text, setText] = useState(value.text);
  const [reason, setReason] = useState('');
  const [baseRevision, setBaseRevision] = useState(value.revision);
  const [openedSource] = useState(value.source);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const inFlight = useRef(false);
  const newer = value.revision !== baseRevision;
  const identityChanged = value.source !== openedSource;
  const conflict = personalMemoryConflict(error) || newer || identityChanged;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current || identityChanged || newer || !text.trim() || text.trim().length > 4000 || reason.trim().length > 1000) return;
    inFlight.current = true; setPending(true); setError(null);
    try { await onSave({ expectedRevision: baseRevision, text: text.trim(), ...(reason.trim() ? { reason: reason.trim() } : {}) }); }
    catch (failure) { setError(failure); }
    finally { inFlight.current = false; setPending(false); }
  }
  return <form onSubmit={event => void submit(event)} aria-label={t('编辑个人记忆')} className="space-y-4 rounded-xl border border-cyan-200 bg-cyan-50/40 p-4">
    <div><h3 className="text-sm font-semibold text-slate-900">{t(value.status === 'withdrawn' ? '编辑并恢复记忆' : '编辑个人记忆')}</h3>
      <p className="mt-1 text-xs leading-5 text-slate-500">{t('保存会创建新修订，适用范围保持不变。旧版本将停止作为有效记忆使用。')}</p></div>
    <label className="block space-y-1.5 text-sm font-medium text-slate-700"><span>{t('记忆内容')}</span><textarea aria-label={t('记忆内容')} rows={6} maxLength={4000} value={text} disabled={pending} onChange={event => setText(event.target.value)} className={inputStyle} required /></label>
    <label className="block space-y-1.5 text-sm font-medium text-slate-700"><span>{t('修改原因（可选）')}</span><input aria-label={t('修改原因（可选）')} maxLength={1000} value={reason} disabled={pending} onChange={event => setReason(event.target.value)} className={inputStyle} /></label>
    {conflict && <div role="alert" className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
      <p>{t('记忆已出现更新。你的草稿已保留，请读取当前版本并核对后再保存。')}</p>
      <button type="button" disabled={pending} onClick={() => { void onRefresh().catch(setError); }} className="ui-context-action">{t('读取当前版本')}</button>
      {newer && !identityChanged && <><p className="whitespace-pre-wrap rounded-lg bg-white/80 p-3 text-xs leading-5">{t('当前版本 r{revision} 的内容', { revision: value.revision })}{'\n'}{value.text}</p>
        <button type="button" disabled={pending} className="ui-button ui-button-secondary text-xs" onClick={() => { setBaseRevision(value.revision); setError(null); }}>{t('已核对，以当前版本继续保存草稿')}</button></>}
    </div>}
    {Boolean(error) && !personalMemoryConflict(error) && <p role="alert" className="break-words text-sm text-rose-700">{errorText()}</p>}
    <div className="flex flex-wrap gap-2"><button type="submit" disabled={pending || !text.trim() || newer || identityChanged} className="ui-button ui-button-primary">{t(pending ? '正在保存…' : value.status === 'withdrawn' ? '保存并恢复' : '保存新修订')}</button><button type="button" disabled={pending} onClick={onCancel} className="ui-button ui-button-secondary">{t('取消')}</button></div>
  </form>;
}

export function PersonalMemoryWithdrawal({ value, onWithdraw, onCancel }: {
  value: PersonalMemoryView; onWithdraw: (input: PersonalMemoryWithdraw) => Promise<unknown>; onCancel: () => void;
}) {
  const [expectedRevision] = useState(value.revision);
  const [openedSource] = useState(value.source);
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const inFlight = useRef(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current || value.source !== openedSource || value.revision !== expectedRevision || reason.trim().length > 1000) return;
    inFlight.current = true; setPending(true); setError(null);
    try { await onWithdraw({ expectedRevision, ...(reason.trim() ? { reason: reason.trim() } : {}) }); }
    catch (failure) { setError(failure); }
    finally { inFlight.current = false; setPending(false); }
  }
  return <form onSubmit={event => void submit(event)} aria-label={t('撤回个人记忆')} className="space-y-3 rounded-xl border border-amber-200 bg-amber-50 p-4">
    <h3 className="text-sm font-semibold text-amber-950">{t('确认撤回这条记忆？')}</h3>
    <p className="text-sm leading-6 text-amber-900">{t('撤回后，Agent 将不能继续引用这条记忆。历史修订仍仅供你查看，存储副本清理进度会继续显示。')}</p>
    <label className="block space-y-1.5 text-sm text-slate-700"><span>{t('撤回原因（可选）')}</span><input aria-label={t('撤回原因（可选）')} maxLength={1000} value={reason} disabled={pending} onChange={event => setReason(event.target.value)} className={inputStyle} /></label>
    {Boolean(error) && <p role="alert" className="break-words text-sm text-rose-700">{personalMemoryConflict(error) ? t('记忆已更新，撤回尚未执行。请取消后读取当前版本再确认。') : errorText()}</p>}
    {(value.source !== openedSource || value.revision !== expectedRevision) && <p role="alert" className="text-sm text-amber-900">{t('记忆已更新，撤回尚未执行。请取消后读取当前版本再确认。')}</p>}
    <div className="flex gap-2"><button type="submit" disabled={pending || value.source !== openedSource || value.revision !== expectedRevision} className="ui-button border-amber-400 bg-amber-900 text-white hover:bg-amber-800">{t(pending ? '正在撤回…' : '确认撤回')}</button><button type="button" disabled={pending} onClick={onCancel} className="ui-button ui-button-secondary">{t('取消')}</button></div>
  </form>;
}

export function PersonalMemoryDetails({ value, onEdit, onWithdraw }: {
  value: PersonalMemoryView; onEdit: () => void; onWithdraw: () => void;
}) {
  const cleanup = value.projection.cleanupPending;
  return <article aria-label={t('个人记忆详情')} className="space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex flex-wrap items-center gap-2"><h2 className="text-base font-bold text-slate-900">{t('记忆详情')}</h2><span className={`rounded-md px-2 py-0.5 text-xs ${value.status === 'active' ? 'bg-emerald-50 text-emerald-800' : 'bg-slate-100 text-slate-600'}`}>{t(stateLabel[value.status])}</span></div>
      <p className="mt-1 text-xs text-slate-500">{t('当前修订 r{revision}', { revision: value.revision })}{' · '}{date(value.updatedAt)}</p></div>
      <div className="flex gap-2"><button type="button" onClick={onEdit} className="ui-button ui-button-secondary text-xs">{t(value.status === 'withdrawn' ? '编辑并恢复' : '编辑')}</button>{value.status === 'active' && <button type="button" onClick={onWithdraw} className="ui-button ui-button-secondary text-xs text-amber-900">{t('撤回')}</button>}</div></div>
    <p className="whitespace-pre-wrap break-words rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm leading-7 text-slate-800">{value.text}</p>
    <dl className="grid gap-4 text-sm sm:grid-cols-2"><div><dt className="text-xs text-slate-500">{t('可见范围')}</dt><dd className="mt-1 font-medium text-slate-800">{t('仅本人可见')}</dd></div><div><dt className="text-xs text-slate-500">{t('适用范围')}</dt><dd className="mt-1 font-medium text-slate-800">{t(value.applicability === 'account' ? '跨项目个人偏好' : '仅当前项目')}{value.applicability === 'project' && <span className="ml-2 break-words text-xs text-slate-500">{value.projectName ?? value.projectCode}</span>}</dd></div></dl>
    <section aria-label={t('个人记忆同步状态')} className="rounded-xl border border-slate-200 p-4"><h3 className="text-xs font-semibold text-slate-600">{t('检索与清理状态')}</h3><p role="status" className={`mt-2 text-sm font-medium ${value.projection.status === 'needs_reconcile' ? 'text-amber-800' : 'text-slate-800'}`}>{t(syncLabel[value.projection.status])}</p>
      <p className="mt-1 text-xs leading-5 text-slate-500">{t(value.status === 'withdrawn' ? '这条记忆已停用。撤回不等待索引副本清理完成。' : '保存后立即以新修订为准，检索索引会在后台更新。')}</p>
      {cleanup && <p className="mt-2 text-xs text-amber-800">{t('旧版本已停用，存储副本仍在清理。')}</p>}
      {value.projection.lastError && <p className="mt-2 break-words text-xs text-amber-800">{t('同步尚未完成，后台将继续重试。')} <code>{value.projection.lastError}</code></p>}
    </section>
    <details className="rounded-xl border border-slate-200 p-4"><summary className="cursor-pointer text-sm font-semibold text-slate-700">{t('来源与引用')}</summary><dl className="mt-3 space-y-2 text-xs"><div><dt className="text-slate-500">{t('来源会话')}</dt><dd className="mt-1 break-all font-mono text-slate-700">{value.provenance.sessionId}</dd></div><div><dt className="text-slate-500">{t('来源事件')}</dt><dd className="mt-1 break-all font-mono text-slate-700">{value.provenance.eventId}</dd></div><div><dt className="text-slate-500">{t('采集回执')}</dt><dd className="mt-1 break-all font-mono text-slate-700">{value.provenance.receiptCode}</dd></div><div><dt className="text-slate-500">{t('当前修订引用')}</dt><dd className="mt-1 break-all font-mono text-slate-700">{value.revisionSource}</dd></div></dl></details>
    <section aria-label={t('修订历史')}><h3 className="text-sm font-semibold text-slate-800">{t('修订历史')}</h3><ol className="mt-3 space-y-3">{value.history.map(revision => <li key={revision.source} className="rounded-xl border border-slate-200 p-3"><div className="flex flex-wrap items-center gap-2 text-xs text-slate-500"><strong className="text-slate-700">r{revision.revision}</strong><span>{t(stateLabel[revision.status])}</span><time dateTime={revision.createdAt}>{date(revision.createdAt)}</time></div><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-slate-700">{revision.text}</p>{revision.reason && <p className="mt-2 break-words text-xs text-slate-500">{t('变更原因：{reason}', { reason: revision.reason })}</p>}</li>)}</ol></section>
  </article>;
}

export function PersonalMemoryWorkbench({ ownerCode, initialProject }: { ownerCode: string; initialProject?: string }) {
  useLocale();
  const client = useQueryClient();
  const [status, setStatus] = useState<PersonalMemoryFilter>('active');
  const [selected, setSelected] = useState<string | null>(null);
  const [operation, setOperation] = useState<{ kind: 'edit' | 'withdraw'; source: string } | null>(null);
  const [message, setMessage] = useState('');
  const projectDirectory = useQuery({ queryKey: ['projects', 'switcher', ownerCode], queryFn: () => listProjects(), staleTime: 30000, retry: false });
  const list = useQuery({ queryKey: personalMemoryListKey(ownerCode, status, initialProject), queryFn: () => listPersonalMemory(status, initialProject), retry: false, refetchInterval: 10000 });
  const source = operation?.source ?? selected ?? list.data?.items[0]?.source;
  const detail = useQuery({ queryKey: personalMemoryDetailKey(ownerCode, source ?? ''), queryFn: () => {
    if (!source) throw Error('No personal memory selected');
    return getPersonalMemory(source);
  }, enabled: Boolean(source), retry: false, refetchInterval: 5000 });
  const edit = useMutation({ mutationFn: ({ code, input }: { code: string; input: PersonalMemoryEdit }) => editPersonalMemory(code, input) });
  const withdraw = useMutation({ mutationFn: ({ code, input }: { code: string; input: PersonalMemoryWithdraw }) => withdrawPersonalMemory(code, input) });
  const occupied = operation !== null;
  const current = detail.data?.source === source ? detail.data : undefined;
  const projects = new Map(projectDirectory.data?.map(value => [value.code, value.name]));
  for (const value of list.data?.items ?? []) if (!projects.has(value.projectCode)) projects.set(value.projectCode, value.projectName ?? value.projectCode);
  if (initialProject && !projects.has(initialProject)) projects.set(initialProject, initialProject);
  async function refresh() { await Promise.all([list.refetch(), ...(source ? [detail.refetch()] : [])]); }
  async function changed(value: PersonalMemoryView, action: 'edit' | 'withdraw') {
    client.setQueryData(personalMemoryDetailKey(ownerCode, value.source), value);
    setSelected(value.source);
    setOperation(null);
    setMessage(action === 'withdraw' ? '记忆已撤回。' : '新修订已保存。');
    await client.invalidateQueries({ queryKey: personalMemoryQueryKey(ownerCode) });
  }
  return <main className="min-h-0 flex-1 overflow-y-auto bg-slate-50 p-4 sm:p-6 lg:p-8"><div className="mx-auto max-w-6xl space-y-5">
    <header className="flex flex-wrap items-start justify-between gap-4"><div><div className="flex items-center gap-2"><span aria-hidden="true" className="h-2 w-2 rounded-full bg-cyan-500" /><p className="text-xs font-semibold tracking-wide text-cyan-700">{t('个人空间')}</p></div><h1 className="mt-2 text-2xl font-bold tracking-tight text-slate-900">{t('我的记忆')}</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">{t('查看 Agent 为你积累的偏好，纠正或撤回不合适的内容。个人记忆仅本人可见，与项目共享共识分开。')}</p></div><a href="/account" className="ui-button ui-button-secondary text-sm">{t('个人设置')}</a></header>
    <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex flex-wrap gap-3"><label className="flex items-center gap-2 text-sm text-slate-600"><span>{t('记忆状态')}</span><select aria-label={t('记忆状态')} value={status} disabled={occupied} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm" onChange={event => { setStatus(event.target.value as PersonalMemoryFilter); setSelected(null); setMessage(''); }}><option value="active">{t('使用中')}</option><option value="withdrawn">{t('已撤回')}</option><option value="all">{t('全部记忆')}</option></select></label>
      <label className="flex items-center gap-2 text-sm text-slate-600"><span>{t('来源项目')}</span><select aria-label={t('来源项目')} value={initialProject ?? ''} disabled={occupied} className="max-w-56 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm" onChange={event => navigateWorkspace(personalMemoryWorkspacePath(event.target.value || undefined))}><option value="">{t('全部来源项目')}</option>{[...projects].map(([code, name]) => <option key={code} value={code}>{name}</option>)}</select></label></div>
      <button type="button" disabled={list.isFetching || detail.isFetching} className="ui-context-action" onClick={() => void refresh()}>{t('刷新记忆')}</button></div>
    {initialProject && <p className="text-xs text-slate-500">{t('正在查看来自项目 {project} 的个人记忆', { project: projects.get(initialProject) ?? initialProject })} <a href="/account/memory" className="ml-2 text-cyan-700 underline">{t('查看全部个人记忆')}</a></p>}
    {message && <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{t(message)}</p>}
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(250px,320px)_minmax(0,1fr)]">
      <section aria-label={t('个人记忆列表')} className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"><div className="border-b border-slate-100 px-4 py-3"><h2 className="text-sm font-semibold text-slate-800">{t('记忆条目')}</h2>{occupied && <p className="mt-1 text-xs text-slate-500">{t('完成或取消当前操作后可切换记忆。')}</p>}</div>
        {list.isPending ? <p role="status" className="p-5 text-sm text-slate-500">{t('正在读取个人记忆…')}</p> : list.error ? <div role="alert" className="space-y-3 p-5 text-sm text-rose-700"><p>{t('个人记忆暂时无法读取，请重试。')}</p><button type="button" onClick={() => void list.refetch()} className="ui-button ui-button-secondary text-xs">{t('重试')}</button></div> : list.data?.items.length ? <ul className="divide-y divide-slate-100">{list.data.items.map(value => <li key={value.source}><button type="button" aria-pressed={source === value.source} disabled={occupied} onClick={() => { setSelected(value.source); setMessage(''); }} className={`w-full space-y-2 border-l-2 p-4 text-left transition disabled:cursor-default ${source === value.source ? 'border-cyan-500 bg-cyan-50/60' : 'border-transparent hover:bg-slate-50'}`}><p className="line-clamp-3 break-words text-sm leading-6 text-slate-800">{value.text}</p><div className="flex flex-wrap gap-2 text-[11px] text-slate-500"><span>{t(value.applicability === 'account' ? '跨项目' : '项目内')}</span><span>{t(stateLabel[value.status])}</span><span>r{value.revision}</span></div></button></li>)}</ul> : <div className="space-y-2 p-5"><p className="text-sm font-medium text-slate-700">{t(status === 'withdrawn' ? '还没有撤回的记忆' : '这里还没有记忆')}</p><p className="text-xs leading-6 text-slate-500">{t('接入 Agent 后，明确表达你的个人偏好，会话整理完成后会显示在这里。')}</p></div>}
        {list.data?.truncated && <p className="border-t border-slate-100 p-4 text-xs text-amber-800">{t('这里只显示部分记忆，可以按项目缩小范围查看。')}</p>}
      </section>
      <section aria-label={t('所选个人记忆')} className="min-w-0 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        {source ? detail.isPending ? <p role="status" className="text-sm text-slate-500">{t('正在读取记忆详情…')}</p> : detail.error && !occupied ? <div role="alert" className="space-y-3 text-sm text-rose-700"><p>{t('这条记忆暂不可用，请刷新后重新选择。')}</p><button type="button" className="ui-button ui-button-secondary text-xs" onClick={() => void detail.refetch()}>{t('重试')}</button></div> : current ? <div className="space-y-5">
          {detail.error && occupied && <p role="alert" className="text-xs text-amber-900">{t('当前版本暂时无法刷新，你的草稿仍然保留。')}</p>}
          {operation?.kind === 'edit' ? <PersonalMemoryEditor value={current} onCancel={() => setOperation(null)} onRefresh={() => detail.refetch()} onSave={async input => changed(await edit.mutateAsync({ code: operation.source, input }), 'edit')} /> : operation?.kind === 'withdraw' ? <PersonalMemoryWithdrawal value={current} onCancel={() => setOperation(null)} onWithdraw={async input => changed(await withdraw.mutateAsync({ code: operation.source, input }), 'withdraw')} /> : <PersonalMemoryDetails value={current} onEdit={() => setOperation({ kind: 'edit', source: current.source })} onWithdraw={() => setOperation({ kind: 'withdraw', source: current.source })} />}
        </div> : null : <div className="py-12 text-center text-sm text-slate-400">{t('选择一条记忆查看内容、来源与修订。')}</div>}
      </section>
    </div>
  </div></main>;
}
