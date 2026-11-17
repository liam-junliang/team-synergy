import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { t } from './i18n';
import { useLocale } from './useLocale';
import { documentQualityPurposes, getDocumentQuality, qualityReportMatches, type DocumentQualityCheck, type DocumentQualityPurpose, type DocumentQualityResponse } from './documentQualityApi';

const checkLabels = { passed: '符合检查项', failed: '待完善', needs_review: '待人工核验', not_applicable: '不适用' };
const checkStyles = { passed: 'bg-emerald-50 text-emerald-800', failed: 'bg-amber-50 text-amber-900', needs_review: 'bg-slate-100 text-slate-600', not_applicable: 'bg-slate-50 text-slate-500' };
const reviewLabels = { not_requested: '尚未发起', open: '评审中', passed: '该版评审通过', changes_requested: '需要修改', no_consensus: '尚未形成共识', not_available: '本报告未包含' };

export function DocumentQualityPanel({ projectCode, documentCode, revision, onLocate }: {
  projectCode: string; documentCode: string; revision: number; onLocate?: (line: number) => void;
}) {
  useLocale();
  const [open, setOpen] = useState(false);
  const [purpose, setPurpose] = useState<DocumentQualityPurpose>();
  const [tab, setTab] = useState<'findings' | 'standards'>('findings');
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const locating = useRef(false);
  const id = useId();
  const query = useQuery({
    queryKey: ['document-quality', projectCode, documentCode, revision, purpose ?? 'auto'],
    queryFn: () => getDocumentQuality(documentCode, revision, purpose),
    enabled: Boolean(projectCode && documentCode && revision > 0), retry: false,
  });
  const report = !query.error && qualityReportMatches(query.data, projectCode, documentCode, revision, purpose) ? query.data : undefined;
  const mismatch = Boolean(query.data && !report && !query.error);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    return () => {
      if (!locating.current) previous?.focus();
      locating.current = false;
    };
  }, [open]);

  function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); }
    if (event.key !== 'Tab') return;
    const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), select, a[href], summary, [tabindex="0"]') ?? []).filter(element => element.getClientRects().length);
    const first = controls[0], last = controls.at(-1);
    if (!first || !last) { event.preventDefault(); return; }
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first.focus(); }
  }

  const status = report ? (report.summary.failed ? '需完善' : report.summary.needs_review ? '待人工核验' : '规则检查通过') : query.error ? '检查未完成' : mismatch ? '检查版本已变化' : '正在检查…';
  const tone = report?.summary.failed ? 'bg-amber-50 text-amber-900' : 'bg-slate-50 text-slate-600';
  return <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-1.5" aria-label={t('文档质检摘要')}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className="font-semibold text-slate-700">{t('文档质检')}</span>
        <span role="status" className={`rounded px-2 py-1 font-medium ${tone}`}>{t(status)}</span>
        {report && <span className="hidden text-slate-500 sm:inline">{t('{failed} 项待完善 · {pending} 项待核验', { failed: report.summary.failed, pending: report.summary.needs_review })}</span>}
      </div>
      <button ref={trigger} type="button" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-expanded={open} className="ui-context-action shrink-0">{t('查看质量报告')} →</button>
    </div>
    {report && <p className="hidden flex-wrap gap-x-3 gap-y-0.5 text-xs leading-5 text-slate-500 sm:flex"><span>{t(documentQualityPurposes[report.purpose])} · r{revision}</span><span>{t('人工评审')}：{t(reviewLabels[report.review.status])}</span><span>{t('正式采用')}：{t('未核验')}</span></p>}
    {open && typeof document !== 'undefined' && createPortal(<div className="fixed inset-0 z-[80] flex justify-end bg-slate-950/35" onMouseDown={event => { if (event.target === event.currentTarget) setOpen(false); }}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1} onKeyDown={keyboard} className="flex h-full w-full max-w-[680px] flex-col overflow-hidden bg-white shadow-2xl outline-none">
        <header className="shrink-0 border-b border-slate-200 p-4 sm:p-6">
          <div className="flex items-start justify-between gap-3"><div><p className="text-xs font-medium text-cyan-700">{t('项目文档检查集')} · r{revision}</p><h2 id={`${id}-title`} className="mt-1 text-xl font-semibold text-slate-950">{t('质量报告')}</h2></div><button type="button" onClick={() => setOpen(false)} aria-label={t('关闭质量报告')} className="ui-button ui-button-secondary">{t('关闭')}</button></div>
          <p className="mt-2 text-sm leading-6 text-slate-500">{t('先核对关键问题，再确认资料能否用于开发或交接。')}</p>
          <div className="mt-4 flex flex-wrap items-end gap-3"><label className="min-w-48 flex-1 text-xs font-medium text-slate-600">{t('按资料用途检查')}<select value={purpose ?? ''} onChange={event => setPurpose((event.target.value || undefined) as DocumentQualityPurpose | undefined)} className="form-control mt-1 w-full"><option value="">{t('自动识别用途')}</option>{Object.entries(documentQualityPurposes).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}</select></label><button type="button" disabled={query.isFetching} onClick={() => void query.refetch()} className="ui-button ui-button-secondary">{t(query.isFetching ? '检查中…' : '重新检查')}</button></div>
          <p className="mt-2 text-xs leading-5 text-slate-500">{t('用途选择仅影响本次检查，不修改文档分类或批准状态。')}</p>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
          {query.isPending ? <p role="status" className="py-8 text-sm text-slate-500">{t('正在检查…')}</p> : query.error ? <div role="alert" className="rounded-xl bg-rose-50 p-4 text-sm leading-6 text-rose-800">{t('本次检查未完成，请重试。')}<p className="mt-1 break-words">{query.error.message}</p></div> : mismatch ? <p role="alert" className="rounded-xl bg-amber-50 p-4 text-sm text-amber-900">{t('检查结果与当前文档或版本不一致，请重新检查。')}</p> : report ? <>
            <QualityReportSummary report={report} />
            <div role="group" aria-label={t('质量报告内容')} className="my-5 flex gap-2 border-b border-slate-200 pb-3">{(['findings', 'standards'] as const).map(value => <button key={value} type="button" aria-pressed={tab === value} onClick={() => setTab(value)} className={`rounded-lg px-3 py-2 text-sm font-medium ${tab === value ? 'bg-cyan-50 text-cyan-800' : 'text-slate-500 hover:bg-slate-50'}`}>{t(value === 'findings' ? '检查明细' : '标准与规则')}</button>)}</div>
            {tab === 'findings' ? <QualityCheckList checks={report.checks} onLocate={onLocate ? line => { locating.current = true; setOpen(false); onLocate(line); } : undefined} /> : <QualityStandards report={report} />}
          </> : null}
        </div>
        <footer className="shrink-0 border-t border-slate-200 px-4 py-3 text-xs leading-5 text-slate-500 sm:px-6">{t('本报告提供规则检查和待核验项，不代表业务验收或标准认证。')}</footer>
      </div>
    </div>, document.body)}
  </div>;
}

export function QualityReportSummary({ report }: { report: DocumentQualityResponse }) {
  const s = report.summary;
  return <section aria-label={t('检查覆盖与评审状态')}>
    <div className="rounded-xl bg-slate-50 p-4"><div className="flex flex-wrap items-center justify-between gap-2"><p className="font-medium text-slate-900">{t(documentQualityPurposes[report.purpose])}</p><span className="text-xs text-slate-500">{t(report.purpose_source === 'selected' ? '本次指定用途' : '根据资料自动识别')}</span></div><p className="mt-2 text-sm text-slate-700">{t('适用 {applicable} 项 · 已检查 {checked} 项', { applicable: s.applicable, checked: s.checked })}</p><div className="mt-3 flex flex-wrap gap-2 text-xs"><span className="rounded-md bg-emerald-50 px-2 py-1 text-emerald-800">{t('符合 {count}', { count: s.passed })}</span><span className="rounded-md bg-amber-50 px-2 py-1 text-amber-900">{t('待完善 {count}', { count: s.failed })}</span><span className="rounded-md bg-slate-200/60 px-2 py-1 text-slate-600">{t('待核验 {count}', { count: s.needs_review })}</span>{s.not_applicable > 0 && <span className="px-2 py-1 text-slate-500">{t('不适用 {count}', { count: s.not_applicable })}</span>}</div></div>
    <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-2"><div><dt className="text-slate-500">{t('人工评审')}</dt><dd className="mt-1 font-medium text-slate-800">{t(reviewLabels[report.review.status])} · r{report.review.revision}</dd></div><div><dt className="text-slate-500">{t('正式采用')}</dt><dd className="mt-1 text-slate-700">{t('未核验')}</dd></div></dl>
    <p className="mt-3 text-xs leading-5 text-slate-500">{report.scope_note}</p>
  </section>;
}

export function QualityCheckList({ checks, onLocate }: { checks: DocumentQualityCheck[]; onLocate?: (line: number) => void }) {
  const order = { failed: 0, needs_review: 1, passed: 2, not_applicable: 3 };
  return <ul className="space-y-3">{[...checks].sort((a, b) => order[a.status] - order[b.status]).map(check => <li key={check.id} className="rounded-xl border border-slate-200 p-4">
    <div className="flex flex-wrap items-center gap-2"><span className={`rounded px-2 py-1 text-xs font-medium ${checkStyles[check.status]}`}>{t(checkLabels[check.status])}</span>{check.status === 'failed' && check.severity === 'blocker' && <span className="text-xs font-medium text-rose-700">{t('关键问题')}</span>}<h3 className="text-sm font-semibold text-slate-900">{check.title}</h3></div>
    <p className="mt-2 text-sm leading-6 text-slate-600">{check.message}</p>
    {check.status !== 'passed' && check.status !== 'not_applicable' && <p className="mt-2 rounded-lg bg-slate-50 p-3 text-xs leading-6 text-slate-600"><span className="font-medium text-slate-800">{t('建议')}：</span>{check.suggestion}</p>}
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400"><code>{check.id}</code>{check.line_start && (onLocate ? <button type="button" onClick={() => { if (check.line_start) onLocate(check.line_start); }} className="font-medium text-cyan-700 hover:underline">{t('定位正文第 {line} 行', { line: check.line_start })} ↗</button> : <span>{t('正文第 {line} 行', { line: check.line_start })}</span>)}</div>
  </li>)}</ul>;
}

export function QualityStandards({ report }: { report: DocumentQualityResponse }) {
  return <section className="space-y-4" aria-label={t('检查依据')}>
    <div className="rounded-xl border border-cyan-100 bg-cyan-50/50 p-4"><h3 className="text-sm font-semibold text-cyan-950">{t('项目文档检查集')} {report.rule_version}</h3><p className="mt-2 text-xs leading-6 text-cyan-900">{t('采用下列标准的相关主题形成项目规则；这里展示检查范围，不提供标准符合性评分。')}</p></div>
    {report.standards.map(standard => <div key={standard.id} className="rounded-xl border border-slate-200 p-4"><a href={standard.url} target="_blank" rel="noopener noreferrer" className="break-words text-sm font-medium text-cyan-800 hover:underline">{standard.title} ↗</a><p className="mt-2 text-xs leading-6 text-slate-500">{standard.note}</p><ul className="mt-3 space-y-1 text-xs leading-5 text-slate-600">{report.checks.filter(check => check.standard_ids.includes(standard.id)).map(check => <li key={check.id}><code className="mr-2 text-slate-400">{check.id}</code>{check.title}</li>)}</ul></div>)}
    <details className="rounded-xl border border-slate-200 p-4 text-xs text-slate-500"><summary className="cursor-pointer font-medium">{t('本次检查版本与范围')}</summary><div className="mt-3 space-y-2 leading-5"><p>{t('检查时间')}：{new Date(report.checked_at).toLocaleString()}</p><p>{t('规则版本')}：{report.rule_version}</p><p className="break-all">{t('文档编码')}：{report.document_code} · r{report.revision}</p><p className="break-all">SHA-256：{report.content_sha256}</p>{report.diagram_source_sha256 && <p className="break-all">{t('图源指纹')}：{report.diagram_source_sha256}</p>}</div></details>
  </section>;
}
