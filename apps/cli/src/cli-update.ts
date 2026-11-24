import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { DomainError } from '@team-synergy/domain';
import { z } from 'zod';

const product = 'team-synergy-cli';
const slotPattern = /^(\d+\.\d+\.\d+-[a-f0-9]{16})-[a-zA-Z0-9]{8}$/;
const releaseRoot = fileURLToPath(new URL('../../..', import.meta.url));
const packageVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version as string;
const checkIntervalMs = 24 * 60 * 60 * 1000;
const windows = process.platform === 'win32';
const manifestSchema = z.object({
  schema_version: z.literal(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  artifacts: z.array(z.object({
    platform: z.string(),
    arch: z.string(),
    filename: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    release: z.string(),
    size_bytes: z.number().int().positive(),
  })),
});

type ManagedInstallation = { directory: string; current: string; previous?: string; origin?: string };
type Artifact = { filename: string; sha256: string; release: string; size_bytes: number };
type UpdateCheck = { current: string; available: string; update_available: boolean; version: string };

function optionalFile<T>(file: string, parse: (data: string) => T): T | undefined {
  try { return parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export function cliVersion() {
  const metadata = optionalFile(path.join(releaseRoot, 'distribution.json'), JSON.parse);
  const slot = path.basename(releaseRoot);
  return {
    version: packageVersion,
    release: slotPattern.test(slot) && path.basename(path.dirname(releaseRoot)) === 'versions' ? slot.slice(0, -9) : null,
    source_revision: metadata?.source_revision ?? null,
  };
}

function managedInstallation(fallbackOrigin?: string): ManagedInstallation | undefined {
  const slot = path.basename(releaseRoot);
  const versions = path.dirname(releaseRoot);
  if (!slotPattern.test(slot) || path.basename(versions) !== 'versions') return undefined;
  const directory = path.dirname(versions);
  const legacy = windows
    ? optionalFile(path.join(directory, '.tsp-install.json'), (text) => {
        const marker = JSON.parse(text);
        return { product: marker.product, current: marker.directory, origin: marker.api_url };
      })
    : optionalFile(path.join(directory, '.tsp-install'), (text) => {
        const [product, current, origin] = text.split(/\r?\n/);
        return { product, current, origin };
      });
  const pointer = optionalFile(path.join(directory, '.tsp-current'), (text) => text.split(/\r?\n/));
  const current = pointer?.[0] ?? legacy?.current;
  if (legacy?.product !== product || typeof current !== 'string' || !slotPattern.test(current)) return undefined;
  return { directory, current, previous: pointer?.[1] || undefined, origin: pointer?.[2] || legacy.origin || fallbackOrigin };
}

function error(code: string, message: string): never { throw new DomainError(code, message); }

function normalizedOrigin(installation: ManagedInstallation): string {
  let url: URL;
  try { url = new URL(installation.origin ?? ''); }
  catch { return error('cli_update_origin_missing', '缺少发布 API 地址。请从原平台重新下载安装脚本。'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    return error('cli_update_origin_invalid', '发布 API 必须使用 HTTPS，本机地址可使用 HTTP。');
  }
  return url.href.replace(/\/$/, '');
}

async function check(installation: ManagedInstallation, timeoutMs: number): Promise<UpdateCheck & { artifact: Artifact }> {
  const origin = normalizedOrigin(installation);
  let body: unknown;
  try {
    const response = await fetch(origin + '/cli/manifest.json', { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return error('cli_update_unavailable', `发布服务暂不可用（HTTP ${response.status}）。`);
    body = await response.json();
  } catch (cause) {
    if (cause instanceof DomainError) throw cause;
    return error('cli_update_unavailable', '无法读取原平台的 CLI 发布清单。');
  }

  const parsed = manifestSchema.safeParse(body);
  if (!parsed.success) return error('cli_update_manifest_invalid', 'CLI 发布清单格式无效。');
  const manifest = parsed.data;
  // The bundle selects a native runtime. An emulated Windows bundle can still move to ARM64.
  const architecture = windows && [process.env.PROCESSOR_ARCHITECTURE, process.env.PROCESSOR_ARCHITEW6432].includes('ARM64')
    ? 'arm64' : process.arch;
  const artifacts = manifest.artifacts.filter((artifact) => artifact.platform === process.platform && artifact.arch === architecture);
  const artifact = artifacts[0];
  if (!artifact) return error('cli_update_platform_unavailable', '平台尚未发布适用于本机系统和架构的 CLI 安装包。');
  const extension = windows ? 'zip' : 'tar.gz';
  if (artifacts.length !== 1 || artifact.release !== `${manifest.version}-${artifact.sha256.slice(0, 16)}`
    || artifact.filename !== `tsp-${artifact.release}-${process.platform}-${architecture}.${extension}`) {
    return error('cli_update_manifest_invalid', '本机安装包的发布标识或校验值无效。');
  }
  const current = installation.current.slice(0, -9);
  const latestParts = manifest.version.split('.');
  const currentVersion = current.slice(0, current.lastIndexOf('-'));
  const versionOrder = currentVersion.split('.').reduce((order, part, index) => {
    const difference = BigInt(latestParts[index] ?? '0') - BigInt(part);
    return order || (difference === 0n ? 0 : difference > 0n ? 1 : -1);
  }, 0);
  const updateAvailable = versionOrder > 0 || (versionOrder === 0 && artifact.release !== current);
  return { current, available: artifact.release, update_available: updateAvailable, version: manifest.version, artifact };
}

async function confirmed(question: string, yes: boolean): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY || !process.stderr.isTTY) return error('cli_update_confirmation_required', '请在交互终端确认。自动化需要显式提供 --yes。');
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try { return /^(?:y|yes)$/i.test((await prompt.question(question + ' [y/N] ')).trim()); }
  finally { prompt.close(); }
}

async function bundledInstaller(installation: ManagedInstallation, artifact?: Artifact): Promise<void> {
  const directory = path.join(installation.directory, 'versions', installation.current);
  const installer = path.join(directory, 'installers', windows ? 'install.ps1' : 'install.sh');
  const script = await lstat(installer).catch(() => undefined);
  if (!script?.isFile()) return error('cli_update_installer_missing', '当前版本没有内置安装程序。请从平台重新下载安装脚本。');
  const args = windows
    ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', installer, '-InstallDir', installation.directory,
       '-NoModifyPath', '-ExpectedCurrent', installation.current,
       ...(artifact ? ['-BaseUrl', normalizedOrigin(installation), '-ExpectedSha256', artifact.sha256] : ['-Rollback'])]
    : [installer, '--install-dir', installation.directory, '--no-modify-path', '--expected-current', installation.current,
       ...(artifact ? ['--base-url', normalizedOrigin(installation), '--expected-sha256', artifact.sha256] : ['--rollback'])];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(windows ? 'powershell.exe' : '/bin/sh', args, { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
    child.stdout.pipe(process.stderr, { end: false });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new DomainError('cli_update_install_failed', 'CLI 切换失败，请查看安装程序输出。')));
  });
}

export async function runCliUpdate(options: { check?: boolean; rollback?: boolean; yes?: boolean }, fallbackOrigin?: string) {
  if (options.check && options.rollback) return error('cli_update_invalid_options', '--check 和 --rollback 不能同时使用。');
  const installation = managedInstallation(fallbackOrigin);
  if (!installation) return error('cli_update_unmanaged', '此命令适用于平台安装包。源码或其他方式安装的 CLI 请使用原安装方式更新。');
  if (options.rollback) {
    if (!installation.previous || !slotPattern.test(installation.previous)) return error('cli_update_no_rollback', '没有可回退的上一版本。');
    const previous = installation.previous.slice(0, -9);
    if (!await confirmed(`将后续启动的 CLI 和 agentd 切换到 ${previous}？`, options.yes ?? false)) return { cancelled: true };
    await bundledInstaller(installation);
    return { version: previous.split('-')[0], release: previous, rolled_back: true };
  }

  const { artifact, ...result } = await check(installation, 10_000);
  if (options.check || !result.update_available) return result;
  if (!await confirmed(`将 CLI 和 agentd 从 ${result.current} 升级到 ${result.available}？`, options.yes ?? false)) return { ...result, cancelled: true };
  await bundledInstaller(installation, artifact);
  return { ...result, updated: true };
}

export async function notifyCliUpdate(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stderr.isTTY) return;
  try {
    const installation = managedInstallation();
    if (!installation?.origin || installation.current !== path.basename(releaseRoot)) return;
    const stateFile = path.join(installation.directory, '.tsp-update-check');
    const state = await lstat(stateFile).catch(() => undefined);
    if (state && !state.isFile()) return;
    if (state && Date.now() - state.mtimeMs < checkIntervalMs && await readFile(stateFile, 'utf8') === installation.current) return;
    await writeFile(stateFile, installation.current, { mode: 0o600 });
    const result = await check(installation, 1_500);
    if (result.update_available) process.stderr.write(`Team Synergy CLI 有新版本 ${result.available}。运行 tsp update 可查看并确认升级。\n`);
  } catch { /* A release check cannot interfere with normal CLI usage. */ }
}
