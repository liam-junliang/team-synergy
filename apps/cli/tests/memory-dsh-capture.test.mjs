import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DomainError } from '@team-synergy/domain';
import { apply, createMemoryDshCapture, dshCapturePluginEntry, dshOperatorCapture } from '../dist/memory-dsh-capture.js';
import { nativeCaptureEventId } from '../dist/memory-native-capture.js';

const config = () => ({ harness: 'dsh', hostSessionId: 'native-chat', memorySession: 'member-memory',
  cwd: process.cwd(), memberHome: tmpdir(), cliPath: path.join(process.cwd(), 'apps/cli/dist/index.js'), nodePath: process.execPath, owner: 'a'.repeat(64) });
const session = extra => ({ id: 'native-chat', header: { id: 'native-chat', cwd: process.cwd(), ...extra } });
const message = (id = 'msg-native-1', text = '在所有项目中我习惯用中文写变更说明。', seq = 3) => ({ type: 'user/message', seq,
  data: { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }, surfaceOp: 'append' });
const bridge = () => { const queued = []; let kicks = 0; return { queued, kicks: () => kicks,
  enqueue: async (event, ready) => { queued.push({ ...event, ready }); return { eventId: event.eventId, durable: true, state: 'ready' }; }, kick: () => { kicks++; } }; };

test('captures only committed operator text, with a stable native message identity independent of seq', () => {
  const first = dshOperatorCapture(config(), session(), message());
  assert.equal(first.eventId, nativeCaptureEventId('dsh', 'native-chat', 'msg-native-1'));
  assert.equal(first.nativeSeq, 3);
  assert.equal(first.nativeMessageId, 'msg-native-1');
  assert.equal(first.eventId, dshOperatorCapture(config(), session(), message('msg-native-1', first.sourceText, 90)).eventId);
  assert.notEqual(first.eventId, dshOperatorCapture(config(), session(), message('msg-native-2')).eventId);
  const multiple = message(); multiple.data.content.push({ type: 'text', text: '这不授予推送权限。' });
  assert.equal(dshOperatorCapture(config(), session(), multiple).sourceText, first.sourceText + '\n这不授予推送权限。');
});

test('assistant, tools, injected user-role messages, compaction and subagents never become operator memory', async () => {
  const calls = bridge(), capture = createMemoryDshCapture(config(), calls);
  for (const type of ['assistant/message', 'tool/result', 'developer/message', 'compaction/summary', 'agent/inbox/spliced']) {
    capture.event(session(), { ...message(), type });
  }
  for (const kind of ['tool', 'model', 'system-prompt', 'memory-recall', 'goal', 'subagent']) {
    const event = message(); event.data.source = { kind }; capture.event(session(), event);
  }
  const assistantRole = message(); assistantRole.data.role = 'assistant'; capture.event(session(), assistantRole);
  capture.event({ id: 'another-chat' }, message());
  capture.event(session({ origin: 'subagent' }), message());
  capture.event(session({ delegationDepth: 1 }), message());
  await capture.flush(session());
  assert.deepEqual(calls.queued, []);
});

test('native event observer returns immediately; flush awaits only local durability and then kicks delivery', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const queued = []; let kicks = 0, drained = 0;
  const capture = createMemoryDshCapture(config(), {
    enqueue: async (event, ready) => { queued.push({ ...event, ready }); await gate; return { eventId: event.eventId, durable: true, state: 'ready' }; },
    kick: () => { kicks++; }, drain: async () => { drained++; throw Error('remote-must-not-be-awaited'); },
  });
  assert.equal(capture.event(session(), message()), undefined);
  let flushed = false; const flush = capture.flush(session()).then(() => { flushed = true; });
  await Promise.resolve();
  assert.equal(flushed, false); assert.equal(kicks, 0);
  release(); await flush;
  assert.equal(flushed, true); assert.equal(kicks, 1); assert.equal(drained, 0);
  assert.equal(queued[0].ready, true);
});

test('resume and idle recover the existing local spool without reading or re-enqueuing historical seed', async () => {
  const calls = bridge(), capture = createMemoryDshCapture(config(), calls);
  const native = { ...session({ isSeeded: true, parentSession: 'old-chat' }), snapshotEvents() { throw Error('historical-seed-must-not-be-read'); } };
  capture.created(native); capture.idle(native); await capture.flush(native);
  assert.ok(calls.kicks() >= 2); assert.deepEqual(calls.queued, []);
  capture.event(native, message()); await capture.flush(native);
  assert.equal(calls.queued.length, 1);
  assert.equal(calls.queued[0].eventId, nativeCaptureEventId('dsh', 'native-chat', 'msg-native-1'));
  const restarted = createMemoryDshCapture(config(), calls);
  restarted.created(native); await restarted.flush(native);
  assert.equal(calls.queued.length, 1, 'restart drains the durable spool rather than resampling seed messages');
});

test('account/owner failure latches capture closed and is visible at the native durability checkpoint', async () => {
  let kicks = 0, enqueue = 0;
  const capture = createMemoryDshCapture(config(), { enqueue: async () => { enqueue++; throw new DomainError('memory_binding_changed', 'synthetic-owner-change'); }, kick: () => { kicks++; } });
  capture.event(session(), message());
  await assert.rejects(capture.flush(session()), { code: 'memory_binding_changed' });
  capture.event(session(), message('msg-after-switch'));
  capture.created(session()); capture.idle(session());
  assert.equal(enqueue, 1); assert.equal(kicks, 0);
});

test('a malformed, staged or mismatched local ACK is not treated as durable ready capture', async () => {
  for (const ack of [{}, { durable: true, eventId: 'another', state: 'ready' },
    { durable: true, eventId: nativeCaptureEventId('dsh', 'native-chat', 'msg-native-1'), state: 'staged' }]) {
    const capture = createMemoryDshCapture(config(), { enqueue: async () => ack, kick() { throw Error('bad-ack-must-not-drain'); } });
    capture.event(session(), message());
    await assert.rejects(capture.flush(session()), { code: 'memory_native_ack_invalid' });
  }
});

test('wrong native workspace and native directory changes cannot enqueue into the old project', async t => {
  const folder = mkdtempSync(path.join(tmpdir(), 'tsp-dsh-capture-'));
  t.after(() => { assert.equal(path.dirname(folder), path.resolve(tmpdir())); rmSync(folder, { recursive: true, force: true }); });
  const calls = bridge(), mismatch = createMemoryDshCapture(config(), calls);
  mismatch.event(session({ cwd: folder }), message());
  await assert.rejects(mismatch.flush(session()), { code: 'memory_native_session_mismatch' });
  assert.equal(calls.queued.length, 0);
  const changed = createMemoryDshCapture(config(), calls);
  changed.event(session(), { type: 'working-directory/change', seq: 10, data: { cwd: folder } });
  changed.event(session(), message());
  await assert.rejects(changed.flush(session()), { code: 'memory_native_session_mismatch' });
  assert.equal(calls.queued.length, 0);
});

test('unsupported attachments, oversized bodies and missing durable IDs fail visibly without partial capture', async () => {
  for (const alter of [event => { event.data.content.push({ type: 'image', url: 'fixture-only' }); },
    event => { event.data.content[0].text = '大'.repeat(4001); }, event => { delete event.data.id; }, event => { delete event.seq; }]) {
    const calls = bridge(), capture = createMemoryDshCapture(config(), calls), event = message(); alter(event);
    capture.event(session(), event);
    await assert.rejects(capture.flush(session()), error => ['memory_native_event_invalid', 'memory_native_content_unsupported'].includes(error.code));
    assert.deepEqual(calls.queued, []);
  }
});

test('audit retains only hashes and native identity metadata; config copies cannot switch a running observer', async t => {
  const folder = mkdtempSync(path.join(tmpdir(), 'tsp-dsh-capture-audit-')), file = path.join(folder, 'audit.jsonl');
  t.after(() => { assert.equal(path.dirname(folder), path.resolve(tmpdir())); rmSync(folder, { recursive: true, force: true }); });
  const input = { ...config(), auditFile: file }, calls = bridge(), capture = createMemoryDshCapture(input, calls);
  input.hostSessionId = 'changed-by-caller'; input.owner = 'b'.repeat(64);
  capture.event(session(), message()); await capture.flush(session());
  const text = readFileSync(file, 'utf8'); assert.doesNotMatch(text, /用中文写变更说明|msg-native-1/u);
  const audit = JSON.parse(text.trim()); assert.equal(audit.kind, 'native-capture-durable'); assert.equal(audit.nativeSeq, 3);
  assert.match(audit.sourceHash, /^[a-f0-9]{64}$/u); assert.equal(calls.queued.length, 1);
});

test('exports a direct Cordis module entry and registers native event/flush/recovery listeners', () => {
  const entry = dshCapturePluginEntry(config()); assert.equal(entry.id, 'tsp-memory-dsh-capture'); assert.match(entry.name, /^file:/u);
  const listeners = new Map(); apply({ on: (event, listener) => { listeners.set(event, listener); } }, config());
  assert.deepEqual([...listeners.keys()], ['session/event', 'session/flush', 'agent/created', 'agent/status', 'dispose']);
  for (const change of [{ owner: '' }, { nodePath: 'node' }, { cliPath: 'relative.mjs' }, { harness: 'other' }, { hostSessionId: '../foreign' }, { extra: true }]) {
    assert.throws(() => dshCapturePluginEntry({ ...config(), ...change }), { code: 'memory_native_capture_invalid' });
  }
});
