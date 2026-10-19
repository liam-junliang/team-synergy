import { t } from './i18n';
import type { AdminSection } from './workspaceRouting';

export const ADMIN_SECTIONS: Array<{ id: AdminSection; label: string }> = [
  { id: 'settings', label: '系统配置' },
  { id: 'teams', label: '团队项目管理' },
  { id: 'users', label: '用户管理' },
];

export function AdminNavigation({ tab }: { tab?: AdminSection }) {
  return <>{ADMIN_SECTIONS.map(item => <a key={item.id} href={`/admin/${item.id}`} aria-current={tab === item.id ? 'page' : undefined} className={`shrink-0 border-b-2 px-3 py-2 text-sm font-medium transition ${tab === item.id ? 'border-cyan-400 text-white' : 'border-transparent text-slate-400 hover:text-slate-100'}`}>{t(item.label)}</a>)}</>;
}
