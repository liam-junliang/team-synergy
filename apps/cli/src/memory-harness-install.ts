import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DomainError } from '@team-synergy/domain';
import { PublicCodeSchema } from '@team-synergy/contracts';
import { authDirectory } from './auth-store.js';
import { memoryContext, valueOf, type MemoryContext } from './memory.js';
import { isNativeCaptureStatus, nativeHarnessInstallationLocation, type NativeCaptureBridgeConfig } from './memory-native-capture.js';

export type CaptureHarness = 'codex' | 'dsh' | 'opencode';
export const supportedHarnessVersions: Record<CaptureHarness, readonly string[]> = {
  codex: ['0.145.0', '0.169.0-alpha.11.1', '0.171.0-alpha.13'],
  dsh: ['0.2.1-rc.2', '0.2.2-rc.5'],
  opencode: ['1.14.21'],
};
export type HarnessInstallation = {
  schema: 1; id: string; enabled: boolean; harness: CaptureHarness; hostVersion: string; runtime: string;
  workspace: string; projectCode: string; actor: string; owner: string; memberHome: string; cliPath: string; nodePath: string;
  hostHome: string; configFile: string; pluginFile: string; installationFile: string; auditFile: string; installedAt: string;
  managed: Record<string, unknown>; backupFile?: string;
};
type InstallInput = { harness: unknown; workspace?: string; hostHome?: string; config?: string; runtime?: string };
type HostConfig = Record<string, unknown> | unknown[];
type CapturePreflight = { serviceEnabled: boolean; allowed: boolean; reason: 'memory_capture_disabled' | 'memory_forbidden' | null };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const diagnosticCode = (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9_]{1,100}$/u.test(value);
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
export function writeHarnessConfig(file: string, content: string, before?: string) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (before !== undefined && text(file) !== before) fail('memory_harness_config_changed', '宿主配置已变化，请重新检查后安装。');
  const temporary = file + '.tsp-' + randomBytes(8).toString('hex');
  writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
  try { renameSync(temporary, file); }
  catch (error) { try { unlinkSync(temporary); } catch { /* Preserve the rename failure. */ } throw error; }
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
export function harnessRuntimePath(name: CaptureHarness | 'claudecode', explicit?: string) {
  if (explicit) { if (!absolute(explicit) || !existsSync(explicit)) fail('memory_harness_runtime_missing', '宿主运行文件必须为现有绝对路径。'); return realpathSync.native(explicit); }
  const packages = { codex: ['@openai/codex', 'bin/codex.js'], dsh: ['@deepseek-ai/dsh', 'lib/bin.js'],
    opencode: ['opencode-ai', 'bin/opencode'], claudecode: ['@anthropic-ai/claude-code', 'cli.js'] };
  const executableName = name === 'claudecode' ? 'claude' : name;
  const directories = [path.join(homedir(), '.local', 'bin'), ...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean)];
  for (const directory of directories) {
    const candidate = path.join(directory, 'node_modules', ...packages[name]);
    if (existsSync(candidate)) return realpathSync.native(candidate);
    const executable = path.join(directory, executableName + (process.platform === 'win32' ? '.exe' : ''));
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
export function readHarnessConfig(raw: string, name: CaptureHarness, runtime: string): HostConfig {
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
function assertCurrentOwner(context: MemoryContext) {
  if (memoryContext().owner !== context.owner) fail('memory_binding_changed', '检查期间账号或项目已变化。');
}

async function capturePreflight(context: MemoryContext): Promise<CapturePreflight> {
  if (valueOf(await context.client.whoami()).user_code !== context.actor) fail('memory_actor_mismatch', '设备身份与当前账号不一致。');
  const data = valueOf(await context.client.request<unknown>('GET', context.route + '/capture-preflight'));
  assertCurrentOwner(context);
  if (!object(data) || typeof data.serviceEnabled !== 'boolean' || typeof data.allowed !== 'boolean') {
    fail('api_bad_response', '平台未返回可核验的会话采集权限。');
  }
  const { serviceEnabled, allowed, reason } = data;
  if (serviceEnabled && allowed && reason === null) return { serviceEnabled, allowed, reason };
  if (!allowed && (reason === 'memory_forbidden' || !serviceEnabled && reason === 'memory_capture_disabled')) return { serviceEnabled, allowed, reason };
  return fail('api_bad_response', '平台未返回可核验的会话采集权限。');
}

function recentAudit(file: string, installedAt: string) {
  if (!existsSync(file)) return [];
  const descriptor = openSync(file, 'r');
  try {
    const length = fstatSync(descriptor).size;
    const buffer = Buffer.alloc(Math.min(length, 65536));
    const offset = length - buffer.length;
    const size = readSync(descriptor, buffer, 0, buffer.length, offset);
    const lines = buffer.toString('utf8', 0, size).split('\n');
    if (offset > 0) lines.shift();
    return lines.flatMap(line => {
      try {
        const row: unknown = JSON.parse(line);
        return object(row) && typeof row.at === 'string' && row.at >= installedAt ? [row] : [];
      } catch { return []; }
    });
  } finally { closeSync(descriptor); }
}

async function latestNativeCapture(context: MemoryContext, recent: ReturnType<typeof recentAudit>, allowed: boolean) {
  const receipt = recent.findLast(row => row.kind === 'native-server-received' &&
    PublicCodeSchema.safeParse(row.captureCode).success && isNativeCaptureStatus(row.status));
  if (!receipt) return null;
  const { captureCode, status, at: receivedAt } = receipt;
  if (typeof captureCode !== 'string' || !isNativeCaptureStatus(status) || typeof receivedAt !== 'string') return null;
  const acknowledged = { captureCode, status, receivedAt, statusSource: 'delivery_receipt' as const };
  if (!allowed) return acknowledged;
  try {
    const value = valueOf(await context.client.request<unknown>('GET', context.route + '/captures/' + captureCode));
    assertCurrentOwner(context);
    if (!object(value) || value.captureCode !== captureCode || !isNativeCaptureStatus(value.status)) {
      fail('api_bad_response', '平台未返回此采集编号的有效状态。');
    }
    const errorCode = object(value.error) && diagnosticCode(value.error.code) ? value.error.code : undefined;
    return { ...acknowledged, status: value.status, statusSource: 'server' as const, ...(errorCode ? { errorCode } : {}) };
  } catch (error) {
    assertCurrentOwner(context);
    return { ...acknowledged, refreshErrorCode: error instanceof DomainError && diagnosticCode(error.code) ? error.code : 'memory_capture_status_unavailable' };
  }
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
  const preflight = await capturePreflight(context);
  if (!preflight.allowed) fail(preflight.reason ?? 'memory_forbidden', preflight.reason === 'memory_capture_disabled' ?
    '服务端尚未开启会话采集。' : '当前账号没有项目会话采集权限。');
  const runtime = harnessRuntimePath(name, input.runtime), hostVersion = harnessRuntimeVersion(name, runtime);
  const hostHome = path.resolve(input.hostHome ?? (name === 'codex' ? process.env.CODEX_HOME ?? path.join(homedir(), '.codex') :
    name === 'dsh' ? process.env.DSH_HOME ?? path.join(homedir(), '.dsh') : path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config'), 'opencode')));
  const configFile = input.config ?? path.join(hostHome, name === 'codex' ? 'hooks.json' : name === 'dsh' ? 'cordis.patch.yml' : 'opencode.json');
  if (!absolute(configFile)) fail('memory_harness_invalid', '配置路径必须为绝对路径。');
  if (name === 'opencode' && !input.config && existsSync(path.join(hostHome, 'opencode.jsonc'))) fail('memory_harness_config_unsupported', '已有 JSONC 配置，需要先明确兼容的 JSON 配置路径。');
  const { id, directory } = nativeHarnessInstallationLocation(name, context.owner, context.root);
  const installationFile = path.join(directory, 'installation.json');
  if (existsSync(installationFile)) {
    const existing = JSON.parse(text(installationFile)) as HarnessInstallation;
    if (existing.enabled) fail('memory_harness_already_installed', '已存在接入记录，请先运行 doctor 或安全卸载。');
  }
  const before = text(configFile), data = readHarnessConfig(before, name, runtime);
  const installation: HarnessInstallation = { schema: 1, id, enabled: true, harness: name, hostVersion, runtime,
    workspace: context.root, projectCode: context.projectCode, actor: context.actor, owner: context.owner,
    memberHome: path.resolve(authDirectory()), cliPath: fileURLToPath(new URL('./index.js', import.meta.url)), nodePath: process.execPath,
    hostHome, configFile, pluginFile: path.join(directory, 'capture-plugin.mjs'), installationFile,
    auditFile: path.join(directory, 'events.ndjson'), installedAt: new Date().toISOString(), managed: {} };
  installation.managed = managedEntries(installation);
  const updated = changeEntries(data, installation, false);
  assertCurrentOwner(context);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (before) {
    installation.backupFile = path.join(directory, 'config-before-' + randomBytes(8).toString('hex') + '.bak');
    writeFileSync(installation.backupFile, before, { flag: 'wx', mode: 0o600 });
  }
  if (name === 'opencode') writeHarnessConfig(installation.pluginFile,
    `import { persistentOpencodePlugin } from ${JSON.stringify(new URL('./memory-opencode-capture.js', import.meta.url).href)};\nexport default persistentOpencodePlugin(${JSON.stringify(installationFile)});\n`);
  // A config reference without a completed registry fails closed in every adapter.
  writeHarnessConfig(configFile, JSON.stringify(updated, null, 2) + '\n', before);
  writeHarnessConfig(installationFile, JSON.stringify(installation, null, 2) + '\n');
  return { installationFile, harness: name, hostVersion, workspace: context.root, projectCode: context.projectCode,
    actor: context.actor, configFile, backupFile: installation.backupFile, restartRequired: true,
    hookTrust: name === 'codex' ? 'review_current_definition_in_codex_hooks' : 'not_applicable', collectionObserved: false, capturePreflight: preflight };
}
export async function doctorHarness(input: InstallInput) {
  const checkedAt = new Date().toISOString();
  let preflight: CapturePreflight | undefined;
  try {
    const name = harness(input.harness), context = memoryContext(5000);
    preflight = await capturePreflight(context);
    const { directory } = nativeHarnessInstallationLocation(name, context.owner, context.root);
    const installation = readHarnessInstallation(path.join(directory, 'installation.json'), name);
    if (installation.owner !== context.owner || installation.actor !== context.actor || installation.projectCode !== context.projectCode ||
      !sameHarnessWorkspace(installation.workspace, context.root) || installation.auditFile !== path.join(directory, 'events.ndjson')) {
      fail('memory_binding_changed', '接入记录与当前账号或工作区不一致。');
    }
    const hostVersion = harnessRuntimeVersion(name, installation.runtime);
    const data = readHarnessConfig(text(installation.configFile), name, installation.runtime);
    changeEntries(data, installation, true); // Confirms that the exact owned definitions remain present.
    const recent = recentAudit(installation.auditFile, installation.installedAt);
    const durable = recent.filter(row => row.kind === 'native-capture-durable' || row.kind === 'native-source-verified').at(-1);
    const lastDelivery = recent.findLast(row => row.kind === 'native-server-received' || row.kind === 'native-server-delivery-failed');
    const deliveryErrorCode = lastDelivery?.kind === 'native-server-delivery-failed' && diagnosticCode(lastDelivery.code) ? lastDelivery.code : null;
    const latestCapture = await latestNativeCapture(context, recent, preflight.allowed);
    assertCurrentOwner(context);
    return { checkedAt, status: preflight.reason ?? (durable ? 'local_capture_observed' : 'awaiting_new_session'), harness: name,
      hostVersion, workspace: context.root, projectCode: context.projectCode, actor: context.actor,
      configFile: installation.configFile, backupFile: installation.backupFile, installed: true,
      hookTrust: name === 'codex' ? 'unknown_review_in_codex_hooks' : 'not_applicable',
      validatedVersions: supportedHarnessVersions[name],
      lastLocalDurableAt: durable?.at ?? null, lastErrorCode: recent.findLast(row => diagnosticCode(row.code))?.code ?? null,
      capturePreflight: preflight, latestCapture, deliveryErrorCode,
      remoteDelivery: deliveryErrorCode ? 'local_delivery_failed' : latestCapture?.statusSource === 'server' ? 'verified_server_receipt' :
        latestCapture ? 'acknowledged_status_unavailable' : 'not_observed_by_local_doctor' };
  } catch (error) {
    const status = error instanceof DomainError ? error.code : 'memory_harness_diagnosis_failed';
    return { checkedAt, status: status === 'memory_harness_not_installed' ? preflight?.reason ?? status : status,
      installed: status === 'memory_harness_not_installed' ? false : 'unknown', collectionObserved: false,
      ...(preflight && status !== 'memory_binding_changed' ? { capturePreflight: preflight } : {}) };
  }
}
export async function uninstallHarness(input: InstallInput) {
  const name = harness(input.harness), context = memoryContext();
  const { directory } = nativeHarnessInstallationLocation(name, context.owner, context.root);
  const installation = readHarnessInstallation(path.join(directory, 'installation.json'), name);
  const before = text(installation.configFile), data = readHarnessConfig(before, name, installation.runtime);
  const updated = changeEntries(data, installation, true);
  const backup = path.join(directory, 'config-before-uninstall-' + randomBytes(8).toString('hex') + '.bak');
  writeFileSync(backup, before, { flag: 'wx', mode: 0o600 });
  writeHarnessConfig(installation.configFile, JSON.stringify(updated, null, 2) + '\n', before);
  writeHarnessConfig(installation.installationFile, JSON.stringify({ ...installation, enabled: false }, null, 2) + '\n');
  return { harness: name, removedOwnEntries: true, backupFile: backup, retainedLocalQueue: true, restartRequired: true };
}
