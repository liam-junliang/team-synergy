import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMemoryOpencodeCapture as createNativeCapture, opencodeUserCapture } from '../dist/memory-opencode-capture.js';
import { nativeCaptureEventId } from '../dist/memory-native-capture.js';
import { DomainError } from '@team-synergy/domain';

const input = { sessionID: 'ses_native', messageID: 'msg_user' };
const part = (changes = {}) => ({ id: 'prt_user', sessionID: 'ses_native', messageID: 'msg_user', type: 'text', text: '我偏好先写验证结果。', ...changes });
const output = (changes = {}) => ({ message: { id: 'msg_user', sessionID: 'ses_native', role: 'user' }, parts: [part()], ...changes });

test('native chat.message supplies the exact original user text and stable host message identity', () => {
  assert.deepEqual(opencodeUserCapture(input, output()), {
    nativeSessionId: 'ses_native', nativeEventId: 'msg_user', sourceText: '我偏好先写验证结果。',
  });
  assert.deepEqual(opencodeUserCapture({ sessionID: 'ses_native' }, output()), opencodeUserCapture(input, output()));
  assert.equal(opencodeUserCapture(input, output({ parts: [part({ text: '  原始文本不修剪  ' })] })).sourceText, '  原始文本不修剪  ');
});

test('assistant, tool, system and synthetic/ignored continuation content never becomes user memory', () => {
  for (const role of ['assistant', 'tool', 'system']) assert.equal(opencodeUserCapture(input, output({ message: { role } })), null);
  for (const changes of [{ synthetic: true }, { ignored: true }, { type: 'tool' }, { type: 'reasoning' }, { type: 'file' }]) {
    assert.equal(opencodeUserCapture(input, output({ parts: [part(changes)] })), null);
  }
  assert.equal(opencodeUserCapture(input, output({ parts: [part(), part({ id: 'prt_file_text', synthetic: true, text: '工具读取的文件正文，不是用户原话' })] })).sourceText, part().text);
});

test('host session, message and part identities must all agree before staging any source', () => {
  for (const changes of [{ sessionID: 'ses_other' }, { messageID: 'msg_other' }, { id: '../part' }, { synthetic: 'false' }, { ignored: 0 }]) {
    assert.throws(() => opencodeUserCapture(input, output({ parts: [part(changes)] })), { code: 'memory_native_source_invalid' });
  }
  assert.throws(() => opencodeUserCapture({ ...input, messageID: 'msg_other' }, output()), { code: 'memory_native_source_invalid' });
  assert.throws(() => opencodeUserCapture(input, output({ message: { id: 'msg_user', sessionID: 'ses_other', role: 'user' } })), { code: 'memory_native_source_invalid' });
  assert.throws(() => opencodeUserCapture(input, output({ parts: 'not-parts' })), { code: 'memory_native_source_invalid' });
});

test('empty inputs are ignored and oversize original input is explicitly unsupported rather than truncated', () => {
  assert.equal(opencodeUserCapture(input, output({ parts: [part({ text: '  ' })] })), null);
  assert.throws(() => opencodeUserCapture(input, output({ parts: [part({ text: 'x'.repeat(4001) })] })), { code: 'memory_native_source_unsupported' });
});

const config = () => ({ harness: 'opencode', hostSessionId: 'ses_native', memorySession: 'member-memory',
  owner: 'f'.repeat(64), cwd: process.cwd(), memberHome: tmpdir(), cliPath: path.join(process.cwd(), 'dist/index.js'), nodePath: process.execPath });
function localPort() {
  const staged = new Map(), ready = new Map(), confirmations = [];
  let kicked = 0;
  return { staged, ready, confirmations, get kicked() { return kicked; },
    async enqueue(value, initialReady) { assert.equal(initialReady, false); staged.set(value.eventId, { ...value }); },
    async pending() { return [...staged.values()]; },
    async confirm(value) { assert.equal(staged.get(value.eventId)?.sourceText, value.sourceText); ready.set(value.eventId, staged.get(value.eventId)); staged.delete(value.eventId); confirmations.push(value); },
    kick() { kicked++; },
  };
}
const modelInput = () => ({ sessionID: input.sessionID, message: output().message });
const persisted = (changes = {}) => ({ info: output().message, parts: output().parts, ...changes });
function createMemoryOpencodeCapture(options, bridge, readMessage, readSession) {
  const session = { id: options.hostSessionId, directory: options.cwd };
  return createNativeCapture(options, bridge, readMessage, readSession ?? (async () => session));
}

test('chat.message only stages locally and the post-save native read confirms before asynchronous delivery', async () => {
  const port = localPort(), reads = [];
  const capture = createMemoryOpencodeCapture(config(), port, async id => { reads.push(id); return persisted(); });
  capture.start();
  await capture.message(input, output());
  const eventId = nativeCaptureEventId('opencode', input.sessionID, input.messageID);
  assert.equal(port.staged.get(eventId).sourceText, part().text);
  assert.deepEqual(reads, []);
  assert.equal(port.confirmations.length, 0);
  await capture.beforeModel(modelInput());
  assert.deepEqual(reads, ['msg_user']);
  assert.equal(port.staged.size, 0);
  assert.equal(port.ready.get(eventId).sourceText, part().text);
  assert.ok(port.kicked >= 1);
  await capture.beforeModel(modelInput());
  assert.equal(port.confirmations.length, 1);
});

test('failed host persistence and post-hook text mutation never authorize staged text for upload', async () => {
  for (const readMessage of [async () => { throw Error('not committed'); }, async () => persisted({ parts: [part({ text: '别的插件改写了用户原话' })] }),
    async () => persisted({ info: { id: 'msg_user', sessionID: 'ses_native', role: 'assistant' } })]) {
    const port = localPort(), capture = createMemoryOpencodeCapture(config(), port, readMessage);
    capture.start(); await capture.message(input, output()); await capture.beforeModel(modelInput());
    assert.equal(port.staged.size, 1);
    assert.equal(port.ready.size, 0);
    assert.equal(port.confirmations.length, 0);
  }
});

test('a fresh native plugin replays staged IDs through native storage and does not trust a model event', async () => {
  const port = localPort(), first = createMemoryOpencodeCapture(config(), port, async () => { throw Error('process stopped before persistence'); });
  first.start(); await first.message(input, output());
  const reads = [], restarted = createMemoryOpencodeCapture(config(), port, async id => { reads.push(id); return persisted(); });
  restarted.start(); await restarted.replay();
  assert.deepEqual(reads, ['msg_user']);
  assert.equal(port.ready.size, 1);
  assert.equal(port.confirmations.length, 1);
});

test('another chat cannot stage, confirm or redirect the fixed native session after options mutate', async () => {
  const options = config(), port = localPort(), capture = createMemoryOpencodeCapture(options, port, async () => persisted());
  capture.start(); options.hostSessionId = 'ses_other';
  await capture.message({ sessionID: 'ses_other' }, output());
  await capture.beforeModel({ sessionID: 'ses_other', message: output().message });
  assert.equal(port.staged.size, 0);
  await capture.message(input, output());
  assert.equal(port.staged.size, 1);
  await capture.beforeModel(modelInput());
  assert.equal(port.ready.size, 1);
});

test('capture errors stay staged and audit only safe metadata, without breaking the model hook', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tsp-opencode-capture-')), auditFile = path.join(directory, 'audit.jsonl');
  try {
    const port = localPort(), capture = createMemoryOpencodeCapture({ ...config(), auditFile }, port, async () => { throw Error('secret-private-message-must-not-log'); });
    capture.start(); await capture.message(input, output()); await capture.beforeModel(modelInput());
    const log = await readFile(auditFile, 'utf8');
    assert.match(log, /memory_native_source_unavailable/u);
    assert.doesNotMatch(log, /secret-private-message|我偏好/u);
    assert.equal(port.staged.size, 1);
  } finally {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.match(path.basename(directory), /^tsp-opencode-capture-[a-zA-Z0-9]+$/u);
    await rm(directory, { recursive: true, force: true });
  }
});

test('failed local staging is visible to the host instead of losing a completed user turn', async () => {
  for (const error of [new Error('disk-write-failed-with-private-details'),
    new DomainError('memory_binding_changed', 'old-private-account-details')]) {
    const port = localPort(); port.enqueue = async () => { throw error; };
    const capture = createMemoryOpencodeCapture(config(), port, async () => persisted());
    capture.start();
    await assert.rejects(capture.message(input, output()), failure => failure.code === 'memory_native_capture_unavailable' &&
      !failure.message.includes('private-details') && !failure.message.includes('old-private-account'));
    assert.equal(port.staged.size, 0); assert.equal(port.confirmations.length, 0);
  }
});

test('the native session directory and parent relationship authorize capture before any staging', async () => {
  for (const session of [
    { id: 'ses_native', directory: path.dirname(process.cwd()) },
    { id: 'ses_native', directory: process.cwd(), parentID: 'ses_parent' },
    { id: 'ses_other', directory: process.cwd() },
  ]) {
    const port = localPort(); let reads = 0;
    const capture = createMemoryOpencodeCapture(config(), port, async () => { reads++; return persisted(); }, async () => session);
    capture.start();
    await assert.rejects(capture.message(input, output()), { code: 'memory_native_capture_unavailable' });
    assert.equal(port.staged.size, 0); assert.equal(port.confirmations.length, 0); assert.equal(reads, 0);
  }
});

test('session metadata is loaded lazily per process and a restarted foreign session cannot replay staged data', async () => {
  const port = localPort(); let metadataReads = 0;
  const first = createMemoryOpencodeCapture(config(), port, async () => persisted(), async () => {
    metadataReads++; return { id: 'ses_native', directory: process.cwd() };
  });
  first.start(); assert.equal(metadataReads, 0, 'plugin startup must not await the native SDK during bootstrap');
  await first.message(input, output()); assert.equal(metadataReads, 1);
  const second = createMemoryOpencodeCapture(config(), port, async () => persisted(), async () => {
    metadataReads++; return { id: 'ses_native', directory: process.cwd(), parentID: 'ses_child_parent' };
  });
  second.start(); await second.replay();
  assert.ok(metadataReads >= 2); assert.equal(port.staged.size, 1); assert.equal(port.ready.size, 0);
});

test('one hundred unrecoverable candidates cannot hide a later current user message or later replay page', async () => {
  const port = localPort(), reads = [], queries = [];
  port.pending = async (query = {}) => {
    queries.push(query);
    return [...port.staged.values()].filter(row => query.nativeMessageId ? row.nativeMessageId === query.nativeMessageId : row.cursor > (query.after ?? 0)).slice(0, 100);
  };
  const add = (nativeMessageId, cursor) => {
    const eventId = nativeCaptureEventId('opencode', 'ses_native', nativeMessageId);
    port.staged.set(eventId, { eventId, nativeMessageId, sourceText: '有效的新消息', cursor });
  };
  for (let i = 1; i <= 100; i++) add('msg_bad_' + i, i);
  add('msg_current', 101);
  const capture = createMemoryOpencodeCapture(config(), port, async messageID => {
    reads.push(messageID);
    return { info: { id: messageID, sessionID: 'ses_native', role: messageID.startsWith('msg_bad_') ? 'assistant' : 'user' },
      parts: [part({ messageID, text: '有效的新消息' })] };
  });
  capture.start();
  await capture.beforeModel({ sessionID: 'ses_native', message: { id: 'msg_current', sessionID: 'ses_native', role: 'user' } });
  assert.deepEqual(reads, ['msg_current']);
  assert.deepEqual(queries[0], { nativeMessageId: 'msg_current' });
  assert.equal(port.ready.size, 1); assert.equal(port.staged.size, 100);
  add('msg_later', 102); queries.length = 0;
  await capture.replay();
  assert.deepEqual(queries, [{}, { after: 100 }]);
  assert.equal(port.ready.size, 2); assert.equal(port.staged.size, 100);
});

test('background recovery stops after twenty full pages and records that later candidates still need review', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tsp-opencode-capture-limit-')), auditFile = path.join(directory, 'audit.jsonl');
  try {
    const port = localPort(); let pages = 0;
    port.pending = async (query = {}) => {
      pages++;
      return Array.from({ length: 100 }, (_, i) => {
        const cursor = (query.after ?? 0) + i + 1, nativeMessageId = 'msg_unrecoverable_' + cursor;
        return { cursor, nativeMessageId, sourceText: '不能确认的旧候选', eventId: nativeCaptureEventId('opencode', 'ses_native', nativeMessageId) };
      });
    };
    const capture = createMemoryOpencodeCapture({ ...config(), auditFile }, port, async id => ({ info: { id, sessionID: 'ses_native', role: 'assistant' }, parts: [] }));
    capture.start(); await capture.replay();
    assert.equal(pages, 20); assert.equal(port.confirmations.length, 0);
    assert.match(await readFile(auditFile, 'utf8'), /native-capture-recovery-pending/u);
  } finally {
    assert.equal(path.dirname(directory), path.resolve(tmpdir())); assert.match(path.basename(directory), /^tsp-opencode-capture-limit-[a-zA-Z0-9]+$/u);
    await rm(directory, { recursive: true, force: true });
  }
});
