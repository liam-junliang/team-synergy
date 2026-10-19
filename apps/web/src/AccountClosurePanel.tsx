import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { beginAccountClosure, cancelAccountClosure, closureStatus, completeAccountClosure, currentPrincipalCode, listOwnershipTransfers, respondOwnershipTransfer } from './api';
import { WorkspaceDialog } from './WorkspaceDialog';
import { formatDate, t } from './i18n';
import { useLocale } from './useLocale';
import { projectWorkspacePath } from './workspaceRouting';

export function AccountClosurePanel({ onClose, onClosed }: { onClose: () => void; onClosed: () => void }) {
  useLocale();
  const client = useQueryClient();
  const [confirmed, setConfirmed] = useState(false);
  const status = useQuery({ queryKey: ['account-closure'], queryFn: closureStatus });
  const transfers = useQuery({ queryKey: ['ownership-transfers'], queryFn: listOwnershipTransfers });
  const me = currentPrincipalCode();
  const pending = (transfers.data ?? []).filter(item => item.status === 'pending' && Date.parse(item.expires_at) > Date.now());
  const data = status.data;
  const blocked = !data || data.teams.length + data.projects.length + data.open_tasks.length + data.active_runs.length > 0;
  async function refresh() {
    await Promise.all(['account-closure', 'ownership-transfers', 'teams', 'projects', 'project', 'team-members', 'project-members'].map(key => client.invalidateQueries({ queryKey: [key] })));
  }
  const closure = useMutation({ mutationFn: async (action: 'begin' | 'cancel' | 'complete') => {
    if (action === 'complete') return completeAccountClosure();
    return action === 'begin' ? beginAccountClosure() : cancelAccountClosure();
  }, onSuccess: async (_, action) => {
    if (action === 'complete') onClosed();
    else { setConfirmed(false); await refresh(); }
  } });
  const transfer = useMutation({ mutationFn: ({ code, action }: { code: string; action: 'accept' | 'cancel' }) => respondOwnershipTransfer(code, action), onSuccess: refresh });
  const busy = closure.isPending || transfer.isPending;
  return <WorkspaceDialog id="my-account" title={t('我的账号')} description={t('管理所有权交接和账号注销。')} onClose={onClose} size="wide">
    <div className="space-y-5">
      <section className="space-y-3">
        <h3 className="text-sm font-bold text-slate-900">{t('所有权交接')}</h3>
        {transfers.isPending && <p className="ui-help">{t('加载中…')}</p>}
        {transfers.error && <p role="alert" className="text-sm text-rose-700">{transfers.error.message}</p>}
        {!transfers.isPending && !transfers.error && !pending.length && <p className="ui-help">{t('没有待处理的转移请求。')}</p>}
        {pending.map(item => <div key={item.code} className="space-y-2 rounded-xl border border-slate-200 p-3">
          <p className="text-sm font-semibold text-slate-900">{item.scope === 'team' ? t('团队') : t('项目')} · {item.scope_name || item.scope_code}</p>
          <p className="ui-help">{item.target_user_code === me ? t('等待你接受负责人转移。') : t('等待接收人确认：{name}', { name: item.target_user_code })}</p>
          <p className="ui-help">{t('有效期至 {date}', { date: formatDate(item.expires_at) })}</p>
          <div className="flex flex-wrap gap-2">
            {item.target_user_code === me && <button type="button" disabled={busy || !data || data.pending_deletion} className="ui-button ui-button-primary ui-button-compact" onClick={() => transfer.mutate({ code: item.code, action: 'accept' })}>{t('接受转移')}</button>}
            <button type="button" disabled={busy} className="ui-button ui-button-secondary ui-button-compact" onClick={() => transfer.mutate({ code: item.code, action: 'cancel' })}>{t('取消转移')}</button>
          </div>
        </div>)}
        {transfer.error && <p role="alert" className="text-sm text-rose-700">{transfer.error.message}</p>}
      </section>
      <section className="space-y-3 border-t border-slate-200 pt-5">
        <h3 className="text-sm font-bold text-slate-900">{t('注销前的交接清单')}</h3>
        <p className="ui-help">{t('先转移全部团队和项目负责人，再完成任务与运行交接。历史文档、版本和作者记录会保留。')}</p>
        {status.isPending && <p className="ui-help">{t('加载中…')}</p>}
        {status.error && <p role="alert" className="text-sm text-rose-700">{status.error.message}</p>}
        {data && <>
          <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-sm font-semibold">{t('负责的团队和项目：{count}', { count: data.teams.length + data.projects.length })}</p>
            {data.teams.map(team => <div key={team.code} className="flex items-center justify-between gap-3 text-sm"><span>{team.name}</span><a href="/teams" onClick={onClose} className="text-cyan-700 underline">{t('前往团队管理')}</a></div>)}
            {data.projects.map(project => <div key={project.code} className="flex items-center justify-between gap-3 text-sm"><span>{project.name}{project.status === 'archived' ? ` · ${t('已归档')}` : ''}</span><a href={projectWorkspacePath(project.code)} onClick={onClose} className="text-cyan-700 underline">{t('前往成员与权限')}</a></div>)}
            <p className="text-sm font-semibold">{t('未完成任务：{count}', { count: data.open_tasks.length })}</p>
            {data.open_tasks.map(task => <p key={task.code} className="break-all text-xs text-slate-600">{task.title} · {task.code}</p>)}
            <p className="text-sm font-semibold">{t('活动运行：{count}', { count: data.active_runs.length })}</p>
            {data.active_runs.map(run => <p key={run.code} className="break-all font-mono text-xs text-slate-600">{run.code} · {run.status}</p>)}
          </div>
          {data.pending_deletion ? <>
            <p className="ui-help rounded-lg bg-amber-50 p-3 text-amber-900">{t('账号正在等待注销。仍可完成交接，但不能新建团队或项目，也不能接受所有权。')}</p>
            {!blocked && <label className="flex items-start gap-2 text-sm text-slate-700"><input type="checkbox" className="mt-1" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />{t('我确认注销账号并撤销所有登录及设备凭据。')}</label>}
            <div className="flex flex-wrap gap-2"><button type="button" disabled={busy} className="ui-button ui-button-secondary" onClick={() => closure.mutate('cancel')}>{t('取消注销')}</button><button type="button" disabled={busy || blocked || !confirmed} className="ui-button ui-button-danger" onClick={() => closure.mutate('complete')}>{t('确认注销账号')}</button></div>
          </> : <button type="button" disabled={busy} className="ui-button ui-button-secondary" onClick={() => closure.mutate('begin')}>{t('开始注销流程')}</button>}
        </>}
        {closure.error && <p role="alert" className="text-sm text-rose-700">{closure.error.message}</p>}
      </section>
    </div>
  </WorkspaceDialog>;
}
