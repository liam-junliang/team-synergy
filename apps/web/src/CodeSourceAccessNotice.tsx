import { t } from './i18n';
import { useLocale } from './useLocale';
import { projectWorkspacePath } from './workspaceRouting';

export function CodeSourceAccessNotice({ projectCode, resource }: { projectCode: string; resource: 'map' | 'candidates' }) {
  useLocale();
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6">
      <h2 className="text-base font-semibold text-slate-800">{t('查看权限受限')}</h2>
      <p className="mt-2 text-sm leading-6 text-slate-600">
        {resource === 'map'
          ? t('观看者可以阅读已发布的项目资料。查看规格地图和源码证据需要项目成员权限。')
          : t('观看者可以阅读已发布的项目资料。查看代码候选和源码证据需要项目成员权限。')}
      </p>
      <a className="ui-button ui-button-secondary mt-4" href={projectWorkspacePath(projectCode, 'documents')}>
        {t('查看项目文档')}
      </a>
    </section>
  );
}
