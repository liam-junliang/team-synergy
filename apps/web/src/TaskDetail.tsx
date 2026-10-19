import { useLocale } from './useLocale';
import { t, formatDateTime } from './i18n.ts';
import type { AuditEvent, TaskArtifact, TaskDetail, TaskEvidence, TaskRun } from './api';
import { STATUS_META, PROFILE_META, SOURCE_META } from './status';
import { MarkdownDocument } from './MarkdownDocument';
import { useProjectDisplayNames } from './ProjectDisplayNames';
import type { ReactNode } from 'react';
import { HandoverPanel } from './HandoverPanel';
import { TaskBaselinePanel } from './TaskBaselinePanel';

/** 审计动作中文映射 */
const ACTION_LABEL: Record<string, string> = {
  'task.created': '创建',
  'task.assigned': '分派',
  'task.claimed': '领取',
  'task.self_tested': '自测完成',
  'task.submitted': '提交',
  'task.verification_claimed': '验证领取',
  'task.verified': '验证通过',
  'task.closed': '关闭',
  'member.added': '成员加入',
  'member.removed': '成员移除',
  'feature.created': 'Feature 创建',
};

const EVIDENCE_TYPE_LABEL: Record<string, string> = {
  self_test: '自测',
  verifier_review: '验证复核',
  deployment: '部署',
  manual: '人工',
};

const EVIDENCE_RESULT_LABEL: Record<string, string> = {
  pass: '通过',
  fail: '失败',
  inconclusive: '待定',
};

function OverviewItem({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0 bg-white px-4 py-3">
      <dt className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">{label}</dt>
      <dd className={`mt-1 text-xs font-medium text-slate-700 [overflow-wrap:anywhere] ${mono ? 'font-mono' : ''}`}>
        {value}
      </dd>
    </div>
  );
}

function Section({
  id,
  title,
  subtitle,
  count,
  children,
}: {
  id: string;
  title: string;
  subtitle?: string;
  count?: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <header className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3.5">
        <div className="min-w-0">
          <h3 id={id} className="text-sm font-semibold text-slate-800">{title}</h3>
          {subtitle && <p className="mt-0.5 text-[11px] text-slate-400">{subtitle}</p>}
        </div>
        {count && <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-500">{count}</span>}
      </header>
      <div className="p-4 sm:p-5">
        {children}
      </div>
    </section>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/70 px-4 py-8 text-center text-xs text-slate-400">
      {label}
    </div>
  );
}

function CodeBlock({ children }: { children: string }) {
  return <code className="block break-all rounded-lg bg-slate-100 px-2.5 py-2 font-mono text-[11px] text-slate-600">{children}</code>;
}

function EntityChip({ title, code, tone = 'slate' }: { title: string; code: string; tone?: 'slate' | 'cyan' | 'amber' | 'rose' }) {
  const toneClass = tone === 'cyan'
    ? 'bg-cyan-50 text-cyan-800 ring-cyan-100'
    : tone === 'amber'
      ? 'bg-amber-50 text-amber-800 ring-amber-100'
      : tone === 'rose'
        ? 'bg-rose-50 text-rose-800 ring-rose-100'
        : 'bg-slate-50 text-slate-700 ring-slate-200';
  return (
    <span className={`inline-flex max-w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-[11px] font-semibold ring-1 ${toneClass}`}>
      <span className="min-w-0 truncate">{title}</span>
      <code className="shrink-0 font-mono text-[10px] opacity-70">{code}</code>
    </span>
  );
}

function EvidenceTypePill({ type }: { type: string }) {
  const label = t(EVIDENCE_TYPE_LABEL[type] ?? type);
  return <span className="rounded-full bg-cyan-50 px-2.5 py-1 text-[11px] font-semibold text-cyan-700">{label}</span>;
}

function ResultPill({ result }: { result: string }) {
  const label = t(EVIDENCE_RESULT_LABEL[result] ?? result);
  const tone = result === 'pass' ? 'bg-emerald-100 text-emerald-700' : result === 'fail' ? 'bg-rose-100 text-rose-700' : 'bg-amber-100 text-amber-700';
  return <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${tone}`}>{label}</span>;
}

function RunCard({ run, memberName }: { run: TaskRun; memberName: (code: string) => string }) {
  return (
    <article className="rounded-xl border border-slate-200 bg-slate-50/70 p-4">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="text-sm font-semibold text-slate-900 [overflow-wrap:anywhere]">Run {run.run_code}</h4>
          <p className="mt-1 text-[11px] text-slate-400">
            {run.profile} · {memberName(run.principal_code) || run.principal_code}
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold text-slate-500 ring-1 ring-slate-200">
          {run.status}
        </span>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-2 text-[11px] text-slate-500">
        <div>
          <dt className="text-[10px] uppercase tracking-[0.12em] text-slate-400">Workspace</dt>
          <dd className="mt-1 font-semibold text-slate-700">{run.workspace_code}</dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-[0.12em] text-slate-400">Base</dt>
          <dd className="mt-1 font-mono text-slate-700">#{run.base_snapshot}</dd>
        </div>
        <div className="col-span-2 min-w-0">
          <dt className="text-[10px] uppercase tracking-[0.12em] text-slate-400">{t("路径")}</dt>
          <dd className="mt-1 break-all font-mono text-slate-600">{run.workspace_path}</dd>
        </div>
        <div className="col-span-2 min-w-0">
          <dt className="text-[10px] uppercase tracking-[0.12em] text-slate-400">{t("基线")}</dt>
          <dd className="mt-1 break-all font-mono text-slate-600">{run.git_base || '—'}</dd>
        </div>
        <div className="col-span-2">
          <dt className="text-[10px] uppercase tracking-[0.12em] text-slate-400">{t("时间")}</dt>
          <dd className="mt-1 text-slate-600">
            <time dateTime={run.started_at}>{formatDateTime(run.started_at)}</time>
            {run.finished_at ? <span> → <time dateTime={run.finished_at}>{formatDateTime(run.finished_at)}</time></span> : <span> {t("· 进行中")}</span>}
          </dd>
        </div>
      </dl>
    </article>
  );
}

function EvidenceCard({ evidence }: { evidence: TaskEvidence }) {
  return (
    <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 className="text-sm font-semibold text-slate-900">{evidence.evidence_code}</h4>
          <p className="mt-1 text-[11px] text-slate-400">
            {evidence.run_code ? `Run ${evidence.run_code}` : t('未绑定 Run')}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <EvidenceTypePill type={evidence.type} />
          <ResultPill result={evidence.result} />
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {evidence.acceptance_refs.length ? evidence.acceptance_refs.map((ref) => (
          <span key={ref} className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600">{ref}</span>
        )) : <span className="text-xs text-slate-400">{t("未关联验收项")}</span>}
      </div>
      {evidence.summary && <p className="mt-3 text-xs leading-5 text-slate-600 [overflow-wrap:anywhere]">{evidence.summary}</p>}
      {evidence.command && <CodeBlock>{evidence.command}</CodeBlock>}
      {evidence.report_uri && <p className="mt-3 break-all text-[11px] text-slate-400">{t("报告：")}{evidence.report_uri}</p>}
      <p className="mt-2 text-[11px] text-slate-400">
        <time dateTime={evidence.recorded_at}>{formatDateTime(evidence.recorded_at)}</time>
      </p>
    </article>
  );
}

function ArtifactCard({ artifact }: { artifact: TaskArtifact }) {
  return (
    <article className="rounded-xl border border-slate-200 bg-slate-50/70 p-4">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="text-sm font-semibold text-slate-900">{artifact.title ?? artifact.kind}</h4>
          <p className="mt-1 text-[11px] text-slate-400">{artifact.artifact_code}</p>
        </div>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${artifact.published ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
          {artifact.published ? t('已发布') : t('未发布')}
        </span>
      </div>
      {artifact.summary && <p className="mt-3 text-xs leading-5 text-slate-600 [overflow-wrap:anywhere]">{artifact.summary}</p>}
      <div className="mt-3 space-y-2">
        <CodeBlock>{artifact.uri}</CodeBlock>
        <CodeBlock>{artifact.content_hash}</CodeBlock>
      </div>
    </article>
  );
}

export function TaskDetail({ task, events, stale, staleHint }: {
  task: TaskDetail;
  events: AuditEvent[];
  stale: boolean;
  staleHint?: string;
}) {
  useLocale();
  const meta = STATUS_META[task.status] ?? { label: task.status, color: 'bg-slate-200 text-slate-700' };
  const acceptance = task.acceptance ?? [];
  const requirementAcceptance = task.requirement_acceptance_criteria ?? [];
  const validationSeams = task.validation_seams ?? [];
  const scopePaths = task.scope?.writable_paths ?? [];
  const runs = task.runs ?? [];
  const evidences = task.evidences ?? [];
  const artifacts = task.artifacts ?? [];
  const { featureName, memberName, projectName } = useProjectDisplayNames();
  const assignee = memberName(task.assignee_code);
  const featureLabel = featureName(task.feature_code);
  const projectLabel = projectName;
  const requirementLabel = task.requirement_title ?? task.requirement_code ?? t('未绑定需求');

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <section aria-label={t("任务概览")} className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="bg-gradient-to-br from-white via-white to-cyan-50/60 p-4 sm:p-5">
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-4">
            <div className="min-w-0">
              <h2 className="min-w-0 text-lg font-bold leading-7 text-slate-900 [overflow-wrap:anywhere] sm:text-xl">
                {task.title}
              </h2>
              <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2">
                <code className="rounded-md bg-slate-900 px-2 py-1 font-mono text-[11px] font-semibold text-white">
                  {task.code}
                </code>
                <EntityChip title={projectLabel || t('项目')} code={task.project_code} tone="cyan" />
                <EntityChip title={featureLabel || 'Feature'} code={task.feature_code} tone="slate" />
                <EntityChip title={requirementLabel} code={task.requirement_code ?? '—'} tone="amber" />
                {task.defect_code && <EntityChip title="Defect" code={task.defect_code} tone="rose" />}
              </div>
            </div>
            <span
              title={t(meta.label)}
              className={`inline-flex max-w-[8rem] shrink-0 items-center truncate whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ${meta.color}`}
            >
              {t(meta.label)}
            </span>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-slate-200 sm:grid-cols-4">
            <OverviewItem label={t("负责人")} value={assignee} />
            <OverviewItem label={t("角色")} value={t(PROFILE_META[task.profile] ?? task.profile)} />
            <OverviewItem label={t("来源")} value={t(SOURCE_META[task.source] ?? task.source)} />
            <OverviewItem label={t("快照")} value={`#${task.base_snapshot}`} mono />
          </div>
        </div>
      </section>

      <TaskBaselinePanel key={`baseline-${task.code}`} task={task} />
      <HandoverPanel key={task.code} task={task} />

      <section aria-labelledby="brief-heading" className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <header className="border-b border-slate-100 px-4 py-3.5">
          <h3 id="brief-heading" className="text-sm font-semibold text-slate-800">{t("任务简报")}</h3>
          <p className="mt-0.5 text-[11px] text-slate-400">{t("优先展示简报正文，支持 Markdown 和纯文本混排。")}</p>
        </header>
        <div className="px-4 py-4 sm:px-5">
          {task.brief ? <MarkdownDocument content={task.brief} /> : <EmptyState label={t("暂无简报")} />}
        </div>
      </section>

      {stale && (
        <aside className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-3.5 text-amber-900" aria-label={t("停滞提醒")}>
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-amber-100 text-sm" aria-hidden="true">!</span>
          <div className="min-w-0">
            <div className="text-sm font-semibold">{t("任务可能已经停滞")}</div>
            <p className="mt-0.5 text-xs leading-5 text-amber-800 [overflow-wrap:anywhere]">
              {staleHint ?? t('该任务超过 24 小时没有活动')}{t("，建议确认是否需要重新分派或补充上下文。")}</p>
          </div>
        </aside>
      )}

      <Section
        id="contract-heading"
        title={t("任务合同")}
        subtitle={t("任务验收、验证接缝与可写范围")}
        count={t("{value0} 项验收 · {value1} 个接缝", { value0: acceptance.length, value1: validationSeams.length })}
      >
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(280px,0.85fr)]">
          <div className="space-y-5 min-w-0">
            <div>
              <h4 className="text-xs font-bold uppercase tracking-[0.12em] text-slate-400">{t("验收标准")}</h4>
              {acceptance.length === 0 ? (
                <div className="mt-3">
                  <EmptyState label={t("暂无验收标准")} />
                </div>
              ) : (
                <ul className="mt-3 space-y-2.5">
                  {acceptance.map((criterion) => (
                    <li key={criterion.id} className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-3 rounded-xl border border-slate-200 bg-slate-50/60 p-3">
                      <code className="rounded-md bg-white px-2 py-1 font-mono text-[10px] font-semibold text-cyan-700 shadow-sm ring-1 ring-slate-200">
                        {criterion.id}
                      </code>
                      <span className="min-w-0 pt-0.5 text-sm leading-5 text-slate-700 [overflow-wrap:anywhere]">
                        {criterion.text}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div>
              <h4 className="text-xs font-bold uppercase tracking-[0.12em] text-slate-400">{t("验证接缝")}</h4>
              {validationSeams.length === 0 ? (
                <div className="mt-3">
                  <EmptyState label={t("暂无验证接缝")} />
                </div>
              ) : (
                <div className="mt-3 flex flex-wrap gap-2">
                  {validationSeams.map((seam) => (
                    <span key={seam} className="rounded-full bg-cyan-50 px-2.5 py-1 text-[11px] font-semibold text-cyan-700 [overflow-wrap:anywhere]">
                      {seam}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="space-y-5 min-w-0">
            <div>
              <h4 className="text-xs font-bold uppercase tracking-[0.12em] text-slate-400">{t("可写范围")}</h4>
              {scopePaths.length === 0 ? (
                <div className="mt-3">
                  <EmptyState label={t("暂无范围约束")} />
                </div>
              ) : (
                <ul className="mt-3 space-y-2">
                  {scopePaths.map((path) => (
                    <li key={path} className="rounded-xl border border-slate-200 bg-slate-50/60 px-3 py-2 text-xs font-mono text-slate-600 [overflow-wrap:anywhere]">
                      {path}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
              <h4 className="text-xs font-bold uppercase tracking-[0.12em] text-slate-400">{t("当前任务口径")}</h4>
              <dl className="mt-3 grid grid-cols-2 gap-3 text-xs text-slate-600">
                <OverviewItem label="Project" value={projectLabel || task.project_code} />
                <OverviewItem label="Feature" value={featureLabel || task.feature_code} />
                <OverviewItem label="Requirement" value={task.requirement_title ?? task.requirement_code ?? t('未绑定')} />
                <OverviewItem label="View" value={task.derived_view || '—'} />
              </dl>
            </div>
          </div>
        </div>
      </Section>

      <Section
        id="requirement-heading"
        title={t("关联需求")}
        subtitle={t("需求正文、需求验收与待决问题")}
        count={t("{value0} 个需求验收 · {value1} 个待决问题", { value0: requirementAcceptance.length, value1: task.requirement_open_questions.length })}
      >
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(280px,0.85fr)]">
          <div className="min-w-0 space-y-4">
            <div>
              <h4 className="text-sm font-semibold text-slate-900 [overflow-wrap:anywhere]">
                {task.requirement_title ?? t('未绑定需求')}
              </h4>
              <div className="mt-2 flex flex-wrap gap-2">
                {task.requirement_code && <EntityChip title={t("需求点")} code={task.requirement_code} tone="cyan" />}
                {task.requirement_document_code && <EntityChip title={t("需求文档")} code={task.requirement_document_code} tone="slate" />}
                {task.project_document_code && <EntityChip title={t("项目文档")} code={task.project_document_code} tone="slate" />}
              </div>
            </div>

            {task.requirement_body ? (
              <div className="rounded-xl border border-slate-200 bg-white p-3">
                <MarkdownDocument content={task.requirement_body} />
              </div>
            ) : (
              <EmptyState label={t("暂无需求正文")} />
            )}
          </div>

          <div className="space-y-4 min-w-0">
            <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
              <h4 className="text-xs font-bold uppercase tracking-[0.12em] text-slate-400">{t("需求验收")}</h4>
              {requirementAcceptance.length === 0 ? (
                <div className="mt-3">
                  <EmptyState label={t("暂无需求验收")} />
                </div>
              ) : (
                <ul className="mt-3 space-y-2.5">
                  {requirementAcceptance.map((criterion) => (
                    <li key={criterion.id} className="rounded-xl border border-slate-200 bg-white p-3">
                      <code className="block text-[10px] font-semibold text-cyan-700">{criterion.id}</code>
                      <div className="mt-1 text-sm leading-5 text-slate-700 [overflow-wrap:anywhere]">{criterion.text}</div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
              <h4 className="text-xs font-bold uppercase tracking-[0.12em] text-slate-400">{t("待决问题")}</h4>
              {task.requirement_open_questions.length === 0 ? (
                <div className="mt-3">
                  <EmptyState label={t("暂无待决问题")} />
                </div>
              ) : (
                <ul className="mt-3 space-y-2">
                  {task.requirement_open_questions.map((question, index) => (
                    <li key={`${index}-${question}`} className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm leading-5 text-slate-700 [overflow-wrap:anywhere]">
                      {question}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      </Section>

      <div className="grid gap-5 xl:grid-cols-3">
        <Section id="runs-heading" title={t("执行 Runs")} subtitle={t("Claim 后的工作环境与执行基线")} count={t("{value0} 个", { value0: runs.length })}>
          {runs.length === 0 ? (
            <EmptyState label={t("暂无 Run")} />
          ) : (
            <div className="space-y-3">
              {runs.map((run) => <RunCard key={run.run_code} run={run} memberName={memberName} />)}
            </div>
          )}
        </Section>

        <Section id="evidence-heading" title={t("验证证据")} subtitle={t("自测 / 验证复核 / 部署证据")} count={t("{value0} 条", { value0: evidences.length })}>
          {evidences.length === 0 ? (
            <EmptyState label={t("暂无证据")} />
          ) : (
            <div className="space-y-3">
              {evidences.map((evidence) => <EvidenceCard key={evidence.evidence_code} evidence={evidence} />)}
            </div>
          )}
        </Section>

        <Section id="artifacts-heading" title={t("交付产物")} subtitle={t("任务产物、报告与外部引用")} count={t("{value0} 个", { value0: artifacts.length })}>
          {artifacts.length === 0 ? (
            <EmptyState label={t("暂无产物")} />
          ) : (
            <div className="space-y-3">
              {artifacts.map((artifact) => <ArtifactCard key={artifact.artifact_code} artifact={artifact} />)}
            </div>
          )}
        </Section>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(260px,0.85fr)]">
        <section aria-labelledby="timeline-heading" className="min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <header className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3.5">
            <div className="min-w-0">
              <h3 id="timeline-heading" className="text-sm font-semibold text-slate-800">{t("审计时间线")}</h3>
              <p className="mt-0.5 text-[11px] text-slate-400">{t("状态与协作记录")}</p>
            </div>
            <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-500">
              {events.length} {t("条")}</span>
          </header>

          <div className="p-4">
            {events.length === 0 ? (
              <EmptyState label={t("暂无审计记录")} />
            ) : (
              <ol>
                {events.map((event, index) => (
                  <li key={`${event.timestamp}-${index}`} className="grid min-w-0 grid-cols-[12px_minmax(0,1fr)] gap-3">
                    <span className="relative flex justify-center" aria-hidden="true">
                      {index < events.length - 1 && <span className="absolute bottom-0 top-4 w-px bg-slate-200" />}
                      <span className={`relative mt-1.5 h-2.5 w-2.5 rounded-full ring-4 ${index === 0 ? 'bg-cyan-500 ring-cyan-50' : 'bg-slate-300 ring-white'}`} />
                    </span>
                    <div className="min-w-0 pb-4">
                      <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-1">
                        <span className="text-sm font-semibold text-slate-700 [overflow-wrap:anywhere]">
                          {t(ACTION_LABEL[event.action] ?? event.action)}
                        </span>
                        <time dateTime={event.timestamp} className="shrink-0 text-[10px] text-slate-400">
                          {formatDateTime(event.timestamp)}
                        </time>
                      </div>
                      {(event.principal_code || (event.from && event.to)) && (
                        <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5 text-[10px] text-slate-500">
                          {event.principal_code && (
                            <span title={t("用户编码：{value0}", { value0: event.principal_code })} className="max-w-full rounded bg-slate-100 px-1.5 py-0.5 font-semibold [overflow-wrap:anywhere]">
                              {memberName(event.principal_code)}
                            </span>
                          )}
                          {event.from && event.to && (
                            <span className="min-w-0 rounded bg-slate-100 px-1.5 py-0.5 [overflow-wrap:anywhere]">
                              {event.from} → {event.to}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </section>

        <section aria-labelledby="summary-heading" className="min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <header className="border-b border-slate-100 px-4 py-3.5">
            <h3 id="summary-heading" className="text-sm font-semibold text-slate-800">{t("交付概览")}</h3>
            <p className="mt-0.5 text-[11px] text-slate-400">{t("证据与产物计数")}</p>
          </header>
          <div className="space-y-2 p-4 text-xs text-slate-600">
            <div className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2">
              <span>{t("验证证据")}</span>
              <strong className="font-mono text-slate-800">{task.evidence_count}</strong>
            </div>
            <div className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2">
              <span>{t("交付产物")}</span>
              <strong className="font-mono text-slate-800">{task.artifact_count}</strong>
            </div>
            <div className="rounded-xl bg-slate-50 px-3 py-2">
              <div className="text-[10px] uppercase tracking-[0.12em] text-slate-400">{t("关联需求")}</div>
              <div className="mt-1 break-all font-mono text-slate-700">{task.requirement_code ?? '—'}</div>
            </div>
            <div className="rounded-xl bg-slate-50 px-3 py-2">
              <div className="text-[10px] uppercase tracking-[0.12em] text-slate-400">{t("项目文档")}</div>
              <div className="mt-1 break-all font-mono text-slate-700">{task.project_document_code ?? '—'}</div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
