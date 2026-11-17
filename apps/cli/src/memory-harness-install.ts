import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DomainError } from '@team-synergy/domain';
import { authDirectory } from './auth-store.js';
import { memoryContext, valueOf } from './memory.js';
import type { NativeCaptureBridgeConfig } from './memory-native-capture.js';

export type CaptureHarness = 'codex' | 'dsh' | 'opencode';
export const supportedHarnessVersions: Record<CaptureHarness, readonly string[]> = {
  codex: ['0.145.0', '0.169.0-alpha.11.1'], dsh: ['0.2.1-rc.2'], opencode: ['1.14.21'],
};
export type HarnessInstallation = {
  schema: 1; id: string; enabled: boolean; harness: CaptureHarness; hostVersion: string; runtime: string;
  workspace: string; projectCode: string; actor: string; owner: string; memberHome: string; cliPath: string; nodePath: string;
  hostHome: string; configFile: string; pluginFile: string; installationFile: string; auditFile: string; installedAt: string;
  managed: Record<string, unknown>; backupFile?: string;
};
type InstallInput = { harness: unknown; workspace?: string; hostHome?: string; config?: string; runtime?: string };
type HostConfig = Record<string, unknown> | unknown[];
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function fail(code: string, message: string): never { throw new DomainError(code, message); }
const absolute = (value: unknown): value is string => typeof value === 'string' && path.isAbsolute(value) && !/\p{Cc}/u.test(value);
function harness(value: unknown): CaptureHarness {
  if (value !== 'codex' && value !== 'dsh' && value !== 'opencode') fail('memory_harness_unsupported', '请选择 codex、dsh 或 opencode。');
  return value;
}
export function sameHarnessWorkspace(first: unknown, second: string) {
  if (!absolute(first)) return false;
  try { return realpathSync.native(first) === realpathSync.native(second); } catch { return false; }
}
function text(file: string) { return existsSync(file) ? readFileSync(file, 'utf8') : ''; }
function atomic(file: string, content: string, before?: string) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (before !== undefined && text(file) !== before) fail('memory_harness_config_changed', '宿主配置已变化，请重新检查后安装。');
  const temporary = file + '.tsp-' + randomBytes(8).toString('hex');
  writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
  renameSync(temporary, file);
}
function packageRoot(runtime: string, name: string) {
  let directory = path.dirname(realpathSync.native(runtime));
  for (;;) {
    const file = path.join(directory, 'package.json');
    if (existsSync(file)) {
      try { if (JSON.parse(text(file)).name === name) return file; } catch { /* Continue through unrelated parents. */ }
    }
    const parent = path.dirname(directory); if (parent === directory) return; directory = parent;
  }
}
function runtimePath(name: CaptureHarness, explicit?: string) {
  if (explicit) { if (!absolute(explicit) || !existsSync(explicit)) fail('memory_harness_runtime_missing', '宿主运行文件必须为现有绝对路径。'); return realpathSync.native(explicit); }
  const packages = { codex: ['@openai/codex', 'bin/codex.js'], dsh: ['@deepseek-ai/dsh', 'lib/bin.js'], opencode: ['opencode-ai', 'bin/opencode'] };
  for (const directory of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, 'node_modules', ...packages[name]);
    if (existsSync(candidate)) return realpathSync.native(candidate);
    const executable = path.join(directory, name + (process.platform === 'win32' ? '.exe' : ''));
    if (existsSync(executable)) return realpathSync.native(executable);
  }
  return fail('memory_harness_runtime_missing', '未找到宿主运行文件；用 --runtime 指定已安装宿主的绝对入口。');
}
export function harnessRuntimeVersion(name: CaptureHarness, runtime: string) {
  const useNode = /\.[cm]?js$/u.test(runtime) || name === 'opencode' && path.basename(runtime) === 'opencode';
  let output: string;
  try { output = execFileSync(useNode ? process.execPath : runtime, useNode ? [runtime, '--version'] : ['--version'],
    { encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8192 }).trim(); }
  catch { return fail('memory_harness_runtime_unavailable', '宿主版本检测失败，未启用自动采集。'); }
  const version = output.match(/(?:^|\s)(\d+\.\d+\.\d+(?:-[\w.-]+)?)(?:\s|$)/u)?.[1];
  if (!version || !supportedHarnessVersions[name].includes(version)) fail('memory_harness_version_unsupported', '当前宿主版本未经采集格式验证，未启用自动采集。');
  return version;
}
function configData(raw: string, name: CaptureHarness, runtime: string): HostConfig {
  if (!raw.trim()) return name === 'dsh' ? [] : {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch {
    if (name !== 'dsh') return fail('memory_harness_config_unsupported', '配置不是受支持的 JSON，原文件保持不变。');
    const sdk = packageRoot(runtime, '@deepseek-ai/dsh');
    if (!sdk) return fail('memory_harness_config_unsupported', '未找到 DSH 原生配置解析器，原 YAML 保持不变。');
    try { const yaml = createRequire(sdk)('js-yaml') as { load(input: string): unknown }; parsed = yaml.load(raw); }
    catch { return fail('memory_harness_config_unsupported', 'DSH 原生解析器无法读取该配置，原文件保持不变。'); }
  }
  if (name === 'dsh' ? !Array.isArray(parsed) : !object(parsed)) fail('memory_harness_config_unsupported', '宿主配置格式不匹配，原文件保持不变。');
  return parsed as HostConfig;
}
function commandArgument(value: string, windows: boolean) {
  if (windows) {
    if (/\p{Cc}/u.test(value)) fail('memory_harness_command_path_unsupported', '路径包含不受支持的 Windows 命令字符。');
    return "'" + value.replace(/'/gu, "''") + "'";
  }
  return "'" + value.replace(/'/gu, "'\\''") + "'";
}
function managedEntries(installation: HarnessInstallation) {
  if (installation.harness === 'codex') {
    // Both pinned Windows hosts run hooks in PowerShell. Quoting an executable
    // alone is a string expression there; the call operator is required.
    const command = (windows: boolean) => (windows ? '& ' : '') +
      [installation.nodePath, installation.cliPath, 'memory', 'native', 'event', '--installation', installation.installationFile]
        .map(value => commandArgument(value, windows)).join(' ');
    return Object.fromEntries(['SessionStart', 'UserPromptSubmit', 'Stop'].map(event => [event,
      { hooks: [{ type: 'command', command: command(false), commandWindows: command(true), timeout: 10,
        statusMessage: 'TeamSynergy 本地采集' }] }]));
  }
  if (installation.harness === 'dsh') return { plugin: { id: 'tsp-memory-auto-' + installation.id,
    name: pathToFileURL(fileURLToPath(new URL('./memory-dsh-capture.js', import.meta.url))).href,
    config: { installation: installation.installationFile } } };
  return { plugin: pathToFileURL(installation.pluginFile).href };
}
function changeEntries(data: HostConfig, installation: HarnessInstallation, remove: boolean) {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const update = (rows: unknown, entry: unknown): unknown[] => {
    if (rows !== undefined && !Array.isArray(rows)) fail('memory_harness_config_unsupported', '宿主插件配置结构不受支持。');
    const existing = (rows ?? []) as unknown[];
    if (remove && !existing.some(row => same(row, entry))) fail('memory_harness_config_changed', '自有配置已被修改，未自动删除。');
    return remove ? existing.filter(row => !same(row, entry)) : existing.some(row => same(row, entry)) ? existing : [...existing, entry];
  };
  if (installation.harness === 'dsh') return update(data, { insert: [installation.managed.plugin] });
  if (!object(data)) fail('memory_harness_config_unsupported', '宿主配置必须为对象。');
  if (installation.harness === 'codex') {
    if (data.hooks !== undefined && !object(data.hooks)) fail('memory_harness_config_unsupported', 'Codex hooks 配置结构无效。');
    const hooks = { ...(data.hooks as Record<string, unknown> ?? {}) };
    for (const [event, entry] of Object.entries(installation.managed)) hooks[event] = update(hooks[event], entry);
    return { ...data, hooks };
  }
  return { ...data, plugin: update(data.plugin, installation.managed.plugin) };
}
function installationLocation(name: CaptureHarness, owner: string, workspace: string) {
  const id = hash(JSON.stringify([name, owner, workspace])).slice(0, 32);
  return { id, directory: path.join(authDirectory(), 'memory-harness', id) };
}
export function readHarnessInstallation(file: string, expected?: CaptureHarness): HarnessInstallation {
  if (!absolute(file)) fail('memory_harness_invalid', '接入记录路径无效。');
  let value: unknown;
  try { value = JSON.parse(text(file)); } catch { return fail('memory_harness_not_installed', '未找到有效的持久接入记录。'); }
  if (!object(value) || value.schema !== 1 || value.enabled !== true || value.installationFile !== file ||
    !/^[a-f0-9]{32}$/u.test(String(value.id)) || !/^[a-f0-9]{64}$/u.test(String(value.owner)) ||
    !['codex', 'dsh', 'opencode'].includes(String(value.harness)) || expected && value.harness !== expected ||
    !['workspace', 'memberHome', 'cliPath', 'nodePath', 'hostHome', 'configFile', 'pluginFile', 'auditFile', 'runtime'].every(key => absolute(value[key])) ||
    typeof value.actor !== 'string' || typeof value.projectCode !== 'string' || !object(value.managed)) {
    fail('memory_harness_not_installed', '持久接入记录无效或已停用。');
  }
  const result = value as unknown as HarnessInstallation;
  if (!supportedHarnessVersions[result.harness].includes(result.hostVersion)) fail('memory_harness_version_unsupported', '接入记录的宿主版本未经验证。');
  return result;
}
export function installedSessionConfig(installation: HarnessInstallation, sessionId: string): NativeCaptureBridgeConfig {
  if (!/^[a-zA-Z0-9._:-]{1,160}$/u.test(sessionId)) fail('memory_harness_session_invalid', '原生会话编号无效。');
  return { harness: installation.harness, hostSessionId: sessionId,
    memorySession: installation.harness + '.' + hash(sessionId).slice(0, 32), owner: installation.owner,
    cwd: installation.workspace, memberHome: installation.memberHome, cliPath: installation.cliPath,
    nodePath: installation.nodePath, auditFile: installation.auditFile };
}
export async function installHarness(input: InstallInput) {
  const name = harness(input.harness), context = memoryContext(5000);
  if (input.workspace && !sameHarnessWorkspace(input.workspace, context.root) || !sameHarnessWorkspace(process.cwd(), context.root)) {
    fail('memory_harness_workspace_mismatch', '请在明确绑定项目的工作区根目录注册接入。');
  }
  if (valueOf(await context.client.whoami()).user_code !== context.actor) fail('memory_actor_mismatch', '设备身份与当前账号不一致。');
  valueOf(await context.client.request('GET', context.route + '/binding'));
  if (memoryContext().owner !== context.owner) fail('memory_binding_changed', '接入期间账号或项目已变化。');
  const runtime = runtimePath(name, input.runtime), hostVersion = harnessRuntimeVersion(name, runtime);
  const hostHome = path.resolve(input.hostHome ?? (name === 'codex' ? process.env.CODEX_HOME ?? path.join(homedir(), '.codex') :
    name === 'dsh' ? process.env.DSH_HOME ?? path.join(homedir(), '.dsh') : path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config'), 'opencode')));
  const configFile = input.config ?? path.join(hostHome, name === 'codex' ? 'hooks.json' : name === 'dsh' ? 'cordis.patch.yml' : 'opencode.json');
  if (!absolute(configFile)) fail('memory_harness_invalid', '配置路径必须为绝对路径。');
  if (name === 'opencode' && !input.config && existsSync(path.join(hostHome, 'opencode.jsonc'))) fail('memory_harness_config_unsupported', '已有 JSONC 配置，需要先明确兼容的 JSON 配置路径。');
  const { id, directory } = installationLocation(name, context.owner, context.root);
  const installationFile = path.join(directory, 'installation.json');
  if (existsSync(installationFile)) {
    const existing = JSON.parse(text(installationFile)) as HarnessInstallation;
    if (existing.enabled) fail('memory_harness_already_installed', '已存在接入记录，请先运行 doctor 或安全卸载。');
  }
  const before = text(configFile), data = configData(before, name, runtime);
  const installation: HarnessInstallation = { schema: 1, id, enabled: true, harness: name, hostVersion, runtime,
    workspace: context.root, projectCode: context.projectCode, actor: context.actor, owner: context.owner,
    memberHome: path.resolve(authDirectory()), cliPath: fileURLToPath(new URL('./index.js', import.meta.url)), nodePath: process.execPath,
    hostHome, configFile, pluginFile: path.join(directory, 'capture-plugin.mjs'), installationFile,
    auditFile: path.join(directory, 'events.ndjson'), installedAt: new Date().toISOString(), managed: {} };
  installation.managed = managedEntries(installation);
  const updated = changeEntries(data, installation, false);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (before) {
    installation.backupFile = path.join(directory, 'config-before-' + randomBytes(8).toString('hex') + '.bak');
    writeFileSync(installation.backupFile, before, { flag: 'wx', mode: 0o600 });
  }
  if (name === 'opencode') atomic(installation.pluginFile,
    `import { persistentOpencodePlugin } from ${JSON.stringify(new URL('./memory-opencode-capture.js', import.meta.url).href)};\nexport default persistentOpencodePlugin(${JSON.stringify(installationFile)});\n`);
  // A config reference without a completed registry fails closed in every adapter.
  atomic(configFile, JSON.stringify(updated, null, 2) + '\n', before);
  atomic(installationFile, JSON.stringify(installation, null, 2) + '\n');
  return { installationFile, harness: name, hostVersion, workspace: context.root, projectCode: context.projectCode,
    actor: context.actor, configFile, backupFile: installation.backupFile, restartRequired: true,
    hookTrust: name === 'codex' ? 'review_current_definition_in_codex_hooks' : 'not_applicable', collectionObserved: false };
}
export async function doctorHarness(input: InstallInput) {
  const checkedAt = new Date().toISOString();
  try {
    const name = harness(input.harness), context = memoryContext(5000);
    const { directory } = installationLocation(name, context.owner, context.root);
    const installation = readHarnessInstallation(path.join(directory, 'installation.json'), name);
    const hostVersion = harnessRuntimeVersion(name, installation.runtime);
    const data = configData(text(installation.configFile), name, installation.runtime);
    changeEntries(data, installation, true); // Confirms that the exact owned definitions remain present.
    if (valueOf(await context.client.whoami()).user_code !== context.actor) fail('memory_actor_mismatch', '设备身份与当前账号不一致。');
    valueOf(await context.client.request('GET', context.route + '/binding'));
    const recent = text(installation.auditFile).slice(-65536).split('\n').flatMap(line => {
      try { const row = JSON.parse(line) as Record<string, unknown>; return object(row) ? [row] : []; } catch { return []; }
    });
    const durable = recent.filter(row => row.kind === 'native-capture-durable' || row.kind === 'native-source-verified').at(-1);
    return { checkedAt, status: durable ? 'local_capture_observed' : 'awaiting_new_session', harness: name,
      hostVersion, workspace: context.root, projectCode: context.projectCode, actor: context.actor,
      configFile: installation.configFile, backupFile: installation.backupFile, installed: true,
      hookTrust: name === 'codex' ? 'unknown_review_in_codex_hooks' : 'not_applicable',
      validatedVersions: supportedHarnessVersions[name],
      lastLocalDurableAt: durable?.at ?? null, lastErrorCode: recent.filter(row => typeof row.code === 'string').at(-1)?.code ?? null,
      remoteDelivery: 'not_observed_by_local_doctor' };
  } catch (error) {
    return { checkedAt, status: error instanceof DomainError ? error.code : 'memory_harness_diagnosis_failed', installed: 'unknown', collectionObserved: false };
  }
}
export async function uninstallHarness(input: InstallInput) {
  const name = harness(input.harness), context = memoryContext();
  const { directory } = installationLocation(name, context.owner, context.root);
  const installation = readHarnessInstallation(path.join(directory, 'installation.json'), name);
  const before = text(installation.configFile), data = configData(before, name, installation.runtime);
  const updated = changeEntries(data, installation, true);
  const backup = path.join(directory, 'config-before-uninstall-' + randomBytes(8).toString('hex') + '.bak');
  writeFileSync(backup, before, { flag: 'wx', mode: 0o600 });
  atomic(installation.configFile, JSON.stringify(updated, null, 2) + '\n', before);
  atomic(installation.installationFile, JSON.stringify({ ...installation, enabled: false }, null, 2) + '\n');
  return { harness: name, removedOwnEntries: true, backupFile: backup, retainedLocalQueue: true, restartRequired: true };
}
