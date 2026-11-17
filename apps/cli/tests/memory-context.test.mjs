import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryContextReceipts } from '../dist/memory-context.js';

const source = { source: 'source-A', state: 'discussed', scope: 'project', text: '暂定退款方案',
  topicCode: 'topic-A', topicStatus: 'open', requirementCode: 'requirement-A', sourceRevision: 1 };
const save = (cache, rows = [source], receipt, verified = [], options = {}) =>
  cache.finish(cache.begin('member-A/project-A', receipt), rows, verified, { full: false, ...options });

test('receipt chains are opt-in, immutable and local to each conversation branch', () => {
  const cache = new MemoryContextReceipts();
  const first = save(cache);
  assert.deepEqual(first.rows, [source]);
  assert.equal(first.metadata.unchanged_sources.length, 0);
  const repeat = save(cache, [source], first.metadata.context_receipt, [source]);
  assert.deepEqual(repeat.rows, []);
  assert.equal(repeat.metadata.unchanged_sources[0].source, source.source);
  assert.match(repeat.metadata.unchanged_sources[0].version, /^[a-f\d]{64}$/);
  assert.equal(repeat.metadata.unchanged_sources[0].state, 'discussed');
  assert.equal(repeat.metadata.unchanged_sources[0].scope, 'project');
  assert.notEqual(repeat.metadata.context_receipt, first.metadata.context_receipt);
  // Another conversation in the same process sees all text on its first read.
  assert.deepEqual(save(cache).rows, [source]);
  const later = { ...source, text: '已改成新的方案', sourceRevision: 2 };
  save(cache, [later], repeat.metadata.context_receipt, [later]);
  // Advancing the child branch must not modify its parent's fingerprint.
  assert.deepEqual(save(cache, [source], first.metadata.context_receipt, [source]).rows, []);
  assert.deepEqual(save(cache, [later], first.metadata.context_receipt, [later]).rows, [later]);
});

test('each factual change returns full evidence while presentation and object key order do not', () => {
  const cache = new MemoryContextReceipts();
  const first = save(cache, [{ ...source, evidenceStatus: '仅表示讨论中' }]);
  const receipt = first.metadata.context_receipt;
  const reordered = Object.fromEntries(Object.entries(source).reverse());
  assert.deepEqual(save(cache, [reordered], receipt, [reordered]).rows, []);
  for (const changes of [
    { text: '新事实' }, { state: 'confirmed' }, { scope: 'personal' }, { topicCode: 'topic-B' },
    { topicStatus: 'decided' }, { requirementCode: 'requirement-B' }, { sourceRevision: 2 }, { applicability: 'account' },
  ]) {
    const current = { ...source, ...changes };
    assert.deepEqual(save(cache, [source], receipt, [current]).rows, [current]);
  }
});

test('authorized revalidation replaces stale result versions and reports changed out-of-query sources', () => {
  const cache = new MemoryContextReceipts();
  const first = save(cache);
  const fresh = { ...source, state: 'confirmed', text: '真正的新结论', sourceRevision: 2 };
  const changed = save(cache, [source], first.metadata.context_receipt, [fresh]);
  assert.deepEqual(changed.rows, [fresh]);
  assert.doesNotMatch(JSON.stringify(changed), /暂定退款方案/);
  assert.deepEqual(save(cache, [], first.metadata.context_receipt, [fresh]).rows, [fresh]);
  const unavailable = save(cache, [source], changed.metadata.context_receipt, []);
  assert.deepEqual(unavailable.rows, []);
  assert.deepEqual(unavailable.metadata.unavailable_sources, [source.source]);
  assert.doesNotMatch(JSON.stringify(unavailable), /真正的新结论|暂定退款方案/);
  assert.deepEqual(cache.begin('member-A/project-A', unavailable.metadata.context_receipt).sources.size, 0);
});

test('explicit source reload and full baseline preserve the current complete body', () => {
  const cache = new MemoryContextReceipts();
  const first = save(cache);
  assert.deepEqual(save(cache, [source], first.metadata.context_receipt, [source], { forceSource: source.source }).rows, [source]);
  assert.deepEqual(save(cache, [source], first.metadata.context_receipt, [source], { full: true }).rows, [source]);
});

test('expired and unknown receipts safely restart without reusing another owner', () => {
  let now = 0;
  const cache = new MemoryContextReceipts(() => now);
  const first = save(cache);
  assert.throws(() => cache.begin('member-B/project-A', first.metadata.context_receipt), { code: 'memory_context_mismatch' });
  assert.throws(() => cache.begin('member-A/project-B', first.metadata.context_receipt), { code: 'memory_context_mismatch' });
  assert.equal(first.metadata.expires_in_seconds, 1800);
  now = 30 * 60 * 1000;
  const expired = save(cache, [source], first.metadata.context_receipt);
  assert.deepEqual(expired.rows, [source]);
  assert.equal(expired.metadata.receipt_reset, 'expired_or_unknown');
  const unknown = save(cache, [source], 'tampered');
  assert.deepEqual(unknown.rows, [source]);
  assert.equal(unknown.metadata.receipt_reset, 'expired_or_unknown');
});

test('finite receipt and source horizons fall back to full reads and reject foreign source responses', () => {
  const cache = new MemoryContextReceipts();
  const first = save(cache);
  for (let i = 0; i < 128; i++) save(cache);
  assert.equal(save(cache, [source], first.metadata.context_receipt).metadata.receipt_reset, 'expired_or_unknown');
  const rows = Array.from({ length: 41 }, (_, i) => ({ ...source, source: 'source-' + i }));
  const many = save(cache, rows);
  const base = cache.begin('member-A/project-A', many.metadata.context_receipt);
  assert.equal(base.sources.size, 40);
  assert.equal(base.sources.has('source-0'), false);
  assert.throws(() => cache.finish(base, [], [{ ...source, source: 'foreign' }], { full: false }), { code: 'memory_invalid_sources' });
});

test('repeat long excerpts reduce context while retaining current citations', t => {
  const cache = new MemoryContextReceipts();
  const rows = Array.from({ length: 6 }, (_, i) => ({ ...source, source: 'source-' + i, text: '有来源的项目背景与验收条件。'.repeat(50) }));
  const first = save(cache, rows);
  const repeat = save(cache, rows, first.metadata.context_receipt, rows);
  const fullChars = JSON.stringify({ rows: first.rows, ...first.metadata }).length;
  const repeatChars = JSON.stringify({ rows: repeat.rows, ...repeat.metadata }).length;
  t.diagnostic(JSON.stringify({ fullChars, repeatChars, savedPercent: Math.round((1 - repeatChars / fullChars) * 100) }));
  assert.ok(repeatChars < fullChars / 2);
  assert.deepEqual(repeat.metadata.unchanged_sources.map(s => s.source), rows.map(s => s.source));
});
