// Native DSH capture contracts and opt-in real SDK helper. No database/profile
// is read and no model/network work runs from --check or module import.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createMemoryDshCapture, dshCapturePluginEntry, mountMemoryDshCapture } from '../../cli/dist/memory-dsh-capture.js';
import { createNativeCaptureBridge } from '../../cli/dist/memory-native-capture.js';
import { dshLifecyclePluginEntry } from '../../cli/dist/memory-dsh-lifecycle.js';
import { createDshEvalPatch } from './native-memory-dsh.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const installedDsh = () => process.env.TSP_PROBE_DSH_BIN ?? path.join(process.env.APPDATA ?? '', 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js');
async function installation() {
  const bin = installedDsh(); assert.ok(path.isAbsolute(bin));
  const manifest = JSON.parse(await readFile(path.resolve(path.dirname(bin), '../package.json'), 'utf8'));
  assert.equal(manifest.name, '@deepseek-ai/dsh'); assert.equal(manifest.version, '0.2.1-rc.2');
  const require = createRequire(bin);
  const module = async name => import(pathToFileURL(require.resolve(name)).href);
  return { bin, version: manifest.version, module };
}

/** This proves installed Session commit/flush semantics, not Agent reasoning or
 * SQLite/HTTP durability. The in-memory bridge is explicitly an adapter test. */
export async function checkNativeDshCaptureContract() {
  const installed = await installation();
  const { Context } = await installed.module('@deepseek-ai/cordis');
  const { SessionStore } = await installed.module('@deepseek-ai/dsh-session');
  const { createUserMessage } = await installed.module('@deepseek-ai/dsh-llm');
  const config = { harness: 'dsh', hostSessionId: 'native-session-contract', memorySession: 'native-memory-contract',
    cwd: process.cwd(), memberHome: process.cwd(), cliPath: fileURLToPath(new URL('../../cli/dist/index.js', import.meta.url)),
    nodePath: process.execPath, owner: 'a'.repeat(64) };
  let release, pending = true, kicks = 0; const gate = new Promise(resolve => { release = resolve; });
  const captured = [];
  const collector = createMemoryDshCapture(config, { enqueue: async (event, ready) => {
    captured.push({ ...event, ready }); await gate; return { eventId: event.eventId, durable: true, state: 'ready' };
  }, kick: () => { kicks++; } });
  const ctx = new Context(); new SessionStore(ctx); mountMemoryDshCapture(ctx, collector);
  const session = ctx.sessions.prepare(config.hostSessionId, { meta: { cwd: config.cwd } });
  const detach = ctx.sessions.enter(session); ctx.sessions.announce(session);
  const actual = session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '原生用户偏好声明' }] }), { surfaceOp: 'append' });
  assert.equal(captured.length, 1); assert.equal(actual.data.id, captured[0].nativeMessageId);
  assert.equal(session.snapshotEvents()[0].data.id, actual.data.id, 'observer sees a committed log event');
  const flushing = ctx.sessions.flush(session).then(() => { pending = false; });
  await Promise.resolve(); assert.equal(pending, true); release(); await flushing;
  session.append('user/message', createUserMessage({ source: { kind: 'fixture-injected-context' }, content: [{ type: 'text', text: '不是操作者' }] }), { surfaceOp: 'append' });
  await ctx.sessions.flush(session); assert.equal(captured.length, 1);
  const seed = session.snapshotEvents(); detach();
  const resumedCtx = new Context(); new SessionStore(resumedCtx);
  const resumedCollector = createMemoryDshCapture(config, { enqueue: async event => { captured.push(event); return { eventId: event.eventId, durable: true, state: 'ready' }; }, kick: () => { kicks++; } });
  mountMemoryDshCapture(resumedCtx, resumedCollector);
  const resumed = resumedCtx.sessions.prepare(config.hostSessionId, { seed, meta: { cwd: config.cwd } });
  const detachResumed = resumedCtx.sessions.enter(resumed); resumedCtx.sessions.announce(resumed);
  resumedCollector.created(resumed); await resumedCtx.sessions.flush(resumed); assert.equal(captured.length, 1, 'native restore must not republish seed into capture');
  resumed.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '恢复后的新发言' }] }), { surfaceOp: 'append' });
  await resumedCtx.sessions.flush(resumed); assert.equal(captured.length, 2); assert.notEqual(captured[0].eventId, captured[1].eventId);
  detachResumed();
  return { mode: 'installed-native-session-contract', dshVersion: installed.version, controllerNode: process.version,
    modelCalls: 0, networkCalls: 0, databasesOpened: 0, runtimeProfilesRead: 0,
    bridge: 'explicit in-memory adapter test; does not establish SQLite/HTTP durability',
    postCommitEvent: true, nativeFlushAwaitsLocalAck: true, injectedUserRoleExcluded: true, restoredSeedNotRecaptured: true,
    capturedNewNativeMessages: captured.length, kicks };
}

/** Real Agent helper: only SDK session/prompt carries the user text. The
 * production plugin itself enqueues native events; this helper never invokes
 * capture/enqueue/confirm/drain on behalf of a user turn. */
export async function withNativeCaptureDsh({ member, config, dir, system, maxTokens = 3072, turnTimeoutMs = 180000 }, work) {
  const installed = await installation();
  assert.equal(config.harness, 'dsh'); assert.equal(config.cwd, member.cwd); assert.equal(config.memberHome, member.home);
  assert.ok(path.isAbsolute(config.nodePath));
  assert.equal(process.env.TSP_EVAL_MODEL, 'workbuddy/deepseek-v4.1-flash');
  const gateway = new URL(process.env.TSP_EVAL_GATEWAY_URL ?? 'about:blank');
  assert.ok(gateway.protocol === 'http:' && gateway.hostname === '127.0.0.1' && gateway.port && /^\/v1\/?$/u.test(gateway.pathname));
  assert.ok(process.env.TSP_EVAL_GATEWAY_TOKEN);
  const parent = await realpath(dir), home = await mkdtemp(path.join(parent, 'native-dsh-'));
  const bridge = createNativeCaptureBridge(config), nativeEvents = [], generations = [];
  let active;
  const start = async resume => {
    const patch = JSON.parse(createDshEvalPatch(member, [config.cliPath, 'memory', 'mcp'], gateway, process.env.TSP_EVAL_MODEL, system, false, maxTokens));
    const memory = patch.flatMap(row => row.insert ?? []).find(row => row.id === 'tsp-memory');
    memory.config.command = config.nodePath; memory.config.env.TSP_MEMORY_SESSION = config.memorySession;
    patch.push({ insert: [dshCapturePluginEntry(config), dshLifecyclePluginEntry({ hostSessionId: config.hostSessionId,
      memorySession: config.memorySession, cwd: config.cwd, memberHome: config.memberHome, cliPath: config.cliPath,
      nodePath: config.nodePath, ...(config.auditFile ? { auditFile: config.auditFile } : {}) }),
    { id: 'session-checkpoints', name: '@deepseek-ai/dsh-session-checkpoint-policy' }] });
    const overlay = path.join(home, 'patch.json'); await writeFile(overlay, JSON.stringify(patch), { mode: 0o600 });
    const env = { DSH_HOME: home, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, TEMP: home, TMP: home,
      DSH_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1', DSH_PRIMARY_RUNTIME: '', DSH_SYSTEM_PROMPT: system,
      DEEPSEEK_BASE_URL: gateway.origin, DEEPSEEK_API_KEY: process.env.TSP_EVAL_GATEWAY_TOKEN, NO_PROXY: '127.0.0.1,localhost' };
    for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT']) if (process.env[key]) env[key] = process.env[key];
    const proc = spawn(config.nodePath, [installed.bin, '--profile', 'sdk-minimal', '--patch', overlay], { cwd: member.cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const done = once(proc, 'close'); proc.stderr.resume();
    const reader = createInterface({ input: proc.stdout }), lines = reader[Symbol.asyncIterator](); let seq = 0;
    const send = (method, params) => { const id = ++seq; proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); return id; };
    const next = async () => {
      for (;;) {
        const line = await lines.next(); if (line.done) throw Error('native_dsh_exited');
        if (/^Client\.list(?:Resources|ResourceTemplates)\(\) called but server does not advertise resources capability - returning empty list$/u.test(line.value)) continue;
        const frame = JSON.parse(line.value); if (frame.error) throw Error('native_dsh_rpc_' + String(frame.error.code)); return frame;
      }
    };
    const waitRpc = async id => { for (;;) { const frame = await next(); if (frame.id === id) return frame.result; } };
    let timer = setTimeout(() => proc.kill(), turnTimeoutMs);
    const stop = async () => {
      clearTimeout(timer);
      if (proc.exitCode === null && proc.signalCode === null && !proc.stdin.destroyed) proc.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 999999, method: 'shutdown', params: {} }) + '\n');
      const reap = setTimeout(() => proc.kill(), 8000); try { await done; } finally { clearTimeout(reap); reader.close(); }
    };
    active = { stop };
    const init = await waitRpc(send('initialize', { cwd: member.cwd, provider: 'deepseek-official', model: process.env.TSP_EVAL_MODEL, maxTokens }));
    assert.equal(init.serverInfo?.name, 'deepseek-harness-sdk-runtime');
    if (resume) await waitRpc(send('session/resume', { sessionId: config.hostSessionId }));
    clearTimeout(timer); generations.push({ resumed: resume, dshVersion: installed.version });
    return { stop, async turn(prompt) {
      timer = setTimeout(() => proc.kill(), turnTimeoutMs); const id = send('session/prompt', { sessionId: config.hostSessionId, contentBlocks: [{ type: 'text', text: prompt }] });
      const calls = [], userEvents = []; let answer = '', messageId;
      try {
        for (;;) {
          const frame = await next(); if (frame.id === id) messageId = frame.result?.messageId;
          if (frame.method !== 'session.event' || frame.params?.sessionId !== config.hostSessionId) continue;
          const event = frame.params.event, data = event.data;
          if (event.type === 'user/message' && data.role === 'user' && data.source?.kind === 'user') {
            const text = data.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
            const observed = { nativeMessageId: data.id, nativeSeq: event.seq, sourceKind: data.source.kind, textHash: hash(text) };
            userEvents.push(observed); nativeEvents.push(observed);
          } else if (event.type === 'tool/call') { calls.push(data.name); assert.ok(calls.length <= 16); }
          else if (event.type === 'assistant/message') answer = (data.message?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('');
          else if (event.type === 'turn/end') {
            assert.equal(data.reason?.kind, 'completed'); assert.ok(messageId && userEvents.some(event => event.nativeMessageId === messageId && event.textHash === hash(prompt)));
            return { answer, calls, messageId, nativeUserEvents: userEvents };
          }
        }
      } finally { clearTimeout(timer); }
    } };
  };
  try {
    let runtime = await start(false);
    return await work({ sessionId: config.hostSessionId, version: installed.version, nativeEvents, generations,
      turn: prompt => runtime.turn(prompt), status: () => bridge.status(),
      async restart() { await runtime.stop(); runtime = await start(true); } });
  } finally {
    if (active) await active.stop();
    const owned = await realpath(home); assert.equal(path.dirname(owned), parent); assert.match(path.basename(owned), /^native-dsh-[A-Za-z0-9]+$/u);
    await rm(owned, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv[2], '--check', 'Use --check without services; a live caller must provide an isolated fixture explicitly.');
  console.log(JSON.stringify(await checkNativeDshCaptureContract()));
}
