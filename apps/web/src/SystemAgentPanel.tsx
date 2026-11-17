import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getHandoffDocument, listHandoffLibrary } from './api';
import { formatDateTime, t } from './i18n';
import { useLocale } from './useLocale';
import { useProjectAccess } from './useProjectAccess';
import { MarkdownDocument } from './MarkdownDocument';
import { applySystemAgentJob, cancelSystemAgentJob, createSystemAgentJob, exactSystemAgentQuote, getSystemAgentJob, getSystemAgentStatus, listSystemAgentJobs, newSystemAgentDraft, readSystemAgentDraft, rejectSystemAgentJob, SYSTEM_AGENT_OPEN_EVENT, systemAgentCanApply, systemAgentDocumentEligible, systemAgentJobActive, systemAgentLineDiff, type SystemAgentDraft, type SystemAgentJob, type SystemAgentTarget } from './systemAgentApi';
import './systemAgent.css';

const statusLabels: Record<SystemAgentJob['status'], string> = { queued: '排队中', running: '正在生成草稿', awaiting_review: '等待你确认', applied: '已保存新版本', rejected: '已拒绝草稿', failed: '执行失败', cancelled: '已取消' };
const storageForDraft = () => { try { return window.sessionStorage; } catch { return undefined; } };
const freshKey = () => crypto.randomUUID();

export function SystemAgentPanel({ projectCode, projectName, userCode }: { projectCode: string; projectName: string; userCode: string }) {
  useLocale();
  const storageKey = `tsp:system-agent:${userCode}:${projectCode}`;
  const [draft, setDraft] = useState<SystemAgentDraft>(() => readSystemAgentDraft(storageForDraft(), storageKey, projectCode));
  const [open, setOpen] = useState(false);
  const [wide, setWide] = useState(false);
  const [localError, setLocalError] = useState('');
  const [selecting, setSelecting] = useState(false);
  const [compareMode, setCompareMode] = useState<'diff' | 'preview'>('diff');
  const panelRef = useRef<HTMLElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const selectionSequence = useRef(0);
  const { canWrite } = useProjectAccess(projectCode);
  const client = useQueryClient();
  const status = useQuery({ queryKey: ['system-agent-status'], queryFn: getSystemAgentStatus, enabled: open, retry: false, staleTime: 30_000 });
  const jobs = useQuery({ queryKey: ['system-agent-jobs', projectCode, userCode], queryFn: () => listSystemAgentJobs(projectCode), enabled: open, refetchInterval: open ? 3000 : false, retry: false });
  const job = useQuery({ queryKey: ['system-agent-job', draft.selected_job, userCode], queryFn: () => getSystemAgentJob(draft.selected_job ?? ''), enabled: open && Boolean(draft.selected_job), refetchInterval: query => query.state.data && systemAgentJobActive(query.state.data) ? 1800 : query.state.data?.status === 'awaiting_review' ? 5000 : false, retry: false });
  const library = useQuery({ queryKey: ['handoff-library', projectCode, 'system-agent'], queryFn: () => listHandoffLibrary(projectCode), enabled: open && !draft.selected_job, retry: false });
  const eligibleDocuments = library.data?.documents.filter(systemAgentDocumentEligible) ?? [];
  const currentJob = !job.isError && job.data?.project_code === projectCode ? job.data : undefined;

  useEffect(() => { try { storageForDraft()?.setItem(storageKey, JSON.stringify(draft)); } catch { /* A blocked/full session store must not block work. */ } }, [draft, storageKey]);
  useEffect(() => {
    const show = (event: Event) => {
      const target = (event as CustomEvent<SystemAgentTarget>).detail;
      if (target?.project_code !== projectCode) return;
      selectionSequence.current++;
      setSelecting(false); setLocalError('');
      setDraft(current => ({ ...current, target, selected_job: null, request_key: freshKey() }));
      setOpen(true);
    };
    window.addEventListener(SYSTEM_AGENT_OPEN_EVENT, show);
    return () => window.removeEventListener(SYSTEM_AGENT_OPEN_EVENT, show);
  }, [projectCode]);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const launcher = launcherRef.current;
    panelRef.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setOpen(false); }
      if (event.key !== 'Tab' || !panelRef.current) return;
      const elements = Array.from(panelRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], select:not(:disabled), textarea:not(:disabled), input:not(:disabled), [tabindex="0"]')).filter(element => element.getClientRects().length > 0);
      const first = elements[0]; const last = elements.at(-1);
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); if (previous?.isConnected) previous.focus(); else launcher?.focus(); };
  }, [open]);

  const saveJob = async (saved: SystemAgentJob) => {
    client.setQueryData(['system-agent-job', saved.job_code, userCode], saved);
    setDraft(current => ({ ...current, selected_job: saved.job_code }));
    await client.invalidateQueries({ queryKey: ['system-agent-jobs', projectCode, userCode] });
  };
  const create = useMutation({ mutationFn: () => {
    if (!draft.target) throw new Error(t('请选择一份可编辑的项目文档。'));
    return createSystemAgentJob(projectCode, { document_code: draft.target.document_code, base_revision: draft.target.base_revision, instruction: draft.instruction.trim(), quote: draft.target.quote, request_key: draft.request_key });
  }, onSuccess: saveJob });
  const action = useMutation({ mutationFn: async (kind: 'cancel' | 'reject' | 'apply') => {
    if (!currentJob) throw new Error(t('请重新载入任务。'));
    if (kind === 'apply') {
      if (!systemAgentCanApply(currentJob) || !currentJob.proposal_hash) throw new Error(t('这份草稿当前不可采用，请刷新任务状态。'));
      return applySystemAgentJob(currentJob.job_code, { proposal_hash: currentJob.proposal_hash, base_revision: currentJob.base_revision });
    }
    return kind === 'cancel' ? cancelSystemAgentJob(currentJob.job_code) : rejectSystemAgentJob(currentJob.job_code);
  }, onSuccess: async saved => {
    await saveJob(saved);
    if (saved.status === 'applied') await Promise.all([
      client.invalidateQueries({ queryKey: ['handoff-document', saved.document_code] }),
      client.invalidateQueries({ queryKey: ['handoff-library', projectCode] }),
      client.invalidateQueries({ queryKey: ['document-quality', projectCode, saved.document_code] }),
    ]);
  } });
  const resetErrors = () => { setLocalError(''); create.reset(); action.reset(); };
  const chooseDocument = async (code: string, instruction = draft.instruction) => {
    resetErrors();
    const sequence = ++selectionSequence.current;
    setDraft(newSystemAgentDraft(instruction, freshKey()));
    if (!code) { setSelecting(false); return; }
    setSelecting(true);
    try {
      const document = await getHandoffDocument(code);
      if (selectionSequence.current !== sequence) return;
      if (document.project_code !== projectCode || !systemAgentDocumentEligible(document)) throw new Error(t('请选择一份可编辑的项目文档。'));
      setDraft(current => ({ ...current, target: { project_code: projectCode, document_code: code, title: document.title, base_revision: document.current_revision } }));
    } catch (error) { if (selectionSequence.current === sequence) setLocalError(error instanceof Error ? error.message : String(error)); }
    finally { if (selectionSequence.current === sequence) setSelecting(false); }
  };
  function submit(event: FormEvent) {
    event.preventDefault();
    if (create.isPending || !draft.target || !draft.request_key || !draft.instruction.trim() || !status.isSuccess || !status.data?.configured || !canWrite) return;
    resetErrors(); create.mutate();
  }
  const error = localError || create.error?.message || action.error?.message;
  const visibleJobs = jobs.isError ? undefined : jobs.data;
  const pendingReview = visibleJobs?.filter(value => value.status === 'awaiting_review').length ?? 0;

  return <>
    <button ref={launcherRef} type="button" className="system-agent-launcher" aria-label={t('打开系统 Agent')} aria-expanded={open} aria-controls="system-agent-panel" onClick={() => setOpen(value => !value)}>
      <span aria-hidden="true" className="system-agent-spark">✦</span><span>{t('系统 Agent')}</span>{pendingReview > 0 && <span className="system-agent-count">{pendingReview}</span>}
    </button>
    {open && <div className="system-agent-overlay" onMouseDown={event => { if (event.target === event.currentTarget) setOpen(false); }}>
      <aside id="system-agent-panel" ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="system-agent-title" tabIndex={-1} className={`system-agent-panel ${wide ? 'system-agent-panel-wide' : ''}`}>
        <header className="system-agent-header"><div className="system-agent-heading"><span aria-hidden="true" className="system-agent-spark">✦</span><div><h2 id="system-agent-title">{t('系统 Agent')}</h2><p title={projectName}>{projectName} · {t('文档协作 · 第一版')}</p></div></div><div className="system-agent-header-actions"><button type="button" className="system-agent-icon-button" aria-label={t(wide ? '收窄窗口' : '展开窗口')} title={t(wide ? '收窄窗口' : '展开窗口')} onClick={() => setWide(value => !value)}>{wide ? '↙' : '↗'}</button><button type="button" className="system-agent-icon-button" aria-label={t('最小化系统 Agent')} title={t('最小化；任务会继续执行')} onClick={() => setOpen(false)}>−</button></div></header>
        <div className="system-agent-scope">{t('草稿自动生成 · 正式文档由你确认后保存')}</div>
        <div className="system-agent-body">
          <section className="system-agent-history" aria-label={t('我的 Agent 任务')}><div className="system-agent-section-heading"><h3>{t('我的 Agent 任务')}</h3><button type="button" className="system-agent-link" disabled={create.isPending || selecting} onClick={() => void chooseDocument(currentJob?.document_code ?? draft.target?.document_code ?? '', currentJob?.instruction ?? draft.instruction)}>{t('新建任务')}</button></div>
            {jobs.error && <p role="alert" className="system-agent-error">{t('任务记录加载失败')} · {jobs.error.message}<button type="button" className="system-agent-link" onClick={() => void jobs.refetch()}>{t('重试')}</button></p>}
            {jobs.isLoading && <p className="system-agent-muted">{t('正在读取任务记录…')}</p>}
            {visibleJobs?.length === 0 && <p className="system-agent-muted">{t('从一条文档批注开始，执行记录会保存在这里。')}</p>}
            <div className="system-agent-history-list">{visibleJobs?.map(value => <button type="button" key={value.job_code} aria-pressed={draft.selected_job === value.job_code} onClick={() => { resetErrors(); setDraft(current => ({ ...current, selected_job: value.job_code })); }}><span className="system-agent-history-title">{value.document_title || value.base_title}</span><span className={`system-agent-status system-agent-status-${value.status}`}>{t(statusLabels[value.status])}</span><small>{formatDateTime(value.created_at)}</small></button>)}</div>
          </section>
          {draft.selected_job ? <>
            {job.isLoading && <p role="status">{t('正在读取任务…')}</p>}
            {job.error && <div role="alert" className="system-agent-error">{job.error.message}<button type="button" className="system-agent-link" onClick={() => void job.refetch()}>{t('重试')}</button></div>}
            {currentJob && <>
              <SystemAgentJobContext job={currentJob} />
              {systemAgentJobActive(currentJob) && <div className="system-agent-progress" role="status"><span className="system-agent-running-dot" /><div><strong>{t(statusLabels[currentJob.status])}</strong><p>{t('任务由系统执行，可关闭窗口。正式文档尚未改变。')}</p></div></div>}
              {currentJob.error && <p role="alert" className="system-agent-error">{currentJob.error}</p>}
              {currentJob.proposal && <SystemAgentProposalReview job={currentJob} mode={compareMode} onModeChange={setCompareMode} />}
              {currentJob.status === 'applied' && <p role="status" className="system-agent-success">{t('已保存为 r{revision}，批注与采用记录已留存。', { revision: currentJob.applied_revision ?? '' })}<a className="system-agent-link" href={`/projects/${encodeURIComponent(projectCode)}/documents?document=${encodeURIComponent(currentJob.document_code)}`}>{t('查看文档')}</a></p>}
              {currentJob.status === 'awaiting_review' && !systemAgentCanApply(currentJob) && <p className="system-agent-notice">{t('当前不可采用：文档版本或你的权限可能已变化。请刷新状态；需要时基于最新版本新建任务。')}</p>}
              {['failed', 'cancelled', 'rejected'].includes(currentJob.status) && <p className="system-agent-notice">{t('本次任务已结束，正式文档未被修改。')}</p>}
              {error && <p role="alert" className="system-agent-error">{error}<br />{t('若文档版本已变化，请基于最新版本重新生成草稿。')}</p>}
              <SystemAgentJobActions job={currentJob} pending={action.isPending || selecting} applying={action.isPending && action.variables === 'apply'} canWrite={canWrite} refreshing={job.isFetching} onAction={kind => action.mutate(kind)} onNew={() => void chooseDocument(currentJob.document_code, currentJob.instruction)} onRefresh={() => void job.refetch()} />
            </>}
          </> : <form className="system-agent-composer" onSubmit={submit}>
            <div><h3>{t('你希望怎样完善这份文档？')}</h3><p className="system-agent-muted">{t('Agent 根据所选文档和你的批注形成修改建议，保留依据与待确认项。')}</p></div>
            {status.isLoading && <p role="status" className="system-agent-notice">{t('正在检查执行引擎…')}</p>}
            {status.error && <p role="alert" className="system-agent-error">{t('无法确认执行引擎状态')} · {status.error.message}<button type="button" className="system-agent-link" onClick={() => void status.refetch()}>{t('重试')}</button></p>}
            {status.data && !status.data.configured && <div className="system-agent-notice" role="status"><strong>{t('执行引擎尚未就绪')}</strong><p>{status.data.message}</p><button type="button" className="system-agent-link" onClick={() => void status.refetch()}>{t('重新检查')}</button></div>}
            {!canWrite && <p className="system-agent-notice">{t('你当前没有项目写入权限，可以查看自己的任务记录。')}</p>}
            <label className="system-agent-field">{t('工作文档')}<select value={draft.target?.document_code ?? ''} disabled={create.isPending || selecting || !canWrite} onChange={event => void chooseDocument(event.target.value)}><option value="">{t(selecting ? '正在读取文档…' : '选择一份项目文档')}</option>{draft.target && !eligibleDocuments.some(value => value.document_code === draft.target?.document_code) && <option value={draft.target.document_code}>{draft.target.title}</option>}{eligibleDocuments.map(document => <option key={document.document_code} value={document.document_code}>{document.title} · r{document.current_revision}</option>)}</select></label>
            {library.error && <p role="alert" className="system-agent-error">{library.error.message}</p>}
            <p className="system-agent-muted">{t('第一版支持文档库中可直接编辑的项目文档。需求、架构与测试来源文档后续接入。')}</p>
            {draft.target && <div className="system-agent-target"><strong>{draft.target.title}</strong><span>r{draft.target.base_revision} · {draft.target.quote ? t('选区批注') : t('整篇文档')}</span>{draft.target.quote && <blockquote>{draft.target.quote}</blockquote>}</div>}
            <label className="system-agent-field">{t('给 Agent 的批注')}<textarea required rows={5} maxLength={8000} value={draft.instruction} disabled={create.isPending} placeholder={t('例如：补充这段流程的失败分支、权限边界和可验证的验收条件；没有依据的内容列为待确认。')} onChange={event => { resetErrors(); setDraft(current => ({ ...current, instruction: event.target.value, request_key: freshKey() })); }} /></label>
            {error && <p role="alert" className="system-agent-error">{error}<br />{t('提交结果不确定时可再次提交相同内容，平台会复用同一任务。')}</p>}
            <div className="system-agent-composer-footer"><span className="system-agent-muted">{t('仅生成草稿，不自动保存正式文档。')}</span><button type="submit" className="ui-button ui-button-primary" disabled={create.isPending || selecting || !draft.target || !draft.instruction.trim() || !status.isSuccess || !status.data?.configured || !canWrite}>{t(create.isPending ? '正在提交…' : '交给 Agent 生成草稿')}</button></div>
          </form>}
        </div>
        <footer className="system-agent-footer">{t('系统 Agent 的建议需要核验；规则检查不等于人工批准。')}</footer>
      </aside>
    </div>}
  </>;
}

export function SystemAgentJobContext({ job }: { job: SystemAgentJob }) {
  return <section className="system-agent-job-context"><div className="system-agent-section-heading"><h3>{job.base_title}</h3><span className={`system-agent-status system-agent-status-${job.status}`}>{t(statusLabels[job.status])}</span></div><p className="system-agent-muted">{t('基于文档 r{revision}', { revision: job.base_revision })} · {formatDateTime(job.created_at)}</p>{job.quote && <blockquote>{job.quote}</blockquote>}<p className="system-agent-user-message">{job.instruction}</p>{job.execution_metadata && <details className="system-agent-quality"><summary>{t('执行依据')}</summary><p>{job.execution_metadata.engine} · {job.execution_metadata.engine_version} · {job.execution_metadata.model}</p><p>Skill {job.execution_metadata.skill_version}</p><code className="break-all">{job.execution_metadata.skill_sha256}</code></details>}</section>;
}

export function SystemAgentJobActions({ job, pending, applying, canWrite, refreshing, onAction, onNew, onRefresh }: { job: SystemAgentJob; pending: boolean; applying: boolean; canWrite: boolean; refreshing: boolean; onAction: (kind: 'apply' | 'reject' | 'cancel') => void; onNew: () => void; onRefresh: () => void }) {
  return <div className="system-agent-job-actions">
    {systemAgentJobActive(job) && <button type="button" className="ui-button ui-button-secondary" disabled={pending} onClick={() => onAction('cancel')}>{t('取消任务')}</button>}
    {job.status === 'awaiting_review' && <><button type="button" className="ui-button ui-button-secondary" disabled={pending} onClick={() => onAction('reject')}>{t('拒绝这份草稿')}</button><button type="button" className="ui-button ui-button-primary" disabled={pending || !systemAgentCanApply(job) || !canWrite} onClick={() => { if (!pending && systemAgentCanApply(job) && canWrite) onAction('apply'); }}>{t(applying ? '正在保存新版本…' : '确认采用并保存新版本')}</button></>}
    {!systemAgentJobActive(job) && job.status !== 'applied' && <button type="button" className="system-agent-link" disabled={pending} onClick={onNew}>{t('基于最新版本新建任务')}</button>}
    <button type="button" className="system-agent-link" disabled={refreshing} onClick={onRefresh}>{t('刷新状态')}</button>
  </div>;
}

export function SystemAgentProposalReview({ job, mode, onModeChange }: { job: SystemAgentJob; mode: 'diff' | 'preview'; onModeChange: (mode: 'diff' | 'preview') => void }) {
  const proposal = job.proposal;
  if (!proposal) return null;
  return <section className="system-agent-proposal"><h3>{t('修改草稿')}</h3><p className="system-agent-rationale">{proposal.rationale}</p>
    <AgentList title={t('依据')} items={proposal.evidence} empty={t('未提供额外依据，请核验文档事实。')} />
    <AgentList title={t('待确认与风险')} items={proposal.warnings} empty={t('Agent 未列出额外待确认项，仍需你核验。')} />
    {job.quality ? <details className="system-agent-quality"><summary>{t('草稿规则质检')} · {t('符合 {passed} · 待完善 {failed} · 待核验 {review}', { passed: job.quality.summary.passed, failed: job.quality.summary.failed, review: job.quality.summary.needs_review })}</summary><p className="system-agent-muted">{t('规则版本 {version}', { version: job.quality.rule_version })} · {job.quality.scope_note}</p><ul>{job.quality.checks.map(check => <li key={check.id}><strong>{check.title}</strong> · {t({ passed: '符合', failed: '待完善', needs_review: '待核验', not_applicable: '不适用' }[check.status])}<p>{check.message}</p>{check.suggestion && <p>{check.suggestion}</p>}</li>)}</ul></details> : <p className="system-agent-notice">{t('尚无草稿规则检查结果，请核验后决定是否采用。')}</p>}
    <div className="system-agent-section-heading"><h4>{t('完整修改对比')}</h4><div className="system-agent-tabs" role="group" aria-label={t('对比显示方式')}><button type="button" aria-pressed={mode === 'diff'} onClick={() => onModeChange('diff')}>{t('逐行差异')}</button><button type="button" aria-pressed={mode === 'preview'} onClick={() => onModeChange('preview')}>{t('草稿预览')}</button></div></div>
    <p className="system-agent-muted">{t('− 删除 · ＋ 新增 · 无标记为保留内容；标题、摘要与正文均参与采用。')}</p>
    <SystemAgentDiff title={t('标题')} before={job.base_title} after={proposal.title} />
    <SystemAgentDiff title={t('摘要')} before={job.base_summary ?? ''} after={proposal.summary} />
    {mode === 'diff' ? <SystemAgentDiff title={t('正文')} before={job.base_content} after={proposal.content} /> : <div className="system-agent-markdown"><MarkdownDocument content={proposal.content} allowImages={false} /></div>}
    <p className="system-agent-muted">{t('确认后将保存此处完整草稿。若原文已更新，平台会拒绝覆盖。')}</p>
  </section>;
}

function AgentList({ title, items, empty }: { title: string; items: string[]; empty: string }) { return <div className="system-agent-evidence"><h4>{title}</h4>{items.length ? <ul>{items.map((value, index) => <li key={index}>{value}</li>)}</ul> : <p className="system-agent-muted">{empty}</p>}</div>; }

export function SystemAgentDiff({ title, before, after }: { title: string; before: string; after: string }) {
  const lines = useMemo(() => systemAgentLineDiff(before, after), [before, after]);
  return <section className="system-agent-diff" aria-label={t('{title}差异', { title })}><h5>{title} {before === after && <span>{t('未变化')}</span>}</h5><div className="system-agent-diff-lines" tabIndex={0} role="region" aria-label={t('{title}完整逐行对比', { title })}>{lines.map((line, index) => <div key={index} className={`system-agent-diff-line system-agent-diff-${line.kind}`}><span aria-hidden="true" className="system-agent-line-numbers">{line.before ?? ' '}<br />{line.after ?? ' '}</span><span className="system-agent-diff-mark" aria-label={t(line.kind === 'added' ? '新增行' : line.kind === 'removed' ? '删除行' : '保留行')}>{line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}</span><code>{line.text || '\u00a0'}</code></div>)}</div></section>;
}

export function SystemAgentAnnotation({ target, content, children }: { target: SystemAgentTarget; content: string; children: ReactNode }) {
  const [selection, setSelection] = useState('');
  const [invalidSelection, setInvalidSelection] = useState<'format' | 'too_long' | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const tools = useRef<HTMLDetailsElement>(null);
  const capture = () => {
    const selected = window.getSelection();
    if (!selected || selected.isCollapsed || !contentRef.current?.contains(selected.anchorNode) || !contentRef.current.contains(selected.focusNode)) return;
    const text = selected.toString().trim();
    if (!text) return;
    const quote = exactSystemAgentQuote(content, text);
    if (tools.current) tools.current.open = true;
    setSelection(quote ?? ''); setInvalidSelection(quote ? null : text.length > 20_000 ? 'too_long' : 'format');
  };
  return <>
    <details ref={tools} className="system-agent-annotation"><summary>{t('文档批注')}</summary><div className="system-agent-annotation-actions"><span>{t('选中正文中的文字，即可添加批注。')}</span><button type="button" className="system-agent-link" onClick={() => { setSelection(''); setInvalidSelection(null); window.dispatchEvent(new CustomEvent(SYSTEM_AGENT_OPEN_EVENT, { detail: target })); }}>{t('整篇交给 Agent')}</button></div>
      {selection && <div className="system-agent-selected-quote"><blockquote>{selection}</blockquote><button type="button" className="ui-button ui-button-primary ui-button-compact" onClick={() => window.dispatchEvent(new CustomEvent(SYSTEM_AGENT_OPEN_EVENT, { detail: { ...target, quote: selection } }))}>{t('批注交给 Agent')}</button><button type="button" className="system-agent-link" onClick={() => setSelection('')}>{t('清除选区')}</button></div>}
      {invalidSelection && <p role="status" className="system-agent-notice">{t(invalidSelection === 'too_long' ? '批注引用最多 20000 字符，请缩小选区或改为整篇批注。' : '选中文字含渲染格式，无法精确定位原文。请在下方 Markdown 原文中选择，或改为整篇批注。')}</p>}
      <details open={Boolean(invalidSelection) || undefined}><summary>{t('从 Markdown 原文选择')}</summary><textarea readOnly rows={7} value={content} aria-label={t('选择批注原文')} onSelect={event => { const element = event.currentTarget; const quote = content.slice(element.selectionStart, element.selectionEnd).trim(); if (quote) { setSelection(quote.length <= 20_000 ? quote : ''); setInvalidSelection(quote.length > 20_000 ? 'too_long' : null); } }} /></details>
    </details>
    <div ref={contentRef} onMouseUp={capture} onKeyUp={capture}>{children}</div>
  </>;
}
