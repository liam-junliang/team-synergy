import { createHash } from 'node:crypto';
import { appendFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { DomainError } from '@team-synergy/domain';
import { createNativeCaptureBridge, nativeCaptureEventId } from './memory-native-capture.js';

export interface MemoryDshCaptureConfig {
  harness: 'dsh';
  hostSessionId: string;
  memorySession: string;
  cwd: string;
  memberHome: string;
  cliPath: string;
  nodePath: string;
  owner: string;
  auditFile?: string;
}
type Session = { id: unknown; header?: { id?: unknown; cwd?: unknown; origin?: unknown; delegationDepth?: unknown } };
type Event = { type: unknown; seq?: unknown; data?: unknown };
export type DshOperatorCapture = { eventId: string; sourceText: string; nativeMessageId: string; nativeSeq: number };
interface Bridge {
  enqueue(event: DshOperatorCapture, ready?: boolean): Promise<unknown>;
  kick(): void;
}
interface DshContext {
  on(event: 'session/event', listener: (session: Session, event: Event) => void): unknown;
  on(event: 'session/flush', listener: (session: Session) => Promise<void>): unknown;
  on(event: 'agent/created', listener: (payload: { agent: { session: Session } }) => void): unknown;
  on(event: 'agent/status', listener: (payload: { agent: { session: Session }; status: string }) => void): unknown;
  on(event: 'dispose', listener: () => Promise<void>): unknown;
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const unavailable = () => new DomainError('memory_native_capture_unavailable', '本机会话采集尚未持久入队，请检查记忆连接状态。');

function validate(config: MemoryDshCaptureConfig) {
  const keys = ['harness', 'hostSessionId', 'memorySession', 'cwd', 'memberHome', 'cliPath', 'nodePath', 'owner', 'auditFile'];
  if (!config || Object.keys(config).some(key => !keys.includes(key)) || config.harness !== 'dsh' ||
      ![config.hostSessionId, config.memorySession].every(value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/u.test(value)) ||
      typeof config.owner !== 'string' || !/^[a-f0-9]{64}$/u.test(config.owner) ||
      ![config.cwd, config.memberHome, config.cliPath, config.nodePath, ...(config.auditFile ? [config.auditFile] : [])].every(value =>
        typeof value === 'string' && path.isAbsolute(value) && value.length <= 4096 && !/\p{Cc}/u.test(value))) {
    throw new DomainError('memory_native_capture_invalid', '请提供单会话的项目、账号归属与明确的 Node 可执行路径。');
  }
}

function authorizedSession(config: MemoryDshCaptureConfig, session: Session) {
  if (session.id !== config.hostSessionId || session.header?.origin === 'subagent' ||
      typeof session.header?.delegationDepth === 'number' && session.header.delegationDepth > 0) return false;
  try {
    if (session.header?.id !== session.id || typeof session.header.cwd !== 'string' ||
        realpathSync.native(session.header.cwd) !== realpathSync.native(config.cwd)) throw unavailable();
  } catch { throw new DomainError('memory_native_session_mismatch', '原生会话身份或工作目录与授权配置不一致。'); }
  return true;
}

/** Only a committed native operator message is capture material. User-role
 * injected recall, goals, skills, tool output and compaction are not operators. */
export function dshOperatorCapture(config: MemoryDshCaptureConfig, session: Session, event: Event): DshOperatorCapture | undefined {
  if (!authorizedSession(config, session) || event.type !== 'user/message' || !record(event.data)) return;
  const data = event.data;
  if (data.role !== 'user' || !record(data.source) || data.source.kind !== 'user') return;
  if (typeof data.id !== 'string' || !data.id || data.id.length > 160 || /\p{Cc}/u.test(data.id) ||
      !Number.isSafeInteger(event.seq) || Number(event.seq) < 0) {
    throw new DomainError('memory_native_event_invalid', '原生用户事件缺少稳定消息身份或序列。');
  }
  if (!Array.isArray(data.content) || data.content.length === 0 || data.content.some(block =>
      !record(block) || block.type !== 'text' || typeof block.text !== 'string')) {
    throw new DomainError('memory_native_content_unsupported', '会话采集暂仅支持纯文本用户事件，不会截取附件消息的部分内容。');
  }
  const sourceText = data.content.map(block => (block as { text: string }).text).join('\n');
  if (!sourceText.trim()) return;
  if (sourceText.length > 4000) throw new DomainError('memory_native_content_unsupported', '单条会话采集最多支持4000字符，不会静默截断原文。');
  return { eventId: nativeCaptureEventId('dsh', config.hostSessionId, data.id), sourceText, nativeMessageId: data.id, nativeSeq: Number(event.seq) };
}

/** Native DSH 0.2.1-rc.2 observer. The post-commit listener does not await
 * network work. Its durability checkpoint waits only for local enqueue. */
export function createMemoryDshCapture(input: MemoryDshCaptureConfig, injectedBridge?: Bridge) {
  validate(input);
  const config = { ...input }, bridge = injectedBridge ?? createNativeCaptureBridge(config);
  const pending = new Set<Promise<void>>();
  let fault: DomainError | undefined;
  const audit = (entry: Record<string, unknown>) => {
    if (config.auditFile) appendFileSync(config.auditFile, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', { mode: 0o600 });
  };
  const rememberFailure = (error: unknown) => {
    fault = error instanceof DomainError ? error : unavailable();
    try { audit({ kind: 'native-capture-error', code: fault.code }); } catch { /* Keep the original failure authoritative. */ }
  };
  const flush = async () => {
    while (pending.size) await Promise.all([...pending]);
    if (fault) throw fault;
    bridge.kick();
  };
  return {
    event(session: Session, event: Event) {
      try {
        if (fault) return;
        if (event.type === 'working-directory/change' && authorizedSession(config, session)) {
          if (!record(event.data) || typeof event.data.cwd !== 'string' ||
              realpathSync.native(event.data.cwd) !== realpathSync.native(config.cwd)) {
            throw new DomainError('memory_native_session_mismatch', '宿主工作目录已变化，请重新核对项目归属后连接采集。');
          }
          return;
        }
        const captured = dshOperatorCapture(config, session, event);
        if (!captured) return;
        const work = bridge.enqueue(captured, true).then(ack => {
          if (!record(ack) || ack.durable !== true || ack.eventId !== captured.eventId ||
              !['ready', 'sending', 'accepted'].includes(String(ack.state))) {
            throw new DomainError('memory_native_ack_invalid', '本地采集尚未获得匹配的持久入队回执。');
          }
          audit({ kind: 'native-capture-durable', eventId: captured.eventId, nativeSeq: captured.nativeSeq,
            messageIdHash: hash(captured.nativeMessageId), sourceHash: hash(captured.sourceText) });
        }).catch(rememberFailure).finally(() => pending.delete(work));
        pending.add(work);
      } catch (error) { rememberFailure(error); }
    },
    async flush(session: Session) {
      if (!authorizedSession(config, session)) return;
      await flush();
    },
    created(session: Session) {
      if (fault) return;
      try { if (authorizedSession(config, session)) bridge.kick(); } catch (error) { rememberFailure(error); }
    },
    idle(session: Session) {
      if (fault) return;
      try { if (authorizedSession(config, session)) void flush().catch(rememberFailure); } catch (error) { rememberFailure(error); }
    },
    dispose: flush,
  };
}

/** A Cordis profile insert row; it contains paths and an owner hash, no token. */
export function dshCapturePluginEntry(config: MemoryDshCaptureConfig) {
  validate(config);
  return { id: 'tsp-memory-dsh-capture', name: import.meta.url, config: { ...config } };
}

export const name = 'tsp-memory-dsh-capture';
export const inject = ['agents', 'sessions'];
export function mountMemoryDshCapture(ctx: DshContext, capture: ReturnType<typeof createMemoryDshCapture>) {
  ctx.on('session/event', (session, event) => capture.event(session, event));
  ctx.on('session/flush', session => capture.flush(session));
  ctx.on('agent/created', ({ agent }) => capture.created(agent.session));
  ctx.on('agent/status', ({ agent, status }) => { if (status === 'idle') capture.idle(agent.session); });
  ctx.on('dispose', () => capture.dispose());
}
export function apply(ctx: DshContext, config: MemoryDshCaptureConfig) {
  mountMemoryDshCapture(ctx, createMemoryDshCapture(config));
}
