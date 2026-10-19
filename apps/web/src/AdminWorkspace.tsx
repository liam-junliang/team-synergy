import { AccountWorkbench } from './AccountWorkbench';
import { AdminTeamsProjects } from './AdminTeamsProjects';
import { SystemSettings } from './SystemSettings';
import { useLocale } from './useLocale';
import { t } from './i18n';
import type { AdminSection } from './workspaceRouting';

export function AdminWorkspace({ tab = 'teams', isSystemAdmin }: { tab?: AdminSection; isSystemAdmin: boolean }) {
  useLocale();
  if (!isSystemAdmin) return <div role="alert" className="flex flex-1 items-center justify-center bg-slate-50 p-6 text-sm text-slate-500">{t('只有系统管理员可以进入管理控制台。')}</div>;
  if (tab === 'users') return <AccountWorkbench />;
  return <main className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-slate-50 p-4 lg:p-7">
    <section className="mx-auto max-w-[1400px]">
      <header className="mb-5"><p className="text-xs font-bold tracking-[0.18em] text-cyan-700">SYSTEM ADMINISTRATION</p><h1 className="mt-1 text-2xl font-bold text-slate-900">{t(tab === 'settings' ? '系统配置' : '团队项目管理')}</h1><p className="mt-2 text-sm leading-6 text-slate-500">{t(tab === 'settings' ? '统一配置平台公开地址，检查 CLI 发布状态。' : '管理平台内的团队和项目，查看归属、成员规模及项目状态。')}</p></header>
      {tab === 'settings' ? <SystemSettings /> : <AdminTeamsProjects />}
    </section>
  </main>;
}
