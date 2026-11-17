import { DomainError } from '@team-synergy/domain';
import { appendFileSync, realpathSync } from 'node:fs';
import { createMemoryOpencodeLifecycle, type MemoryOpencodeLifecycleConfig } from './memory-opencode-lifecycle.js';
import { createNativeCaptureBridge, nativeCaptureEventId } from './memory-native-capture.js';
import { authDirectory } from './auth-store.js';
import { harnessRuntimeVersion, installedSessionConfig, readHarnessInstallation, sameHarnessWorkspace } from './memory-harness-install.js';

export type OpencodeUserCapture = { nativeSessionId: string; nativeEventId: string; sourceText: string };
export type OpencodeMessageInput = { sessionID?: unknown; messageID?: unknown };
export type OpencodeMessageOutput = { message?: unknown; parts?: unknown };
export type OpencodeCaptureConfig = MemoryOpencodeLifecycleConfig & { harness: 'opencode'; owner: string; nodePath: string };
type PendingCapture = { eventId: string; sourceText: string; nativeMessageId: string; nativeSeq?: number; cursor?: number };
type CapturePort = {
  enqueue(value: PendingCapture, ready: boolean): Promise<unknown>;
  pending(query?: { nativeMessageId?: string; after?: number }): Promise<PendingCapture[]>;
  confirm(value: { eventId: string; sourceText: string }): Promise<unknown>;
  kick(): void;
};
type NativeRead = (messageID: string) => Promise<{ info?: unknown; parts?: unknown }>;
type NativeSessionRead = () => Promise<{ id?: unknown; directory?: unknown; parentID?: unknown }>;
type NativeEvent = { event: { type: string; properties?: { sessionID?: unknown; status?: { type?: unknown } } } };

const nativeId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/u.test(value);
const invalid = () => new DomainError('memory_native_source_invalid', 'OpenCode 用户消息的原生来源标识不一致。');

/** Pinned to OpenCode v1.14.21 chat.message: the host supplies a complete
 * UserMessage plus assigned parts before its first model request. Generated
 * continuation/compaction messages do not pass through this hook. */
export function opencodeUserCapture(input: OpencodeMessageInput, output: OpencodeMessageOutput): OpencodeUserCapture | null {
  const message = output.message && typeof output.message === 'object' ? output.message as Record<string, unknown> : undefined;
  if (!message || message.role !== 'user') return null;
  if (!nativeId(input.sessionID) || !nativeId(message.id) || message.sessionID !== input.sessionID ||
      (input.messageID !== undefined && input.messageID !== message.id) || !Array.isArray(output.parts)) throw invalid();
  const text: string[] = [];
  for (const part of output.parts) {
    if (!part || typeof part !== 'object') throw invalid();
    if (part.type !== 'text') continue;
    if (part.synthetic === true || part.ignored === true) continue;
    if (part.synthetic !== undefined && part.synthetic !== false || part.ignored !== undefined && part.ignored !== false ||
        !nativeId(part.id) || part.sessionID !== input.sessionID || part.messageID !== message.id || typeof part.text !== 'string') throw invalid();
    if (part.text.trim()) text.push(part.text);
  }
  if (!text.length) return null;
  const sourceText = text.join('\n');
  if (sourceText.length > 4000) throw new DomainError('memory_native_source_unsupported', 'OpenCode 当前发言超过自动记忆采集的长度限制。');
  return { nativeSessionId: input.sessionID, nativeEventId: message.id, sourceText };
}

/** Only local staging is awaited in chat.message. Confirmation happens at the
 * post-persistence chat.params hook or via a recovery read of the native store. */
export function createMemoryOpencodeCapture(options: OpencodeCaptureConfig, bridge: CapturePort, readMessage: NativeRead,
    readSession: NativeSessionRead) {
  const config = { ...options };
  let configured = false;
  let authorized: Promise<void> | undefined;
  const verifying = new Map<string, Promise<void>>();
  const audit = (kind: string, code?: string, eventId?: string) => {
    if (!config.auditFile) return;
    try { appendFileSync(config.auditFile, JSON.stringify({ at: new Date().toISOString(), kind, harness: 'opencode', ...(code ? { code } : {}), ...(eventId ? { eventId } : {}) }) + '\n', { mode: 0o600 }); }
    catch { /* Capture storage remains authoritative; never log private text. */ }
  };
  const failure = (error: unknown, eventId?: string) => {
    const code = error instanceof DomainError ? error.code : 'memory_native_source_unavailable';
    audit('native-capture-error', code, eventId);
  };
  const authorize = () => {
    if (!authorized) authorized = (async () => {
      const session = await readSession();
      try {
        if (session.id !== config.hostSessionId || session.parentID !== undefined || typeof session.directory !== 'string' ||
            realpathSync.native(session.directory) !== realpathSync.native(config.cwd)) {
          throw new Error();
        }
      } catch {
        throw new DomainError('memory_native_session_mismatch', '原生 OpenCode 会话不属于已授权的工作区或属于子会话。');
      }
    })().catch(error => { authorized = undefined; throw error; });
    return authorized;
  };
  const verify = async (pending: PendingCapture) => {
    const existing = verifying.get(pending.eventId);
    if (existing) return existing;
    const task = (async () => {
      try {
        await authorize();
        const stored = await readMessage(pending.nativeMessageId);
        const captured = opencodeUserCapture({ sessionID: config.hostSessionId, messageID: pending.nativeMessageId }, {
          message: stored.info, parts: stored.parts,
        });
        if (!captured || captured.sourceText !== pending.sourceText ||
            pending.eventId !== nativeCaptureEventId('opencode', config.hostSessionId, captured.nativeEventId)) {
          throw new DomainError('memory_native_source_changed', '已保存的 OpenCode 用户发言与暂存原文不一致，未上传。');
        }
        await bridge.confirm({ eventId: pending.eventId, sourceText: captured.sourceText });
        audit('native-source-verified', undefined, pending.eventId);
        bridge.kick();
      } catch (error) { failure(error, pending.eventId); }
    })();
    verifying.set(pending.eventId, task);
    try { await task; } finally { verifying.delete(pending.eventId); }
  };
  const replay = async (messageID?: string) => {
    if (!configured) return;
    try {
      let after;
      for (let page = 0; page < 20; page++) {
        const pending = await bridge.pending(messageID === undefined ? (after === undefined ? {} : { after }) : { nativeMessageId: messageID });
        for (const item of pending) {
          if (messageID === undefined || item.nativeMessageId === messageID) await verify(item);
        }
        if (messageID !== undefined || pending.length < 100) break;
        const cursor = pending.at(-1)?.cursor;
        // Older injected adapters have no cursor; production returns a pinned
        // rowid so bad staged candidates cannot hide later valid operators.
        if (!Number.isSafeInteger(cursor) || cursor === undefined || cursor <= (after ?? 0)) break;
        after = cursor;
        if (page === 19) audit('native-capture-recovery-pending', 'memory_native_recovery_pending');
      }
      bridge.kick();
    } catch (error) { failure(error); }
  };
  const schedule = () => {
    const timer = setTimeout(() => { void replay(); }, 0);
    timer.unref();
  };
  return {
    start() { configured = true; schedule(); },
    async message(input: OpencodeMessageInput, output: OpencodeMessageOutput) {
      if (!configured || input.sessionID !== config.hostSessionId) return;
      try {
        const captured = opencodeUserCapture(input, output);
        if (!captured) return;
        await authorize();
        await bridge.enqueue({ eventId: nativeCaptureEventId('opencode', captured.nativeSessionId, captured.nativeEventId),
          nativeMessageId: captured.nativeEventId, sourceText: captured.sourceText }, false);
      } catch (error) {
        failure(error);
        // No local durable candidate exists when staging fails. Make this
        // visible to the host instead of silently losing the operator turn.
        throw new DomainError('memory_native_capture_unavailable', '本地原生会话采集尚未持久确认，请检查连接后重试。');
      }
    },
    async beforeModel(input: { sessionID?: unknown; message?: unknown }) {
      if (!configured || input.sessionID !== config.hostSessionId) return;
      const message = input.message && typeof input.message === 'object' ? input.message as Record<string, unknown> : undefined;
      if (message?.role !== 'user' || message.sessionID !== config.hostSessionId || !nativeId(message.id)) return;
      await replay(message.id);
    },
    event(input: NativeEvent) {
      const event = input.event;
      if (!configured || event.properties?.sessionID !== config.hostSessionId) return;
      if (event.type === 'session.idle' || event.type === 'session.error' ||
          event.type === 'session.status' && event.properties.status?.type === 'idle') schedule();
    },
    replay,
  };
}

type PluginInput = {
  directory: string;
  client: { session: {
    message(options: { path: { id: string; messageID: string }; signal: AbortSignal }): Promise<{ data?: { info?: unknown; parts?: unknown } }>;
    get(options: { path: { id: string }; signal: AbortSignal }): Promise<{ data?: { id?: unknown; directory?: unknown; parentID?: unknown } }>;
  } };
};

/** Emits a local plugin module for explicit installation; no global/project
 * settings are modified and no credentials are embedded. */
export function opencodeNativePluginSource(config: OpencodeCaptureConfig) {
  createNativeCaptureBridge(config); // Validate the fixed, credential-free options without spawning.
  return `import plugin from ${JSON.stringify(import.meta.url)};\n` +
    `const options = Object.freeze(${JSON.stringify(config)});\n` +
    `export default { id: plugin.id, server: input => plugin.server(input, options) };\n`;
}

/** Persistent native SDK module; session IDs come from chat.message rather than install-time options. */
export function persistentOpencodePlugin(installationFile: string) {
  const registration = readHarnessInstallation(installationFile, 'opencode');
  return {
    id: 'team-synergy-memory-persistent-capture-' + registration.id,
    async server(input: PluginInput) {
      const registration = readHarnessInstallation(installationFile, 'opencode');
      harnessRuntimeVersion('opencode', registration.runtime);
      if (!sameHarnessWorkspace(input.directory, registration.workspace)) {
        // A global plugin may serve several workspaces; only explicit registrations collect.
        return {};
      }
      let configured = false;
      const captures = new Map<string, ReturnType<typeof createMemoryOpencodeCapture>>();
      const forSession = (sessionID: unknown) => {
        const current = readHarnessInstallation(installationFile, 'opencode');
        if (!sameHarnessWorkspace(authDirectory(), current.memberHome)) throw invalid();
        if (!nativeId(sessionID)) throw invalid();
        let capture = captures.get(sessionID);
        if (!capture) {
          const config = { ...installedSessionConfig(current, sessionID), harness: 'opencode' as const };
          capture = createMemoryOpencodeCapture(config, createNativeCaptureBridge(config), async messageID => {
            const response = await input.client.session.message({ path: { id: sessionID, messageID }, signal: AbortSignal.timeout(5000) });
            if (!response.data) throw invalid(); return response.data;
          }, async () => {
            const response = await input.client.session.get({ path: { id: sessionID }, signal: AbortSignal.timeout(5000) });
            if (!response.data) throw invalid(); return response.data;
          });
          capture.start(); captures.set(sessionID, capture);
        }
        return capture;
      };
      return {
        config: async () => { configured = true; },
        'chat.message': async (value: OpencodeMessageInput, output: OpencodeMessageOutput) => {
          if (configured && opencodeUserCapture(value, output)) await forSession(value.sessionID).message(value, output);
        },
        'chat.params': async (value: { sessionID?: unknown; message?: unknown }) => {
          if (configured) await captures.get(String(value.sessionID))?.beforeModel(value);
        },
        event: async (value: NativeEvent) => { if (configured) captures.get(String(value.event.properties?.sessionID))?.event(value); },
      };
    },
  };
}

/** Native v1.14.21 module. The explicitly installed options pin one authorized
 * host session, workspace, TSP owner and Node executable. No model tool writes. */
export default {
  id: 'team-synergy-memory-native-capture',
  async server(input: PluginInput, options?: unknown) {
    const config = options as OpencodeCaptureConfig;
    const bridge = createNativeCaptureBridge(config);
    if (realpathSync.native(input.directory) !== realpathSync.native(config.cwd)) {
      throw new DomainError('memory_workspace_mismatch', 'OpenCode 工作区与原生会话采集配置不一致。');
    }
    const lifecycle = createMemoryOpencodeLifecycle({ hostSessionId: config.hostSessionId, memorySession: config.memorySession,
      cwd: config.cwd, memberHome: config.memberHome, cliPath: config.cliPath, nodePath: config.nodePath,
      ...(config.auditFile ? { auditFile: config.auditFile } : {}) });
    const capture = createMemoryOpencodeCapture(config, bridge, async messageID => {
      const response = await input.client.session.message({ path: { id: config.hostSessionId, messageID }, signal: AbortSignal.timeout(5000) });
      if (!response.data) throw new DomainError('memory_native_source_unavailable', '无法从 OpenCode 读取已保存的用户发言。');
      return response.data;
    }, async () => {
      const response = await input.client.session.get({ path: { id: config.hostSessionId }, signal: AbortSignal.timeout(5000) });
      if (!response.data) throw new DomainError('memory_native_session_unavailable', '无法从 OpenCode 核对已授权会话。');
      return response.data;
    });
    return {
      config: async (native: Parameters<typeof lifecycle.configure>[0]) => { lifecycle.configure(native); capture.start(); },
      'chat.message': async (value: OpencodeMessageInput, output: OpencodeMessageOutput) => {
        lifecycle.message(value as { sessionID: string });
        await capture.message(value, output);
      },
      'chat.params': async (value: { sessionID?: unknown; message?: unknown }) => capture.beforeModel(value),
      'experimental.session.compacting': async (value: { sessionID: string }) => lifecycle.compacting(value),
      'experimental.compaction.autocontinue': async (value: { sessionID: string }) => lifecycle.autoContinue(value),
      event: async (value: NativeEvent) => { lifecycle.event(value); capture.event(value); },
      'tool.execute.before': async (value: { sessionID: string; tool: string; callID: string }) => lifecycle.beforeTool(value),
    };
  },
};
