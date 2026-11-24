import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { applyTaskWorkflowCommand, listMembers, type TaskDetail, type TaskWorkflowCommand } from './api';
import { ApiError } from './apiError';
import { formatDateTime, t } from './i18n.ts';
import { useProjectDisplayNames } from './ProjectDisplayNames';
import { TASK_BOARD_REFRESH_INTERVAL_MS } from './queryPolicy';
import { applyTaskWebWorkflow, EXECUTION_HEALTH_LABELS, getTaskWebWorkflow, type TaskWebWorkflow } from './taskWebWorkflow';
import { TaskWorkflowActionForm, type WorkflowCommand } from './TaskWorkflowActionForm';

type LegacyWorkflowAction = TaskWorkflowCommand['action'];
type WorkflowAction = WorkflowCommand['action'];
const LIVE_RUN_STATUSES = new Set(['active', 'suspended', 'preparing']);

export function availableTaskWorkflowActions(task: Pick<TaskDetail, 'status' | 'runs'>): LegacyWorkflowAction[] {
  const hasLiveRun = task.runs.some((run) => LIVE_RUN_STATUSES.has(run.status));
  switch (task.status) {
    case 'draft':
    case 'failed':
      return hasLiveRun ? [] : ['assign', 'ready'];
    case 'ready':
    case 'assigned':
      return hasLiveRun ? [] : ['assign'];
    case 'blocked':
      return hasLiveRun ? [] : ['ready'];
    case 'verified':
      return ['close'];
    default:
      return [];
  }
}

const REASON_MESSAGES: Record<string, string> = {
  acceptance_required: '请先编辑任务，补充验收标准。',
  assignee_not_member: '所选成员已无法执行此项目的任务，请重新选择。',
  base_snapshot_mismatch: '任务已更新，请核对最新状态后重新操作。',
  concurrent_modification: '任务已更新，请核对最新状态后重新操作。',
  invalid_transition: '任务已更新，请核对最新状态后重新操作。',
  project_archived: '项目已归档，任务无法修改。',
  project_forbidden: '当前账号没有执行此操作的权限。',
  task_assignee_unchanged: '请改派给另一位项目成员。',
  task_handover_pending: '此任务正在交接，请先处理交接。',
  task_run_active: '此任务仍有未结束的执行，请先处理该 Run。',
  task_execution_confirmation_required: '请确认结束仍可能在线的执行。',
  task_review_self: '请由成果作者以外的成员验收。',
  task_review_assigned: '当前已有指定验收人，请等待该成员验收或由负责人改派。',
  task_review_submission_missing: '当前没有可核验的交付记录。',
  task_review_state_invalid: '当前验收状态已变化，请核对后重新操作。',
  task_review_replacement_confirmation_required: '请确认结束当前验收尝试并填写更换原因。',
  task_delivery_version_changed: '补证沿用本轮交付链接和校验值。',
  claim_dependencies_unsatisfied: '依赖任务尚未完成，暂不能登记交付。',
  acceptance_coverage_incomplete: '验收通过需要覆盖全部验收项。',
  validation_failed: '请核对填写的链接、原因和验收项后重试。',
};

function actionMessage(reason?: string) {
  if (!reason) return undefined;
  if (reason.endsWith('_forbidden')) return t(REASON_MESSAGES[reason] ?? '当前账号没有执行此操作的权限。');
  if (REASON_MESSAGES[reason]) return t(REASON_MESSAGES[reason]);
  return undefined;
}

function deliveryLink(value?: string | null): string | undefined {
  if (!value) return undefined;
  try {
    const uri = new URL(value);
    return !uri.username && !uri.password && ['https:', 'http:'].includes(uri.protocol) ? uri.href : undefined;
  } catch {
    return undefined;
  }
}

function panelActions(task: TaskDetail, view: Partial<TaskWebWorkflow>, canManageWorkflow: boolean): WorkflowAction[] {
  const { execution, delivery } = view;
  return [
    ...(delivery?.can_finish_review ? ['finish_review'] as const : []),
    ...(delivery?.can_start_review ? ['start_review'] as const : []),
    ...(execution?.can_recover && !delivery?.can_record_delivery ? ['recover_execution'] as const : []),
    ...(delivery?.can_record_delivery ? ['record_delivery'] as const : []),
    ...(canManageWorkflow ? availableTaskWorkflowActions(task) : []),
    ...(delivery?.can_assign_review ? ['assign_review'] as const : []),
    ...(execution?.can_recover && delivery?.can_record_delivery ? ['recover_execution'] as const : []),
    ...(execution?.can_release ? ['release_assignment'] as const : []),
  ];
}

export function TaskWorkflowPanel({ task, canManageWorkflow = false, managementActions, viewerCode }: {
  task: TaskDetail;
  canManageWorkflow?: boolean;
  managementActions?: ReactNode;
  viewerCode?: string;
}) {
  const queryClient = useQueryClient();
  const { memberName } = useProjectDisplayNames();
  const [confirmation, setSelection] = useState<{ action: WorkflowAction; snapshot: number } | null>(null);
  const [notice, setNotice] = useState(false);
  const workflow = useQuery({
    queryKey: ['task-web-workflow', task.code],
    queryFn: () => getTaskWebWorkflow(task.code),
    refetchInterval: TASK_BOARD_REFRESH_INTERVAL_MS,
    retry: false,
  });
  const view = workflow.data;
  const executionIsStale = view?.execution.base_snapshot !== undefined && view.execution.base_snapshot !== task.base_snapshot;
  const deliveryIsStale = view?.delivery.base_snapshot !== undefined && view.delivery.base_snapshot !== task.base_snapshot;
  const actions = panelActions(task, {
    execution: executionIsStale ? undefined : view?.execution,
    delivery: deliveryIsStale ? undefined : view?.delivery,
  }, view?.execution.can_manage ?? canManageWorkflow);
  const actionLabels: Record<WorkflowAction, string> = {
    assign: task.status === 'assigned' ? '改派任务' : '分派任务',
    ready: task.status === 'draft' ? '加入待分派' : '退回待分派',
    close: '关闭任务',
    recover_execution: '收回执行',
    release_assignment: '收回分派',
    record_delivery: view?.delivery.review_status === 'needs_evidence' ? '补录自测证据' : '登记交付',
    assign_review: view?.delivery.reviewer_code || view?.delivery.review_requires_confirmation ? '改派验收' : '指派验收',
    start_review: '我来验收',
    finish_review: '填写验收结论',
  };
  const members = useQuery({
    queryKey: ['members', task.project_code],
    queryFn: () => listMembers(task.project_code),
    enabled: Boolean(confirmation && ['assign', 'recover_execution', 'record_delivery', 'assign_review'].includes(confirmation.action)),
  });
  const eligible = (members.data ?? []).filter((member) => {
    if (!['owner', 'admin', 'member'].includes(member.effective_role ?? member.role)) return false;
    if (confirmation?.action === 'assign' && task.status === 'assigned') return member.code !== task.assignee_code;
    if (confirmation?.action === 'assign_review') return member.code !== view?.delivery.reviewer_code && member.code !== view?.delivery.submission_author_code;
    return true;
  });
  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['task', task.code] }),
    queryClient.invalidateQueries({ queryKey: ['task-history', task.code] }),
    queryClient.invalidateQueries({ queryKey: ['task-web-workflow', task.code] }),
    queryClient.invalidateQueries({ queryKey: ['tasks', task.project_code] }),
    queryClient.invalidateQueries({ queryKey: ['project-task-workflow', task.project_code] }),
    queryClient.invalidateQueries({ queryKey: ['features', task.project_code] }),
  ]);
  const mutation = useMutation({
    mutationFn: async (command: WorkflowCommand) => {
      if (command.action === 'assign' || command.action === 'ready' || command.action === 'close') {
        await applyTaskWorkflowCommand(task.code, command);
      } else {
        await applyTaskWebWorkflow(task.code, command as Exclude<WorkflowCommand, TaskWorkflowCommand>);
      }
    },
    onSuccess: async () => {
      setSelection(null);
      setNotice(true);
      await refresh();
    },
    onError: async () => { await refresh(); },
  });
  function openAction(action: WorkflowAction) {
    mutation.reset();
    setNotice(false);
    setSelection({ action, snapshot: task.base_snapshot });
  }

  const execution = view?.execution;
  const delivery = view?.delivery;
  const currentRun = task.runs.find((run) => run.run_code === execution?.run_code);
  const executionBaseline = execution?.git_base || currentRun?.git_base;
  const uri = deliveryLink(delivery?.submission_uri);
  const reason = actionMessage(delivery?.reason) ?? actionMessage(execution?.reason);
  const reasonWhenUnavailable = executionIsStale || deliveryIsStale ? t('任务已更新，请核对最新状态后重新操作。') : reason;
  const visibleReason = reasonWhenUnavailable && (actions.length === 0 || delivery?.reason !== 'project_forbidden' && execution?.reason !== 'project_forbidden');
  const terminal = ['cancelled', 'closed'].includes(task.status);
  const unavailable = reasonWhenUnavailable ?? (terminal ? t('此任务已结束，可查看历史记录。')
    : !view?.execution.can_manage && !canManageWorkflow ? t('当前账号在此阶段没有可用的任务操作。')
      : t('当前状态没有可用操作。'));
  const error = mutation.error instanceof ApiError ? actionMessage(mutation.error.code) : undefined;
  const disabledForCriteria = (action: WorkflowAction) => task.acceptance.length === 0 && ['assign', 'ready', 'record_delivery'].includes(action);
  const hasActions = actions.length > 0 || Boolean(managementActions);

  return (
    <section aria-label={t('任务操作')} className="space-y-3 border-t border-slate-200 px-4 py-3 sm:px-5">
      {notice && <p role="status" className="text-xs font-medium text-emerald-700">{t('任务已更新。')}</p>}
      {(execution?.run_code || delivery?.submission_code || delivery?.reviewer_code || delivery?.review_reason) && (
        <dl className="grid min-w-0 gap-x-6 gap-y-2 rounded-lg bg-slate-50 px-3 py-2 text-xs sm:grid-cols-2">
          {execution?.run_code && <div className="min-w-0">
            <dt className="font-medium text-slate-700">{t(EXECUTION_HEALTH_LABELS[execution.execution_health])}</dt>
            <dd className="break-all text-slate-600"><code>{execution.run_code}</code></dd>
            {execution.last_heartbeat_at && <dd className="text-slate-500">{t('最后心跳 {time}', { time: formatDateTime(execution.last_heartbeat_at) })}</dd>}
            {executionBaseline && <dd className="break-all text-slate-500">{t('执行基线 {revision}', { revision: executionBaseline })}</dd>}
            {execution.lease_expires_at && <dd className="text-slate-500">{t('执行租约到期 {time}', { time: formatDateTime(execution.lease_expires_at) })}</dd>}
          </div>}
          {delivery?.submission_code && <div className="min-w-0">
            <dt className="font-medium text-slate-700">{t('本轮交付')}</dt>
            <dd className="break-all text-slate-600"><code>{delivery.submission_code}</code> {uri && <a href={uri}
              target="_blank" rel="noreferrer" className="font-medium text-cyan-700 underline">{t('打开交付链接')}</a>}</dd>
            {delivery.submission_author_code && <dd className="break-words text-slate-500">{t('成果作者 {name}', { name: memberName(delivery.submission_author_code) })}</dd>}
            {delivery.submission_registrar_code && <dd className="break-words text-slate-500">{t('登记人 {name}', { name: memberName(delivery.submission_registrar_code) })}</dd>}
          </div>}
          {delivery?.reviewer_code && <div className="min-w-0">
            <dt className="font-medium text-slate-700">{t('验收人')}</dt>
            <dd className="break-words text-slate-600">{memberName(delivery.reviewer_code)}</dd>
            {delivery.review_status === 'in_progress' && <dd className="text-slate-500">{t('验收中')}</dd>}
          </div>}
          {delivery?.review_reason && <div className="min-w-0">
            <dt className="font-medium text-slate-700">{t('最近验收说明')}</dt>
            <dd className="whitespace-pre-wrap break-words text-slate-600">{delivery.review_reason}</dd>
          </div>}
        </dl>
      )}
      {confirmation ? <TaskWorkflowActionForm key={`${confirmation.action}:${confirmation.snapshot}`}
        task={task} workflow={view} action={confirmation.action} label={t(actionLabels[confirmation.action])} snapshot={confirmation.snapshot}
        members={eligible} membersStatus={members.status} pending={mutation.isPending} viewerCode={viewerCode}
        stale={confirmation.snapshot !== task.base_snapshot || !actions.includes(confirmation.action)}
        error={mutation.error ? (error ?? t('暂时无法确认操作结果，请核对任务状态后重试。')) : undefined}
        onBack={() => { mutation.reset(); setSelection(null); }} onSubmit={(command) => mutation.mutate(command)} />
        : <>
          {hasActions && <div className="flex flex-wrap items-center gap-2">
            {actions.map((action, index) => (
              <button key={action} type="button" onClick={() => openAction(action)}
                className={`ui-button ${index === 0 ? 'ui-button-primary' : 'ui-button-secondary'}`}
                disabled={disabledForCriteria(action) || mutation.isPending}>
                {t(actionLabels[action])}
              </button>
            ))}
            {managementActions}
          </div>}
          {actions.some(disabledForCriteria) && <p className="text-xs text-slate-600">{t('请先编辑任务，补充验收标准。')}</p>}
          {!hasActions && <p className="text-sm text-slate-600">{workflow.isPending ? t('正在核对可用任务操作…')
            : workflow.isError && !terminal ? t('暂时无法加载任务操作，请稍后重试。') : unavailable}</p>}
          {hasActions && visibleReason && <p className="text-xs text-slate-600">{reasonWhenUnavailable}</p>}
        </>}
    </section>
  );
}
