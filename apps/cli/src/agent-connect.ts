import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { PublicCodeSchema } from '@team-synergy/contracts';
import { DomainError } from '@team-synergy/domain';
import { createAgentConnection } from './agent-connection.js';
import { authDirectory } from './auth-store.js';
import { doctorHarness, harnessRuntimePath, harnessRuntimeVersion, installHarness, readHarnessConfig, sameHarnessWorkspace, writeHarnessConfig,
  type CaptureHarness } from './memory-harness-install.js';
import { memoryContext } from './memory.js';

type ConnectHarness = CaptureHarness | 'claudecode';
type Options = { harness: string; project: string; capture?: boolean; readOnly?: boolean; hostHome?: string; runtime?: string };
type Stdio = { command: string; args: string[]; env: Record<string, string> };
type ConfigRecord = Record<string, unknown>;
type Change = { matches: boolean; apply: () => void };
const name = 'team_synergy_local';
const object = (value: unknown): value is ConfigRecord => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function selectHarness(input: string): ConnectHarness {
  const value = input === 'claude-code' ? 'claudecode' : input;
  if (value !== 'codex' && value !== 'dsh' && value !== 'opencode' && value !== 'claudecode') {
    throw new DomainError('agent_harness_unsupported', '请选择 codex、dsh、opencode 或 claudecode');
  }
  return value;
}

function readConfig(file: string): string {
  if (!existsSync(file)) return '';
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024) {
    throw new DomainError('agent_config_invalid', '宿主配置不是可安全读取的普通文件');
  }
  return readFileSync(file, 'utf8');
}

function jsonObject(raw: string): ConfigRecord {
  if (!raw.trim()) return {};
  try {
    const data: unknown = JSON.parse(raw);
    if (object(data)) return data;
  } catch { /* Do not overwrite invalid input. */ }
  throw new DomainError('agent_config_invalid', '连接配置格式无效，已保留原内容');
}

function conflict(): never {
  throw new DomainError('agent_mcp_conflict', '已存在不同配置的 team_synergy_local，未覆盖现有连接');
}

function hostsRun(runtime: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): string {
  const script = /\.[cm]?js$/u.test(runtime);
  try {
    return execFileSync(script ? process.execPath : runtime, script ? [runtime, ...args] : args, {
      cwd, env, encoding: 'utf8', timeout: 12000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 512 * 1024,
    });
  } catch {
    throw new DomainError('agent_harness_command_failed', '宿主未完成 MCP 配置，请检查已安装版本与宿主诊断');
  }
}

function fromEntry(entry: unknown, expected: Stdio): boolean {
  return object(entry) && (entry.type === undefined || entry.type === 'stdio') && entry.url === undefined && entry.command === expected.command &&
    isDeepStrictEqual(entry.args, expected.args) && isDeepStrictEqual(entry.env, expected.env);
}

function planCodex(source: Stdio, root: string, home: string, runtime: string): Change {
  const env = { ...process.env, CODEX_HOME: home };
  const list = (): unknown => {
    const servers: unknown = JSON.parse(hostsRun(runtime, ['mcp', 'list', '--json'], root, env));
    if (!Array.isArray(servers)) throw new DomainError('agent_config_invalid', 'Codex 未返回可验证的 MCP 配置清单');
    if (!servers.some(server => object(server) && server.name === name)) return undefined;
    return JSON.parse(hostsRun(runtime, ['mcp', 'get', name, '--json'], root, env)) as unknown;
  };
  const prior = list();
  const expected = (entry: unknown) => object(entry) && entry.enabled === true && fromEntry(entry.transport, source) &&
    object(entry.transport) && (entry.transport.cwd === undefined || entry.transport.cwd === null) &&
    (!Array.isArray(entry.transport.env_vars) || entry.transport.env_vars.length === 0) &&
    (entry.enabled_tools === undefined || entry.enabled_tools === null) && (entry.disabled_tools === undefined || entry.disabled_tools === null);
  if (prior !== undefined && !expected(prior)) conflict();
  return { matches: prior !== undefined, apply() {
    const current = list();
    if (current !== undefined) { if (!expected(current)) conflict(); return; }
    hostsRun(runtime, ['mcp', 'add', name, '--env', 'AGENTCTL_HOME=' + source.env.AGENTCTL_HOME,
      '--', source.command, ...source.args], root, env);
    if (!expected(list())) throw new DomainError('agent_config_unverified', 'Codex 未读回本次配置，请核对宿主清单');
  } };
}

function planDsh(source: Stdio, home: string, runtime: string): Change {
  harnessRuntimeVersion('dsh', runtime);
  const file = path.join(home, 'cordis.patch.yml'), before = readConfig(file);
  const patch = readHarnessConfig(before, 'dsh', runtime);
  if (!Array.isArray(patch)) throw new DomainError('agent_config_invalid', 'DSH patch 不是受支持的数组');
  const desired = { id: 'tsp-agent-local', name: '@deepseek-ai/dsh-mcp-client', config: {
    serverName: name, transport: 'stdio', ...source, failOnStartupError: false, toolCallTimeoutMs: 60000,
  } };
  const entries = patch.flatMap(item => object(item) && Array.isArray(item.insert) ? item.insert : []);
  const found = entries.filter(entry => object(entry) && (entry.id === desired.id || object(entry.config) && entry.config.serverName === name));
  if (found.length > 1 || found.length === 1 && !isDeepStrictEqual(found[0], desired)) conflict();
  return { matches: found.length === 1, apply() { writeHarnessConfig(file, JSON.stringify([...patch, { insert: [desired] }], null, 2) + '\n', before); } };
}

function planOpenCode(source: Stdio, root: string, home: string): Change {
  const explicit = process.env.OPENCODE_CONFIG;
  if (explicit || process.env.OPENCODE_CONFIG_CONTENT || process.env.OPENCODE_CONFIG_DIR || existsSync(path.join(home, 'opencode.jsonc'))) {
    throw new DomainError('agent_config_invalid', '检测到 OpenCode 自定义配置或 JSONC，请保留现有设置并按接入页高级示例配置');
  }
  const projectOverride = path.join(root, 'opencode.json');
  if (path.resolve(home) !== path.resolve(root) &&
      [readConfig(projectOverride), readConfig(path.join(root, 'opencode.jsonc'))].some(raw => raw.includes('"' + name + '"'))) {
    conflict();
  }
  const file = path.join(home, 'opencode.json'), before = readConfig(file), config = jsonObject(before);
  if (config.mcp !== undefined && !object(config.mcp)) throw new DomainError('agent_config_invalid', 'OpenCode 的 MCP 配置必须为对象');
  const mcp = (config.mcp ?? {}) as ConfigRecord;
  const desired = { type: 'local', command: [source.command, ...source.args], environment: source.env, enabled: true };
  if (mcp[name] !== undefined && !isDeepStrictEqual(mcp[name], desired)) conflict();
  return { matches: mcp[name] !== undefined, apply() {
    writeHarnessConfig(file, JSON.stringify({ ...config, mcp: { ...mcp, [name]: desired } }, null, 2) + '\n', before);
  } };
}

function planClaude(source: Stdio, root: string, runtime: string): Change {
  // Let Claude retain ownership of its own account state and project path normalization.
  // Local-scope configuration is documented in ~/.claude.json; alternate config dirs are ambiguous.
  if (process.env.CLAUDE_CONFIG_DIR) throw new DomainError('agent_config_invalid', 'Claude Code 使用自定义目录，请按高级示例配置');
  const file = path.join(homedir(), '.claude.json');
  const current = (): unknown => {
    const config = jsonObject(readConfig(file));
    if (config.projects !== undefined && !object(config.projects)) throw new DomainError('agent_config_invalid', 'Claude Code 的项目配置无效');
    const projects = config.projects as ConfigRecord | undefined;
    const entries = Object.entries(projects ?? {}).filter(([location]) => sameHarnessWorkspace(location, root));
    if (entries.length > 1) conflict();
    const project = entries[0]?.[1];
    if (project === undefined) return undefined;
    if (!object(project) || (project.mcpServers !== undefined && !object(project.mcpServers))) {
      throw new DomainError('agent_config_invalid', 'Claude Code 的本地 MCP 配置无效');
    }
    return object(project.mcpServers) ? project.mcpServers[name] : undefined;
  };
  const prior = current();
  if (prior !== undefined && !fromEntry(prior, source)) conflict();
  return { matches: prior !== undefined, apply() {
    const live = current();
    if (live !== undefined) { if (!fromEntry(live, source)) conflict(); return; }
    hostsRun(runtime, ['mcp', 'add', '--env', 'AGENTCTL_HOME=' + source.env.AGENTCTL_HOME,
      '--transport', 'stdio', '--scope', 'local', name, '--', source.command, ...source.args], root, process.env);
    if (!fromEntry(current(), source)) throw new DomainError('agent_config_unverified', 'Claude Code 未读回本次本地项目连接');
  } };
}

export async function connectAgent(options: Options) {
  const harness = selectHarness(options.harness);
  const code = PublicCodeSchema.safeParse(options.project);
  if (!code.success) throw new DomainError('invalid_project_code', '项目编码必须为 20 位公开编码');
  if (options.readOnly && options.capture) {
    throw new DomainError('agent_options_conflict', '仅查看模式不能同时注册采集');
  }
  if (harness === 'claudecode' && options.capture) {
    throw new DomainError('agent_capture_unsupported', 'Claude Code 当前支持 MCP，其原生采集尚未通过宿主验证');
  }
  const projectCode = code.data;
  const connection = createAgentConnection({ projectCode });
  const identity = await connection.getContext();
  if (!identity.connected) throw new DomainError('login_required', '请先执行 tsp auth login');
  const accessible = await connection.listProjects({ query: projectCode, limit: 100 });
  if (!accessible.items.some(project => project.projectCode === projectCode && project.status === 'active')) {
    throw new DomainError('project_forbidden', '当前 CLI 账号无法访问这个启用项目');
  }
  const workspace = realpathSync.native(process.cwd());
  if (options.capture) {
    const bound = memoryContext();
    if (bound.projectCode !== projectCode || !sameHarnessWorkspace(workspace, bound.root)) {
      throw new DomainError('agent_capture_workspace_mismatch', '在已绑定此项目的工作区根目录运行；不会覆盖已有绑定');
    }
  }
  if (options.hostHome && (!path.isAbsolute(options.hostHome) || /\p{Cc}/u.test(options.hostHome))) {
    throw new DomainError('agent_config_invalid', '宿主配置目录必须是有效绝对路径');
  }
  if (harness === 'claudecode' && options.hostHome) throw new DomainError('agent_config_invalid', 'Claude Code 本地项目连接由宿主 CLI 管理');
  const memberHome = path.resolve(authDirectory());
  const source: Stdio = { command: process.execPath, args: [fileURLToPath(new URL('./index.js', import.meta.url)),
    'mcp', '--project', projectCode, '--lock-project', ...(options.readOnly ? ['--read-only'] : [])], env: { AGENTCTL_HOME: memberHome } };
  const runtime = harness !== 'opencode' || options.capture ? harnessRuntimePath(harness, options.runtime) : undefined;
  const home = path.resolve(options.hostHome ?? (harness === 'codex' ? process.env.CODEX_HOME ?? path.join(homedir(), '.codex')
    : harness === 'dsh' ? process.env.DSH_HOME ?? path.join(homedir(), '.dsh')
      : path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config'), 'opencode')));
  const plan = () => {
    if (harness === 'opencode') return planOpenCode(source, workspace, home);
    if (!runtime) throw new Error('Missing harness runtime');
    if (harness === 'codex') return planCodex(source, workspace, home, runtime);
    if (harness === 'dsh') return planDsh(source, home, runtime);
    return planClaude(source, workspace, runtime);
  };
  const initial = plan();
  let capture: 'not_requested' | 'configured' | 'unchanged' = 'not_requested';
  if (options.capture) {
    try {
      await installHarness({ harness, workspace, hostHome: home, runtime });
      capture = 'configured';
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== 'memory_harness_already_installed') throw error;
      const existing = await doctorHarness({ harness, workspace });
      if (existing.installed !== true) throw new DomainError(existing.status, '现有会话采集配置需要检查，未覆盖');
      capture = 'unchanged';
    }
  }
  let status: 'configured' | 'unchanged';
  try {
    // Native DSH capture merges into the same patch. Re-read before applying.
    const change = options.capture ? plan() : initial;
    if (!change.matches) change.apply();
    status = change.matches ? 'unchanged' : 'configured';
  } catch (error) {
    if (capture !== 'configured') throw error;
    throw new DomainError('agent_connect_partial', '已注册会话采集，MCP 尚未配置。修正宿主配置后可重试。',
      { mcpError: error instanceof DomainError ? error.code : 'agent_config_failed', capture });
  }
  return { harness, projectCode, workspace, serverName: name, status, access: options.readOnly ? 'read-only' : 'interactive', capture,
    restartRequired: status === 'configured' || capture === 'configured' };
}
