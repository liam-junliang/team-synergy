import LanguageSwitcher from './LanguageSwitcher';
import { useLocale } from './useLocale';
import { t } from './i18n.ts';
import { useState, type FormEvent } from 'react';
import { changeWebPassword, type AuthUser } from './api';

export function PasswordChangePage({ user, onChanged, onLogout }: { user: AuthUser; onChanged: (user: AuthUser) => void; onLogout: () => void }) {
  useLocale();
  const [currentPassword, setCurrentPassword] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (password !== confirmation) {
      setError('两次输入的密码不一致。');
      return;
    }
    setPending(true);
    setError(null);
    try {
      onChanged(await changeWebPassword(password, currentPassword || undefined));
    } catch (e) {
      const message = e instanceof Error ? e.message : '';
      if (message.includes('auth_credentials_invalid')) {
        setError('当前密码错误，请重新输入。');
      } else if (message.includes('auth_current_password_required')) {
        setError('请输入当前密码。');
      } else if (message.includes('auth_initial_password_expired')) {
        setError('初始密码已过期，请联系管理员重新发放。');
      } else {
        setError('密码修改失败，请确认密码为 8 到 128 个字符。');
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="grid min-h-screen min-w-[320px] place-items-center bg-slate-950 p-5">
      <section className="w-full max-w-md rounded-2xl border border-amber-300 bg-white p-6 shadow-2xl">
        <p className="text-xs font-black tracking-[0.16em] text-amber-700">FIRST LOGIN</p>
        <h1 className="mt-2 text-2xl font-black text-slate-900">{t("请先设置新密码")}</h1>
        <p className="mt-2 text-sm leading-6 text-slate-500">{t("账号 {account} 正在使用临时初始密码。完成修改后才能进入团队和项目。", { account: user.account })}</p>
        <div className="flex justify-end px-6 pt-4"><LanguageSwitcher /></div>
        <form onSubmit={submit} className="mt-6 space-y-4">
          <label className="block text-sm font-semibold text-slate-700">{t("当前密码")}<input required autoComplete="current-password" type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} placeholder={t("管理员发放的初始密码")} className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2.5 outline-none focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100" />
          </label>
          <label className="block text-sm font-semibold text-slate-700">{t("新密码")}<input autoFocus required minLength={8} maxLength={128} type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={t("8 到 128 个字符")} className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2.5 outline-none focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100" />
          </label>
          <label className="block text-sm font-semibold text-slate-700">{t("确认新密码")}<input required minLength={8} maxLength={128} type="password" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder={t("再次输入新密码")} className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2.5 outline-none focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100" />
          </label>
          {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{t(error)}</p>}
          <button disabled={pending} className="ui-button ui-button-primary ui-button-roomy ui-button-block">{pending ? t('正在保存…') : t('保存新密码并进入')}</button>
          <button type="button" onClick={onLogout} className="w-full text-xs font-semibold text-slate-500 hover:text-slate-800">{t("退出当前账号")}</button>
        </form>
      </section>
    </main>
  );
}
