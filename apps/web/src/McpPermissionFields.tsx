import { t } from './i18n';

export function McpPermissionFields({
  allowTaskWrite, allowWorkspaceWrite, allowPersonalMemory, disabled,
  onTaskWriteChange, onWorkspaceWriteChange, onPersonalMemoryChange,
}: {
  allowTaskWrite: boolean;
  allowWorkspaceWrite: boolean;
  allowPersonalMemory: boolean;
  disabled: boolean;
  onTaskWriteChange: (allow: boolean) => void;
  onWorkspaceWriteChange: (allow: boolean) => void;
  onPersonalMemoryChange: (allow: boolean) => void;
}) {
  return <>
    <fieldset className="space-y-2 text-sm text-slate-700" disabled={disabled}>
      <legend className="ui-field-label mb-2">{t('连接权限')}</legend>
      <p>{t('读取有权限的项目资料、代码与共享记忆。')}</p>
      <label className="flex items-start gap-2 rounded-lg border border-slate-200 p-3">
        <input type="checkbox" className="mt-1 accent-cyan-700" checked={allowTaskWrite} onChange={event => onTaskWriteChange(event.target.checked)} />
        <span><strong className="block font-medium text-slate-900">{t('可协作')}</strong>{t('还能按项目角色创建、发布、分派和领取任务，并提交证据。')}</span>
      </label>
      <label className="flex items-start gap-2 rounded-lg border border-slate-200 p-3">
        <input type="checkbox" className="mt-1 accent-cyan-700" checked={allowWorkspaceWrite} onChange={event => onWorkspaceWriteChange(event.target.checked)} />
        <span><strong className="block font-medium text-slate-900">{t('管理团队和项目')}</strong>{t('允许按当前角色创建团队和项目，管理成员与仓库，并更新项目资料和业务记录。')}</span>
      </label>
    </fieldset>
    <label className="flex items-start gap-2 rounded-lg bg-slate-50 p-3 text-sm text-slate-700">
      <input type="checkbox" className="mt-1 accent-cyan-700" checked={allowPersonalMemory} onChange={event => onPersonalMemoryChange(event.target.checked)} disabled={disabled} />
      <span>{t('同时允许读取我的账号偏好')}</span>
    </label>
  </>;
}
