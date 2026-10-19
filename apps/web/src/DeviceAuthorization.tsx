import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { decideDeviceAuthorization, getDeviceAuthorizationRequest, type AuthUser, type DeviceAuthorizationRequest } from './api';
import { formatDateTime, t } from './i18n';
import { SkillError } from './SkillShared';
import { navigateWorkspace } from './workspaceNavigation';

export function DeviceAuthorizationCard({ request, user, busy, decision, onDecision }: { request: DeviceAuthorizationRequest; user: AuthUser; busy: boolean; decision?: 'approve' | 'deny'; onDecision: (decision: 'approve' | 'deny') => void }) {
  const [confirmed, setConfirmed] = useState(false);
  const pending = !decision && request.status === 'pending' && Date.parse(request.expires_at) > Date.now();
  const status = decision === 'approve' || request.status === 'approved' || request.status === 'consumed' ? '授权已完成，请返回终端继续。'
    : decision === 'deny' || request.status === 'denied' ? '已拒绝这次授权。' : '授权请求已过期，请在终端重新登录。';
  return <section className="space-y-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
    <div><h1 className="text-xl font-bold">{t('授权 CLI 客户端')}</h1><p className="mt-2 text-sm leading-6 text-slate-500">{t('核对终端中的授权码，只批准你本人发起的登录。')}</p></div>
    <dl className="grid gap-4 text-sm sm:grid-cols-2"><div><dt className="text-xs text-slate-500">{t('设备名称')}</dt><dd className="mt-1 break-words font-semibold">{request.device_name}</dd></div><div><dt className="text-xs text-slate-500">{t('客户端')}</dt><dd className="mt-1">{request.client_type === 'cli' ? 'tsp' : request.client_type}{request.platform && ` · ${request.platform}`}</dd></div><div><dt className="text-xs text-slate-500">{t('授权账号')}</dt><dd className="mt-1 break-words font-semibold">{user.display_name} <span className="font-normal text-slate-500">@{user.account}</span></dd></div><div><dt className="text-xs text-slate-500">{t('有效期至')}</dt><dd className="mt-1">{formatDateTime(request.expires_at)}</dd></div></dl>
    <div className="rounded-xl border border-cyan-200 bg-cyan-50 p-4 text-center"><p className="text-xs font-medium text-cyan-800">{t('授权码')}</p><code className="mt-2 block text-2xl font-bold tracking-widest text-cyan-950">{request.user_code}</code></div>
    {pending ? <><p className="text-sm leading-6 text-slate-600">{t('授权后，该 CLI 可以在你的账号权限范围内访问项目。你可以随时在设备管理中吊销授权。')}</p><label className="flex items-start gap-2 text-sm leading-6 text-slate-700"><input type="checkbox" className="mt-1.5" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />{t('我已核对授权码，并确认这是我正在登录的客户端。')}</label><div className="flex justify-end gap-3"><button type="button" className="ui-button ui-button-secondary" disabled={busy} onClick={() => onDecision('deny')}>{t('拒绝')}</button><button type="button" className="ui-button ui-button-primary" disabled={busy || !confirmed} onClick={() => onDecision('approve')}>{t('确认授权')}</button></div></> : <p role="status" className="rounded-lg bg-slate-50 p-4 text-sm font-medium text-slate-700">{t(status)}</p>}
  </section>;
}

export function DeviceAuthorization({ user, code = '' }: { user: AuthUser; code?: string }) {
  const client = useQueryClient();
  const [entry, setEntry] = useState(code);
  const [decision, setDecision] = useState<'approve' | 'deny'>();
  const request = useQuery({ queryKey: ['device-authorization', user.code, code], queryFn: () => getDeviceAuthorizationRequest(code), enabled: Boolean(code), retry: false, refetchInterval: query => !decision && query.state.data?.status === 'pending' && Date.parse(query.state.data.expires_at) > Date.now() ? 5000 : false });
  const approve = useMutation({ mutationFn: (value: 'approve' | 'deny') => decideDeviceAuthorization(code, value), onSuccess: async (_, value) => { setDecision(value); await client.invalidateQueries({ queryKey: ['devices', user.code] }); } });
  function submit(event: FormEvent) { event.preventDefault(); if (entry.trim()) navigateWorkspace(`/agent/authorize?${new URLSearchParams({ code: entry.trim().toUpperCase() })}`); }
  return <main className="min-h-0 flex-1 overflow-y-auto bg-slate-50 p-4 sm:p-6"><div className="mx-auto max-w-xl space-y-4"><p className="text-xs font-bold tracking-[0.16em] text-cyan-700">TEAM SYNERGY</p>{!code ? <form onSubmit={submit} className="space-y-4 rounded-2xl border border-slate-200 bg-white p-6"><h1 className="text-xl font-bold">{t('授权 CLI 客户端')}</h1><label className="block text-sm font-medium">{t('输入终端显示的授权码')}<input required autoFocus autoComplete="off" maxLength={32} className="form-control mt-2 w-full font-mono uppercase" value={entry} onChange={event => setEntry(event.target.value)} /></label><button type="submit" className="ui-button ui-button-primary">{t('继续')}</button></form> : request.isPending ? <p role="status" className="p-6 text-sm text-slate-500">{t('正在加载…')}</p> : request.data && <DeviceAuthorizationCard key={code} request={request.data} user={user} busy={approve.isPending} decision={decision} onDecision={value => approve.mutate(value)} />}<SkillError error={request.error || approve.error} /><a className="ui-context-action" href="/agent/connect">{t('返回 CLI 接入')}</a></div></main>;
}
