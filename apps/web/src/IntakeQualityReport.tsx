import { t } from './i18n';
import type { IntakeBatchDetail } from './intakeApi';
import { ENTERPRISE_ARTIFACTS } from '../../../packages/contracts/src/intake-quality-catalog';
import { IntakeCoverage } from './IntakeCoverage';

const artifactLabels = Object.fromEntries(ENTERPRISE_ARTIFACTS.map(artifact => [artifact.type, artifact.title]));
const gateLabels = { unknown: '档位未确认', blocked: '有质量阻断项', eligible: '规则门禁可进入审阅', stale: '检查依据已变化' };
const publicationLabels = { not_started: '尚未执行', in_progress: '执行中', partial: '部分执行', completed: '执行完成' };
const issueLabels = { blocker: '阻断项', warning: '改进项', needs_review: '待核验' };
const issueStyles = { blocker: 'bg-rose-50 text-rose-800', warning: 'bg-amber-50 text-amber-900', needs_review: 'bg-slate-100 text-slate-600' };

export function IntakeQualityReport({ batch, onSelect }: { batch: IntakeBatchDetail; onSelect?: (key: string, line?: number) => void }) {
  const gate = batch.quality_gate;
  const report = batch.quality_report;
  const dossier = batch.dossier;
  const publication = batch.publication;
  const status = gate?.status ?? 'unknown';
  return <section aria-label={t('候选质量与交付状态')} className="min-w-0 rounded-xl border border-slate-200 bg-white p-4">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-sm font-semibold text-slate-900">{t('候选质量与交付状态')}</h3><p className="mt-1 text-xs leading-5 text-slate-500">{t('质量检查、负责人确认、发布执行和档案覆盖分别记录。')}</p></div><span role="status" className={`rounded-md px-2 py-1 text-xs font-medium ${status === 'blocked' ? 'bg-rose-50 text-rose-800' : 'bg-slate-100 text-slate-700'}`}>{t(gateLabels[status])}</span></div>
    <dl className="mt-4 grid gap-4 text-xs sm:grid-cols-2 xl:grid-cols-4">
      <div><dt className="text-slate-500">{t('交付档位')}</dt><dd className="mt-1 font-medium text-slate-800">{t(batch.profile === 'enterprise' ? '企业档位' : batch.profile === 'pilot' ? '试点档位' : '未知历史档位')}</dd><dd className="mt-1 leading-5 text-slate-500">{report ? t('规则 {version} · 候选 r{revision}', { version: report.rule_version, revision: report.batch_revision ?? '?' }) : t('尚无可用的持久化质量报告')}</dd></div>
      <div><dt className="text-slate-500">{t('负责人确认')}</dt><dd className="mt-1 font-medium text-slate-800">{t('未记录正式批准')}</dd><dd className="mt-1 leading-5 text-slate-500">{batch.approval?.note ?? t('冻结计划记录逐项发布选择，不代表正式业务批准。')}</dd></div>
      <div><dt className="text-slate-500">{t('发布执行')}</dt><dd className="mt-1 font-medium text-slate-800">{t(publication ? publicationLabels[publication.status] : '尚未执行')}</dd>{publication && <dd className="mt-1 leading-5 text-slate-500">{t('新增 {created} · 关联 {bound} · 跳过 {skipped} / {total} 项', publication)}</dd>}</div>
      <div><dt className="text-slate-500">{t('企业档案覆盖')}</dt><dd className="mt-1 font-medium text-slate-800">{dossier ? t('候选覆盖 {present} / {required} 类', { present: dossier.present, required: dossier.required }) : t('尚未核验')}</dd>{dossier && <dd className="mt-1 leading-5 text-slate-500">{t('必交资料新增 {published} · 关联 {bound} · 跳过 {skipped}', { published: dossier.published, bound: dossier.bound, skipped: dossier.skipped })}</dd>}<dd className="mt-1 leading-5 text-slate-500">{t('正文质量与正式采用仍需核验')}</dd></div>
    </dl>
    <IntakeCoverage batch={batch} onSelect={onSelect} />
    <p className="mt-4 rounded-lg bg-slate-50 p-3 text-xs leading-6 text-slate-600">{gate?.note ?? t('历史批次未保存交付档位和质量依据，不能追认检查通过。请选择档位并重新审阅。')}</p>
    {dossier && dossier.missing.length > 0 && <p className="mt-3 break-words text-xs leading-6 text-amber-900">{t('缺少必交资料')}：{dossier.missing.map(value => t(artifactLabels[value] ?? value)).join(' · ')}</p>}
    {dossier && (dossier.bound > 0 || dossier.skipped > 0) && <p className="mt-2 text-xs leading-6 text-amber-900">{t('关联或跳过必交项，不代表全部企业资料已发布并核验。')}</p>}
    {report && <details className="mt-4 border-t border-slate-200 pt-3"><summary className="cursor-pointer text-xs font-semibold text-cyan-800">{t('查看候选质量报告')} · {t('阻断 {blockers} · 改进 {warnings} · 待核验 {needs_review}', report.summary)}</summary><div className="mt-3 space-y-3"><p className="text-xs leading-6 text-slate-500">{report.scope_note}</p><p className="text-xs leading-6 text-slate-500">{t('检查范围为上传的候选与来源摘要；不会读取本机源码、执行测试或评审关联目标正文。')}</p>{report.payload_hash && <p className="break-all text-[11px] leading-5 text-slate-400">SHA-256: <code>{report.payload_hash}</code></p>}
      <ul className="space-y-3">{[...report.issues].sort((a, b) => ({ blocker: 0, warning: 1, needs_review: 2 })[a.severity] - ({ blocker: 0, warning: 1, needs_review: 2 })[b.severity]).map((issue, index) => <li key={`${issue.rule_id}:${issue.item_key ?? ''}:${index}`} className="rounded-lg border border-slate-200 p-3"><div className="flex flex-wrap items-center justify-between gap-2 text-xs"><span className={`rounded px-2 py-1 font-medium ${issueStyles[issue.severity]}`}>{t(issueLabels[issue.severity])}</span><code className="break-all text-[11px] text-slate-400">{issue.rule_id}</code></div><p className="mt-2 break-words text-sm leading-6 text-slate-700">{issue.message}</p><p className="mt-2 break-words text-xs leading-6 text-slate-500">{t('建议')}：{issue.suggestion}</p>{issue.artifact_type && <p className="mt-2 text-xs text-slate-500">{t(artifactLabels[issue.artifact_type] ?? issue.artifact_type)}</p>}{issue.item_key && <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs"><code className="break-all text-slate-500">{issue.item_key}</code>{onSelect && batch.items.some(view => view.item.key === issue.item_key) && <button type="button" className="font-medium text-cyan-800 hover:underline" onClick={() => { if (issue.item_key) onSelect(issue.item_key, issue.line_start); }}>{issue.line_start ? t('定位候选第 {line} 行', { line: issue.line_start }) : t('查看对应候选')} ↗</button>}</div>}</li>)}</ul>{report.issues.length === 0 && <p className="text-xs leading-6 text-slate-500">{t('本规则集未发现问题，仍需核对业务语义和实际实现。')}</p>}</div></details>}
    <details className="mt-4 border-t border-slate-200 pt-3"><summary className="cursor-pointer text-xs font-semibold text-cyan-800">{t('企业资料标准目录')}</summary><p className="mt-3 text-xs leading-6 text-slate-500">{t('按资料用途组织交付内容；规则检查用于查漏，语义正确性和证据真实性仍需核验。')}</p><ul className="mt-3 grid gap-3 md:grid-cols-2">{ENTERPRISE_ARTIFACTS.map(artifact => <li key={artifact.type} className="rounded-lg bg-slate-50 p-3"><h4 className="text-xs font-semibold text-slate-800">{t(artifact.title)} <span className="ml-1 font-normal text-slate-500">{t(artifact.required ? '必交' : '按需')}</span></h4><p className="mt-2 text-xs leading-6 text-slate-500">{artifact.sections.map(section => t(section)).join(' · ')}</p></li>)}</ul></details>
  </section>;
}

export function locateIntakeQualityLine(container: HTMLElement | null, line?: number): boolean {
  if (!container) return false;
  const markdown = container.querySelector<HTMLElement>('[data-intake-candidate-content]');
  if (!markdown) return false;
  const nodes = Array.from(markdown.querySelectorAll<HTMLElement>('[data-source-line]'));
  const target = Number.isSafeInteger(line) && Number(line) > 0 ? nodes.filter(node => Number(node.dataset.sourceLine) <= Number(line)).at(-1) ?? nodes[0] ?? markdown : markdown;
  target.setAttribute('tabindex', '-1');
  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  target.focus({ preventScroll: true });
  return true;
}
