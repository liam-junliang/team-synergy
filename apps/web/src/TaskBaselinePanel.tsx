import { useProjectAccess } from './useProjectAccess';
import { useLocale } from './useLocale';
import { t } from './i18n.ts';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { bindTaskBaseline, listRequirementBaselines, type TaskDetail } from './api';

export function TaskBaselinePanel({ task }: { task: TaskDetail }) {
  useLocale();
  const client = useQueryClient();
  const { canManage } = useProjectAccess(task.project_code);
  const [selection, setSelection] = useState('');
  const list = useQuery({ queryKey: ['requirement-baselines', task.project_code], queryFn: () => listRequirementBaselines(task.project_code), enabled: Boolean(task.project_code) });
  const editable = canManage && list.data?.can_create && ['draft', 'ready', 'assigned'].includes(task.status) && !task.runs?.length;
  const options = (list.data?.baselines ?? []).filter(item => !task.requirement_code || item.requirements.some(requirement => requirement.requirement_code === task.requirement_code && (task.source_requirement_revision == null || requirement.revision === task.source_requirement_revision)));
  const mutation = useMutation({ mutationFn: () => bindTaskBaseline(task.code, selection, task.base_snapshot), onSuccess: async () => {
    setSelection('');
    await Promise.all([client.invalidateQueries({ queryKey: ['task', task.code] }), client.invalidateQueries({ queryKey: ['tasks'] })]);
  } });
  return <section aria-label={t("任务需求基线")} className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
    <h3 className="text-sm font-semibold text-slate-800">{t("需求基线")}</h3>
    {task.requirement_baseline_code ? <p className="text-sm font-semibold text-slate-700">v{task.requirement_baseline_version} · {task.requirement_baseline_name || task.requirement_baseline_code}</p> : <p className="text-sm text-slate-500">{t("此任务尚未绑定需求基线。")}</p>}
    <p className="text-xs leading-5 text-slate-500">{t("任务按绑定基线执行，交接继续使用同一份冻结规格。需求关联任务的固定修订必须与基线一致；开始执行后不能更换基线。")}</p>
    {editable && <form className="flex flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); mutation.mutate(); }}><label className="min-w-52 flex-1 text-xs text-slate-600">{t("绑定基线")}<select aria-label={t("任务绑定基线")} className="mt-1 block w-full rounded-lg border border-slate-200 p-2 text-sm" value={selection} onChange={event => setSelection(event.target.value)} required><option value="">{t("选择基线")}</option>{options.map(item => <option key={item.baseline_code} value={item.baseline_code}>v{item.version} · {item.name}</option>)}</select></label><button type="submit" className="ui-button ui-button-primary" disabled={!selection || mutation.isPending}>{mutation.isPending ? t('绑定中…') : t('绑定基线')}</button></form>}
    {editable && !options.length && <p className="text-xs text-slate-500">{t("目前没有与此需求修订相符的历史基线记录。")}</p>}
    {list.error && <p role="alert" className="text-xs text-rose-700">{t("基线加载失败：")}{t(list.error.message)}</p>}
    {mutation.error && <p role="alert" className="text-xs text-rose-700">{t("绑定失败：")}{t(mutation.error.message)}</p>}
  </section>;
}
