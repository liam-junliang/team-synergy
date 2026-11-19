import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { AuthUser } from './api';
import { ApiError } from './apiError';
import { t } from './i18n';
import { decideMcpAuthorization, getMcpAuthorizationRequest, type McpAuthorizationDecision } from './mcpConnectionsApi';
import { McpPermissionFields } from './McpPermissionFields';

export function safeMcpCallback(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return null;
    if (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) return url.href;
  } catch { /* A response with an invalid callback cannot complete authorization. */ }
  return null;
}

export function McpConsentWorkspace({ request, user }: { request?: string; user: AuthUser }) {
  const [allowTaskWrite, setAllowTaskWrite] = useState(false);
  const [allowPersonalMemory, setAllowPersonalMemory] = useState(false);
  const preview = useQuery({ queryKey: ['mcp-authorization-request', user.code, request], queryFn: ({ signal }) => getMcpAuthorizationRequest(request ?? '', signal), enabled: !!request, retry: false });
  const requestData = preview.data;
  const decision = useMutation({ mutationFn: async (input: McpAuthorizationDecision) => {
    if (!request || !requestData) return;
    const result = await decideMcpAuthorization(request, input);
    const callback = safeMcpCallback(result.redirectUrl);
    if (!callback || new URL(callback).origin !== requestData.redirectOrigin) throw new Error('Invalid MCP callback');
    window.location.replace(callback);
  } });
  const unavailable = '此连接请求已失效。请在 Agent 中重新发起连接。';
  const errorCode = decision.error instanceof ApiError ? decision.error.code : undefined;
  const previewExpired = preview.error instanceof ApiError && (preview.error.code === 'mcp_oauth_request_unavailable' || preview.error.status === 404 || preview.error.status === 410);

  return <main className="min-h-0 flex-1 overflow-y-auto bg-slate-50 px-4 py-6 sm:py-10">
    <section aria-labelledby="mcp-authorization-title" className="mx-auto max-w-xl space-y-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
      <header>
        <h1 id="mcp-authorization-title" className="text-xl font-bold text-slate-950">{t('授权 TeamSynergy Connector')}</h1>
        <p className="mt-2 text-sm leading-6 text-slate-600">{t('请核对客户端、返回地址和你要授权的账号。')}</p>
      </header>
      {!request || previewExpired ? <>
        <p role="alert" className="rounded-lg bg-slate-100 p-4 text-sm text-slate-700">{t(unavailable)}</p>
        <a className="ui-context-action" href="/agent/connect">{t('返回 Agent 接入')}</a>
      </> : preview.isError ? <div className="flex flex-wrap items-center gap-3">
        <p role="alert" className="text-sm text-slate-700">{t('无法读取连接请求。')}</p><button type="button" className="ui-button ui-button-secondary" onClick={() => void preview.refetch()}>{t('重试')}</button>
      </div> : !requestData ? <p role="status" className="text-sm text-slate-600">{t('正在读取连接请求…')}</p> : <>
        <dl className="grid gap-4 rounded-xl bg-slate-50 p-4 text-sm text-slate-700 sm:grid-cols-2">
          <div><dt className="text-xs text-slate-600">{t('客户端')}</dt><dd className="mt-1 break-all font-semibold">{requestData.clientName}</dd></div>
          <div><dt className="text-xs text-slate-600">{t('授权账号')}</dt><dd className="mt-1 break-words font-semibold">{user.display_name} <span className="font-normal text-slate-600">@{user.account}</span></dd></div>
          <div className="sm:col-span-2"><dt className="text-xs text-slate-600">{t('完成后返回')}</dt><dd className="mt-1 break-all">{requestData.redirectOrigin}</dd></div>
        </dl>
        <p className="text-sm leading-6 text-slate-600">{t('Agent 在每次调用时指定项目。平台按你的当前项目权限检查每个请求。')}</p>
        {(requestData.requestedTaskWrite || requestData.requestedPersonalMemory) && <p className="text-sm leading-6 text-slate-600">
          {t(requestData.requestedTaskWrite && requestData.requestedPersonalMemory
            ? '客户端申请了任务协作和个人记忆读取。请按需选择授权。'
            : requestData.requestedTaskWrite ? '客户端申请了任务协作。请按需选择授权。' : '客户端申请了个人记忆读取。请按需选择授权。')}
        </p>}
        <form className="space-y-4" onSubmit={event => {
          event.preventDefault();
          if (decision.isPending || decision.isSuccess) return;
          decision.mutate({ decision: 'allow', allowTaskWrite, allowPersonalMemory });
        }}>
          <McpPermissionFields allowTaskWrite={allowTaskWrite} allowPersonalMemory={allowPersonalMemory}
            disabled={decision.isPending || decision.isSuccess} onTaskWriteChange={setAllowTaskWrite} onPersonalMemoryChange={setAllowPersonalMemory} />
          <p className="text-sm leading-6 text-slate-600">{t('记忆仅供读取。此连接不会启用会话采集。你可在 Agent 接入页撤销连接。')}</p>
          {decision.isError && <p role="alert" className="text-sm text-rose-700">{t(errorCode === 'mcp_oauth_request_unavailable'
            ? unavailable : '未能完成连接授权，请从 Agent 重新发起连接。')}</p>}
          <div className="flex flex-wrap justify-end gap-3">
            <button type="button" className="ui-button ui-button-secondary" disabled={decision.isPending || decision.isSuccess} onClick={() => decision.mutate({ decision: 'deny' })}>{t('拒绝')}</button>
            <button type="submit" className="ui-button ui-button-primary" disabled={decision.isPending || decision.isSuccess}>{t(decision.isPending ? '正在授权…' : '确认授权')}</button>
          </div>
        </form>
      </>}
    </section>
  </main>;
}
