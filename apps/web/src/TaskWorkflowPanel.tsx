import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { applyTaskWorkflowCommand, listMembers, type TaskDetail, type TaskWorkflowCommand } from './api';
import { ApiError } from './apiError';
import { t } from './i18n.ts';

type WorkflowAction = TaskWorkflowCommand['action'];
const LIVE_RUN_STATUSES = new Set(['active', 'suspended', 'preparing']);

export function availableTaskWorkflowActions(task: Pick<TaskDetail, 'status' | 'runs'>): WorkflowAction[] {
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

const ERROR_MESSAGES: Record<string, string> = {
  acceptance_required: '请先编辑任务，补充验收标准。',
  assignee_not_member: '所选成员已无法执行此项目的任务，请重新选择。',
  base_snapshot_mismatch: '任务已更新，请核对最新状态后重新操作。',
  concurrent_modification: '任务已更新，请核对最新状态后重新操作。',
  invalid_transition: '任务已更新，请核对最新状态后重新操作。',
  project_archived: '项目已归档，任务无法修改。',
  task_assignee_unchanged: '请改派给另一位项目成员。',
  task_handover_pending: '此任务正在交接，请先处理交接。',
  task_run_active: '此任务仍有未结束的执行，请先处理该 Run。',
};

export function TaskWorkflowPanel({ task }: { task: TaskDetail }) {
  const queryClient = useQueryClient();
  const [review, setReview] = useState<{ action: WorkflowAction; snapshot: number } | null>(null);
  const [assignee, setAssignee] = useState('');
  const [notice, setNotice] = useState('');
  const actions = availableTaskWorkflowActions(task);
  const reassigning = task.status === 'assigned';
  const returning = task.status !== 'draft';
  const needsAcceptance = ['draft', 'blocked', 'failed'].includes(task.status) && task.acceptance.length === 0;
  const actionLabels = {
    assign: reassigning ? '改派任务' : '分派任务',
    ready: returning ? '重新就绪' : '标为就绪',
    close: '关闭任务',
  } as const;
  const members = useQuery({
    queryKey: ['members', task.project_code],
    queryFn: () => listMembers(task.project_code),
    enabled: review?.action === 'assign',
  });
  const eligible = (members.data ?? []).filter((member) =>
    ['owner', 'admin', 'member'].includes(member.effective_role ?? member.role)
    && (!reassigning || member.code !== task.assignee_code));
  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['task', task.code] }),
    queryClient.invalidateQueries({ queryKey: ['task-history', task.code] }),
    queryClient.invalidateQueries({ queryKey: ['tasks', task.project_code] }),
    queryClient.invalidateQueries({ queryKey: ['features', task.project_code] }),
  ]);
  const mutation = useMutation({
    mutationFn: (command: TaskWorkflowCommand) => applyTaskWorkflowCommand(task.code, command),
    onSuccess: async () => {
      await refresh();
      setReview(null);
      setNotice('任务已更新。');
    },
    onError: async () => { await refresh(); },
  });

  if (actions.length === 0 && !review && !notice) return null;
  const stale = review && (review.snapshot !== task.base_snapshot || !actions.includes(review.action));
  const eligibleAssignee = eligible.some((member) => member.code === assignee);
  const error = mutation.error instanceof ApiError ? mutation.error.code : '';
  const message = error.endsWith('_forbidden')
    ? '当前账号没有执行此操作的权限。'
    : ERROR_MESSAGES[error] ?? '暂时无法确认操作结果，请核对任务状态后重试。';

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!review || stale || needsAcceptance || mutation.isPending) return;
    if (review.action === 'assign' && !eligibleAssignee) return;
    mutation.mutate(review.action === 'assign'
      ? { action: 'assign', assignee_principal_code: assignee, base_snapshot: review.snapshot }
      : { action: review.action, base_snapshot: review.snapshot });
  }

  return (
    <section aria-label={t('任务操作')} className="space-y-3 border-t border-slate-200 px-4 py-3 sm:px-5">
      {notice && <p role="status" className="text-xs font-medium text-emerald-700">{t(notice)}</p>}
      {review ? (
        <form onSubmit={submit} className="space-y-3">
          <h3 className="text-sm font-semibold text-slate-800">{t(actionLabels[review.action])}</h3>
          {stale ? <p role="status" className="text-sm text-amber-800">{t('任务已更新，请核对最新状态后重新操作。')}</p>
            : review.action === 'assign' ? (
              <label className="block max-w-md text-xs font-medium text-slate-700">
                {t('选择执行成员')}
                <select
                  className="form-control mt-1 w-full"
                  value={assignee}
                  onChange={(event) => setAssignee(event.target.value)}
                  disabled={mutation.isPending || members.isLoading || eligible.length === 0}
                  required
                >
                  <option value="">{t(members.isLoading ? '正在加载成员…' : '选择执行成员')}</option>
                  {eligible.map((member) => (
                    <option key={member.code} value={member.code}>
                      {member.display_name}{member.account ? ` (@${member.account})` : ''}
                    </option>
                  ))}
                </select>
              </label>
            ) : review.action === 'close' ? (
              <p className="text-sm text-slate-600">{t('该任务已通过验收。关闭后，下游任务可继续执行。')}</p>
            ) : returning ? (
              <p className="text-sm text-slate-600">{t('任务将回到待处理，清除本轮分派并保留历史记录。')}</p>
            ) : null}
          {!stale && review.action === 'assign' && (members.isError || (!members.isLoading && eligible.length === 0)) && (
            <p role="status" className="text-sm text-slate-600">
              {t(members.isError ? '无法加载项目成员，请重新打开分派。' : '当前没有可分派的项目成员。')}
            </p>
          )}
          {!stale && mutation.error && <p role="alert" className="text-sm text-rose-700">{t(message)}</p>}
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => setReview(null)} disabled={mutation.isPending} className="ui-button ui-button-secondary">{t('返回')}</button>
            <button type="submit" disabled={Boolean(stale) || needsAcceptance || mutation.isPending || (review.action === 'assign' && !eligibleAssignee)} className="ui-button ui-button-strong">
              {t(mutation.isPending ? '保存中…' : '确认')}
            </button>
          </div>
        </form>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {actions.map((action) => (
              <button
                key={action}
                type="button"
                className={`ui-button ${action === actions[0] ? 'ui-button-strong' : 'ui-button-secondary'}`}
                disabled={needsAcceptance || mutation.isPending}
                onClick={() => {
                  mutation.reset();
                  setNotice('');
                  setAssignee('');
                  setReview({ action, snapshot: task.base_snapshot });
                }}
              >
                {t(actionLabels[action])}
              </button>
            ))}
          </div>
          {needsAcceptance && actions.length > 0 && <p className="text-xs text-slate-600">{t('请先编辑任务，补充验收标准。')}</p>}
        </>
      )}
    </section>
  );
}
