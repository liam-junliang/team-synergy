import { execFileSync } from 'node:child_process';
import { appendFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { DomainError } from '@team-synergy/domain';

export interface MemoryOpencodeLifecycleConfig {
  hostSessionId: string;
  memorySession: string;
  cwd: string;
  memberHome: string;
  cliPath: string;
  nodePath?: string;
  auditFile?: string;
}

type Reason = 'compaction' | 'resume';
type HostInput = { sessionID: string };
type ToolInput = HostInput & { tool: string; callID: string };
type NativeEvent = { type: string; properties?: { sessionID?: unknown } };
type NativeConfig = { mcp?: Record<string, unknown> };

const invalid = () => new DomainError('memory_lifecycle_invalid', '请为 OpenCode 记忆桥接提供明确的单聊天配置。');
const unavailable = () => new DomainError('memory_lifecycle_unavailable', '宿主记忆恢复尚未完成，请修复连接后重试。');

function validate(value: unknown): asserts value is MemoryOpencodeLifecycleConfig {
  if (!value || typeof value !== 'object') throw invalid();
  const config = value as MemoryOpencodeLifecycleConfig;
  const keys = ['hostSessionId', 'memorySession', 'cwd', 'memberHome', 'cliPath', 'nodePath', 'auditFile'];
  if (Object.keys(value).some(key => !keys.includes(key)) ||
      ![config.hostSessionId, config.memorySession].every(item => typeof item === 'string' && /^[a-zA-Z0-9._:-]{1,160}$/u.test(item)) ||
      ![config.cwd, config.memberHome, config.cliPath, ...(config.nodePath !== undefined ? [config.nodePath] : []), ...(config.auditFile ? [config.auditFile] : [])].every(item =>
        typeof item === 'string' && path.isAbsolute(item) && item.length <= 4096 && !/\p{Cc}/u.test(item))) throw invalid();
}

function sameDirectory(first: unknown, second: string) {
  if (typeof first !== 'string' || !path.isAbsolute(first)) return false;
  try { return realpathSync.native(first) === realpathSync.native(second); } catch { return false; }
}

function resetThroughCli(config: MemoryOpencodeLifecycleConfig, reason: Reason) {
  const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']
    .filter(key => process.env[key]).map(key => [key, process.env[key]]));
  const output = execFileSync(config.nodePath ?? process.execPath, [config.cliPath, 'memory', 'context', 'reset', '--session', config.memorySession, '--reason', reason], {
    cwd: config.cwd, env: { ...env, AGENTCTL_HOME: config.memberHome }, timeout: 15000, encoding: 'utf8',
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32768,
  });
  if ((JSON.parse(output) as { ok?: unknown }).ok !== true) throw unavailable();
}

/** OpenCode 1.14.21 single-chat bridge. Native hook sessionID is authoritative;
 * model arguments never select the checkpoint. This does not multiplex MCP. */
export function createMemoryOpencodeLifecycle(input: MemoryOpencodeLifecycleConfig,
    reset?: (reason: Reason) => void) {
  validate(input);
  const config = { ...input };
  const resetAction = reset ?? ((reason: Reason) => resetThroughCli(config, reason));
  let configured = false;
  let started = false;
  let pendingCompaction = false;
  let skipCompletionEvent = false;
  let faulted = false;
  const audit = (reason: Reason, ok: boolean) => {
    if (config.auditFile) appendFileSync(config.auditFile, JSON.stringify({ kind: 'context-reset', reason, ok }) + '\n', { mode: 0o600 });
  };
  const advance = (reason: Reason) => {
    try { resetAction(reason); audit(reason, true); }
    catch {
      faulted = true;
      try { audit(reason, false); } catch { /* Preserve the reset failure. */ }
      throw unavailable();
    }
  };
  const assertReady = () => {
    if (!configured || faulted || pendingCompaction) throw unavailable();
  };
  const start = () => {
    assertReady();
    if (!started) {
      // OpenCode has no dedicated resume plugin event. A new plugin process
      // conservatively resets on its first trusted use of the bound session.
      advance('resume');
      started = true;
    }
  };
  const completed = () => {
    if (!configured || faulted) throw unavailable();
    advance('compaction');
    pendingCompaction = false;
  };
  return {
    configure(native: NativeConfig) {
      const server = native.mcp?.tsp_memory;
      const value = server && typeof server === 'object' ? server as Record<string, unknown> : undefined;
      const environment = value?.environment && typeof value.environment === 'object'
        ? value.environment as Record<string, unknown> : undefined;
      if (value?.type !== 'local' || environment?.TSP_MEMORY_SESSION !== config.memorySession ||
          !sameDirectory(environment?.AGENTCTL_HOME, config.memberHome)) {
        faulted = true;
        throw new DomainError('memory_session_mismatch', 'OpenCode 的记忆连接与宿主聊天配置不匹配。');
      }
      configured = true;
    },
    message({ sessionID }: HostInput) {
      if (sessionID === config.hostSessionId) start();
    },
    compacting({ sessionID }: HostInput) {
      if (sessionID !== config.hostSessionId) return;
      start();
      pendingCompaction = true;
      skipCompletionEvent = false;
    },
    autoContinue({ sessionID }: HostInput) {
      if (sessionID !== config.hostSessionId) return;
      completed();
      // In 1.14.21 the success bus event follows the awaited auto hook.
      skipCompletionEvent = true;
    },
    event({ event }: { event: NativeEvent }) {
      if (event.type !== 'session.compacted' || event.properties?.sessionID !== config.hostSessionId) return;
      if (skipCompletionEvent) { skipCompletionEvent = false; return; }
      // OpenCode fire-and-forgets bus plugin promises. Remember failures and
      // stop subsequent memory tools instead of rejecting an unobserved promise.
      try { completed(); } catch { /* faulted remains authoritative. */ }
    },
    beforeTool({ sessionID, tool }: ToolInput) {
      if (!tool.startsWith('tsp_memory_')) return;
      if (sessionID !== config.hostSessionId) {
        throw new DomainError('memory_session_mismatch', '此记忆连接仅绑定一个宿主聊天，请为当前聊天创建独立连接。');
      }
      start();
    },
  };
}

/** OpenCode v1 plugin module: a default object prevents helper exports from
 * being treated as legacy plugins. No model tool or credentials are added. */
export default {
  id: 'team-synergy-memory-lifecycle',
  async server(input: { directory: string }, options?: unknown) {
    validate(options);
    if (!sameDirectory(input.directory, options.cwd)) {
      throw new DomainError('memory_workspace_mismatch', 'OpenCode 工作区与记忆连接的工作区不一致。');
    }
    const lifecycle = createMemoryOpencodeLifecycle(options);
    return {
      config: async (config: NativeConfig) => lifecycle.configure(config),
      'chat.message': async (value: HostInput, _output: unknown) => lifecycle.message(value),
      'experimental.session.compacting': async (value: HostInput, _output: unknown) => lifecycle.compacting(value),
      'experimental.compaction.autocontinue': async (value: HostInput, _output: unknown) => lifecycle.autoContinue(value),
      event: async (value: { event: NativeEvent }) => lifecycle.event(value),
      'tool.execute.before': async (value: ToolInput, _output: unknown) => lifecycle.beforeTool(value),
    };
  },
};
