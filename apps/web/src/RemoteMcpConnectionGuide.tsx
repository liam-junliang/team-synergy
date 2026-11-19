import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ProjectSummary } from './api';
import { t } from './i18n';
import { createMcpConnection, listMcpConnections, revokeMcpConnection, type McpConnection, type NewMcpConnection } from './mcpConnectionsApi';
import { getPlatformClientConfig, PLATFORM_CLIENT_CONFIG_QUERY_KEY, remoteMcpEndpoint } from './platformClientConfig';
import { CopyCommand } from './SkillShared';
import { useLocale } from './useLocale';
import { WorkspaceDialog } from './WorkspaceDialog';
import { McpPermissionFields } from './McpPermissionFields';

const connectionsKey = (accountCode: string) => ['remote-mcp-connections', accountCode] as const;

export function RemoteMcpConnectionGuide({ accountCode, projects, onLocalSetup }: {
  accountCode: string;
  projects?: ProjectSummary[];
  onLocalSetup: () => void;
}) {
  const locale = useLocale();
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<McpConnection>();
  const config = useQuery({ queryKey: PLATFORM_CLIENT_CONFIG_QUERY_KEY, queryFn: getPlatformClientConfig, retry: false });
  const endpoint = remoteMcpEndpoint(config.data);
  const list = useQuery({ queryKey: connectionsKey(accountCode), queryFn: ({ signal }) => listMcpConnections(signal), enabled: !!endpoint, retry: false });
  const dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });

  return <div className="space-y-4">
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm" aria-labelledby="remote-mcp-setup-title">
      <h2 id="remote-mcp-setup-title" className="text-base font-bold">{t('添加 TeamSynergy Connector')}</h2>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">{t('无需下载 Connector 或安装 CLI。在支持远程 HTTP MCP 与 OAuth 的 Agent 中添加服务地址，完成浏览器授权后即可使用。')}</p>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">{t('授权绑定你的账号，Agent 可按权限查资料、读记忆并参与多个项目。每次调用指定项目，无需绑定本机目录。')}</p>
      {config.isPending ? <p role="status" className="mt-4 text-sm text-slate-500">{t('正在读取平台接入配置…')}</p>
        : config.isError ? <div className="mt-4 flex flex-wrap items-center gap-3"><p role="alert" className="text-sm text-slate-700">{t('无法读取平台接入配置。')}</p><button type="button" className="ui-button ui-button-secondary" onClick={() => void config.refetch()}>{t('重试')}</button></div>
        : endpoint ? <div className="mt-4 max-w-3xl space-y-3">
          <CopyCommand command={endpoint} copyLabel={t('复制服务地址')} />
          <ol className="list-decimal space-y-3 pl-5 text-sm leading-6 text-slate-700">
            <li><strong>{t('添加连接')}</strong><p>{t('在 Agent 的 MCP 或 Connector 设置中选择远程 HTTP，粘贴服务地址并发起连接。')}</p></li>
            <li><strong>{t('在浏览器登录并授权')}</strong><p>{t('按 Agent 的提示打开 TeamSynergy 登录页。已有登录会话时会直接进入授权页。核对账号、客户端和返回地址，按需选择连接权限。要创建或推进任务，请选择可协作。')}</p></li>
            <li><strong>{t('返回 Agent 验证')}</strong><p>{t('同意后，浏览器会将授权结果返回给 Agent。可以在新会话里问「我能访问哪些 TeamSynergy 项目？」来验证。')}</p></li>
          </ol>
          <p className="text-xs leading-5 text-slate-600">{t('个人记忆读取需单独授权。连接后的会话采集仍保持关闭。')}</p>
        </div> : <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg bg-slate-50 px-4 py-3">
          <p role="status" className="text-sm text-slate-700">{t('此站点尚未启用 HTTP Connector。')}</p>
          <button type="button" className="ui-button ui-button-secondary" onClick={onLocalSetup}>{t('打开本地接入')}</button>
        </div>}
    </section>

    {endpoint && <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm" aria-labelledby="remote-mcp-connections-title">
      <h2 id="remote-mcp-connections-title" className="text-base font-bold">{t('我的远程连接')}</h2>
      <p className="mt-1 text-sm leading-6 text-slate-600">{t('查看各连接的授权范围和权限，或随时撤销授权。')}</p>
      {list.isPending ? <p role="status" className="mt-4 text-sm text-slate-500">{t('正在读取远程连接…')}</p>
        : list.isError ? <div className="mt-4 flex flex-wrap items-center gap-3"><p role="alert" className="text-sm text-slate-700">{t('无法读取远程连接。')}</p><button type="button" className="ui-button ui-button-secondary" onClick={() => void list.refetch()}>{t('重试')}</button></div>
        : list.data?.length ? <ul className="mt-4 divide-y divide-slate-200 border-t border-slate-200">
          {list.data.map(connection => {
            const expires = new Date(connection.expiresAt);
            const validDate = Number.isFinite(expires.getTime());
            const status = connection.revokedAt ? '已撤销' : !validDate || expires.getTime() <= Date.now() ? '已过期' : '已授权';
            const scope = connection.projectCode === null ? t('本账号可访问的项目')
              : t('仅限项目 {project}', { project: projects?.find(item => item.code === connection.projectCode)?.name ?? connection.projectCode });
            return <li key={connection.code} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
              <div className="min-w-0">
                <h3 className="break-words text-sm font-semibold text-slate-900">{connection.name}</h3>
                <p className="mt-1 break-words text-xs text-slate-600">{scope} · {t(connection.allowTaskWrite ? '可协作' : '仅查看')}
                  {connection.allowPersonalMemory && <> · {t('含账号偏好')}</>}</p>
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-slate-600">
                <span className="font-medium text-slate-700">{t(status)}</span>
                {validDate && <time dateTime={connection.expiresAt}>{t('到期时间 {time}', { time: dateFormat.format(expires) })}</time>}
                {status === '已授权' && <button type="button" className="ui-button ui-button-secondary ui-button-compact" onClick={() => setRevoking(connection)}
                  aria-label={t('撤销连接 {name}', { name: connection.name })}>{t('撤销连接')}</button>}
              </div>
            </li>;
          })}
        </ul> : <p className="mt-4 rounded-lg bg-slate-50 px-4 py-3 text-sm text-slate-600">{t('还没有远程连接。')}</p>}
    </section>}
    {endpoint && <details className="rounded-2xl border border-slate-200 bg-white p-5">
      <summary className="cursor-pointer text-sm font-semibold">{t('高级接入：使用授权头')}</summary>
      <p className="my-3 text-sm leading-6 text-slate-600">{t('无法发起浏览器 OAuth 且支持 Authorization 请求头时，可为当前账号生成有期限的凭据。')}</p>
      <button type="button" className="ui-button ui-button-secondary" onClick={() => setCreating(true)}>{t('新建连接')}</button>
    </details>}
    {creating && endpoint && <CreateRemoteMcpDialog accountCode={accountCode} endpoint={endpoint} onClose={() => setCreating(false)} />}
    {revoking && endpoint && <RevokeRemoteMcpDialog accountCode={accountCode} connection={revoking} onClose={() => setRevoking(undefined)} />}
  </div>;
}

function CreateRemoteMcpDialog({ accountCode, endpoint, onClose }: {
  accountCode: string;
  endpoint: string;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [name, setName] = useState('');
  const [allowPersonalMemory, setAllowPersonalMemory] = useState(false);
  const [allowTaskWrite, setAllowTaskWrite] = useState(false);
  const [created, setCreated] = useState<NewMcpConnection>();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const mounted = useRef(false);
  const creating = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || creating.current) return;
    creating.current = true;
    setPending(true);
    setFailed(false);
    try {
      const result = await createMcpConnection({ name: name.trim(), allowPersonalMemory, allowTaskWrite });
      if (mounted.current) setCreated(result);
      void client.invalidateQueries({ queryKey: connectionsKey(accountCode) });
    } catch {
      if (mounted.current) setFailed(true);
    } finally {
      creating.current = false;
      if (mounted.current) setPending(false);
    }
  }

  return <WorkspaceDialog id="remote-mcp-create" title={t(created ? '远程连接已授权' : '新建远程 MCP 连接')} description={t(created
    ? '授权头只在此处显示一次。将它和服务地址填入客户端的远程 MCP 设置。'
    : '客户端以你的身份访问有权限的项目。你可以随时撤销授权。')} onClose={() => { if (!creating.current) onClose(); }}>
    {created ? <div className="space-y-4">
      <CopyCommand command={endpoint} copyLabel={t('复制服务地址')} />
      <CopyCommand command={`Authorization: Bearer ${created.token}`} copyLabel={t('复制授权头')} />
      <div className="flex justify-end"><button type="button" className="ui-button ui-button-primary" onClick={onClose}>{t('完成')}</button></div>
    </div> : <form className="space-y-4" onSubmit={event => void submit(event)}>
      <label className="ui-field-label block">{t('连接名称')}
        <input autoFocus required maxLength={100} className="form-control mt-2" value={name} onChange={event => setName(event.target.value)} disabled={pending} />
      </label>
      <McpPermissionFields allowTaskWrite={allowTaskWrite} allowPersonalMemory={allowPersonalMemory}
        disabled={pending} onTaskWriteChange={setAllowTaskWrite} onPersonalMemoryChange={setAllowPersonalMemory} />
      {failed && <p role="alert" className="text-sm text-rose-700">{t('未能创建远程连接，请检查账号后重试。')}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className="ui-button ui-button-secondary" disabled={pending} onClick={onClose}>{t('取消')}</button>
        <button type="submit" className="ui-button ui-button-primary" disabled={pending || !name.trim()}>{t(pending ? '正在授权…' : '确认授权')}</button>
      </div>
    </form>}
  </WorkspaceDialog>;
}

function RevokeRemoteMcpDialog({ accountCode, connection, onClose }: { accountCode: string; connection: McpConnection; onClose: () => void }) {
  const client = useQueryClient();
  const revoke = useMutation({
    mutationFn: () => revokeMcpConnection(connection.code),
    onSuccess: async () => { await client.invalidateQueries({ queryKey: connectionsKey(accountCode) }); onClose(); },
  });
  return <WorkspaceDialog id="remote-mcp-revoke" title={t('撤销连接')} description={t('撤销后，客户端将无法继续使用 {name} 的授权。', { name: connection.name })} onClose={() => { if (!revoke.isPending) onClose(); }}>
    {revoke.isError && <p role="alert" className="mb-3 text-sm text-rose-700">{t('未能撤销远程连接，请重试。')}</p>}
    <div className="flex justify-end gap-2">
      <button type="button" className="ui-button ui-button-secondary" disabled={revoke.isPending} onClick={onClose}>{t('取消')}</button>
      <button type="button" className="ui-button ui-button-danger" disabled={revoke.isPending} onClick={() => revoke.mutate()}>{t(revoke.isPending ? '正在撤销…' : '确认撤销连接')}</button>
    </div>
  </WorkspaceDialog>;
}
