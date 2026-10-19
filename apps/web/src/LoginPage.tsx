import LanguageSwitcher from './LanguageSwitcher';
import { useLocale } from './useLocale';
import { t } from './i18n.ts';
import { useState, type FormEvent } from 'react';
import { loginWebSession, type AuthUser } from './api';
import { browserClientInfo } from './clientIdentity';

export function LoginPage({ onLogin }: { onLogin: (user: AuthUser) => void }) {
  useLocale();
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const user = await loginWebSession({
        account: account.trim(),
        password,
        device_name: browserClientInfo(navigator.userAgent).name,
      });
      onLogin(user);
    } catch {
      setError('登录失败：账号或密码错误，初始密码也可能已经过期。');
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="grid min-h-screen min-w-[320px] place-items-center bg-slate-950 p-5">
      <div className="pointer-events-none fixed inset-0 overflow-hidden" aria-hidden="true">
        <div className="absolute -left-32 top-[-14rem] h-[32rem] w-[32rem] rounded-full bg-cyan-500/15 blur-3xl" />
        <div className="absolute -bottom-64 right-[-10rem] h-[38rem] w-[38rem] rounded-full bg-blue-600/10 blur-3xl" />
      </div>
      <section className="relative w-full max-w-md overflow-hidden rounded-2xl border border-slate-700/80 bg-white shadow-2xl shadow-cyan-950/30">
        <header className="bg-slate-900 px-6 py-5 text-white">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 grid-cols-2 gap-1 rounded-xl bg-cyan-600 p-2" aria-hidden="true"><i className="rounded-sm bg-white" /><i className="rounded-sm bg-cyan-200" /><i className="rounded-sm bg-cyan-200" /><i className="rounded-sm bg-white" /></span>
            <div><strong className="block text-base">Team Synergy</strong><span className="text-[10px] font-semibold tracking-[0.18em] text-cyan-300">TEAM WORKSPACE</span></div>
          </div>
          <h1 className="mt-7 text-2xl font-bold">{t("登录项目工作台")}</h1>
          <p className="mt-2 text-sm leading-6 text-slate-400">{t("使用用户账号和密码登录。首次登录请输入管理员提供的临时初始密码。")}</p>
        </header>
        <div className="flex justify-end px-6 pt-4"><LanguageSwitcher /></div>
        <form onSubmit={submit} className="space-y-4 p-6">
          <label className="block text-sm font-semibold text-slate-700">{t("用户账号")}<input autoFocus required autoComplete="username" value={account} onChange={(event) => setAccount(event.target.value)} placeholder={t("请输入用户账号")} className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm outline-none focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100" />
          </label>
          <label className="block text-sm font-semibold text-slate-700">{t("密码")}<input required maxLength={128} type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={t("输入密码或初始密码")} className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm outline-none focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100" />
          </label>
          {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{t(error)}</p>}
          <button disabled={pending} className="ui-button ui-button-primary ui-button-roomy ui-button-block">{pending ? t('正在登录…') : t('登录')}</button>
          <p className="text-center text-xs leading-5 text-slate-400">{t("没有账号或初始密码已过期？请联系系统管理员。")}</p>
        </form>
      </section>
    </main>
  );
}
