import { enableUser } from './adminApi';
import { DeviceManagement } from './DeviceManagement';
import { useLocale } from './useLocale';
import { t, formatDateTime } from './i18n.ts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import {
  createUser,
  disableUser,
  issueUserInitialPassword,
  listUsers,
  type CreateUserInput,
  type CreateUserResult,
  type UserAccount,
} from './api';

const EMPTY_FORM: CreateUserInput = { account: '', display_name: '' };

/** System-admin account administration: accounts, initial passwords, and devices. */
export function AccountWorkbench() {
  useLocale();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [form, setForm] = useState<CreateUserInput>(EMPTY_FORM);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [issuedPassword, setIssuedPassword] = useState<CreateUserResult | null>(null);
  const usersQuery = useQuery({ queryKey: ['users'], queryFn: listUsers });
  const users = usersQuery.data ?? [];
  const visibleUsers = users.filter(user => (!status || user.status === status) && `${user.account} ${user.display_name} ${user.code}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const selectedUser = users.find((user) => user.code === selectedId) ?? users[0] ?? null;
  async function refreshUserAccess(userCode: string) {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['users'] }),
      queryClient.invalidateQueries({ queryKey: ['devices', userCode] }),
      queryClient.invalidateQueries({ queryKey: ['device-sessions', userCode] }),
    ]);
  }

  const createMutation = useMutation({
    mutationFn: createUser,
    onSuccess: (result) => {
      setIssuedPassword(result);
      setSelectedId(result.code);
      setForm(EMPTY_FORM);
      void queryClient.invalidateQueries({ queryKey: ['users'] });
    },
  });
  const disableMutation = useMutation({
    mutationFn: disableUser,
    onSuccess: (_, userCode) => refreshUserAccess(userCode),
  });
  const enableMutation = useMutation({ mutationFn: enableUser, onSuccess: (_, userCode) => refreshUserAccess(userCode) });
  const issueMutation = useMutation({
    mutationFn: issueUserInitialPassword,
    onSuccess: (result) => {
      setIssuedPassword(result);
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      void queryClient.invalidateQueries({ queryKey: ['devices', result.code] });
    },
  });

  function submitNewUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    createMutation.mutate({ account: form.account.trim(), display_name: form.display_name.trim() });
  }

  if (usersQuery.isLoading) return <div className="flex flex-1 items-center justify-center bg-slate-50 text-sm text-slate-500">{t("正在加载账号…")}</div>;
  if (usersQuery.error) return <div className="m-7 rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-700">{t("无法加载系统账号：")}{t(usersQuery.error.message)}</div>;

  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-slate-50 p-5 lg:p-7">
      <section className="mx-auto max-w-[1400px]">
        <header className="mb-5">
          <p className="text-xs font-bold tracking-[0.18em] text-cyan-700">SYSTEM ADMINISTRATION</p>
          <h1 className="mt-1 text-2xl font-bold text-slate-900">{t("用户管理")}</h1>
          <p className="mt-1 text-sm text-slate-500">{t("管理用户账号、初始密码、设备和登录会话。")}</p>
        </header>

        <form onSubmit={submitNewUser} className="mb-4 rounded-xl border border-cyan-200 bg-white p-4 shadow-sm">
          <div><h2 className="font-semibold text-slate-800">{t("创建用户")}</h2><p className="mt-1 text-xs text-slate-500">{t("用户编码由系统生成；创建后会显示 15 分钟有效的初始密码")}</p></div>
          <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(180px,1fr)_minmax(180px,1fr)_auto]">
            <label className="text-xs font-semibold text-slate-600">{t("登录账号")}<input required minLength={3} maxLength={64} value={form.account} onChange={(event) => setForm((value) => ({ ...value, account: event.target.value }))} placeholder={t("例如：chen")} className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-normal outline-none focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100" />
            </label>
            <label className="text-xs font-semibold text-slate-600">{t("显示名称")}<input required value={form.display_name} onChange={(event) => setForm((value) => ({ ...value, display_name: event.target.value }))} placeholder={t("例如：陈晨")} className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-normal outline-none focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100" />
            </label>
            <button type="submit" disabled={createMutation.isPending} className="ui-button ui-button-primary self-end">{createMutation.isPending ? t('创建中…') : t('创建账号')}</button>
          </div>
          {createMutation.error && <p role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{t("创建失败：")}{t(createMutation.error.message)}</p>}
        </form>

        <div className="grid min-h-[520px] gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(340px,0.8fr)]">
          <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-200 px-4 py-3"><h2 className="font-semibold text-slate-800">{t("用户列表")}</h2><p className="text-xs text-slate-500">{t("账号数量：{count}", { count: users.length })}</p></div>
            <div className="flex flex-wrap gap-2 border-b border-slate-100 p-4"><input aria-label={t('搜索用户')} className="form-control min-w-40 flex-1" placeholder={t('搜索账号、名称或编码')} value={search} onChange={event => setSearch(event.target.value)} /><select aria-label={t('用户状态')} className="form-control !w-auto" value={status} onChange={event => setStatus(event.target.value)}><option value="">{t('全部状态')}</option><option value="active">{t('启用')}</option><option value="disabled">{t('已禁用')}</option></select></div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500"><tr><th className="px-4 py-3">{t("账号 / 编码")}</th><th className="px-4 py-3">{t("显示名称")}</th><th className="px-4 py-3">{t("状态")}</th><th className="px-4 py-3">{t("密码")}</th><th className="px-4 py-3 text-right">{t("操作")}</th></tr></thead>
                <tbody className="divide-y divide-slate-100">{visibleUsers.map((user) => (
                  <UserRow key={user.code} user={user} selected={selectedUser?.code === user.code} disabling={(disableMutation.isPending && disableMutation.variables === user.code) || (enableMutation.isPending && enableMutation.variables === user.code)} issuing={issueMutation.isPending && issueMutation.variables === user.code} onSelect={() => setSelectedId(user.code)} onIssue={() => issueMutation.mutate(user.code)} onDisable={() => user.status === 'active' ? disableMutation.mutate(user.code) : enableMutation.mutate(user.code)} />
                ))}</tbody>
              </table>
              {visibleUsers.length === 0 && <div className="p-10 text-center text-sm text-slate-400">{t("没有匹配的记录")}</div>}
            </div>
            {enableMutation.error && <p role="alert" className="m-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{t("启用失败：")}{t(enableMutation.error.message)}</p>}
            {disableMutation.error && <p role="alert" className="m-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{t("禁用失败：")}{t(disableMutation.error.message)}</p>}
            {issueMutation.error && <p role="alert" className="m-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{t("生成失败：")}{t(issueMutation.error.message)}</p>}
          </section>

          <aside className="overflow-hidden rounded-xl border border-blue-200 bg-white shadow-sm">
            <div className="border-b border-blue-100 bg-blue-50/60 p-5"><p className="text-xs font-bold uppercase tracking-wider text-blue-600">{t("登录设备")}</p><h2 className="mt-2 text-lg font-bold text-slate-900">{selectedUser?.display_name ?? t('选择用户')}</h2>{selectedUser && <><strong className="mt-1 block text-sm text-blue-700">@{selectedUser.account}</strong><code className="mt-0.5 block text-[11px] text-slate-400">{selectedUser.code}</code></>}</div>
            <div className="space-y-3 p-5">
              {!selectedUser && <p className="text-sm text-slate-400">{t("从用户列表中选择账号以查看设备。")}</p>}
              {selectedUser && <DeviceManagement key={selectedUser.code} userCode={selectedUser.code} />}
            </div>
          </aside>
        </div>
      </section>
      {issuedPassword && <InitialPasswordDialog issued={issuedPassword} onClose={() => setIssuedPassword(null)} />}
    </main>
  );
}

function UserRow({ user, selected, disabling, issuing, onSelect, onIssue, onDisable }: { user: UserAccount; selected: boolean; disabling: boolean; issuing: boolean; onSelect: () => void; onIssue: () => void; onDisable: () => void }) {
  const protectedAccount = user.is_system_admin || Boolean(user.deleted_at) || Boolean(user.pending_deletion);
  return (
    <tr onClick={onSelect} className={`cursor-pointer transition ${selected ? 'bg-blue-50 ring-1 ring-inset ring-blue-200' : 'hover:bg-slate-50'}`}>
      <td className="px-4 py-3"><strong className="block text-slate-800">@{user.account}</strong><code className="mt-0.5 block text-[11px] text-slate-400">{user.code}</code></td>
      <td className="px-4 py-3 font-medium text-slate-800">{user.display_name}{user.is_system_admin && <span className="ml-2 rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-bold text-violet-700">ADMIN</span>}</td>
      <td className="px-4 py-3"><span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${user.deleted_at || user.pending_deletion || user.status === 'disabled' ? 'bg-slate-200 text-slate-600' : 'bg-emerald-100 text-emerald-700'}`}>{t(user.deleted_at ? '已注销' : user.pending_deletion ? '注销中' : user.status === 'active' ? '启用' : '已禁用')}</span></td>
      <td className="px-4 py-3"><span className={`text-xs font-semibold ${user.must_change_password ? 'text-amber-700' : 'text-emerald-700'}`}>{user.must_change_password ? t('等待首次修改') : t('已设置')}</span></td>
      <td className="px-4 py-3 text-right"><div className="flex justify-end gap-2"><button type="button" onClick={(event) => { event.stopPropagation(); onIssue(); }} disabled={protectedAccount || user.status === 'disabled' || issuing} className="ui-button ui-button-secondary ui-button-compact">{issuing ? t('生成中…') : t('重置初始密码')}</button><button type="button" onClick={(event) => { event.stopPropagation(); onDisable(); }} disabled={protectedAccount || disabling} className={`ui-button ${user.status === 'disabled' ? 'ui-button-secondary' : 'ui-button-danger'} ui-button-compact`}>{disabling ? t('处理中…') : user.status === 'disabled' ? t('启用') : t('禁用')}</button></div></td>
    </tr>
  );
}

function InitialPasswordDialog({ issued, onClose }: { issued: CreateUserResult; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  async function copyPassword() {
    try {
      await navigator.clipboard.writeText(issued.initial_password);
      setCopied(true);
      setCopyError(false);
    } catch {
      setCopyError(true);
    }
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4" role="dialog" aria-modal="true" aria-labelledby="initial-password-title">
      <section className="w-full max-w-xl rounded-2xl border border-amber-300 bg-white p-6 shadow-2xl">
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4"><p className="text-xs font-black tracking-[0.16em] text-amber-800">INITIAL PASSWORD</p><h2 id="initial-password-title" className="mt-1 text-xl font-black text-amber-950">{t("初始密码仅显示一次")}</h2><p className="mt-2 text-sm text-amber-800">{t("请安全交付给账号")}<strong>@{issued.account}</strong>{t("。用户首次登录后必须立即设置新密码。")}</p></div>
        <code className="mt-4 block rounded-xl bg-slate-950 p-4 text-center text-2xl font-black tracking-[0.25em] text-cyan-300" data-testid="initial-password">{issued.initial_password}</code>
        <p className="mt-2 text-xs text-slate-500">{t("有效期至")}{formatDateTime(issued.expires_at)}</p>
        {copyError && <p role="alert" className="mt-2 text-xs text-rose-600">{t("自动复制失败，请手动复制上方初始密码。")}</p>}
        <div className="mt-5 flex flex-wrap justify-end gap-2"><button type="button" onClick={copyPassword} className="ui-button ui-button-primary">{copied ? t('已复制') : t('复制初始密码')}</button><button type="button" onClick={onClose} className="ui-button ui-button-secondary">{t("关闭并清除")}</button></div>
      </section>
    </div>
  );
}
