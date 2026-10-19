import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createOwnershipTransfer, currentPrincipalCode, listOwnershipTransfers, listTeamMembers, resolveOwnership, respondOwnershipTransfer, type Member } from './api';
import { PersonSearchSelect } from './PersonSearchSelect';
import { t, formatDate } from './i18n';
import { useLocale } from './useLocale';

export function OwnershipTransferPanel({ scope, scopeCode, teamCode, ownerCode, createdByCode, pending, mayTransfer, actorRole, members }: {
  scope: 'team' | 'project'; scopeCode: string; teamCode: string; ownerCode?: string | null; createdByCode?: string | null;
  pending?: boolean; mayTransfer: boolean; actorRole: string; members: Member[];
}) {
  useLocale();
  const client = useQueryClient();
  const [target, setTarget] = useState('');
  const currentUser = currentPrincipalCode();
  const transfers = useQuery({ queryKey: ['ownership-transfers'], queryFn: listOwnershipTransfers });
  const team = useQuery({ queryKey: ['team-members', teamCode], queryFn: () => listTeamMembers(teamCode), enabled: mayTransfer && !pending });
  const relevant = (transfers.data ?? []).filter((item) => item.scope === scope && item.scope_code === scopeCode && item.status === 'pending' && Date.parse(item.expires_at) > Date.now());
  async function refresh() {
    setTarget('');
    await Promise.all(['ownership-transfers', 'teams', 'projects', 'project', 'team-members', 'project-members'].map((key) => client.invalidateQueries({ queryKey: [key] })));
  }
  const mutation = useMutation({ mutationFn: (input: { action: 'create' | 'accept' | 'cancel' | 'resolve'; code?: string }) => {
    if (input.action === 'resolve') return resolveOwnership({ scope, scope_code: scopeCode, owner_user_code: target });
    if (input.action === 'create') return createOwnershipTransfer({ scope, scope_code: scopeCode, target_user_code: target });
    return respondOwnershipTransfer(input.code!, input.action);
  }, onSuccess: refresh });
  const options = pending ? members.filter((member) => member.role === 'owner') : (team.data ?? []).filter((member) => member.code !== ownerCode);
  const identity = (code?: string | null) => code ? members.find((member) => member.code === code)?.display_name ?? code : t('历史未记录');
  return <section className="space-y-3 rounded-xl border border-slate-200 p-4">
    <h3 className="text-sm font-bold text-slate-900">{t('负责人和创建者')}</h3>
    <dl className="grid gap-2 text-xs text-slate-600 sm:grid-cols-2"><div><dt>{t('当前负责人')}</dt><dd className="mt-1 break-all font-semibold">{pending ? t('待确认唯一负责人') : identity(ownerCode)}</dd></div><div><dt>{t('历史创建者')}</dt><dd className="mt-1 break-all">{identity(createdByCode)}</dd></div></dl>
    {pending && <p className="ui-help rounded-lg bg-amber-50 p-3 text-amber-900">{t('历史数据存在多个负责人。确认唯一负责人后，其他负责人将保留为管理员。')}</p>}
    {((pending && actorRole === 'owner') || (!pending && mayTransfer)) && <form className="space-y-3 border-t border-slate-100 pt-3" onSubmit={(event) => { event.preventDefault(); if (!target) return; if (pending && !window.confirm(t('确认唯一负责人后，其他负责人将成为管理员。是否继续？'))) return; mutation.mutate({ action: pending ? 'resolve' : 'create' }); }}>
      <p className="ui-help">{pending ? t('请选择现有负责人。') : t('接收人必须是团队成员。对方接受后生效，原负责人保留为管理员。')}</p>
      <PersonSearchSelect size="roomy" required value={target} options={options} onChange={setTarget} ariaLabel={t('选择接收人')} placeholder={t('选择接收人')} disabled={mutation.isPending || (!pending && team.isPending)} />
      {team.error && mayTransfer && <p role="alert" className="text-xs text-rose-700">{team.error.message}</p>}
      <button disabled={!target || mutation.isPending || (!pending && (Boolean(team.error) || relevant.length > 0))} className="ui-button ui-button-secondary">{pending ? t('确认唯一负责人') : t('发起所有权转移')}</button>
    </form>}
    {relevant.map((item) => <div key={item.code} className="space-y-2 rounded-lg bg-cyan-50 p-3 text-xs text-cyan-900"><p>{t('等待接收人确认：{name}', { name: identity(item.target_user_code) })}</p><p>{t('有效期至 {date}', { date: formatDate(item.expires_at) })}</p><div className="flex flex-wrap gap-2">{item.target_user_code === currentUser && <button type="button" disabled={mutation.isPending} onClick={() => mutation.mutate({ action: 'accept', code: item.code })} className="ui-button ui-button-primary ui-button-compact">{t('接受转移')}</button>}{(item.target_user_code === currentUser || mayTransfer || item.initiated_by_code === currentUser) && <button type="button" disabled={mutation.isPending} onClick={() => mutation.mutate({ action: 'cancel', code: item.code })} className="ui-button ui-button-secondary ui-button-compact">{t('取消转移')}</button>}</div></div>)}
    {transfers.error && <p role="alert" className="text-xs text-rose-700">{transfers.error.message}</p>}
    {mutation.error && <p role="alert" className="text-xs text-rose-700">{mutation.error.message}</p>}
  </section>;
}
