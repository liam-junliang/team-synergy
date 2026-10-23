import { t } from './i18n';
import type { IntakeBatchDetail } from './intakeApi';

const labels = { specified: '已形成规格', pending: '待补规格', excluded: '范围外', unknown: '范围待确认' };
export function IntakeCoverage({ batch, onSelect }: { batch: IntakeBatchDetail; onSelect?: (key: string) => void }) {
  const coverage = batch.quality_report?.coverage;
  return <section aria-label={t('功能规格与覆盖')} className="mt-4 border-t border-slate-200 pt-4">
    <h4 className="text-sm font-semibold text-slate-800">{t('功能规格与覆盖')}</h4>
    {!coverage || coverage.status === 'unknown' ? <p className="mt-2 text-xs leading-6 text-amber-900">{t('尚无能力清单，业务覆盖范围未知。资料目录齐全不能代替功能覆盖。')}</p> : <>
      <p className="mt-2 text-xs leading-6 text-slate-600">{coverage.scope}</p>
      <dl className="mt-3 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
        <div><dt className="text-slate-500">{t('范围内能力')}</dt><dd className="mt-1 font-semibold text-slate-800">{coverage.in_scope}</dd></div>
        <div><dt className="text-slate-500">{t('已形成规格 / 待补')}</dt><dd className="mt-1 font-semibold text-slate-800">{coverage.specified} / {coverage.pending}</dd></div>
        <div><dt className="text-slate-500">{t('范围待确认 / 范围外')}</dt><dd className="mt-1 font-semibold text-slate-800">{coverage.unknown} / {coverage.excluded}</dd></div>
        <div><dt className="text-slate-500">{t('待处理来源冲突')}</dt><dd className="mt-1 font-semibold text-slate-800">{coverage.open_conflicts}</dd></div>
      </dl>
      <p className="mt-3 rounded-lg bg-slate-50 p-3 text-xs leading-6 text-slate-600">{t('结构化需求 {total} · 有验收标准 {acceptance} · 有逐条验证计划 {verification}', { total: coverage.requirements, acceptance: coverage.with_acceptance, verification: coverage.with_verification })}<br />{t('数字仅针对声明的能力清单；有验证计划不代表已执行或通过。')}{coverage.discovery_status !== 'reviewed' && <span className="text-amber-900"> {t('能力盘点尚未完成范围复核。')}</span>}</p>
      <details className="mt-3"><summary className="cursor-pointer text-xs font-semibold text-cyan-800">{t('查看能力、规格与验收关联')} · {coverage.declared}</summary>
        <ul className="mt-3 space-y-2">{coverage.rows.map(row => <li key={row.key} className="rounded-lg border border-slate-200 p-3 text-xs">
          <div className="flex flex-wrap items-start justify-between gap-2"><span className="font-medium text-slate-800">{row.title}</span><span className={`rounded px-2 py-1 ${row.state === 'specified' ? 'bg-cyan-50 text-cyan-800' : 'bg-amber-50 text-amber-900'}`}>{t(labels[row.state])}</span></div>
          <code className="mt-1 block break-all text-[11px] text-slate-400">{row.key}</code>
          {row.reason && <p className="mt-2 break-words leading-6 text-slate-500">{row.reason}</p>}
          <div className="mt-2 flex flex-wrap gap-2">{[row.feature_key, ...row.requirement_keys].filter((key): key is string => Boolean(key)).map(key => {
            const view = batch.items.find(view => view.item.key === key);
            return view && <button type="button" key={key} disabled={!onSelect} onClick={() => onSelect?.(key)} className="max-w-full break-words rounded bg-slate-50 px-2 py-1 text-left leading-5 text-cyan-800 hover:bg-cyan-50">{view.item.title}{view.item.kind === 'requirement' && <span className="ml-1 text-slate-500">· {view.item.acceptance_criteria?.length ?? 0} AC</span>}</button>;
          })}</div>
        </li>)}</ul>
      </details>
    </>}
  </section>;
}
