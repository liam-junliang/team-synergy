import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CopyCommand, SkillError } from './SkillShared';
import { t } from './i18n';

export type CliPlatform = 'win32' | 'darwin' | 'linux';
export interface CliReleaseManifest {
  schema_version: 1;
  version: string;
  release: string;
  node_version: string;
  artifacts: Array<{ platform: CliPlatform; arch: 'x64' | 'arm64'; filename: string; sha256: string; size_bytes: number; format: 'zip' | 'tar.gz' }>;
}

export async function fetchCliReleaseManifest(): Promise<CliReleaseManifest> {
  const response = await fetch('/api/cli/manifest.json', { credentials: 'same-origin' });
  if (!response.ok) throw new Error(t('无法加载 CLI 安装包，请联系平台管理员检查发布配置。'));
  const data = await response.json();
  if (data.schema_version !== 1 || typeof data.version !== 'string' || !Array.isArray(data.artifacts)) throw new Error(t('CLI 发布清单格式无效。'));
  return data;
}

export function cliInstallCommand(platform: CliPlatform, apiUrl: string): string {
  if (platform === 'win32') {
    const quoted = apiUrl.replace(/'/g, "''");
    return `$installer = Join-Path ([IO.Path]::GetTempPath()) ('tsp-install-' + [guid]::NewGuid() + '.ps1')\nInvoke-WebRequest '${quoted}/cli/install.ps1' -OutFile $installer\npowershell -NoProfile -ExecutionPolicy Bypass -File $installer -BaseUrl '${quoted}'`;
  }
  const quoted = apiUrl.replace(/'/g, "'\\''");
  return `installer="$(mktemp)"\ncurl -fsSL '${quoted}/cli/install.sh' -o "$installer" &&\nsh "$installer" --base-url '${quoted}'`;
}

function detectedPlatform(): CliPlatform {
  const agent = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  return /Macintosh|Mac OS X/i.test(agent) ? 'darwin' : /Linux/i.test(agent) ? 'linux' : 'win32';
}

export function CliInstaller({ apiUrl }: { apiUrl: string }) {
  const [platform, setPlatform] = useState<CliPlatform>(detectedPlatform);
  const manifest = useQuery({ queryKey: ['cli-release'], queryFn: fetchCliReleaseManifest, retry: false, staleTime: 60_000 });
  const artifacts = manifest.data?.artifacts.filter(item => item.platform === platform) ?? [];
  return <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
    <h2 className="text-base font-bold">1. {t('安装 CLI')}</h2><p className="mb-4 mt-2 text-sm leading-6 text-slate-500">{t('从当前平台下载安装包，已包含运行时，无需源码、Node.js 或 pnpm。再次执行安装脚本即可更新，保留登录与项目配置。')}</p>
    <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label={t('选择操作系统')}>{([['win32', 'Windows'], ['darwin', 'macOS'], ['linux', 'Linux']] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={platform === value} className={`ui-button ui-button-compact ${platform === value ? 'ui-button-primary' : 'ui-button-secondary'}`} onClick={() => setPlatform(value)}>{label}</button>)}</div>
    <button type="button" className="ui-context-action mb-3" disabled={manifest.isFetching} onClick={() => void manifest.refetch()}>{t('重新检查安装包')}</button>
    <SkillError error={manifest.error} />{manifest.isPending && <p role="status" className="text-sm text-slate-500">{t('正在检查平台发布版本…')}</p>}
    {manifest.isSuccess && (artifacts.length ? <><p className="mb-3 text-xs text-slate-500">{t('版本 {version} · 可用架构：{architectures}', { version: manifest.data.version, architectures: artifacts.map(item => item.arch).join(' / ') })}</p><CopyCommand command={cliInstallCommand(platform, apiUrl)} /><p className="mt-2 text-xs leading-5 text-slate-500">{t('脚本自动识别本机架构、校验下载文件并安装到用户目录。如果终端尚未识别 tsp，请重开终端。')}</p></> : <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">{t('此平台尚未发布安装包，请联系平台管理员。')}</p>)}
  </section>;
}
