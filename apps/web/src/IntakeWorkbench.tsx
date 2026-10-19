import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from './apiError';
import { useLocale } from './useLocale';
import { t } from './i18n.ts';
import { MarkdownDocument } from './MarkdownDocument';
import { MermaidDiagram } from './MermaidDiagram';
import { DrawioDiagram } from './DrawioDiagram';
import { DocumentReaderHeader } from './DocumentReaderHeader';
import { projectHomeWorkspacePath } from './workspaceRouting';
import { applyIntake, filterIntakeItems, getIntake, getIntakeContext, intakeCanPublish, intakeItemCommitted, intakeKindLabels, intakeKinds, intakeReviewProblem, intakeStatusLabels, listIntakes, parseIntakeUpload, replaceIntake, reviewIntake, stopIntake, submitIntake, type IntakeBatchDetail, type IntakeBundle, type IntakeContext, type IntakeDecision, type IntakeItemView, type IntakeTarget } from './intakeApi';

const publicationRecoveryMessage = '请重新读取发布结果；若持续显示发布中且没有进展，可停止此批次后继续发布，已完成项会保留。';

export function IntakeWorkbench({ projectCode }: { projectCode: string }) {
  useLocale();
  return <IntakeProject key={projectCode} projectCode={projectCode} />;
}

function IntakeProject({ projectCode }: { projectCode: string }) {
  const client = useQueryClient();
  const [selected, setSelected] = useState<string>();
  const [showSetup, setShowSetup] = useState(false);
  const [applying, setApplying] = useState(false);
  const [actionNotice, setActionNotice] = useState('');
  const list = useQuery({ queryKey: ['intakes', projectCode], queryFn: () => listIntakes(projectCode), retry: false });
  const context = useQuery({ queryKey: ['intake-context', projectCode], queryFn: () => getIntakeContext(projectCode), enabled: list.isSuccess, retry: false });
  const batchCode = selected ?? list.data?.batches[0]?.code;
  const detail = useQuery({ queryKey: ['intake', projectCode, batchCode], queryFn: () => getIntake(projectCode, batchCode ?? ''), enabled: list.isSuccess && Boolean(batchCode), retry: false,
    refetchInterval: query => applying || query.state.data?.status === 'applying' ? 1500 : false });
  // A stale cached result must never keep an unauthorized candidate visible after a refetch fails.
  const denied = list.error instanceof ApiError && (list.error.status === 403 || list.error.status === 401 || ['intake_forbidden', 'project_forbidden', 'forbidden'].includes(list.error.code));
  const batch = !detail.error && detail.data?.project_code === projectCode ? detail.data : undefined;
  async function saved(value: IntakeBatchDetail) {
    setSelected(value.code);
    client.setQueryData(['intake', projectCode, value.code], value);
    await Promise.all([client.invalidateQueries({ queryKey: ['intakes', projectCode] }), client.invalidateQueries({ queryKey: ['intake-context', projectCode] })]);
  }
  return <main className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-slate-50">
    <section className="mx-auto max-w-[1440px] p-4 sm:p-6">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3"><div><h1 className="text-2xl font-bold text-slate-950">{t('代码规格')}</h1><p className="mt-2 text-sm leading-6 text-slate-500">{t('从本机代码生成候选，核对证据后发布到项目。已有资料保持不变。')}</p></div>{list.data?.can_submit && !list.error && <button type="button" className="ui-button ui-button-secondary" aria-expanded={showSetup} onClick={() => setShowSetup(!showSetup)}>{t('接入已有代码')}</button>}</header>
      {actionNotice && <p role="status" className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-amber-800">{actionNotice}</p>}
      {list.isPending ? <p role="status" className="p-6 text-sm text-slate-500">{t('正在加载接入批次…')}</p> : list.error ? <section className="rounded-xl border border-slate-200 bg-white p-6"><h2 className="text-base font-semibold text-slate-800">{denied ? t('当前身份不能访问代码候选') : t('无法加载接入批次')}</h2><p className="mt-2 text-sm leading-6 text-slate-600">{denied ? t('代码候选与源码定位仅向当前项目成员开放。观看者可在对应页面阅读已发布资料。') : list.error.message}</p><button type="button" className="ui-button ui-button-secondary mt-4" onClick={() => void list.refetch()}>{t('重试')}</button></section> : <>
        {(showSetup || !list.data.batches.length) && <section className="mb-5 rounded-2xl border border-slate-200 bg-white p-4 sm:p-5"><IntakeSetup projectCode={projectCode} context={context.data} error={context.error} canSubmit={list.data.can_submit} onSaved={saved} onRetry={() => void context.refetch()} /></section>}
        {list.data.batches.length > 0 && <div className="grid min-w-0 items-start gap-5 xl:grid-cols-[280px_minmax(0,1fr)]">
          <aside className="document-library-sidebar" aria-label={t('接入批次列表')}><header className="shrink-0 border-b border-slate-200 p-4"><h2 className="text-sm font-semibold text-slate-800">{t('接入批次')} <span className="font-normal text-slate-500">{list.data.batches.length}</span></h2><button type="button" className="ui-context-action mt-2" onClick={() => { void list.refetch(); void detail.refetch(); }}>{t('刷新')}</button></header><div className="scroll-region min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">{list.data.batches.map(entry => <button key={entry.code} type="button" aria-current={batchCode === entry.code ? 'true' : undefined} onClick={() => setSelected(entry.code)} className={`mb-2 block w-full rounded-xl border p-3 text-left ${batchCode === entry.code ? 'border-cyan-200 bg-cyan-50' : 'border-transparent hover:bg-slate-50'}`}><span className="block break-words text-sm font-semibold text-slate-900">{entry.namespace}</span><span className="mt-2 flex flex-wrap justify-between gap-2 text-xs text-slate-600"><span>{t(intakeStatusLabels[entry.status])}</span><span>{entry.applied_count} / {entry.item_count}</span></span><code className="mt-2 block break-all text-[11px] text-slate-500">{entry.code}</code></button>)}</div></aside>
          {detail.isPending ? <p role="status" className="p-6 text-sm text-slate-500">{t('正在加载候选…')}</p> : detail.error ? <div className="rounded-xl border border-slate-200 bg-white p-5"><IntakeError error={detail.error} /><button type="button" className="ui-button ui-button-secondary mt-3" onClick={() => void detail.refetch()}>{t('重新读取批次')}</button></div> : batch ? <IntakeBatchReader key={`${batch.code}:${batch.revision}:${batch.status}:${batch.applied_count}`} batch={batch} onSaved={saved} onRefresh={() => void detail.refetch()} applyPending={applying} onApplying={setApplying} onNotice={setActionNotice} /> : null}
        </div>}
      </>}
    </section>
  </main>;
}

export function IntakeSetup({ projectCode, context, error, canSubmit, onSaved, onRetry }: { projectCode: string; context?: IntakeContext; error?: Error | null; canSubmit: boolean; onSaved: (batch: IntakeBatchDetail) => Promise<void>; onRetry: () => void }) {
  const [repository, setRepository] = useState('');
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  const [batchName, setBatchName] = useState('first-intake');
  const code = repository || context?.repositories[0]?.code;
  const safeName = /^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$/.test(batchName) ? batchName : 'first-intake';
  const directory = `.tsp/intake/${safeName}`;
  const command = code ? `tsp intake prepare --project ${projectCode} --repository ${code} --scope . --out ${directory}\n\n# ${t('先让 Agent 阅读生成的 SKILL.md 并填写 intake.json，再运行以下命令。')}\ntsp intake validate ${directory}/intake.json\ntsp intake submit ${directory}/intake.json --idempotency-key intake-${code}-${safeName}` : '';
  return <><h2 className="text-base font-semibold text-slate-900">{t('接入已有代码')}</h2><ol className="mt-3 grid gap-3 text-sm leading-6 text-slate-600 md:grid-cols-3"><li><strong className="block text-slate-800">{t('1. 准备来源')}</strong>{t('在已授权的本机仓库中准备代码范围和文件指纹。')}</li><li><strong className="block text-slate-800">{t('2. 生成候选')}</strong>{t('让本机 Agent 按接入技能阅读代码并填写候选，再校验和上传。')}</li><li><strong className="block text-slate-800">{t('3. 审阅发布')}</strong>{t('项目负责人或管理员逐项核对，再冻结计划并发布。')}</li></ol>
    {error ? <div className="mt-4"><IntakeError error={error} /><button type="button" className="ui-button ui-button-secondary mt-2" onClick={onRetry}>{t('重试')}</button></div> : !context ? <p role="status" className="mt-3 text-sm text-slate-500">{t('正在读取仓库…')}</p> : <>
      {context.repositories.length ? <div className="mt-4"><label className="ui-field-label block">{t('代码仓库')}<select className="form-control mt-1 w-full sm:max-w-md" value={code} onChange={event => { setRepository(event.target.value); setCopied(false); }}>{context.repositories.map(repo => <option key={repo.code} value={repo.code}>{repo.name} · {repo.code}</option>)}</select></label><label className="ui-field-label mt-3 block">{t('本次接入目录名')}<input className="form-control mt-1 w-full sm:max-w-md" value={batchName} pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,49}" maxLength={50} onChange={event => { setBatchName(event.target.value); setCopied(false); }} /></label><p className="ui-help mt-2">{t('每次使用新目录名；相同上传重试保留请求标识，不覆盖已有候选。')}</p><p className="ui-help mt-2">{t('接入技能版本：{version}；prepare 仅准备材料，不自动启动模型。', { version: context.skill_version })}</p><div className="mt-3 rounded-xl bg-slate-950 p-4"><button type="button" className="ui-button ui-button-secondary mb-3" onClick={() => { void navigator.clipboard.writeText(command).then(() => { setCopied(true); setCopyError(''); }).catch(() => setCopyError(t('复制失败，请手动选择命令。'))); }}>{copied ? t('已复制') : t('复制命令')}</button><pre className="max-w-full overflow-x-auto text-xs leading-6 text-slate-100"><code>{command}</code></pre></div>{copyError && <p role="alert" className="ui-help mt-2 text-rose-700">{copyError}</p>}</div> : <p className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">{t('请先在项目中绑定代码仓库，再准备候选。')}</p>}
      {canSubmit && context.repositories.length > 0 && <IntakeUpload projectCode={projectCode} onSaved={onSaved} />}
      {!canSubmit && <p className="ui-help mt-4">{t('当前项目为只读，不能提交新候选。')}</p>}
    </>}
  </>;
}

export function IntakeUpload({ projectCode, batch, onSaved }: { projectCode: string; batch?: IntakeBatchDetail; onSaved: (value: IntakeBatchDetail) => Promise<void> }) {
  const [file, setFile] = useState<{ name: string; bundle: IntakeBundle; idempotencyKey: string }>();
  const [error, setError] = useState('');
  const [reading, setReading] = useState(false);
  const sequence = useRef(0);
  const mutation = useMutation({ mutationFn: async () => {
    if (!file) throw new Error(t('请选择候选文件。'));
    return batch ? replaceIntake(projectCode, batch.code, file.bundle, batch.revision) : submitIntake(projectCode, file.bundle, file.idempotencyKey);
  }, onSuccess: async value => { setFile(undefined); await onSaved(value); } });
  async function load(selected?: File) {
    const current = ++sequence.current;
    setFile(undefined); setError(''); setReading(false); mutation.reset();
    if (!selected) return;
    setReading(true);
    try {
      if (selected.size > 10 * 1024 * 1024) throw new Error(t('候选文件不能超过 10 MiB。'));
      const bundle = parseIntakeUpload(await selected.text(), projectCode);
      if (current === sequence.current) setFile({ name: selected.name, bundle, idempotencyKey: crypto.randomUUID() });
    } catch (problem) { if (current === sequence.current) setError(problem instanceof Error ? problem.message : String(problem)); }
    finally { if (current === sequence.current) setReading(false); }
  }
  return <section className="mt-4 border-t border-slate-200 pt-4"><h3 className="text-sm font-semibold text-slate-800">{batch ? t('替换未冻结候选') : t('上传候选 JSON')}</h3><p className="ui-help mt-1">{t('最多 500 项、10 MiB。上传仅保存候选，完整格式与证据由服务端校验。')}</p><label className="ui-field-label mt-3 block">{t('候选文件')}<input type="file" accept=".json,application/json" className="mt-2 block w-full max-w-full text-sm text-slate-600" disabled={mutation.isPending} onChange={event => void load(event.target.files?.[0])} /></label>{file && <p className="ui-help mt-2 break-all">{file.name} · {t('{count} 项候选', { count: file.bundle.items.length })} · {file.bundle.namespace}</p>}{error && <IntakeError error={error} />}{mutation.error && <IntakeError error={mutation.error} />}<button type="button" className="ui-button ui-button-primary mt-3" disabled={!file || reading || mutation.isPending} onClick={() => mutation.mutate()}>{mutation.isPending ? t('正在上传…') : batch ? t('保存替换候选') : t('提交候选')}</button>{mutation.error && <p className="ui-help mt-2">{t('可直接重试；重复提交使用相同请求标识，不会重复建批次。')}</p>}</section>;
}

export function IntakeError({ error }: { error: unknown }) {
  return <p role="alert" className="mt-3 break-words rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm leading-6 text-rose-800">{error instanceof Error ? error.message : String(error)}</p>;
}

export function IntakeBatchReader({ batch, onSaved, onRefresh, applyPending = false, onApplying, onNotice }: { batch: IntakeBatchDetail; onSaved: (batch: IntakeBatchDetail) => Promise<void>; onRefresh: () => void; applyPending?: boolean; onApplying?: (pending: boolean) => void; onNotice?: (message: string) => void }) {
  const [selected, setSelected] = useState(batch.items[0]?.item.key);
  const [kind, setKind] = useState('');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState(batch.status === 'draft');
  const [decisions, setDecisions] = useState<Record<string, IntakeDecision>>(() => Object.fromEntries(batch.items.flatMap(view => view.decision ? [[view.item.key, view.decision]] : [])));
  const requestKey = useRef<string | null>(null);
  const [requestNote, setRequestNote] = useState('');
  const mutation = useMutation({ mutationFn: async (action: 'review' | 'apply') => {
    if (action === 'review') return reviewIntake(batch.project_code, batch.code, { base_revision: batch.revision, decisions: batch.items.flatMap(view => { const decision = decisions[view.item.key] ?? view.decision; return decision ? [decision] : []; }) });
    if (!batch.plan_hash) throw new Error(t('请先完成审阅并冻结发布计划。'));
    requestKey.current ??= crypto.randomUUID();
    return applyIntake(batch.project_code, batch.code, batch.plan_hash, requestKey.current);
  }, onMutate: action => { if (action === 'apply') onApplying?.(true); }, onSettled: (_value, _error, action) => { if (action === 'apply') onApplying?.(false); }, onSuccess: async (value, action) => { if (action === 'apply') { requestKey.current = null; setRequestNote(t('已读取持久化发布结果；已完成项不会重复创建。')); } setEditing(false); await onSaved(value); }, onError: (_error, action) => {
    if (action === 'apply') {
      // This notice outlives the reader remount caused by a status/revision refresh.
      onNotice?.(t(publicationRecoveryMessage));
      onRefresh();
    } else setRequestNote(t('审阅请求未完成，请重新读取批次以核对最新状态。'));
  } });
  // Stop has its own request lane: it must remain usable while the apply HTTP call is running.
  const stop = useMutation({ mutationFn: async () => {
    const current = await getIntake(batch.project_code, batch.code);
    return stopIntake(batch.project_code, batch.code, current.revision);
  }, onSuccess: async value => { onNotice?.(t('停止请求已记录，请以批次状态和逐项结果为准。')); await onSaved(value); }, onError: error => { onNotice?.(`${t('停止请求未完成，已重新读取最新批次；请检查状态后重试。')} ${error.message}`); onRefresh(); } });
  const busy = mutation.isPending || applyPending || stop.isPending;
  const visible = filterIntakeItems(batch.items, kind, status, search);
  const view = visible.find(entry => entry.item.key === selected) ?? visible[0];
  const manager = batch.can_review && !['applying', 'applied', 'cancelled'].includes(batch.status);
  const reviewProblem = intakeReviewProblem(batch, decisions);
  const reviewCount = batch.items.filter(item => intakeItemCommitted(item) || decisions[item.item.key]).length;
  const published = batch.items.filter(intakeItemCommitted).length;
  return <section className="min-w-0 space-y-4">
    <header className="rounded-xl border border-slate-200 bg-white p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="break-words text-base font-semibold text-slate-900">{batch.namespace}</h2><p className="ui-help mt-1">{t(intakeStatusLabels[batch.status])} · r{batch.revision} · {t('已发布或关联 {count} 项', { count: published })}</p></div><div className="flex flex-wrap gap-2"><button type="button" className="ui-button ui-button-secondary" onClick={onRefresh}>{t('重新读取批次')}</button>{manager && !editing && <button type="button" className="ui-button ui-button-secondary" disabled={busy} onClick={() => setEditing(true)}>{t('调整审阅')}</button>}{manager && editing && <button type="button" className="ui-button ui-button-primary" disabled={busy || Boolean(reviewProblem)} onClick={() => mutation.mutate('review')}>{t('冻结发布计划')}</button>}{intakeCanPublish(batch, editing) && <button type="button" className="ui-button ui-button-primary" disabled={busy} onClick={() => mutation.mutate('apply')}>{(mutation.isPending || applyPending) ? t('正在发布…') : batch.status === 'ready' ? t('发布已审阅项') : t('继续发布')}</button>}{batch.can_review && ['draft', 'ready', 'applying', 'partial'].includes(batch.status) && <button type="button" className="ui-button ui-button-secondary" disabled={stop.isPending || batch.stop_requested} onClick={() => stop.mutate()}>{batch.stop_requested ? t('已请求停止') : t('停止此批次')}</button>}</div></div>
      {manager && editing && <p className="ui-help mt-3">{t('已审阅 {count} / {total} 项。修改审阅期间不能发布；保存后生成新计划。', { count: reviewCount, total: batch.items.length })}{reviewProblem && <span className="mt-1 block text-amber-800">{reviewProblem}</span>}</p>}
      {!batch.can_review && <p className="ui-help mt-3">{t('可以阅读候选。审阅、关联与发布由项目负责人或管理员完成。')}</p>}
      {batch.plan_hash && <p className="ui-help mt-3 break-all">{t('冻结计划')} <code>{batch.plan_hash}</code></p>}
      {batch.status === 'applying' && !applyPending && batch.can_review && <p role="status" className="mt-3 rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-800">{t(publicationRecoveryMessage)}</p>}
      {(batch.stop_requested || ['partial', 'stopped', 'cancelled'].includes(batch.status)) && <p className="mt-3 rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-800">{t('停止只阻止后续项，已经完成的内容仍保留。失败项可修正并重新审阅，续传不会重建已完成项。')}</p>}
      {mutation.error && <IntakeError error={mutation.error} />}{requestNote && <p role="status" className="ui-help mt-3">{requestNote}</p>}
      <IntakeSource source={batch.source} />
      {batch.can_edit && !busy && <details className="mt-3"><summary className="cursor-pointer text-xs font-semibold text-cyan-700">{batch.plan_hash ? t('替换候选并重新审阅') : t('替换未冻结候选')}</summary><IntakeUpload projectCode={batch.project_code} batch={batch} onSaved={onSaved} /></details>}
    </header>
    <div className="grid min-w-0 gap-4 2xl:grid-cols-[240px_minmax(0,1fr)]">
      <aside aria-label={t('候选清单')} className="flex max-h-[26rem] min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white 2xl:max-h-[calc(100dvh-14rem)]"><header className="shrink-0 space-y-2 border-b border-slate-200 p-3"><label className="ui-field-label block">{t('搜索候选')}<input className="form-control form-control-compact mt-1 w-full" type="search" value={search} onChange={event => setSearch(event.target.value)} /></label><div className="grid grid-cols-2 gap-2"><label className="ui-field-label block">{t('类型')}<select className="form-control form-control-compact mt-1 w-full" value={kind} onChange={event => setKind(event.target.value)}><option value="">{t('全部')}</option>{intakeKinds.map(value => <option key={value} value={value}>{t(intakeKindLabels[value])}</option>)}</select></label><label className="ui-field-label block">{t('状态')}<select className="form-control form-control-compact mt-1 w-full" value={status} onChange={event => setStatus(event.target.value)}><option value="">{t('全部')}</option><option value="pending">{t('待处理')}</option><option value="applied">{t('已发布 / 已关联')}</option><option value="conflict">{t('冲突 / 需处理')}</option><option value="skipped">{t('已跳过')}</option></select></label></div></header><div className="scroll-region min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">{visible.map(entry => <button type="button" key={entry.item.key} onClick={() => setSelected(entry.item.key)} aria-current={entry.item.key === view?.item.key ? 'true' : undefined} className={`mb-2 w-full rounded-lg border p-3 text-left ${entry.item.key === view?.item.key ? 'border-cyan-200 bg-cyan-50' : 'border-transparent hover:bg-slate-50'}`}><span className="flex flex-wrap justify-between gap-2 text-xs text-slate-500"><span>{t(intakeKindLabels[entry.item.kind])}</span><span>{t(intakeStatusLabels[entry.status])}</span></span><span className="mt-1 block break-words text-sm font-semibold text-slate-800">{entry.item.title}</span><span className="ui-help mt-1 block">{decisions[entry.item.key] ? t(({ create: '新增', bind: '关联已有', skip: '跳过' })[decisions[entry.item.key].action]) : t('尚未审阅')}</span></button>)}{!visible.length && <p className="p-4 text-sm text-slate-500">{t('没有匹配的候选。')}</p>}</div></aside>
      {view ? <IntakeCandidateReader key={view.item.key} batch={batch} view={view} decision={decisions[view.item.key]} editable={manager && editing && !busy && !intakeItemCommitted(view)} onDecision={decision => setDecisions({ ...decisions, [view.item.key]: decision })} /> : <div className="rounded-xl border border-dashed border-slate-200 p-6 text-sm text-slate-500">{t('调整筛选以查看候选。')}</div>}
    </div>
  </section>;
}

export function IntakeSource({ source }: { source: IntakeBatchDetail['source'] }) {
  return <details className="mt-3 rounded-lg border border-slate-200 p-3"><summary className="cursor-pointer text-xs font-semibold text-slate-700">{t('来源与扫描范围')} · {source.dirty ? t('有未提交改动') : t('干净工作区')} · {source.complete ? t('所选范围扫描完整') : t('扫描未完整')}</summary><div className="mt-3 space-y-2 text-xs leading-5 text-slate-600"><p className="break-all">Commit: <code>{source.commit ?? t('无提交记录')}</code></p><p className="break-all">SHA-256: <code>{source.manifest_sha256}</code></p><p>{t('范围')}：{source.scope.join(', ')}</p><p>{t('文件数')}：{source.files.length} · {t('技能版本')}：{source.skill_version}</p><p>{source.analyzed_at}</p><p className="rounded bg-amber-50 p-2 text-amber-900">{t('来源是本次工作区快照，不代表已部署版本。未扫描或读取失败的范围不能被判定为不存在。')}</p>{source.exclusions.length > 0 && <ul className="list-inside list-disc break-words">{source.exclusions.map((entry, index) => <li key={index}>{entry}</li>)}</ul>}</div></details>;
}

export function IntakeTargetContent({ target }: { target: IntakeTarget }) {
  const diagram = target.diagram;
  return <>
    {target.content_markdown?.trim() ? <MarkdownDocument content={target.content_markdown} /> : !diagram && <p className="ui-help">{t('此目标没有正文。')}</p>}
    {diagram?.content_kind === 'mermaid' && <MermaidDiagram source={diagram.source_content} title={target.title} />}
    {diagram?.content_kind === 'drawio' && <><DrawioDiagram source={diagram.source_content} previewSvg={diagram.preview_svg} title={target.title} /><details className="mt-3"><summary className="cursor-pointer text-xs font-semibold text-slate-600">{t('查看图源')}</summary><pre className="mt-2 max-h-72 overflow-auto rounded-lg bg-slate-950 p-3 text-xs leading-5 text-slate-100"><code>{diagram.source_content}</code></pre></details></>}
  </>;
}

export function IntakeCandidateReader({ batch, view, decision, editable, onDecision }: { batch: IntakeBatchDetail; view: IntakeItemView; decision?: IntakeDecision; editable: boolean; onDecision: (decision: IntakeDecision) => void }) {
  const item = view.item;
  const target = decision?.action === 'bind' ? batch.targets.find(entry => entry.code === decision.target_code && entry.kind === item.kind) : undefined;
  return <article aria-label={t('候选正文')} className="min-h-0 min-w-0 overflow-clip rounded-xl border border-slate-200 bg-white">
    <div className="scroll-region max-h-[calc(100dvh-12rem)] min-h-[20rem] overflow-y-auto overscroll-contain">
      <DocumentReaderHeader title={item.title} summary={item.summary} breadcrumb={<><span>{t('代码规格')}</span><span>/</span><span>{t(intakeKindLabels[item.kind])}</span></>} actionsLabel={t('候选审阅操作')} metadata={<><span>{t(intakeStatusLabels[view.status])}</span><code className="break-all">{item.key}</code>{view.target_code && <code className="break-all">{view.target_code}</code>}</>}>
        {editable ? <label className="ui-field-label flex flex-wrap items-center gap-2">{t('审阅动作')}<select className="form-control form-control-compact max-w-full" value={decision?.action ?? ''} onChange={event => { const action = event.target.value as IntakeDecision['action']; if (action) onDecision({ key: item.key, action }); }}><option value="" disabled>{t('请选择动作')}</option><option value="create" disabled={Boolean(view.existing_binding)}>{t('新增')}</option><option value="bind">{t('关联已有')}</option><option value="skip">{t('跳过')}</option></select></label> : <span className="rounded bg-slate-100 px-2 py-1 text-xs text-slate-600">{decision ? t(({ create: '新增', bind: '关联已有', skip: '跳过' })[decision.action]) : t('尚未审阅')}</span>}
      </DocumentReaderHeader>
      <div className="space-y-5 p-4 sm:p-5">
        {view.error && <IntakeError error={view.error} />}
        {view.existing_binding && !intakeItemCommitted(view) && <p className="rounded-lg bg-amber-50 p-3 text-sm leading-6 text-amber-800">{t('此来源已有映射，请关联现有实体或跳过。')} <strong>{view.existing_binding.title}</strong> <code className="break-all">{view.existing_binding.code}</code></p>}
        {decision?.action === 'bind' && <section className="rounded-xl border border-cyan-200 bg-cyan-50 p-4"><label className="ui-field-label block">{t('关联同类型已有资料')}<select className="form-control mt-2 w-full" value={target?.code ?? ''} disabled={!editable} onChange={event => { const entry = batch.targets.find(value => value.kind === item.kind && value.code === event.target.value); if (entry) onDecision({ key: item.key, action: 'bind', target_code: entry.code, target_fingerprint: entry.fingerprint }); }}><option value="">{t('请选择关联目标')}</option>{batch.targets.filter(entry => entry.kind === item.kind).map(entry => <option key={entry.code} value={entry.code}>{entry.title} · {entry.code}</option>)}</select></label><p className="ui-help mt-2">{t('关联仅记录来源映射，不覆盖已有正文或创建新版本。发布时会再次核对目标指纹。')}</p>{target && <div className="mt-4"><h3 className="mb-2 text-sm font-semibold text-slate-800">{t('现有内容')}</h3><p className="mb-3 break-words text-sm text-slate-600">{target.summary}</p><IntakeTargetContent target={target} />{target.kind === 'architecture' && <a className="ui-button ui-button-secondary mt-3" href={projectHomeWorkspacePath(batch.project_code, 'architecture', target.code)} target="_blank" rel="noopener noreferrer">{t('查看现有架构')}</a>}<code className="ui-help mt-3 block break-all">{target.fingerprint}</code></div>}</section>}
        <section><h3 className="mb-3 text-sm font-semibold text-slate-800">{t('候选内容')}</h3><MarkdownDocument content={item.content_markdown} />{item.kind === 'architecture' && item.diagram_source && <MermaidDiagram source={item.diagram_source} title={item.title} />}</section>
        <section className="border-t border-slate-200 pt-4"><h3 className="text-sm font-semibold text-slate-800">{t('代码依据')}</h3><p className="ui-help mt-2">{t(({ observed_in_code: '已观察到代码实现', inferred: '根据代码推断，需核对', unknown: '现状尚不明确' })[item.assessment])}</p><ul className="mt-3 space-y-3">{item.evidence.map((evidence, index) => <li className="rounded-lg bg-slate-50 p-3 text-xs leading-5 text-slate-600" key={index}><code className="block break-all">{evidence.path}:{evidence.line_start}–{evidence.line_end}</code>{evidence.symbol && <code className="mt-1 block break-all">{evidence.symbol}</code>}<code className="mt-1 block break-all">{evidence.sha256}</code></li>)}</ul></section>
        <section className="border-t border-slate-200 pt-4"><h3 className="text-sm font-semibold text-slate-800">{t('测试依据')}</h3><p className="ui-help mt-2">{t('测试结果由客户端报告，平台未独立验证；测试通过不等于业务验收。')}</p>{item.tests.length ? <ul className="mt-3 space-y-3">{item.tests.map((test, index) => <li key={index} className="rounded-lg bg-slate-50 p-3 text-sm leading-6 text-slate-700"><p>{test.name} <span className="ml-1 text-xs font-semibold">{t(({ defined: '仅有测试定义', passed: '报告通过', failed: '报告失败', skipped: '报告跳过', not_run: '未执行' })[test.status])}</span></p><code className="block break-all text-xs">{test.path}</code>{test.note && <p className="ui-help mt-1">{test.note}</p>}</li>)}</ul> : <p className="ui-help mt-2">{t('没有测试记录。')}</p>}</section>
        {item.gaps.length > 0 && <section className="border-t border-slate-200 pt-4"><h3 className="text-sm font-semibold text-slate-800">{t('待确认事项')}</h3><ul className="mt-3 list-inside list-disc space-y-2 break-words text-sm leading-6 text-slate-700">{item.gaps.map((gap, index) => <li key={index}>{gap}</li>)}</ul></section>}
        {[item.module_key, item.feature_key, item.document_key].some(Boolean) && <p className="ui-help border-t border-slate-200 pt-4">{t('候选依赖')}：{[item.module_key, item.feature_key, item.document_key].filter(Boolean).join(' · ')}</p>}
      </div>
    </div>
  </article>;
}
