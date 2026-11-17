import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { DomainError } from '@team-synergy/domain';

export interface MemoryDshLifecycleConfig {
  hostSessionId: string;
  memorySession: string;
  cwd: string;
  memberHome: string;
  cliPath: string;
  nodePath?: string;
  auditFile?: string;
}

type Reason = 'compaction' | 'resume';
type NativeSession = { id: unknown };
type NativeEvent = { type: string; seq?: number; data: Record<string, unknown> };
type Created = { agent: { session: NativeSession }; source: string };
interface DshContext {
  on(event: 'agent/created', listener: (payload: Created) => void): unknown;
  on(event: 'session/event', listener: (session: NativeSession, event: NativeEvent) => void): unknown;
  on(event: 'agent/pre-step', listener: (payload: { agent: { session: NativeSession } }, next: () => unknown) => unknown): unknown;
}

function validate(config: MemoryDshLifecycleConfig) {
  const keys = ['hostSessionId', 'memorySession', 'cwd', 'memberHome', 'cliPath', 'nodePath', 'auditFile'];
  if (!config || Object.keys(config).some(key => !keys.includes(key)) ||
      ![config.hostSessionId, config.memorySession].every(value => typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,160}$/u.test(value)) ||
      ![config.cwd, config.memberHome, config.cliPath, ...(config.nodePath === undefined ? [] : [config.nodePath]), ...(config.auditFile ? [config.auditFile] : [])].every(value =>
        typeof value === 'string' && path.isAbsolute(value) && value.length <= 4096 && !/\p{Cc}/u.test(value))) {
    throw new DomainError('memory_lifecycle_invalid', '请为记忆生命周期适配器提供明确的宿主会话和本机绝对路径。');
  }
}

function resetThroughCli(config: MemoryDshLifecycleConfig, reason: Reason) {
  // Existing Node-hosted profiles remain compatible. A Bun host must provide
  // an explicit Node executable rather than passing Bun to the SQLite CLI.
  const node = config.nodePath ?? (process.versions.node && !process.versions.bun ? process.execPath : undefined);
  if (!node) throw new DomainError('memory_node_path_required', '请为宿主配置独立 Node 可执行路径。');
  const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']
    .filter(key => process.env[key]).map(key => [key, process.env[key]]));
  const output = execFileSync(node, [config.cliPath, 'memory', 'context', 'reset', '--session', config.memorySession, '--reason', reason], {
    cwd: config.cwd, env: { ...env, AGENTCTL_HOME: config.memberHome }, timeout: 15000, encoding: 'utf8',
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32768,
  });
  if ((JSON.parse(output) as { ok?: unknown }).ok !== true) throw new Error('memory_reset_rejected');
}

/** Trusted lifecycle ingress, separate from all model-callable memory tools.
 * The reset callback is injectable for adapter tests; production apply always
 * executes the fixed CLI command with the configured member identity. */
export function createMemoryDshLifecycle(input: MemoryDshLifecycleConfig,
    reset?: (reason: Reason) => void) {
  validate(input);
  const config = { ...input };
  const resetAction = reset ?? ((reason: Reason) => resetThroughCli(config, reason));
  const summaries = new Set<string>();
  let lastPrune: number | undefined;
  let faulted = false;
  const audit = (value: Record<string, unknown>) => {
    if (config.auditFile) appendFileSync(config.auditFile, JSON.stringify(value) + '\n', { mode: 0o600 });
  };
  const advance = (reason: Reason) => {
    try {
      resetAction(reason);
      audit({ kind: 'context-reset', reason, ok: true });
    } catch {
      faulted = true;
      try { audit({ kind: 'context-reset', reason, ok: false }); } catch { /* Keep the reset failure authoritative. */ }
      throw new DomainError('memory_lifecycle_unavailable', '记忆上下文重置失败，请修复宿主连接后继续。');
    }
  };
  return {
    created({ agent, source }: Created) {
      if (String(agent.session.id) !== config.hostSessionId) return;
      if (source === 'resume') {
        summaries.clear();
        advance('resume');
      }
    },
    event(session: NativeSession, event: NativeEvent) {
      if (String(session.id) !== config.hostSessionId) return;
      const data = event.data;
      if (event.type === 'compaction/summary' && typeof data.compactionId === 'string') {
        // Native DSH serializes compaction. Keep a finite defensive horizon.
        if (summaries.size >= 64) { advance('compaction'); summaries.clear(); }
        summaries.add(data.compactionId);
      } else if (event.type === 'compaction/end' && typeof data.compactionId === 'string' && summaries.delete(data.compactionId)) {
        // Even an error after a durable summary can leave a replaced surface.
        // A conservative reset is safe; retaining the old receipt is not.
        advance('compaction');
      } else if (event.type === 'compaction/prune' && (event.seq === undefined || event.seq !== lastPrune)) {
        lastPrune = event.seq;
        advance('compaction');
      }
    },
    beforeStep(session: NativeSession = { id: config.hostSessionId }) {
      if (String(session.id) !== config.hostSessionId) return;
      if (faulted) throw new DomainError('memory_lifecycle_unavailable', '宿主记忆恢复尚未完成。');
    },
  };
}

export const name = 'tsp-memory-dsh-lifecycle';
export const inject = ['agents'];

export function dshLifecyclePluginEntry(config: MemoryDshLifecycleConfig) {
  validate(config);
  return { id: 'tsp-memory-dsh-lifecycle', name: import.meta.url, config: { ...config } };
}

/** Mount this module in a member-owned DSH Cordis profile. It adds no tool. */
export function apply(ctx: DshContext, config: MemoryDshLifecycleConfig) {
  const lifecycle = createMemoryDshLifecycle(config);
  ctx.on('agent/created', payload => lifecycle.created(payload));
  ctx.on('session/event', (session, event) => lifecycle.event(session, event));
  ctx.on('agent/pre-step', (payload, next) => { lifecycle.beforeStep(payload.agent.session); return next(); });
}
