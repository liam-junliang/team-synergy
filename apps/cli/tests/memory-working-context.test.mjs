import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createMemoryWorkingContextStore } from '../dist/memory-working-context.js';
import { MemoryContextReceipts } from '../dist/memory-context.js';

const owner = 'a'.repeat(64);
const source = n => String(n).padStart(20, '0');
const ref = n => ({ source: source(n), version: 'b'.repeat(64) });
function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'tsp-memory-context-'));
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.match(path.basename(directory), /^tsp-memory-context-[a-zA-Z0-9]+$/u);
    rmSync(directory, { recursive: true, force: true });
  });
  let time = 100000;
  const store = (session = 'chat-a', account = owner) => createMemoryWorkingContextStore(account, session, { directory, now: () => time });
  return { directory, store, advance: ms => { time += ms; } };
}

test('checkpoints persist bounded references, never bodies or action capabilities, and reset does not extend retention', async t => {
  const f = fixture(t), store = f.store();
  assert.equal((await store.inspect()).exists, false);
  const first = await store.read();
  await store.commit(first, [ref(1)], []);
  const known = await store.read();
  f.advance(1000);
  const reset = await store.reset('compaction');
  assert.notEqual(reset.epoch, first.epoch);
  assert.equal(reset.expiresAt, known.expiresAt);
  assert.equal(reset.sourceCount, 1);
  assert.deepEqual((await f.store().read()).sources, [ref(1)]);
  await assert.rejects(store.commit(await store.read(), [{ ...ref(2), text: 'private body', grantId: 'authorization' }], []), { code: 'memory_context_invalid' });
  const bytes = readFileSync(path.join(f.directory, 'memory-working-context.sqlite'));
  assert.equal(bytes.includes(Buffer.from('private body')), false);
  assert.equal(bytes.includes(Buffer.from('authorization')), false);
  const mutable = await store.read();
  mutable.sources.push({ ...ref(3), text: 'mutated source body' });
  await store.commit(mutable, [], []);
  assert.deepEqual((await store.read()).sources, [ref(1)]);
  assert.equal((await store.reset('new-chat')).sourceCount, 0);
});

test('epoch changes, clear and concurrent reads cannot checkpoint an obsolete in-flight result', async t => {
  const { store } = fixture(t), s = store();
  const pending = await s.read();
  await s.reset('compaction');
  await assert.rejects(s.commit(pending, [ref(1)], []), { code: 'memory_context_changed' });
  const clearing = await s.read();
  await s.clear();
  await assert.rejects(s.commit(clearing, [ref(1)], []), { code: 'memory_context_changed' });
  const readA = await s.read(), readB = await s.read();
  await s.commit(readA, [ref(1)], []);
  await assert.rejects(s.commit(readB, [ref(2)], []), { code: 'memory_context_changed' });
  assert.deepEqual((await s.read()).sources, [ref(1)]);
});

test('expiry cannot be prolonged by inspect or reset, and new owners or sessions cannot inherit references', async t => {
  const f = fixture(t), store = f.store();
  await store.commit(await store.read(), [ref(1)], []);
  assert.deepEqual((await f.store('chat-b').read()).sources, []);
  assert.deepEqual((await f.store('chat-a', 'c'.repeat(64)).read()).sources, []);
  f.advance(24 * 60 * 60 * 1000);
  assert.equal((await store.inspect()).exists, false);
  assert.equal((await store.reset('resume')).sourceCount, 0);
  assert.deepEqual((await store.read()).sources, []);
});

test('reference horizons and active-session capacity are finite; unavailable entries leave the checkpoint', async t => {
  const f = fixture(t), s = f.store();
  await s.commit(await s.read(), Array.from({ length: 40 }, (_, i) => ref(i)), []);
  await s.commit(await s.read(), [ref(40)], [source(1)]);
  const kept = (await s.read()).sources;
  assert.equal(kept.length, 40);
  assert.equal(kept.some(r => r.source === source(1)), false);
  assert.equal(kept.at(-1).source, source(40));
  await assert.rejects(s.commit(await s.read(), Array.from({ length: 41 }, (_, i) => ref(i)), []), { code: 'memory_context_invalid' });
  for (let i = 1; i < 128; i++) await f.store('chat-' + i).read();
  await assert.rejects(f.store('overflow').read(), { code: 'memory_context_capacity' });
  await s.clear();
  assert.equal((await f.store('overflow').read()).sources.length, 0);
});

test('corrupt and oversized reference records fail closed and can be explicitly cleared', async t => {
  const f = fixture(t), s = f.store();
  await s.read();
  const db = new DatabaseSync(path.join(f.directory, 'memory-working-context.sqlite'));
  try {
    for (const value of ['not-json', ' '.repeat(6001), JSON.stringify([{ ...ref(1), text: 'untrusted' }])]) {
      db.prepare('update working_contexts set sources_json=?').run(value);
      await assert.rejects(s.read(), { code: 'memory_context_invalid' });
    }
  } finally { db.close(); }
  assert.equal((await s.clear()).cleared, true);
  assert.deepEqual((await s.read()).sources, []);
});

test('restoration budgets whole evidence and does not mark deferred bodies as known to the model', () => {
  const receipts = new MemoryContextReceipts();
  const rows = Array.from({ length: 8 }, (_, i) => ({ source: source(i), scope: 'project', state: 'discussed', text: '证据'.repeat(1000) }));
  const result = receipts.finish(receipts.begin(owner, undefined, 'epoch-a'), rows, [], { full: true, restoreBudget: { textChars: 8000, rows: 6 } });
  assert.equal(result.rows.length, 4);
  assert.equal(result.metadata.deferred_sources.length, 4);
  assert.equal(receipts.references(result.metadata.context_receipt).length, 4);
  const deferred = rows[4];
  const next = receipts.finish(receipts.begin(owner, result.metadata.context_receipt, 'epoch-a'), [deferred], rows.slice(0, 4), { full: false });
  assert.deepEqual(next.rows, [deferred]);
  const newEpoch = receipts.begin(owner, next.metadata.context_receipt, 'epoch-b');
  assert.equal(newEpoch.sources.size, 0);
  assert.equal(newEpoch.reset, true);
});
