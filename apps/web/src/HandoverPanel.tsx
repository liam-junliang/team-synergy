import { useProjectAccess } from './useProjectAccess';
import { useLocale } from './useLocale';
import { t } from './i18n.ts';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  approveHandoverDrift, currentPrincipalCode, diffHandoverContext, getHandover, getHandoverContext, listTaskHandovers, transitionHandover,
  type TaskDetail,
} from './api';
import { useProjectDisplayNames } from './ProjectDisplayNames';
import { MarkdownDocument } from './MarkdownDocument';

export const HANDOVER_STATUS_LABELS: Record<string, string> = {
  preparing: '准备中', draft: '草稿', published: '待接收', accepted: '已接收',
  restoring: '恢复中', ready: '等待激活', completed: '已接手', cancelled: '已取消', expired: '已过期',
};
const LABELS = HANDOVER_STATUS_LABELS;

const NOTE_LABELS: Array<[string, string]> = [
  ['completed', '已完成'], ['remaining', '待完成'], ['next_actions', '建议下一步'],
  ['decisions_applied', '采用的决策'], ['assumptions', '当前假设'],
  ['open_questions', '待确认问题'], ['failed_attempts', '失败尝试'], ['evidence_refs', '已有验证记录'],
];
const SOURCE_LABELS: Record<string, string> = {
  project: '项目说明', requirement: '需求', requirement_document: '需求文档',
  project_document: '项目文档', prototype: '设计原型', decision: '已确认决策',
  topic: '需求议题', repository: '代码仓库', task: '任务合同',
};
function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function notesOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0) : [];
}

function WorkingNotes({ summary }: { summary: unknown }) {
  if (typeof summary === 'string') return <MarkdownDocument content={summary} />;
  const notes = recordOf(summary);
  if (!notes) return null;
  return <div className="space-y-4 rounded-xl bg-slate-50 p-4">
    {typeof notes.goal === 'string' && <div><h4 className="mb-1 font-semibold text-slate-800">{t("交接目标")}</h4><MarkdownDocument content={notes.goal} /></div>}
    <div className="grid gap-4 sm:grid-cols-2">
      {NOTE_LABELS.map(([key, label]) => {
        const values = notesOf(notes[key]);
        return values.length > 0 && <div key={key}><h4 className="font-semibold text-slate-800">{t(label)}</h4><ul className="mt-1 list-disc space-y-1 pl-4 leading-5">{values.map((value, index) => <li key={index} className="whitespace-pre-wrap [overflow-wrap:anywhere]">{value}</li>)}</ul></div>;
      })}
    </div>
  </div>;
}

function SharedSources({ context }: { context: Record<string, unknown> }) {
  const manifest = recordOf(context.manifest);
  const sources = Array.isArray(manifest?.sources) ? manifest.sources.map(recordOf).filter((source): source is Record<string, unknown> => source !== null) : [];
  if (!sources.length) return null;
  return <div className="space-y-2">
    <h4 className="font-semibold text-slate-800">{t("共享资料 · {count} 份", { count: sources.length })}</h4>
    {sources.map((source, index) => {
      const kind = typeof source.kind === 'string' ? source.kind : '';
      const label = t(SOURCE_LABELS[kind] || '项目资料');
      const title = typeof source.title === 'string' ? source.title : typeof source.name === 'string' ? source.name : label;
      const content = typeof source.content === 'string' ? source.content : typeof source.description === 'string' ? source.description : '';
      const acceptance = Array.isArray(source.acceptance) ? source.acceptance.map(recordOf).filter((entry): entry is Record<string, unknown> => entry !== null) : [];
      return <details key={`${String(source.code || kind)}-${index}`} className="rounded-lg border border-slate-200 bg-white p-3">
        <summary className="cursor-pointer font-semibold text-slate-700">{title}<span className="ml-2 text-[11px] font-normal text-slate-400">{t(label)}{typeof source.revision === 'number' ? t(" · 修订 {value0}", { value0: String(source.revision) }) : ''}</span></summary>
        <div className="mt-3 space-y-3">
          {content && <MarkdownDocument content={content} />}
          {typeof source.rationale === 'string' && source.rationale && <p className="whitespace-pre-wrap leading-5">{t("决策依据：")}{source.rationale}</p>}
          {acceptance.length > 0 && <div><p className="font-semibold">{t("需求验收标准")}</p><ul className="mt-1 list-disc space-y-1 pl-4">{acceptance.map((entry, position) => <li key={position}>{String(entry.text || '')}</li>)}</ul></div>}
          {!content && kind === 'prototype' && <p className="text-slate-500">{t("此快照包含原型文件，接手者可在本机上下文包中查看。")}</p>}
        </div>
      </details>;
    })}
  </div>;
}

function ContextChanges({ drift }: { drift: Record<string, unknown> }) {
  const changes = Array.isArray(drift.changes) ? drift.changes.map(recordOf).filter((entry): entry is Record<string, unknown> => entry !== null) : [];
  const conflicts = Array.isArray(drift.baseline_conflicts) ? drift.baseline_conflicts.map(recordOf).filter((entry): entry is Record<string, unknown> => entry !== null) : [];
  const sourceLabel = (entry: Record<string, unknown>) => t(SOURCE_LABELS[String(entry.source || '').split(':')[0]] || '共享资料');
  return <div className={`rounded-lg p-3 ${changes.length || conflicts.length ? 'bg-amber-50 text-amber-900' : 'bg-emerald-50 text-emerald-800'}`}>
    <p className="font-semibold">{changes.length || conflicts.length ? t('共享资料存在版本差异') : t('共享资料与准备时一致')}</p>
    {(changes.length > 0 || conflicts.length > 0) && <ul className="mt-2 list-disc space-y-1 pl-4 leading-5">
      {conflicts.map((entry, index) => <li key={`baseline-${index}`}>{t("{source}：任务固定修订 {pinned}，当前为修订 {current}。", { source: sourceLabel(entry), pinned: String(entry.pinned_revision), current: String(entry.current_revision) })}</li>)}
      {changes.map((entry, index) => <li key={`change-${index}`}>{t("{source}在准备交接后发生了变化。", { source: sourceLabel(entry) })}</li>)}
    </ul>}
  </div>;
}

/** Web reviews the portable package; local snapshot and restore remain explicit CLI operations. */
export function HandoverPanel({ task, initialHandoverCode = '', onSelectHandover }: { task: TaskDetail; initialHandoverCode?: string; onSelectHandover?: (code: string) => void }) {
  useLocale();
  const client = useQueryClient();
  const { canWrite } = useProjectAccess(task.project_code);
  const { memberName } = useProjectDisplayNames();
  const [selectedCode, setSelectedCode] = useState(initialHandoverCode);
  const [driftReason, setDriftReason] = useState('');
  const principal = currentPrincipalCode();
  const list = useQuery({ queryKey: ['task-handovers', task.code], queryFn: () => listTaskHandovers(task.code) });
  const entries = [...(list.data || [])].reverse();
  const code = selectedCode || entries[0]?.handover_code || '';
  const detail = useQuery({ queryKey: ['handover', code], queryFn: () => getHandover(code), enabled: Boolean(code) });
  const item = detail.data;
  const snapshotCode = item?.context_snapshot_code || '';
  const context = useQuery({ queryKey: ['handover-context', snapshotCode], queryFn: () => getHandoverContext(snapshotCode), enabled: Boolean(snapshotCode) });
  const drift = useQuery({ queryKey: ['handover-context-diff', snapshotCode], queryFn: () => diffHandoverContext(snapshotCode), enabled: Boolean(snapshotCode) });
  const mutation = useMutation({
    mutationFn: (action: 'publish' | 'accept' | 'cancel') => transitionHandover(code, action, item?.version),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ['task-handovers', task.code] }),
        client.invalidateQueries({ queryKey: ['project-handovers', task.project_code] }),
        client.invalidateQueries({ queryKey: ['handover', code] }),
        client.invalidateQueries({ queryKey: ['task', task.code] }),
      ]);
    },
  });
  const driftApproval = useMutation({
    mutationFn: () => approveHandoverDrift(code, driftReason.trim()),
    onSuccess: async () => {
      setDriftReason('');
      await Promise.all([
        client.invalidateQueries({ queryKey: ['handover', code] }),
        client.invalidateQueries({ queryKey: ['task-handovers', task.code] }),
        client.invalidateQueries({ queryKey: ['project-handovers', task.project_code] }),
        client.invalidateQueries({ queryKey: ['handover-context-diff', snapshotCode] }),
      ]);
    },
  });
  const isTarget = item?.target_user_code === principal;
  const terminal = ['completed', 'cancelled', 'expired'].includes(item?.status || '');
  const hasDrift = drift.data?.source_changed === true
    || (Array.isArray(drift.data?.baseline_conflicts) && drift.data.baseline_conflicts.length > 0);
  const run = task.runs?.find((candidate) => candidate.status === 'active' && candidate.profile === 'builder');
  const buttonClass = 'ui-button ui-button-secondary';

  return (
    <section aria-labelledby="handover-heading" className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <header className="border-b border-slate-100 px-4 py-3.5">
        <h3 id="handover-heading" className="text-sm font-semibold text-slate-800">{t("共享上下文与跨人交接")}</h3>
        <p className="mt-1 text-xs text-slate-500">{t("接手者使用自己的电脑与 Agent；交接保留原 Run 和证据，恢复后创建新 Run。")}</p>
      </header>
      <div className="space-y-4 p-4 sm:p-5">
        {list.isPending && <p className="text-xs text-slate-500">{t("正在读取交接记录…")}</p>}
        {list.error && <p role="alert" className="text-xs text-rose-700">{t(list.error.message)}</p>}
        {list.data?.length === 0 && <p className="text-xs text-slate-500">{t("暂无交接。执行人先在本机准备快照和摘要，再由项目 Owner 发布。")}</p>}
        {Boolean(list.data?.length) && (
          <label className="block text-xs text-slate-600">{t("交接记录")}<select className="mt-1 block w-full rounded-lg border border-slate-200 p-2" value={code} onChange={(event) => { setSelectedCode(event.target.value); onSelectHandover?.(event.target.value); }}>
              {entries.map((entry) => <option key={entry.handover_code} value={entry.handover_code}>{t(LABELS[entry.status] || entry.status)} · {entry.handover_code}</option>)}
            </select>
          </label>
        )}
        {detail.error && <p role="alert" className="text-xs text-rose-700">{t(detail.error.message)}</p>}
        {item && (
          <div className="space-y-3 text-xs text-slate-600">
            <dl className="grid grid-cols-2 gap-3">
              <div><dt>{t("状态")}</dt><dd className="mt-1 font-semibold">{t(LABELS[item.status] || item.status)} · v{item.version}</dd></div>
              <div><dt>{t("交接双方")}</dt><dd className="mt-1 font-semibold">{memberName(item.source_user_code)} → {memberName(item.target_user_code)}</dd></div>
              <div><dt>{t("来源 Run")}</dt><dd className="mt-1 break-all font-mono">{item.source_run_code}</dd></div>
              <div><dt>{t("上下文版本")}</dt><dd className="mt-1 break-all font-mono">{item.context_snapshot_code || t('发布时固定')}</dd></div>
              <div><dt>{t("固定需求基线")}</dt><dd className="mt-1 font-semibold">{item.requirement_baseline_code ? `v${item.requirement_baseline_version} · ${item.requirement_baseline_name || item.requirement_baseline_code}` : t('此交接未绑定需求基线')}</dd></div>
            </dl>
            <WorkingNotes summary={item.summary} />
            {item.workspace_manifest && <p className="rounded-lg bg-cyan-50 p-3 text-cyan-900">{t("代码快照已固定。接手时将在新工作区恢复这一版本，并使用接手者自己的仓库权限。")}</p>}
            {context.data && <SharedSources context={context.data} />}
            {drift.data && <ContextChanges drift={drift.data} />}
            <details className="rounded-lg border border-slate-200 p-3"><summary className="cursor-pointer font-semibold">{t("高级信息：快照清单与完整性校验")}</summary>
              {item.context_snapshot_hash && <p className="mt-2 break-all font-mono text-[11px] text-slate-400">{t("上下文 SHA-256：")}{item.context_snapshot_hash}</p>}
              <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-xs">{JSON.stringify({ workspace_manifest: item.workspace_manifest, context: context.data, drift: drift.data }, null, 2)}</pre>
            </details>
            {(context.error || drift.error) && <p role="alert" className="text-rose-700">{(context.error || drift.error)?.message}</p>}
            <p className="rounded-lg bg-amber-50 p-3 text-amber-800">{t("历史测试与证据保留供参考。接手后需在自己的代码与环境中重新验证，交接不表示验收通过。")}</p>
            {item.status === 'preparing' && (!item.workspace_manifest || !item.stop_ack) && <p className="text-amber-800">{t("准备尚未完成。源执行人需要在本机确认 Agent 已停止、上传代码快照与审阅后的摘要，Owner 才能发布。")}</p>}
            <div className="flex flex-wrap gap-2">
              {!terminal && canWrite && item.can_publish && <button type="button" className={buttonClass} disabled={mutation.isPending || !item.workspace_manifest || !item.stop_ack} onClick={() => mutation.mutate('publish')}>{t("发布交接")}</button>}
              {!terminal && canWrite && item.can_accept && <button type="button" className={buttonClass} disabled={mutation.isPending} onClick={() => mutation.mutate('accept')}>{t("接收交接")}</button>}
              {!terminal && canWrite && item.can_cancel && <button type="button" className={buttonClass} disabled={mutation.isPending} onClick={() => mutation.mutate('cancel')}>{t("取消交接")}</button>}
            </div>
            {!terminal && canWrite && hasDrift && item.can_approve_drift && <form className="space-y-2 rounded-lg border border-amber-200 p-3" onSubmit={(event) => { event.preventDefault(); driftApproval.mutate(); }}>
              <label className="block">{t("Owner 确认沿用固定上下文")}<textarea className="mt-1 block w-full rounded-lg border border-slate-200 p-2" value={driftReason} maxLength={4000} onChange={(event) => setDriftReason(event.target.value)} placeholder={t("说明为何允许在相关资料变化后继续旧基线")} required />
              </label>
              <p className="text-amber-800">{t("确认不会修改交接包。任务合同变化仍要求重新交接；资料再次变化后需要重新确认。")}</p>
              <button type="submit" className={buttonClass} disabled={driftApproval.isPending || !driftReason.trim()}>{t("记录确认与理由")}</button>
              {driftApproval.error && <p role="alert" className="text-rose-700">{t(driftApproval.error.message)}</p>}
            </form>}
            {canWrite && isTarget && ['accepted', 'restoring', 'ready'].includes(item.status) && <div><p className="mb-1">{t("在接手电脑恢复到新的工作区，校验成功后启动自己的 Agent：")}</p><code className="block break-all rounded-lg bg-slate-100 p-3">tsp task handover restore {item.handover_code} {t("--repo <本机仓库> --dir <新工作区>")}</code><code className="mt-2 block break-all rounded-lg bg-slate-100 p-3">tsp task handover activate {item.handover_code}</code></div>}
          </div>
        )}
        {mutation.error && <p role="alert" className="text-xs text-rose-700">{t(mutation.error.message)}</p>}
        {canWrite && run && (!item || terminal) && <div className="text-xs text-slate-500"><p className="mb-1">{t("当前执行人先停止 Agent，审阅摘要后在本机准备交接，再由 Owner 发布：")}</p><code className="block break-all rounded-lg bg-slate-100 p-3">tsp task handover prepare {task.code} {t("--target <成员编码> --run ")}{run.run_code} {t("--summary <摘要.json> --repo <本机仓库> --repository <仓库编码> --agent-stopped")}</code></div>}
      </div>
    </section>
  );
}
