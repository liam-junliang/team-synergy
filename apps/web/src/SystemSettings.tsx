import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getSystemSettings, updateSystemSettings, type SystemSettings as Settings } from './adminApi';
import { fetchCliReleaseManifest } from './CliInstaller';
import { SkillError } from './SkillShared';
import { t, formatDateTime } from './i18n';

const TARGETS = [['win32', 'Windows'], ['darwin', 'macOS'], ['linux', 'Linux']] as const;

export function SystemSettings() {
  const [saved, setSaved] = useState(false);
  const settings = useQuery({ queryKey: ['admin-settings'], queryFn: getSystemSettings });
  return <section className="space-y-5">
    {saved && <p role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">{t('配置已保存')}</p>}
    <SkillError error={settings.error} />
    {settings.isPending && <p role="status" className="text-sm text-slate-500">{t('正在加载配置…')}</p>}
    {settings.data && <SettingsForm key={settings.data.revision} settings={settings.data} onSaved={() => setSaved(true)} onChanged={() => setSaved(false)} />}
    <CliReleaseStatus />
  </section>;
}

export function SettingsForm({ settings, onSaved, onChanged }: { settings: Settings; onSaved?: () => void; onChanged?: () => void }) {
  const queryClient = useQueryClient();
  const [webUrl, setWebUrl] = useState(settings.public_web_url ?? '');
  const [apiUrl, setApiUrl] = useState(settings.public_api_url ?? '');
  const mutation = useMutation({
    mutationFn: updateSystemSettings,
    onSuccess: (result) => {
      onSaved?.();
      queryClient.setQueryData(['admin-settings'], result);
      void queryClient.invalidateQueries({ queryKey: ['platform-client-config'] });
    },
  });
  const changed = webUrl.trim() !== (settings.public_web_url ?? '') || apiUrl.trim() !== (settings.public_api_url ?? '');
  function submit(event: FormEvent) {
    event.preventDefault();
    mutation.mutate({ public_web_url: webUrl.trim() || null, public_api_url: apiUrl.trim() || null, base_revision: settings.revision });
  }
  return <form onSubmit={submit} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
    <h2 className="text-base font-bold text-slate-900">{t('平台访问地址')}</h2>
    <p className="mt-2 text-sm leading-6 text-slate-500">{t('配置成员设备可以访问的地址，用于 CLI 安装、登录和浏览器授权指引。留空时使用当前访问地址。')}</p>
    <div className="mt-5 grid gap-5 lg:grid-cols-2">
      <label className="ui-field-label block">{t('Web 公开地址')}<input className="form-control mt-2" type="url" value={webUrl} onChange={event => { setWebUrl(event.target.value); onChanged?.(); }} placeholder="https://team.example.com" maxLength={2048} /><span className="mt-1.5 block text-xs font-normal leading-5 text-slate-500">{t('填写站点地址，不包含页面路径。')}</span></label>
      <label className="ui-field-label block">{t('API 公开地址')}<input className="form-control mt-2" type="url" value={apiUrl} onChange={event => { setApiUrl(event.target.value); onChanged?.(); }} placeholder="https://team.example.com/api" maxLength={2048} /><span className="mt-1.5 block text-xs font-normal leading-5 text-slate-500">{t('填写完整 API 基础地址，可包含 /api。')}</span></label>
    </div>
    <p className="mt-3 text-xs leading-5 text-slate-500">{t('正式部署请使用 HTTPS；HTTP 仅用于本机开发。此配置不会修改服务监听端口或反向代理。')}</p>
    <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
      <p className="text-xs text-slate-500">{settings.updated_at ? t('更新于 {time}', { time: formatDateTime(settings.updated_at) }) : t('尚未自定义配置')}</p>
      <div className="flex flex-wrap gap-2"><button type="button" onClick={() => void queryClient.invalidateQueries({ queryKey: ['admin-settings'] })} disabled={mutation.isPending} className="ui-button ui-button-secondary">{t('重新加载配置')}</button><button type="submit" disabled={!changed || mutation.isPending} className="ui-button ui-button-primary">{mutation.isPending ? t('保存中…') : t('保存配置')}</button></div>
    </div>
    <div className="mt-3"><SkillError error={mutation.error} /></div>
  </form>;
}

export function CliReleaseStatus() {
  const manifest = useQuery({ queryKey: ['cli-release'], queryFn: fetchCliReleaseManifest, retry: false, staleTime: 60_000 });
  return <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-base font-bold text-slate-900">{t('CLI 安装包')}</h2><p className="mt-2 text-sm leading-6 text-slate-500">{t('检查平台实际提供的安装包。发布文件由部署流程管理，刷新后生效。')}</p></div><button type="button" className="ui-button ui-button-secondary ui-button-compact" disabled={manifest.isFetching} onClick={() => void manifest.refetch()}>{t('刷新')}</button></div>
    <div className="mt-4"><SkillError error={manifest.error} /></div>
    {manifest.isPending && <p role="status" className="text-sm text-slate-500">{t('正在检查平台发布版本…')}</p>}
    {manifest.data && <><p className="mb-3 text-xs text-slate-500">{t('版本 {version} · 运行时 Node.js {runtime}', { version: manifest.data.version, runtime: manifest.data.node_version })}</p>
      <div className="grid gap-3 sm:grid-cols-3">{TARGETS.map(([platform, label]) => <div key={platform} className="rounded-xl border border-slate-200 p-4"><h3 className="text-sm font-semibold text-slate-800">{label}</h3><ul className="mt-3 space-y-2">{(['x64', 'arm64'] as const).map(arch => {
        const artifact = manifest.data.artifacts.find(item => item.platform === platform && item.arch === arch);
        return <li key={arch} className="flex flex-wrap items-center justify-between gap-2 text-xs"><span className="text-slate-500">{arch}</span><span className={artifact ? 'text-emerald-700' : 'text-amber-700'}>{t(artifact ? '已发布' : '未发布')}</span></li>;
      })}</ul></div>)}</div>
      <p className="mt-4 break-all text-xs text-slate-400">{t('发布标识')}：{manifest.data.release}</p>
    </>}
  </section>;
}
