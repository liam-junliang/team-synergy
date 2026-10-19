import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clearWebSession, listDeviceSessions, listDevices, renameDevice, revokeDevice, revokeSession, type DeviceSummary } from './api';
import { formatDateTime, t } from './i18n';
import { SkillError } from './SkillShared';
import { WorkspaceDialog } from './WorkspaceDialog';

function expireCurrentClient() {
  clearWebSession();
  window.dispatchEvent(new Event('acp:auth-expired'));
}

export function DeviceManagement({ userCode }: { userCode: string }) {
  const devices = useQuery({ queryKey: ['devices', userCode], queryFn: () => listDevices(userCode) });
  return <section aria-label={t('设备与登录会话')} className="space-y-3">
    <div className="flex items-center justify-between gap-3"><h2 className="text-sm font-bold">{t('设备与登录会话')}</h2><button type="button" onClick={() => void devices.refetch()} className="ui-context-action">{t('刷新')}</button></div>
    <p className="text-xs leading-5 text-slate-500">{t('每条记录代表一个浏览器或 CLI 客户端；最后登录时间不表示在线状态。')}</p>
    <SkillError error={devices.error} />
    {devices.isPending && <p role="status" className="text-sm text-slate-500">{t('正在加载设备…')}</p>}
    <div className="divide-y divide-slate-100">{devices.data?.map(device => <DeviceRow key={device.code} device={device} userCode={userCode} />)}</div>
    {devices.isSuccess && !devices.data.length && <p className="text-sm text-slate-500">{t('尚未登录任何设备')}</p>}
  </section>;
}

export function DeviceRow({ device, userCode }: { device: DeviceSummary; userCode: string }) {
  const client = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(device.device_name ?? '');
  const [revokeTarget, setRevokeTarget] = useState<{ code: string; current: boolean; session: boolean } | null>(null);
  const sessions = useQuery({ queryKey: ['device-sessions', userCode, device.code], queryFn: () => listDeviceSessions(device.code), enabled: expanded });
  async function refresh() {
    await Promise.all([client.invalidateQueries({ queryKey: ['devices', userCode] }), client.invalidateQueries({ queryKey: ['device-sessions', userCode, device.code] })]);
  }
  const rename = useMutation({ mutationFn: (value: string) => renameDevice(device.code, value), onSuccess: async () => { setRenaming(false); await refresh(); } });
  const revoke = useMutation({
    mutationFn: (target: NonNullable<typeof revokeTarget>) => target.session ? revokeSession(target.code) : revokeDevice(target.code),
    onSuccess: async (_, target) => { setRevokeTarget(null); if (target.current) expireCurrentClient(); else await refresh(); },
  });
  function saveName(event: FormEvent) { event.preventDefault(); if (name.trim()) rename.mutate(name.trim()); }
  return <article className="min-w-0 space-y-2 py-4 first:pt-1">
    <div className="flex flex-wrap items-start gap-2"><h3 className="min-w-0 flex-1 break-words text-sm font-semibold text-slate-800">{device.device_name || t('未命名设备')}</h3>{device.current && <span className="rounded bg-cyan-50 px-2 py-0.5 text-[11px] font-medium text-cyan-700">{t('当前客户端')}</span>}{device.status === 'revoked' && <span className="text-xs text-slate-400">{t('已吊销')}</span>}</div>
    <p className="text-xs text-slate-500">{device.client_type === 'cli' ? 'tsp' : device.client_type === 'web' ? t('浏览器') : t('旧授权记录')}{device.platform && ` · ${device.platform}`}</p>
    <p className="text-xs leading-5 text-slate-500">{t('最后登录：')}{device.last_login_at ? <time dateTime={device.last_login_at}>{formatDateTime(device.last_login_at)}</time> : t('未知（旧授权记录）')}</p>
    <div className="flex flex-wrap gap-x-4 gap-y-2"><button type="button" className="ui-context-action" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? t('收起会话') : t('登录会话（{count}）', { count: device.session_count })}</button>{device.status !== 'revoked' && <><button type="button" className="ui-context-action" onClick={() => { setName(device.device_name ?? ''); setRenaming(!renaming); }}>{t('重命名')}</button><button type="button" className="ui-context-action !text-rose-700" onClick={() => { revoke.reset(); setRevokeTarget({ code: device.code, current: device.current, session: false }); }}>{t('吊销设备')}</button></>}</div>
    {renaming && <form onSubmit={saveName} className="flex flex-wrap gap-2"><label className="min-w-0 flex-1"><span className="sr-only">{t('设备名称')}</span><input autoFocus required maxLength={120} className="form-control w-full" value={name} onChange={event => setName(event.target.value)} /></label><button type="submit" disabled={!name.trim() || rename.isPending} className="ui-button ui-button-secondary ui-button-compact">{t('保存')}</button><SkillError error={rename.error} /></form>}
    {expanded && <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3"><p className="text-[11px] text-slate-500">{t('首次授权：')}{formatDateTime(device.created_at)}</p><SkillError error={sessions.error} />{sessions.isPending && <p role="status" className="text-xs text-slate-500">{t('正在加载…')}</p>}{sessions.data?.map(session => <div key={session.code} className="space-y-1 border-t border-slate-200 pt-2 text-xs"><div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium text-slate-700">{session.current ? t('当前会话') : t('登录会话')}</span><span className="text-slate-500">{t(session.status === 'revoked' ? '已吊销' : session.status === 'expired' ? '已过期' : '有效')}</span></div><p className="text-slate-500">{t('登录于')}{formatDateTime(session.created_at)}</p>{session.expires_at && <p className="text-slate-500">{t('有效期至')}{formatDateTime(session.expires_at)}</p>}{session.status === 'active' && <button type="button" className="ui-context-action !text-rose-700" onClick={() => { revoke.reset(); setRevokeTarget({ code: session.code, current: session.current, session: true }); }}>{t('吊销此会话')}</button>}</div>)}{sessions.isSuccess && !sessions.data.length && <p className="text-xs text-slate-500">{t('没有登录会话')}</p>}</div>}
    {revokeTarget && <WorkspaceDialog id={`revoke-${device.code}`} title={t(revokeTarget.session ? '吊销登录会话' : '吊销设备授权')} description={t(revokeTarget.session ? '只结束这次登录，保留该客户端的其他会话。' : '结束这个客户端的全部会话；重新使用需要再次授权。')} onClose={() => { if (!revoke.isPending) setRevokeTarget(null); }}><p className="text-sm text-slate-700">{device.device_name}</p>{revokeTarget.current && <p className="mt-2 text-sm text-amber-700">{t('这会退出当前浏览器。')}</p>}<SkillError error={revoke.error} /><div className="mt-4 flex justify-end gap-2"><button type="button" disabled={revoke.isPending} className="ui-button ui-button-secondary" onClick={() => setRevokeTarget(null)}>{t('取消')}</button><button type="button" className="ui-button ui-button-danger" disabled={revoke.isPending} onClick={() => revoke.mutate(revokeTarget)}>{t('确认吊销')}</button></div></WorkspaceDialog>}
  </article>;
}
