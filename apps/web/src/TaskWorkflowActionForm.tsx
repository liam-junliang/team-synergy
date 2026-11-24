import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { Member, TaskDetail, TaskWorkflowCommand } from './api';
import { t } from './i18n.ts';
import type { TaskReviewResult, TaskWebWorkflow, TaskWebWorkflowCommand } from './taskWebWorkflow';

export type WorkflowCommand = TaskWorkflowCommand | TaskWebWorkflowCommand;

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block min-w-0 space-y-1.5 text-xs font-medium text-slate-700">
    <span>{label}</span>{children}
  </label>;
}

function MemberField({ label, members, name, value, required = false, onChange }: {
  label: string;
  members: Member[];
  name: string;
  value?: string;
  required?: boolean;
  onChange?: (value: string) => void;
}) {
  return <Field label={label}>
    <select className="form-control w-full" name={name} required={required} value={value} onChange={(event) => onChange?.(event.target.value)}>
      <option value="">{t('选择项目成员')}</option>
      {members.map((member) => <option key={member.code} value={member.code}>
        {member.display_name}{member.account ? ` (@${member.account})` : ''}
      </option>)}
    </select>
  </Field>;
}

export function TaskWorkflowActionForm({ task, workflow, action, label, snapshot, members, membersStatus, pending, stale, error, viewerCode, onBack, onSubmit }: {
  task: TaskDetail;
  workflow?: TaskWebWorkflow;
  action: WorkflowCommand['action'];
  label: string;
  snapshot: number;
  members: Member[];
  membersStatus: 'pending' | 'success' | 'error';
  pending: boolean;
  stale: boolean;
  error?: string;
  viewerCode?: string;
  onBack: () => void;
  onSubmit: (command: WorkflowCommand) => void;
}) {
  const [target, setTarget] = useState('');
  const [recoveryMode, setRecoveryMode] = useState<'ready' | 'self' | 'reassign'>('ready');
  const [result, setResult] = useState<TaskReviewResult>('pass');
  const [checked, setChecked] = useState<string[]>([]);
  const withdrawalRequest = useRef<{ signature: string; key?: string }>(undefined);
  const delivery = workflow?.delivery;
  const supplementing = action === 'record_delivery' && delivery?.review_status === 'needs_evidence';
  const needsAcceptance = (action === 'assign' || action === 'ready' || action === 'record_delivery' || (action === 'recover_execution' && recoveryMode !== 'ready'))
    && task.acceptance.length === 0;
  const selectingMember = action === 'assign' || action === 'assign_review' || (action === 'recover_execution' && recoveryMode === 'reassign');
  const deliveryFields = action === 'record_delivery' || action === 'finish_review';
  const requiresEveryCriterion = action === 'finish_review' && result === 'pass';
  const missingEvidence = (requiresEveryCriterion && (task.acceptance.length === 0 || checked.length !== task.acceptance.length))
    || ((action === 'record_delivery' || (action === 'finish_review' && result === 'return')) && checked.length === 0)
    || (action === 'finish_review' && !delivery?.submission_code);
  const confirmActive = action === 'recover_execution' && workflow?.execution.recovery_requires_confirmation
    || action === 'assign_review' && delivery?.review_requires_confirmation;
  const destructive = action === 'recover_execution' || action === 'release_assignment'
    || (action === 'finish_review' && result === 'return') || confirmActive;

  function withdraw(command: Extract<TaskWebWorkflowCommand, { action: 'recover_execution' | 'release_assignment' }>) {
    const signature = JSON.stringify(command);
    if (withdrawalRequest.current?.signature !== signature) {
      withdrawalRequest.current = { signature, key: globalThis.crypto?.randomUUID?.() };
    }
    onSubmit({ ...command, idempotency_key: withdrawalRequest.current.key });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (stale || pending || needsAcceptance || missingEvidence || (selectingMember && !members.some((member) => member.code === target))) return;
    const input = new FormData(event.currentTarget);
    const value = (key: string) => String(input.get(key) ?? '').trim();
    const confirmed = input.get('confirm_active') === 'on';
    if (confirmActive && !confirmed) return;
    const base = { base_snapshot: snapshot };
    if (action === 'assign') onSubmit({ ...base, action, assignee_principal_code: target });
    else if (action === 'recover_execution') withdraw({
      ...base, action, reason: value('reason'),
      assignee_principal_code: recoveryMode === 'self' ? viewerCode : recoveryMode === 'reassign' ? target : undefined,
      confirm_active: confirmed,
    });
    else if (action === 'release_assignment') withdraw({ ...base, action, reason: value('reason') });
    else if (action === 'record_delivery') onSubmit({
      ...base, action, artifact_uri: value('artifact_uri'), content_hash: value('content_hash').toLowerCase(), summary: value('summary'),
      acceptance_refs: checked, author_principal_code: value('author') || undefined,
    });
    else if (action === 'assign_review') onSubmit({
      ...base, action, reviewer_principal_code: target, reason: value('reason') || undefined, confirm_active: confirmed,
    });
    else if (action === 'finish_review') {
      if (!delivery?.submission_code) return;
      onSubmit({ ...base, action, submission_code: delivery.submission_code, result, acceptance_refs: checked,
        summary: value('summary'), report_uri: value('report_uri') || undefined });
    }
    else onSubmit({ ...base, action });
  }

  return <form onSubmit={submit} className="space-y-3">
    <h3 className="text-sm font-semibold text-slate-900">{label}</h3>
    {stale && <p role="status" className="text-sm text-amber-800">{t('任务已更新，请核对最新状态后重新操作。')}</p>}
    <fieldset disabled={pending || stale} className="min-w-0 space-y-3">
      {action === 'recover_execution' && <>
        <p className="text-sm text-slate-600">{t('收回会阻止原执行继续写入平台。历史和已提交的成果会保留。未同步的本地改动仍在原设备。')}</p>
        <Field label={t('收回后如何处理')}>
          <select className="form-control w-full" value={recoveryMode} onChange={(event) => {
            const mode = event.target.value as typeof recoveryMode;
            setRecoveryMode(mode);
            setTarget('');
          }}>
            <option value="ready">{t('退回待分派')}</option>
            {viewerCode && <option value="self">{t('由我接手')}</option>}
            <option value="reassign">{t('改派给项目成员')}</option>
          </select>
        </Field>
      </>}
      {selectingMember && <>
        <MemberField label={t(action === 'assign_review' ? '选择验收成员' : '选择执行成员')}
          members={members} name="target" value={target} onChange={setTarget} required />
        {membersStatus !== 'success' && <p role="status" className="text-xs text-slate-600">
          {t(membersStatus === 'pending' ? '正在加载成员…' : '无法加载项目成员，请稍后重试。')}
        </p>}
        {membersStatus === 'success' && members.length === 0 && <p role="status" className="text-xs text-slate-600">{t('当前没有可分派的项目成员。')}</p>}
      </>}
      {(action === 'recover_execution' || action === 'release_assignment' || action === 'assign_review') &&
        <Field label={t('处理原因')}>
          <textarea className="form-control w-full" name="reason" required={action !== 'assign_review' || Boolean(delivery?.reviewer_code) || Boolean(confirmActive)}
            maxLength={2000} rows={3} />
        </Field>}
      {confirmActive && <label className="flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
        <input name="confirm_active" type="checkbox" required className="mt-1 shrink-0 accent-cyan-700" />
        <span>{t(action === 'recover_execution' ? '我确认结束仍可能在线的执行。' : '我确认结束当前验收尝试并更换验收人。')}</span>
      </label>}
      {action === 'record_delivery' && <>
        {supplementing && <p className="text-sm text-slate-600">{t('补证沿用本轮交付链接和校验值。')}</p>}
        <Field label={t('交付链接')}>
          <input className="form-control w-full" name="artifact_uri" type="url" pattern="https://.+" maxLength={2048}
            defaultValue={supplementing ? delivery?.submission_uri ?? '' : undefined} readOnly={supplementing} placeholder="https://…" required />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('提交 SHA 或文件 SHA-256')}>
            <input className="form-control w-full font-mono" name="content_hash" pattern="[0-9a-fA-F]{40}|[0-9a-fA-F]{64}" maxLength={64}
              defaultValue={supplementing ? delivery?.submission_content_hash ?? '' : undefined} readOnly={supplementing} required />
          </Field>
          {!supplementing && <MemberField label={t('成果作者（可选）')} members={members} name="author" />}
        </div>
      </>}
      {action === 'finish_review' && <>
        <Field label={t('验收结论')}>
          <select className="form-control w-full" value={result} onChange={(event) => setResult(event.target.value as TaskReviewResult)}>
            <option value="pass">{t('验收通过')}</option>
            <option value="request_evidence">{t('请求补证据')}</option>
            <option value="return">{t('退回修改')}</option>
          </select>
        </Field>
        <Field label={t('证据链接（可选）')}>
          <input className="form-control w-full" name="report_uri" type="url" pattern="https://.+" maxLength={2048} placeholder="https://…" />
        </Field>
      </>}
      {deliveryFields && <>
        <fieldset className="space-y-2 rounded-lg border border-slate-200 p-3">
          <legend className="px-1 text-xs font-semibold text-slate-800">
            {t(action === 'record_delivery' ? '已自测的验收项' : '本次核对的验收项')}
          </legend>
          {task.acceptance.map(({ id, text }) => <label key={id} className="flex min-w-0 items-start gap-2 text-sm text-slate-700">
            <input type="checkbox" className="mt-1 shrink-0 accent-cyan-700" checked={checked.includes(id)}
              onChange={(event) => setChecked((current) => event.target.checked ? [...current, id] : current.filter((item) => item !== id))} />
            <span className="min-w-0 [overflow-wrap:anywhere]"><strong className="mr-1 text-xs">{id}</strong>{text}</span>
          </label>)}
          {task.acceptance.length === 0 && <p className="text-xs text-slate-600">{t('暂无验收标准')}</p>}
          {requiresEveryCriterion && <p className="text-xs text-slate-600">{t('验收通过需要覆盖全部验收项。')}</p>}
          {action === 'finish_review' && result === 'return' && <p className="text-xs text-slate-600">{t('请选择需要返工的验收项。')}</p>}
        </fieldset>
        <Field label={t(action === 'record_delivery' ? '交付与自测说明' : '验收依据或补充要求')}>
          <textarea className="form-control w-full" name="summary" required rows={3} maxLength={8000} />
        </Field>
      </>}
      {action === 'close' && <p className="text-sm text-slate-600">{t('该任务已通过验收。关闭会解除下游任务对这项任务的依赖阻塞。')}</p>}
      {(action === 'ready' && task.status !== 'draft' || action === 'release_assignment') && (
        <p className="text-sm text-slate-600">{t('任务将退回待分派，清除本轮分派并保留历史记录。')}</p>
      )}
    </fieldset>
    {needsAcceptance && <p className="text-xs text-slate-600">{t('请先编辑任务，补充验收标准。')}</p>}
    {error && <p role="alert" className="text-sm text-rose-700">{error}</p>}
    <div className="flex flex-wrap gap-2">
      <button type="button" onClick={onBack} disabled={pending} className="ui-button ui-button-secondary">{t('返回')}</button>
      <button type="submit" disabled={stale || pending || needsAcceptance || missingEvidence || (selectingMember && !target)}
        className={`ui-button ${destructive ? 'ui-button-danger' : 'ui-button-primary'}`}>
        {pending ? t('保存中…') : t('确认 {action}', { action: label })}
      </button>
    </div>
  </form>;
}
