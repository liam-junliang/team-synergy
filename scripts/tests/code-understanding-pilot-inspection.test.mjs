import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { boundedInspect, sourceCatalogWire, inspectTranscript } from '../code-understanding-pilot/run.mjs';
import { contentHash } from '../code-understanding-pilot/facts.mjs';
import { sha } from '../code-understanding-pilot/transport.mjs';

const query = (path = 'guard.ts') => ({ kind: 'source', path, startLine: 1, endLine: 2 });
const sourceResult = (q, text) => ({ kind: 'source', id: 'E-' + q.path, path: q.path,
  startLine: q.startLine, endLine: q.endLine, contentHash: contentHash(text), text });
const context = action => ({ inspect: (queries, owner) => ({ result: queries.map(q => action(q, owner)), retrievalMs: 1 }) });

test('invalid source range is a recoverable tool error and independent valid query still returns complete evidence', () => {
  const ctx = context(q => {
    if (q.startLine < 1) throw new Error('Source range must be valid and <=180 lines');
    return sourceResult(q, 'first\nsecond');
  });
  const observed = boundedInspect(ctx, [{ ...query(), startLine: 0 }, query('valid.ts')], 'task');
  assert.equal(observed.result[0].kind, 'tool-error');
  assert.match(observed.result[0].error, /valid narrower range/u);
  assert.equal(observed.result[1].text, 'first\nsecond');
  assert.equal(observed.result[1].path, 'valid.ts');
});

test('batch budget returns each source intact or an explicit tool error, without clipping or silently dropping queries', () => {
  const contents = { 'first.ts': 'a'.repeat(18 * 1024), 'second.ts': 'b'.repeat(12 * 1024), 'third.ts': 'tail\ncomplete' };
  const observed = boundedInspect(context(q => sourceResult(q, contents[q.path])),
    [query('first.ts'), query('second.ts'), query('third.ts')], 'task');
  assert.equal(observed.result.length, 3);
  assert.equal(observed.result[0].text, contents['first.ts']);
  assert.equal(observed.result[1].kind, 'tool-error');
  assert.match(observed.result[1].error, /source was not returned/u);
  assert.equal(observed.result[2].text, contents['third.ts']);
  assert.ok(Buffer.byteLength(JSON.stringify(observed)) <= 28 * 1024);
});

test('source integrity and boundary failures are fatal, never downgraded to model-correctable query errors', () => {
  for (const message of ['Frozen source hash mismatch: guard.ts', 'Source boundary violation', 'Citation binding audit failed']) {
    assert.throws(() => boundedInspect(context(() => { throw new Error(message); }), [query()], 'task'),
      error => error.message === message);
  }
});

test('inspection enforces query count and hard final envelope bound even for oversized error metadata', () => {
  const ctx = context(q => sourceResult(q, 'small'));
  assert.throws(() => boundedInspect(ctx, [], 'task'), /at least one/u);
  assert.throws(() => boundedInspect(ctx, Array.from({ length: 7 }, () => query()), 'task'), /array <= 6/u);
  const badQuery = { ...query(), path: 'x'.repeat(30 * 1024) };
  assert.throws(() => boundedInspect(context(() => { throw new Error('Source not in frozen snapshot'); }), [badQuery], 'task'),
    /error envelope overflow/u);
});

test('quote catalog stores each complete quote once while preserving every original binding and fact identity', () => {
  const quote = 'if (epoch === 0) return;\nassertLease();';
  const binding = { repository: 'repo', snapshot: 'snap', commit: 'commit', path: 'guard.ts',
    contentHash: contentHash(quote), startLine: 4, endLine: 5, quote };
  const otherBinding = { ...binding, path: 'other.ts', startLine: 20, endLine: 21 };
  const original = { draft: { facts: [{ id: 'task:F1', evidence: [binding] }, { id: 'handover:F1', evidence: [otherBinding] }] },
    evidence: [binding, otherBinding], unknowns: ['pending dependency'] };
  const before = structuredClone(original), wire = sourceCatalogWire(original);
  assert.deepEqual(original, before, 'wire transformation must not mutate internal full bindings');
  assert.equal(wire.sourceCatalog.length, 1);
  assert.equal(wire.sourceCatalog[0].text, quote);
  const slim = wire.value.draft.facts[0].evidence[0];
  assert.equal(slim.sourceRef, wire.value.evidence[0].sourceRef);
  assert.equal(slim.sourceRef, wire.value.draft.facts[1].evidence[0].sourceRef);
  assert.equal('quote' in slim, false);
  const { sourceRef: _sourceRef, ...identity } = slim;
  const { quote: _quote, ...originalIdentity } = binding;
  assert.deepEqual(identity, originalIdentity);
  assert.deepEqual(wire.value.unknowns, original.unknowns);
  assert.equal(wire.value.draft.facts[1].evidence[0].path, 'other.ts');
  assert.equal(wire.value.draft.facts[1].evidence[0].startLine, 20);
});

test('different complete quotes remain distinct and shared large bindings shrink wire input without changing text', () => {
  const quote = '完整来源\n'.repeat(1500);
  const binding = { path: 'large.ts', contentHash: contentHash(quote), startLine: 1, endLine: 1501, quote };
  const second = { ...binding, quote: quote + 'last line' };
  const original = { facts: Array.from({ length: 6 }, (_, i) => ({ id: 'F' + i, evidence: [binding] })), evidence: [binding, second] };
  const wire = sourceCatalogWire(original);
  assert.equal(wire.sourceCatalog.length, 2);
  assert.deepEqual(wire.sourceCatalog.map(item => item.text), [quote, second.quote]);
  assert.ok(Buffer.byteLength(JSON.stringify(wire)) < Buffer.byteLength(JSON.stringify(original)) / 2);
});

test('parent-scope deduplication preserves complete text and every field span', () => {
  const parent = 'Condition: permission check first.\nException: epoch zero skips lease only.';
  const claims = [{ id: 'A', scope_context: { field_text: parent, field_span: [0, 34], field: 'flows.0.summary' } },
    { id: 'B', scope_context: { field_text: parent, field_span: [35, parent.length], field: 'flows.1.summary' } }];
  const before = structuredClone(claims), wire = sourceCatalogWire({ claims });
  assert.deepEqual(claims, before);
  assert.equal(wire.contextCatalog.length, 1);
  assert.equal(wire.contextCatalog[0].text, parent);
  for (let index = 0; index < claims.length; index++) {
    assert.equal(wire.value.claims[index].scope_context.field_text_ref, wire.contextCatalog[0].contextRef);
    assert.deepEqual(wire.value.claims[index].scope_context.field_span, claims[index].scope_context.field_span);
    assert.equal(wire.value.claims[index].scope_context.field, claims[index].scope_context.field);
  }
});

function temporaryDirectory(t) {
  const root = path.resolve(os.tmpdir()), prefix = 'code-pilot-inspect-';
  const directory = fs.mkdtempSync(path.join(root, prefix));
  t.after(() => {
    assert.equal(path.dirname(directory), root);
    assert.ok(path.basename(directory).startsWith(prefix));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}
function transcriptFixture(t, { legacy = false } = {}) {
  const directory = temporaryDirectory(t), queries = [query()], events = [];
  const result = [sourceResult(queries[0], 'actual fixed source\ncomplete')];
  let reads = 0;
  const ctx = { inspect: () => { reads++; return { result: structuredClone(result), retrievalMs: reads * 100 }; } };
  const calls = [], client = { configHash: 'fixed-config', state: () => ({ calls }), event: event => events.push(event) };
  if (legacy) {
    const toolResult = { result, retrievalMs: 23.456 };
    const body = JSON.stringify({ messages: [{ role: 'user', content: JSON.stringify({ toolResult, currentRound: 2 }) }] });
    const requestSha = sha(body);
    fs.writeFileSync(path.join(directory, 'accepted.request.json'), body);
    fs.writeFileSync(path.join(directory, 'accepted.audit.json'), JSON.stringify({ requestFile: 'accepted.request.json', requestSha,
      phase: 'task', name: 'task-round-2', accepted: true, configHash: client.configHash }));
    calls.push({ phase: 'task', name: 'task-round-2', accepted: true, requestSha, audit: 'accepted.audit.json' });
  }
  return { directory, queries, events, result, ctx, client, reads: () => reads };
}

test('new checkpoints omit timing from model transcript while rerunning inspection to restore source bindings', t => {
  const fixture = transcriptFixture(t);
  const first = inspectTranscript(fixture.ctx, fixture.client, fixture.directory, 'task', 1, fixture.queries);
  const second = inspectTranscript(fixture.ctx, fixture.client, fixture.directory, 'task', 1, fixture.queries);
  assert.equal(JSON.stringify(second), JSON.stringify(first));
  assert.equal('retrievalMs' in first, false);
  assert.equal(fixture.reads(), 2);
  assert.deepEqual(fixture.events.map(e => e.actualCurrentRetrievalMs), [100, 200]);
  assert.ok(fixture.events.every(e => e.legacyTimingCompatibility === false));
});

test('legacy accepted request recovers its exact tool-result transcript only after request hash and observable verification', t => {
  const fixture = transcriptFixture(t, { legacy: true });
  const first = inspectTranscript(fixture.ctx, fixture.client, fixture.directory, 'task', 1, fixture.queries);
  assert.equal(first.retrievalMs, 23.456);
  assert.deepEqual(first.result, fixture.result);
  const second = inspectTranscript(fixture.ctx, fixture.client, fixture.directory, 'task', 1, fixture.queries);
  assert.equal(JSON.stringify(second), JSON.stringify(first));
  assert.equal(fixture.reads(), 2);
  assert.equal(fixture.events[0].provenance, 'accepted-request-transcript');
  assert.equal(fixture.events[1].provenance, 'private-inspect-checkpoint');
  assert.ok(fixture.events.every(e => e.legacyTimingCompatibility));
});

test('inspection replay rejects changed source, checkpoint tampering, and accepted-request byte tampering', t => {
  const changed = transcriptFixture(t, { legacy: true });
  changed.ctx.inspect = () => ({ result: [sourceResult(query(), 'different source')], retrievalMs: 1 });
  assert.throws(() => inspectTranscript(changed.ctx, changed.client, changed.directory, 'task', 1, changed.queries), /observable\/query integrity/u);
  const corruptRequest = transcriptFixture(t, { legacy: true });
  fs.appendFileSync(path.join(corruptRequest.directory, 'accepted.request.json'), ' ');
  assert.throws(() => inspectTranscript(corruptRequest.ctx, corruptRequest.client, corruptRequest.directory, 'task', 1, corruptRequest.queries), /accepted request integrity/u);
  const corruptCheckpoint = transcriptFixture(t);
  inspectTranscript(corruptCheckpoint.ctx, corruptCheckpoint.client, corruptCheckpoint.directory, 'task', 1, corruptCheckpoint.queries);
  const file = path.join(corruptCheckpoint.directory, 'inspect-task-round-1.json'), checkpoint = JSON.parse(fs.readFileSync(file));
  checkpoint.toolResult.result[0].text = 'tampered'; fs.writeFileSync(file, JSON.stringify(checkpoint));
  assert.throws(() => inspectTranscript(corruptCheckpoint.ctx, corruptCheckpoint.client, corruptCheckpoint.directory, 'task', 1, corruptCheckpoint.queries), /observable\/query integrity/u);
});
