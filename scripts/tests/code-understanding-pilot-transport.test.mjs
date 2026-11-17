import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CONFIG, sha, transport } from '../code-understanding-pilot/transport.mjs';

function fixture(t, { audit: auditOverrides = {}, envelope: envelopeOverrides = {}, status = 'failed' } = {}) {
  const root = path.resolve(os.tmpdir()), prefix = 'code-pilot-transport-';
  const directory = fs.mkdtempSync(path.join(root, prefix));
  t.after(() => {
    assert.equal(path.dirname(directory), root);
    assert.ok(path.basename(directory).startsWith(prefix));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const identity = { snapshot: 'pure-fixture-snapshot', commit: 'pure-fixture-commit', targets: [] };
  const configHash = sha(JSON.stringify({ config: CONFIG, identity }));
  const messages = [{ role: 'system', content: 'Pure transport fixture; no source or endpoint access.' },
    { role: 'user', content: 'Return the fixed fixture.' }];
  const request = JSON.stringify({ model: CONFIG.model, stream: false, temperature: CONFIG.temperature,
    thinking: CONFIG.thinking, reasoning_effort: CONFIG.reasoning_effort, max_tokens: CONFIG.max_tokens,
    response_format: { type: 'json_object' }, messages });
  const requestSha = sha(request);
  const output = { selectedFactIds: ['task:F1', 'handover:F1'], contracts: [{ id: 'C1',
    factIds: ['task:F1', 'handover:F1'], errors: Array.from({ length: 9 }, (_, i) => 'real-condition-' + i) }], unknowns: [] };
  const envelope = { model: CONFIG.model, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, ...envelopeOverrides };
  const response = JSON.stringify(envelope);
  const audit = { configHash, phase: 'synthesis', name: 'synthesis', requestSha, requestFile: 'original.request.json',
    responseFile: 'original.response.json', responseSha: sha(response), accepted: false, httpStatus: 200,
    finishReason: 'stop', responseModel: CONFIG.model, failure: { name: 'Error', message: 'errors must be an array <= 6' },
    ...auditOverrides };
  fs.writeFileSync(path.join(directory, audit.requestFile), request);
  fs.writeFileSync(path.join(directory, audit.responseFile), response);
  const auditFile = path.join(directory, 'original.audit.json');
  fs.writeFileSync(auditFile, JSON.stringify(audit, null, 2));
  fs.writeFileSync(path.join(directory, 'state.json'), JSON.stringify({ configHash, phase: 'incomplete', events: [],
    calls: [{ phase: audit.phase, name: audit.name, requestSha, accepted: false, status, audit: 'original.audit.json' }] }));
  const auditBytes = fs.readFileSync(auditFile);
  let networkCalls = 0;
  t.mock.method(globalThis, 'fetch', () => { networkCalls++; throw new Error('Network forbidden in pure transport tests'); });
  const requestArgs = { phase: 'synthesis', messages, validate: value => {
    assert.deepEqual(value.selectedFactIds, ['task:F1', 'handover:F1']);
    assert.deepEqual(value.contracts[0].factIds, ['task:F1', 'handover:F1']);
    assert.ok(value.contracts[0].errors.length <= 24);
    return value;
  } };
  return { directory, identity, audit, auditFile, auditBytes, output, requestArgs,
    networkCalls: () => networkCalls,
    receipts: () => fs.readdirSync(directory).filter(name => name.startsWith('resource-revalidation-')),
    assertOriginalAudit: () => assert.deepEqual(fs.readFileSync(auditFile), auditBytes) };
}

test('default transport rejects prior failed and pending requests without any HTTP retry', async t => {
  for (const status of ['failed', 'pending']) await t.test(status, async subtest => {
    const f = fixture(subtest, { status }), client = transport(f.directory, f.identity);
    await assert.rejects(client.call(f.requestArgs), /previously failed\/pending; automatic retry forbidden/u);
    assert.equal(f.networkCalls(), 0);
    assert.deepEqual(f.receipts(), []);
    f.assertOriginalAudit();
  });
});

test('explicit narrow storage-bound revalidation preserves every error, original failure audit, call count and zero-network provenance', async t => {
  const f = fixture(t), client = transport(f.directory, f.identity, { revalidateResourceBounds: true });
  const result = await client.call(f.requestArgs);
  assert.deepEqual(result.value, f.output);
  assert.equal(result.value.contracts[0].errors.length, 9);
  assert.equal(result.cached, true);
  assert.equal(f.networkCalls(), 0);
  f.assertOriginalAudit();
  const state = client.state();
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].status, 'revalidated-resource-count');
  assert.equal(state.calls[0].accepted, true);
  const receipt = JSON.parse(fs.readFileSync(path.join(f.directory, f.receipts()[0])));
  assert.equal(receipt.modelOrNetworkRetry, false);
  assert.equal(receipt.semanticCoverageChecksUnchanged, true);
  assert.deepEqual(receipt.originalFailure, f.audit.failure);
  assert.ok(state.events.some(event => event.kind === 'resource-response-revalidated' && event.newHttpRequests === 0));
  const receiptBytes = fs.readFileSync(path.join(f.directory, f.receipts()[0]));
  assert.deepEqual((await client.call(f.requestArgs)).value, f.output);
  assert.deepEqual(fs.readFileSync(path.join(f.directory, f.receipts()[0])), receiptBytes);
  assert.equal(client.state().calls.length, 1);
  assert.equal(f.networkCalls(), 0);
});

test('opt-in rejects other phases, HTTP failures, non-stop finish, other model and any different prior validation error', async t => {
  const forbidden = [{ phase: 'task' }, { phase: 'delta', name: 'guard-affected-facts-direct' },
    { phase: 'delta', name: 'other-delta-call', failure: { message: 'Invalid bounded text' } },
    { httpStatus: 503 }, { finishReason: 'length' },
    { responseModel: CONFIG.model.split('/').at(-1) }, { responseModel: 'other/model' },
    { failure: { message: 'source coverage missing' } }, { failure: { message: 'errors must be an array <= 60' } }];
  for (const audit of forbidden) await t.test(JSON.stringify(audit), async subtest => {
    const f = fixture(subtest, { audit }), client = transport(f.directory, f.identity, { revalidateResourceBounds: true });
    await assert.rejects(client.call(f.requestArgs), /previously failed\/pending; automatic retry forbidden/u);
    assert.equal(f.networkCalls(), 0); assert.deepEqual(f.receipts(), []); f.assertOriginalAudit();
  });
});

test('request and response SHA mismatches cannot be revalidated even with the explicit option', async t => {
  for (const target of ['request', 'response']) await t.test(target, async subtest => {
    const f = fixture(subtest);
    fs.appendFileSync(path.join(f.directory, target === 'request' ? f.audit.requestFile : f.audit.responseFile), ' ');
    const client = transport(f.directory, f.identity, { revalidateResourceBounds: true });
    await assert.rejects(client.call(f.requestArgs), /(?:exact-request cache identity|response cache integrity) mismatch/u);
    assert.equal(f.networkCalls(), 0); assert.deepEqual(f.receipts(), []); f.assertOriginalAudit();
  });
});

test('actual cached response model and finish are validated independently of the prior audit metadata', async t => {
  const forbidden = [{ model: 'other/model' }, { choices: [{ finish_reason: 'length', message: { content: '{}' } }] }];
  for (const envelope of forbidden) await t.test(JSON.stringify(envelope), async subtest => {
    const f = fixture(subtest, { envelope }), client = transport(f.directory, f.identity, { revalidateResourceBounds: true });
    await assert.rejects(client.call(f.requestArgs), /cached response identity\/finish mismatch/u);
    assert.equal(f.networkCalls(), 0); assert.deepEqual(f.receipts(), []); f.assertOriginalAudit();
  });
});

test('current semantic/source coverage validation still fails without promoting the row or writing a receipt', async t => {
  const f = fixture(t), client = transport(f.directory, f.identity, { revalidateResourceBounds: true });
  let validations = 0;
  await assert.rejects(client.call({ ...f.requestArgs, validate: () => {
    validations++; throw new Error('Cross contract requires both sides in common draft: source coverage failed');
  } }), /source coverage failed/u);
  assert.equal(validations, 1);
  assert.equal(client.state().calls[0].accepted, false);
  assert.equal(client.state().calls[0].status, 'failed');
  assert.equal(f.networkCalls(), 0); assert.deepEqual(f.receipts(), []); f.assertOriginalAudit();
});

function deltaFixture(t, displayText) {
  const f = fixture(t, { audit: { phase: 'delta', name: 'guard-affected-facts-direct',
    failure: { name: 'Error', message: 'Invalid bounded text' } },
  envelope: { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ facts: [{ id: 'task:F1', displayText }] }) } }] } });
  f.requestArgs = { ...f.requestArgs, phase: 'delta', name: 'guard-affected-facts-direct', validate: raw => {
    if (!Array.isArray(raw.facts) || raw.facts.length !== 1 || raw.facts[0].id !== 'task:F1') throw new Error('Affected fact coverage mismatch');
    const value = raw.facts[0].displayText;
    if (typeof value !== 'string' || !value.trim() || value.length > 2000) throw new Error('Invalid bounded text');
    return raw;
  } };
  return f;
}

test('explicit delta text resource revalidation retains the entire 709-character response with immutable failure audit and no HTTP', async t => {
  const displayText = '条'.repeat(709), f = deltaFixture(t, displayText);
  const client = transport(f.directory, f.identity, { revalidateResourceBounds: true });
  const result = await client.call(f.requestArgs);
  assert.equal(result.value.facts[0].displayText, displayText);
  assert.equal(result.value.facts[0].displayText.length, 709);
  assert.equal(result.cached, true);
  assert.equal(client.state().calls.length, 1);
  assert.equal(client.state().calls[0].accepted, true);
  const receipt = JSON.parse(fs.readFileSync(path.join(f.directory, f.receipts()[0])));
  assert.equal(receipt.validationRevision, 'delta-text-resource-2000');
  assert.equal(receipt.modelOrNetworkRetry, false);
  assert.equal(receipt.semanticCoverageChecksUnchanged, true);
  assert.deepEqual(receipt.originalFailure, f.audit.failure);
  assert.equal(f.networkCalls(), 0); f.assertOriginalAudit();
});

test('delta revalidation retains current text type, nonempty and 2000-character bounds without promoting malformed responses', async t => {
  for (const [label, value] of [['empty', ''], ['whitespace', '   '], ['wrong-type', 709], ['over-limit', 'x'.repeat(2001)]])
    await t.test(label, async subtest => {
      const f = deltaFixture(subtest, value), client = transport(f.directory, f.identity, { revalidateResourceBounds: true });
      await assert.rejects(client.call(f.requestArgs), /Invalid bounded text/u);
      assert.equal(client.state().calls[0].accepted, false);
      assert.equal(client.state().calls[0].status, 'failed');
      assert.equal(f.networkCalls(), 0); assert.deepEqual(f.receipts(), []); f.assertOriginalAudit();
    });
});

test('explicit cross-contract text revalidation preserves a complete 2396-character contract and the original failure', async t => {
  const displayText = '界'.repeat(2396);
  const f = fixture(t, { audit: { phase: 'delta', name: 'guard-cross-contracts-direct',
    failure: { name: 'Error', message: 'Invalid bounded text' } }, envelope: {
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ contracts: [{ id: 'C1', displayText }] }) } }] } });
  const request = { ...f.requestArgs, phase: 'delta', name: 'guard-cross-contracts-direct', validate: raw => {
    assert.equal(raw.contracts.length, 1); assert.equal(raw.contracts[0].id, 'C1');
    assert.equal(typeof raw.contracts[0].displayText, 'string');
    assert.ok(raw.contracts[0].displayText.trim() && raw.contracts[0].displayText.length <= 4000);
    return raw;
  } };
  const client = transport(f.directory, f.identity, { revalidateResourceBounds: true });
  const result = await client.call(request);
  assert.equal(result.value.contracts[0].displayText, displayText);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory, f.receipts()[0]))).validationRevision,
    'delta-contract-text-resource-4000');
  assert.equal(client.state().calls.length, 1); assert.equal(f.networkCalls(), 0); f.assertOriginalAudit();
});
