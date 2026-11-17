import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reviewB } from '../code-understanding-pilot/run.mjs';
import { sha } from '../code-understanding-pilot/transport.mjs';

function fixture() {
  const child = 'if (epoch === 0) return; // 中文 😀\n', whole = 'before\n' + child + 'after\n';
  const binding = (quote, startLine, endLine) => ({ repository: 'repo', snapshot: 'snapshot', commit: 'commit', path: 'guard.ts',
    contentHash: sha(whole), startLine, endLine, quote });
  const dependencies = [{ repository: 'repo', path: 'guard.ts', kind: 'guard' }];
  const facts = ['task:F1', 'handover:F1'].map((id, i) => ({ id, repository: 'repo', module: id.split(':')[0], risk: 'critical',
    actor: 'actor', action: 'read', object: 'fixture', preconditions: ['explicit condition'], outcomes: ['static observation'], exceptions: ['unknown runtime'],
    observationType: 'static-observed', displayText: 'Fixture fact ' + i, dependencies, evidence: [i ? binding(whole, 1, 4) : binding(child, 2, 2)] }));
  const contracts = ['C1', 'C2'].map(id => ({ id, factIds: facts.map(f => f.id), displayText: 'Fixture contract ' + id,
    producer: 'task', consumer: 'handover', identity: 'fixture', order: 'fixture', state: 'fixture', errors: [], unknowns: [] }));
  const parent = 'Complete original parent 中文 😀\n'.repeat(20);
  const claims = [...facts, ...contracts].map((item, i) => ({ id: item.id, node_id: i < 2 ? facts[i].module : 'cross',
    text: item.displayText, risk: 'critical', field: 'flows.' + i, kind: 'narrative', evidence: [],
    scope_context: { field_text: parent + item.displayText, field_span: [parent.length, parent.length + item.displayText.length], field: 'flows.' + i } }));
  return { draft: { facts, contracts, unknowns: ['fixture only'] }, claims };
}
const decodeQuote = (entry, catalog) => entry.text ?? catalog.find(row => row.sourceRef === entry.textRef).text.slice(...entry.utf16Slice);
const decodeContext = (entry, catalog) => entry.text ?? entry.textParts.map(part => part.literalText
  ?? catalog.find(fragment => fragment.fragmentRef === part.fragmentRef).text).join('');

test('B fixed batches reconstruct all original source and parent bytes, exact claims, dependency vectors and field spans', async () => {
  const { draft, claims } = fixture(), original = structuredClone({ draft, claims }), names = [];
  const result = await reviewB({}, { call: async request => {
    names.push(request.name);
    const wire = JSON.parse(request.messages[1].content);
    assert.equal(wire.reviewProtocol, 'structured-two-batch-2');
    for (const entry of wire.sourceCatalog) {
      const quote = decodeQuote(entry, wire.sourceCatalog);
      assert.equal(entry.sourceRef, 'QS-' + sha(quote));
      assert.ok(draft.facts.some(fact => fact.evidence.some(binding => binding.quote === quote)));
    }
    for (const entry of wire.scopeContextCatalog) {
      const parent = decodeContext(entry, wire.contextFragmentCatalog);
      assert.equal(entry.contextRef, 'SC-' + sha(parent));
      assert.ok(claims.some(claim => claim.scope_context.field_text === parent));
    }
    for (const claim of wire.claims) {
      const source = claims.find(item => item.id === claim.id);
      assert.equal(claim.text, source.text);
      assert.deepEqual(claim.scope_context.field_span, source.scope_context.field_span);
      assert.equal(decodeContext(wire.scopeContextCatalog.find(row => row.contextRef === claim.scope_context.field_text_ref),
        wire.contextFragmentCatalog), source.scope_context.field_text);
    }
    for (const fact of wire.draft.facts) {
      const source = draft.facts.find(item => item.id === fact.id);
      assert.deepEqual(fact.preconditions, source.preconditions);
      assert.deepEqual(fact.exceptions, source.exceptions);
      assert.deepEqual(fact.dependencyRefs.map(ref => {
        const { dependencyRef: _ref, ...dependency } = wire.hostDependencyCatalog.find(row => row.dependencyRef === ref); return dependency;
      }), source.dependencies);
      for (const binding of fact.evidence) {
        const { sourceRef, ...identity } = binding, originalBinding = source.evidence.find(item => 'QS-' + sha(item.quote) === sourceRef);
        const { quote: _quote, ...originalIdentity } = originalBinding;
        assert.deepEqual(identity, originalIdentity);
      }
    }
    return { value: request.validate({ action: 'final', checks: wire.reviewIds.map(id => ({ id, status: 'unknown',
      reason: 'Pure offline protocol test.', evidence: [] })), unknowns: [] }) };
  } }, claims, draft);
  assert.deepEqual(names, ['critical-facts', 'cross-contracts']);
  assert.equal(result.checks.length, claims.length);
  assert.ok(result.batches.every(batch => batch.representationProtocol === 'lossless-source-substring-context-prefix-1'));
  assert.deepEqual({ draft, claims }, original);
});

test('B batch decoder rejects missing coverage and unsupported proof without requesting extra inspection', async () => {
  for (const mode of ['coverage', 'proof']) {
    const { draft, claims } = fixture();
    await assert.rejects(reviewB({}, { call: async request => {
      const wire = JSON.parse(request.messages[1].content);
      return { value: request.validate({ action: 'final', checks: mode === 'coverage' ? [] : wire.reviewIds.map(id => ({
        id, status: 'supported', reason: 'No source proof provided.', evidence: [] })), unknowns: [] }) };
    } }, claims, draft), mode === 'coverage' ? /coverage mismatch/u : /requires source/u);
  }
});
