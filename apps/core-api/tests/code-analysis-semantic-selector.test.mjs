import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepareArchitectureClaimSourceSelection, selectArchitectureClaimSources, ARCHITECTURE_SOURCE_SELECTION_PROTOCOL } from '../dist/code-analysis-semantic-selector.js';
import { createSemanticModelClient } from '../dist/code-analysis-semantic-model.js';
import { semanticDigest } from '../dist/code-analysis-semantic-source.js';
import { createArchitectureNativeRecoveryContext, ARCHITECTURE_NATIVE_CALL_RECOVERY_PROTOCOL } from '../dist/code-analysis-semantic-reachability.js';

const range = (start = 1, end = start, file = 'src/service.ts') => ({ path: file, line_start: start, line_end: end });
const definition = (id, start = 1, end = start, extra = {}) => ({ id, native_id: id, provider: 'codegraph', kind: 'function', label: id, path: 'src/service.ts', line_start: start, line_end: end, evidence_ids: [], verification: 'observed', ...extra });
const claim = (id = 'claim:one', evidence = [range(1, 1000)], extra = {}) => ({ id, node_id: 'module:workflow', field: `summary[${id}]`, text: '仅当前操作满足前置状态时继续，否则保留未完成状态。', kind: 'narrative', scope_context: { operation: '当前操作', node_field: 'summary' }, evidence, ...extra });
function fixture(claims = [claim()], nodes = [definition('native:operation', 10, 30)]) {
  return { snapshot: { snapshot_id: 'a'.repeat(64), manifest_sha256: 'b'.repeat(64), files: [{ path: 'src/service.ts', sha256: 'c'.repeat(64), line_count: 10000, byte_count: 100000 }] }, native: { nodes, edges: [] }, claims, parallel: async (items, action) => Promise.all(items.map(action)) };
}
function response(contexts, choose = context => context.candidates.slice(0, 1).map(item => item.definition_id)) {
  return { selections: contexts.map(context => {
    const selected_definition_ids = choose(context);
    return { context_id: context.context_id, claim_id: context.claim_id, text_sha256: context.text_sha256, catalog_sha256: context.catalog_sha256, page_sha256: context.page_sha256, selected_definition_ids, missing_reasons: selected_definition_ids.length ? [] : ['当前候选页不足以定位相应实现。'] };
  }) };
}
function mockClient(change, choose) {
  const requests = [];
  return { requests, client: { call: async request => {
    requests.push(request); const raw = response(request.input.contexts, choose); change?.(raw, request);
    return { value: request.validate(raw), cached: false };
  } } };
}

test('native recovery with no extra eligible definitions preserves its prior selection without a model request', async () => {
  const input = fixture(), first = await selectArchitectureClaimSources({ ...input, client: mockClient().client });
  const native_projection_sha256 = semanticDigest({ nodes: input.native.nodes, edges: input.native.edges, evidence: input.native.evidence });
  const context = { snapshot_id: input.snapshot.snapshot_id, manifest_sha256: input.snapshot.manifest_sha256, native_projection_sha256, catalog: () => ({ protocol: 'architecture-native-call-recovery-1.0.0', snapshot_id: input.snapshot.snapshot_id, manifest_sha256: input.snapshot.manifest_sha256, native_projection_sha256, anchor_definition_ids: ['native:operation'], eligible_definition_ids: ['native:operation'], reachable_definitions: [], catalog_sha256: 'e'.repeat(64) }) };
  const next = mockClient(), recovered = await selectArchitectureClaimSources({ ...input, client: next.client, recovery: { context, previous: first.claims } });
  assert.equal(next.requests.length, 0); assert.deepEqual(recovered.claims, first.claims); assert.equal(recovered.statistics.recovery_skipped_no_additional, 1);
});

test('native recovery rejects a previous selection bound to a different original claim', async () => {
  const input = fixture(), first = await selectArchitectureClaimSources({ ...input, client: mockClient().client });
  const previous = structuredClone(first.claims); previous[0].text += ' changed';
  const context = { snapshot_id: input.snapshot.snapshot_id, manifest_sha256: input.snapshot.manifest_sha256, native_projection_sha256: semanticDigest({ nodes: input.native.nodes, edges: input.native.edges, evidence: input.native.evidence }), catalog: () => { throw Error('must reject stale previous identity before catalog generation'); } };
  const next = mockClient();
  await assert.rejects(selectArchitectureClaimSources({ ...input, client: next.client, recovery: { context, previous } }), error => error.details?.reason === 'architecture_source_recovery_previous_identity');
  assert.equal(next.requests.length, 0);
});

function nativeRecoveryFixture() {
  const input = fixture([claim('claim:guard', [range(10, 30)], { text: '当前操作调用的校验函数会拒绝缺少提交材料的状态变更。' })]);
  input.snapshot.files.push({ path: 'src/transition.ts', sha256: 'd'.repeat(64), line_count: 100, byte_count: 1000 }, { path: 'src/guard.ts', sha256: 'e'.repeat(64), line_count: 100, byte_count: 1000 });
  input.native.nodes.push(definition('native:transition', 10, 30, { path: 'src/transition.ts' }), definition('native:guard', 10, 30, { path: 'src/guard.ts' }));
  input.native.evidence = input.native.nodes.map((node, index) => { node.evidence_ids = [`e:${index}`]; return { id: `e:${index}`, path: node.path, line_start: node.line_start, line_end: node.line_end, sha256: input.snapshot.files.find(file => file.path === node.path).sha256 }; });
  input.native.edges = [{ id: 'call:1', source: 'native:operation', target: 'native:transition', provider: 'codegraph', provenance: 'native', type: 'calls', verification: 'inferred', evidence_ids: [] }, { id: 'call:2', source: 'native:transition', target: 'native:guard', provider: 'codegraph', provenance: 'native', type: 'calls', verification: 'inferred', evidence_ids: [] }];
  return input;
}

test('optional native recovery selects a two-hop helper while preserving the default catalog, original evidence and versioned identities', async () => {
  const input = nativeRecoveryFixture(), before = semanticDigest(input.claims), initial = mockClient(undefined, () => []);
  const first = await selectArchitectureClaimSources({ ...input, client: initial.client });
  assert.equal(initial.requests[0].input.selector_protocol, ARCHITECTURE_SOURCE_SELECTION_PROTOCOL);
  assert.equal(initial.requests[0].input.contexts[0].candidates.some(candidate => candidate.definition_id === 'native:guard'), false);
  const context = createArchitectureNativeRecoveryContext(input), next = mockClient(undefined, item => item.candidates.filter(candidate => candidate.definition_id === 'native:guard').map(candidate => candidate.definition_id));
  const recovered = await selectArchitectureClaimSources({ ...input, client: next.client, recovery: { context, previous: first.claims } });
  const selected = recovered.claims[0], ledger = context.catalog(input.claims[0].evidence);
  assert.deepEqual(selected.primary_definition_ids, ['native:guard']); assert.deepEqual(selected.evidence, input.claims[0].evidence); assert.equal(semanticDigest(input.claims), before);
  assert.deepEqual(selected.selection_recovery, { protocol: ARCHITECTURE_NATIVE_CALL_RECOVERY_PROTOCOL, catalog_sha256: ledger.catalog_sha256 });
  assert.equal(selected.selection_claim_sha256, semanticDigest(input.claims[0]));
  assert.equal(selected.selection_sha256, semanticDigest({ protocol: 'architecture-primary-selection-1.2.0', snapshot_id: input.snapshot.snapshot_id, claim_id: selected.id, text_sha256: semanticDigest(selected.text), claim_sha256: selected.selection_claim_sha256, catalog_sha256: selected.selection_catalog_sha256, primary_definition_ids: ['native:guard'], selected_source_evidence: [], selection_recovery: selected.selection_recovery }));
  assert.deepEqual(recovered.selections[0].recovery_catalog.traversed_edges, input.native.edges);
  assert.equal(next.requests[0].input.selector_protocol, ARCHITECTURE_NATIVE_CALL_RECOVERY_PROTOCOL); assert.match(next.requests[0].input.task, /不证明调用实际执行/);
  assert.equal('supported' in selected, false); assert.equal('replacement_text' in selected, false);
  const after = await selectArchitectureClaimSources({ ...input, client: mockClient(undefined, () => []).client }); assert.deepEqual(after.claims, first.claims, 'recovery never changes initial selector identities');
});

test('recovery rejects a context for different native edges before a model request', async () => {
  const input = nativeRecoveryFixture(), first = await selectArchitectureClaimSources({ ...input, client: mockClient().client });
  const foreign = structuredClone({ snapshot: input.snapshot, native: input.native }); foreign.native.edges[0].target = 'native:guard'; const context = createArchitectureNativeRecoveryContext(foreign), next = mockClient();
  await assert.rejects(selectArchitectureClaimSources({ ...input, client: next.client, recovery: { context, previous: first.claims } }), error => error.details?.reason === 'architecture_source_recovery_context_identity');
  assert.equal(next.requests.length, 0);
});

test('recovery with extra candidates but unchanged normalized choices retains the previous claim and audits the actual attempt', async () => {
  const input = nativeRecoveryFixture(); input.claims[0].evidence.push(range(10, 30, 'src/transition.ts'));
  const choose = context => context.candidates.filter(candidate => candidate.definition_kind === 'source_reference' || ['native:operation', 'native:transition'].includes(candidate.definition_id)).map(candidate => candidate.definition_id);
  const first = await selectArchitectureClaimSources({ ...input, client: mockClient(undefined, choose).client }), previous = structuredClone(first.claims);
  previous[0].primary_definition_ids.reverse(); previous[0].selected_source_evidence.reverse();
  const before = JSON.stringify(previous), context = createArchitectureNativeRecoveryContext(input), next = mockClient(undefined, context => choose(context).reverse());
  const recovered = await selectArchitectureClaimSources({ ...input, client: next.client, recovery: { context, previous } });
  assert.equal(next.requests.length, 1, 'actual recovery lookup still occurs because extra native candidates exist');
  assert.equal(recovered.selections[0].recovery_catalog.reachable_definitions.length, 1);
  assert.equal(JSON.stringify(recovered.claims), before, 'the effective claim, including prior order and cache identity, remains byte-identical');
  assert.equal(recovered.selections[0].recovery_unchanged, true);
  assert.equal(recovered.selections[0].effective_selection_sha256, previous[0].selection_sha256);
  assert.notEqual(recovered.selections[0].selection_sha256, previous[0].selection_sha256, 'the attempted recovery identity remains separately auditable');
  assert.equal(recovered.selections[0].selection_recovery.protocol, ARCHITECTURE_NATIVE_CALL_RECOVERY_PROTOCOL);
  assert.equal(recovered.statistics.recovery_unchanged_selections, 1);
});

test('changing supplemental references requires a new recovery claim even when the primary definition stays the same', async () => {
  const input = nativeRecoveryFixture(), choose = context => context.candidates.filter(candidate => candidate.definition_id === 'native:operation' || candidate.definition_kind === 'source_reference').map(candidate => candidate.definition_id);
  const first = await selectArchitectureClaimSources({ ...input, client: mockClient(undefined, choose).client }), context = createArchitectureNativeRecoveryContext(input);
  const next = mockClient(undefined, context => context.candidates.filter(candidate => candidate.definition_id === 'native:operation').map(candidate => candidate.definition_id));
  const recovered = await selectArchitectureClaimSources({ ...input, client: next.client, recovery: { context, previous: first.claims } });
  assert.deepEqual(recovered.claims[0].primary_definition_ids, first.claims[0].primary_definition_ids);
  assert.notDeepEqual(recovered.claims[0].selected_source_evidence, first.claims[0].selected_source_evidence);
  assert.notEqual(recovered.claims[0].selection_sha256, first.claims[0].selection_sha256);
  assert.equal(recovered.claims[0].selection_recovery.protocol, ARCHITECTURE_NATIVE_CALL_RECOVERY_PROTOCOL);
  assert.notEqual(recovered.selections[0].recovery_unchanged, true);
});

function cacheFixture(t, count = 5) {
  const root = mkdtempSync(path.join(tmpdir(), 'tsp-selector-recovery-'));
  t.after(() => { assert.equal(path.dirname(root), path.resolve(tmpdir())); assert(path.basename(root).startsWith('tsp-selector-recovery-')); rmSync(root, { recursive: true, force: true }); });
  const runDirectory = path.join(root, 'run'), cacheDirectory = path.join(root, 'cache'); mkdirSync(runDirectory); mkdirSync(cacheDirectory);
  const input = fixture(Array.from({ length: count }, (_, index) => claim(`claim:${index}`, [range(1, 4, `src/feature${index}.ts`)])), Array.from({ length: count }, (_, index) => definition(`native:${index}`, 1, 4, { path: `src/feature${index}.ts` })));
  input.snapshot.files = input.native.nodes.map(node => ({ path: node.path, sha256: semanticDigest(node.path), line_count: 4, byte_count: 100 }));
  return { ...input, runDirectory, cacheDirectory };
}
function cachedClient(input, calls, options = {}) {
  const model = options.model ?? 'route/model';
  return createSemanticModelClient({ snapshotId: input.snapshot.snapshot_id, engineIdentity: 'same-native-engine', runDirectory: input.runDirectory, cacheDirectory: input.cacheDirectory,
    config: { modelUrl: 'http://127.0.0.1:1/v1', model, apiKey: '', cacheOriginModels: options.cacheOriginModels },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body), prompt = JSON.parse(body.messages[1].content); calls.push(prompt); assert.equal(body.max_tokens, 16000);
      const result = options.reply?.(prompt) ?? { finish: 'stop', content: JSON.stringify(response(prompt.contexts)) };
      return new Response(JSON.stringify({ model: model.split('/').at(-1), choices: [{ finish_reason: result.finish, message: { content: result.content } }] }));
    } });
}

test('truncated selection responses split intact contexts without parsing or caching the partial parent', async t => {
  const input = cacheFixture(t, 4), calls = [], client = cachedClient(input, calls, { reply: prompt => prompt.contexts.length > 2
    ? { finish: 'length', content: '{"selections":[{"context_id":"foreign-partial"}' }
    : { finish: 'stop', content: JSON.stringify(response(prompt.contexts)) } });
  const original = prepareArchitectureClaimSourceSelection(input), progress = [], result = await selectArchitectureClaimSources({ ...input, client, onProgress: async (...value) => { progress.push(value); } });
  assert.deepEqual(calls.map(prompt => prompt.contexts.length), [4, 2, 2]);
  assert.deepEqual(calls.slice(1).flatMap(prompt => prompt.contexts), original.pages[0], 'every candidate, identity and context is retained exactly');
  assert.equal(result.claims.length, 4); assert.equal(result.statistics.output_truncation_partitions, 1); assert.equal(result.statistics.contexts_evaluated, 4);
  assert.deepEqual(progress, [[0, 1], [1, 1]], 'progress remains based on the original planned pages');
  const caches = readdirSync(input.cacheDirectory).map(file => JSON.parse(readFileSync(path.join(input.cacheDirectory, file))));
  assert.equal(caches.some(cache => cache.output.selections.length === 4), false); assert(caches.every(cache => !JSON.stringify(cache).includes('foreign-partial')));
  const auditFile = readdirSync(input.runDirectory).find(file => file.startsWith('semantic-source-selection-partition-'));
  const audit = JSON.parse(readFileSync(path.join(input.runDirectory, auditFile)));
  assert.equal(audit.partitions[0].reason, 'output_truncated'); assert.deepEqual(audit.partitions[0].children.flat(), original.pages[0].map(context => context.context_id));
  assert.equal(audit.partitions[0].request_sha256, semanticDigest({ analysis_phase: 'architecture-source-select', ...calls[0] }));
});

test('singleton truncation, non-truncation failures and cancellation propagate without caching incomplete selections', async t => {
  const single = cacheFixture(t, 1), calls = [], client = cachedClient(single, calls, { reply: () => ({ finish: 'length', content: '{' }) });
  await assert.rejects(selectArchitectureClaimSources({ ...single, client }), error => error.details.reason === 'output_truncated');
  assert.equal(calls.length, 1); assert.deepEqual(readdirSync(single.cacheDirectory), []);
  assert.equal(readdirSync(single.runDirectory).some(file => file.startsWith('semantic-source-selection-partition-')), false);
  for (const code of ['code_analysis_cancelled', 'code_analysis_model_failed']) {
    const input = cacheFixture(t, 4), failure = Object.assign(new Error('bounded failure'), { code }), bad = { call: async () => { throw failure; } };
    await assert.rejects(selectArchitectureClaimSources({ ...input, client: bad }), error => error === failure);
    assert.deepEqual(readdirSync(input.cacheDirectory), []);
  }
  const invalid = cacheFixture(t, 4), invalidCalls = [], wrong = cachedClient(invalid, invalidCalls, { reply: prompt => {
    const raw = response(prompt.contexts); raw.selections[0].selected_definition_ids = ['native:foreign']; return { finish: 'stop', content: JSON.stringify(raw) };
  } });
  await assert.rejects(selectArchitectureClaimSources({ ...invalid, client: wrong }), error => error.details.reason === 'schema');
  assert.equal(invalidCalls.length, 2); assert.deepEqual(readdirSync(invalid.cacheDirectory), []);
});

test('validated singleton selection caches survive regrouping and only changed source identities require a new request', async t => {
  const input = cacheFixture(t), calls = [], client = cachedClient(input, calls);
  const first = await selectArchitectureClaimSources({ ...input, client }); assert.equal(calls.length, 1); assert.equal(first.statistics.contexts_evaluated, 5);
  const subset = { ...input, claims: [input.claims[4], input.claims[1], input.claims[0]] };
  const second = await selectArchitectureClaimSources({ ...subset, client });
  assert.equal(calls.length, 1); assert.equal(second.statistics.contexts_cached, 3); assert.equal(second.statistics.contexts_evaluated, 0);
  const changed = { ...input, snapshot: structuredClone(input.snapshot) }; changed.snapshot.files[1].sha256 = 'f'.repeat(64);
  const third = await selectArchitectureClaimSources({ ...changed, client });
  assert.equal(calls.length, 2); assert.deepEqual(calls[1].contexts.map(context => context.claim_id), [input.claims[1].id]);
  assert.equal(third.statistics.contexts_cached, 4); assert.equal(third.statistics.contexts_evaluated, 1);
});

test('existing validated group caches derive singleton rows with their actual model origin', async t => {
  const input = cacheFixture(t, 4), oldCalls = [], old = cachedClient(input, oldCalls, { model: 'route/old' });
  await selectArchitectureClaimSources({ ...input, client: { ...old, cacheRequest: undefined, save: undefined } });
  assert.equal(oldCalls.length, 1); assert.equal(readdirSync(input.cacheDirectory).length, 1, 'fixture seeds only the existing complete grouped checkpoint');
  const calls = [], next = cachedClient(input, calls, { model: 'route/new', cacheOriginModels: ['route/old'] });
  const first = await selectArchitectureClaimSources({ ...input, client: next });
  assert.equal(calls.length, 0); assert.equal(first.statistics.concrete_cached_groups, 1); assert.equal(first.statistics.contexts_cached, 4);
  const second = await selectArchitectureClaimSources({ ...input, claims: [input.claims[3], input.claims[0]], client: next });
  assert.equal(second.statistics.contexts_cached, 2); assert.equal(calls.length, 0);
  const saved = readdirSync(input.cacheDirectory).map(file => JSON.parse(readFileSync(path.join(input.cacheDirectory, file))));
  assert.equal(saved.filter(cache => cache.output.selections.length === 1).length, 4); assert(saved.every(cache => cache.model === 'old'));
  assert(next.metrics().provenance.origins.every(origin => origin.requested_model === 'route/old'));
  const withoutOrigin = [], fresh = await selectArchitectureClaimSources({ ...input, client: cachedClient(input, withoutOrigin, { model: 'route/new' }) });
  assert.equal(withoutOrigin.length, 1); assert.equal(fresh.statistics.contexts_evaluated, 4);
});

test('cached singleton selections revalidate raw candidate vocabulary and invalid parent groups derive no rows', async t => {
  const input = cacheFixture(t, 2), calls = [], client = cachedClient(input, calls); await selectArchitectureClaimSources({ ...input, client });
  const files = readdirSync(input.cacheDirectory).map(file => ({ file, data: JSON.parse(readFileSync(path.join(input.cacheDirectory, file))) }));
  const one = files.find(({ data }) => data.output.selections.length === 1 && data.output.selections[0].claim_id === input.claims[0].id);
  one.data.output.selections[0].selected_definition_ids = ['native:foreign']; one.data.output_sha256 = semanticDigest(one.data.output); writeFileSync(path.join(input.cacheDirectory, one.file), JSON.stringify(one.data));
  const result = await selectArchitectureClaimSources({ ...input, client });
  assert.equal(calls.length, 2); assert.equal(result.statistics.contexts_cached, 1); assert.equal(result.statistics.contexts_evaluated, 1); assert.equal(calls[1].contexts.length, 1);
  const rejected = cacheFixture(t, 2), rejectedCalls = [], bad = cachedClient(rejected, rejectedCalls, { reply: prompt => {
    const raw = response(prompt.contexts); raw.selections[1].claim_id = raw.selections[0].claim_id; return { finish: 'stop', content: JSON.stringify(raw) };
  } });
  await assert.rejects(selectArchitectureClaimSources({ ...rejected, client: bad }), { code: 'code_analysis_model_invalid' });
  assert.equal(rejectedCalls.length, 2); assert.deepEqual(readdirSync(rejected.cacheDirectory), [], 'a valid sibling row in a rejected group cannot seed a checkpoint');
});

test('narrow operation selection excludes an enclosing factory explicitly and keeps the claim and exact selected body immutable', async () => {
  const input = fixture([claim('claim:narrow', [range(120, 125)])], [definition('native:factory', 1, 900), definition('native:operation', 100, 200, { kind: 'method' }), definition('native:unrelated', 300, 400)]), before = structuredClone(input.claims);
  const mock = mockClient(), result = await selectArchitectureClaimSources({ ...input, client: mock.client });
  assert.deepEqual(input.claims, before); assert.deepEqual(result.claims[0].primary_definition_ids, ['native:operation']); assert.deepEqual(result.claims[0].evidence, before[0].evidence);
  for (const field of ['id', 'node_id', 'field', 'text', 'kind', 'scope_context']) assert.deepEqual(result.claims[0][field], before[0][field]);
  assert.deepEqual(result.selections[0].excluded_containers, [{ definition_id: 'native:factory', reason: 'outer_container_of_narrow_operation', nested_definition_ids: ['native:operation'] }]);
  assert.deepEqual(mock.requests[0].input.contexts[0].candidates.filter(item => item.definition_kind !== 'source_reference').map(item => item.definition_id), ['native:operation']);
  assert.deepEqual(result.selections[0].candidates.filter(item => item.definition_kind !== 'source_reference').map(item => item.definition_id), ['native:operation', 'native:factory']);
  assert.equal(result.claims[0].selection_claim_sha256, semanticDigest(before[0]));
  assert.equal(result.claims[0].selection_sha256, semanticDigest({ protocol: 'architecture-primary-selection-1.1.0', snapshot_id: input.snapshot.snapshot_id, claim_id: before[0].id, text_sha256: semanticDigest(before[0].text), claim_sha256: semanticDigest(before[0]), catalog_sha256: result.claims[0].selection_catalog_sha256, primary_definition_ids: ['native:operation'], selected_source_evidence: [] }));
  result.claims[0].scope_context.operation = '调用者修改'; result.claims[0].evidence[0].line_start = 999;
  assert.deepEqual(input.claims, before); assert.deepEqual(result.selections[0].original_claim, before[0]); assert.deepEqual(result.selections[0].selected_evidence, [range(100, 200)]);
});

test('wide evidence retains the enclosing operation catalog and testing candidates never acquire a proof verdict', async () => {
  const input = fixture([claim()], [definition('native:factory', 1, 900), definition('native:inner', 100, 200), definition('native:test', 10, 30, { path: 'src/service.test.ts' })]);
  input.snapshot.files.push({ path: 'src/service.test.ts', sha256: 'd'.repeat(64), line_count: 100, byte_count: 1000 });
  input.claims[0].evidence.push(range(1, 100, 'src/service.test.ts'));
  const mock = mockClient(), result = await selectArchitectureClaimSources({ ...input, client: mock.client });
  assert.equal(result.statistics.original_candidates, 5); assert.equal(result.statistics.excluded_containers, 0);
  assert.equal(mock.requests[0].input.contexts[0].candidates.find(item => item.definition_id === 'native:test').source_kind, 'test');
  assert.equal('status' in result.selections[0], false); assert.equal('supported' in result.claims[0], false); assert.equal('replacement' in result.claims[0], false);
  assert.match(mock.requests[0].input.task, /不是事实校验/); assert.match(mock.requests[0].input.task, /不能作为运行时行为/);
});

test('selector rejects unknown, duplicate, cross-claim and stale identities without approving or rewriting claims', async () => {
  const input = fixture([claim('claim:first', [range(1, 10)]), claim('claim:second', [range(30, 40)], { text: '另一个原操作保持自己的状态边界。' })], [definition('native:first', 1, 10), definition('native:second', 30, 40)]);
  const changes = [
    raw => { raw.selections[0].selected_definition_ids = ['native:foreign']; },
    raw => { raw.selections[0].selected_definition_ids = ['native:second']; },
    raw => { raw.selections[0].selected_definition_ids.push(raw.selections[0].selected_definition_ids[0]); },
    raw => { raw.selections[1] = structuredClone(raw.selections[0]); },
    raw => { raw.selections.pop(); },
    raw => { raw.selections[0].text_sha256 = raw.selections[1].text_sha256; },
    raw => { raw.selections[0].catalog_sha256 = raw.selections[1].catalog_sha256; },
    raw => { raw.selections[0].page_sha256 = raw.selections[1].page_sha256; },
    raw => { raw.selections[0].claim_id = raw.selections[1].claim_id; },
    raw => { raw.selections[0].supported = true; },
    raw => { raw.selections[0].replacement = '禁止产生替换规则'; },
    raw => { raw.selections[0].selected_definition_ids = []; raw.selections[0].missing_reasons = []; },
  ];
  for (const change of changes) { const mock = mockClient(change); await assert.rejects(selectArchitectureClaimSources({ ...input, client: mock.client }), { code: 'code_analysis_model_invalid' }); }
  await assert.rejects(selectArchitectureClaimSources({ ...input, claims: [input.claims[0], input.claims[0]], client: mockClient().client }), error => error.details.reason === 'architecture_source_selection_claim_identity');
});

test('empty retrieval preserves immutable original evidence for later source review without claiming an operation was found', async () => {
  const noCandidates = fixture([claim('claim:missing', [range(800, 900)])]), mock = mockClient(undefined, () => []), result = await selectArchitectureClaimSources({ ...noCandidates, client: mock.client });
  assert.equal(mock.requests.length, 1, 'original references are offered even when no native operation overlaps'); assert.equal(result.claims.length, 1); assert.deepEqual(result.claims[0].evidence, noCandidates.claims[0].evidence); assert.deepEqual(result.claims[0].primary_definition_ids, []); assert.deepEqual(result.claims[0].selected_source_evidence, []); assert.ok(result.selections[0].missing_reasons.length);
  const noChoice = mockClient(undefined, () => []), unselected = await selectArchitectureClaimSources({ ...fixture(), client: noChoice.client });
  assert.deepEqual(unselected.claims[0].evidence, fixture().claims[0].evidence); assert.deepEqual(unselected.claims[0].primary_definition_ids, []); assert.equal(unselected.statistics.empty_selections, 1); assert.ok(unselected.selections[0].missing_reasons.length);
});

test('source-definition scope and native declaration locations remain bound to the exact original claim', async () => {
  const original = claim('claim:contract', [range(100, 110)], { assertion_scope: 'source_definition' });
  const input = fixture([original], [definition('native:contract', 100, 110, { kind: 'interface' })]), mock = mockClient();
  const result = await selectArchitectureClaimSources({ ...input, client: mock.client });
  assert.deepEqual(result.claims[0].evidence, original.evidence); assert.equal(result.claims[0].assertion_scope, 'source_definition');
  assert.equal(mock.requests[0].input.contexts[0].assertion_scope, 'source_definition');
  assert.equal(mock.requests[0].input.contexts[0].candidates[0].definition_kind, 'interface');
  assert.equal(result.claims[0].selection_claim_sha256, semanticDigest(original));
  const invalid = fixture([original], [definition('native:bad', 100, 20000, { kind: 'variable' })]);
  assert.throws(() => prepareArchitectureClaimSourceSelection(invalid), error => error.details.reason === 'architecture_source_selection_native_range');
  assert.throws(() => prepareArchitectureClaimSourceSelection(fixture([{ ...original, assertion_scope: 'runtime' }])), error => error.details.reason === 'architecture_source_selection_claim_identity');
});

test('mixed native and exact original reference selections retain immutable provenance without making references primary definitions', async () => {
  const references = [range(10, 30), range(1, 20, 'README.md'), range(1, 40, '.github/workflows/check.yml'), range(1, 15, 'tests/access.test.ts'), range(1, 5, 'src/types.ts')];
  const input = fixture([claim('claim:mixed', references)]);
  for (const ref of references.slice(1)) input.snapshot.files.push({ path: ref.path, sha256: semanticDigest(ref.path), line_count: ref.line_end, byte_count: 2000 });
  const before = semanticDigest(input), mock = mockClient(undefined, context => context.candidates.map(item => item.definition_id));
  const result = await selectArchitectureClaimSources({ ...input, client: mock.client }), selection = result.selections[0];
  assert.equal(semanticDigest(input), before); assert.deepEqual(selection.original_claim, input.claims[0]);
  assert.deepEqual(result.claims[0].primary_definition_ids, ['native:operation']);
  const ordered = [...references].sort((a, b) => a.path.localeCompare(b.path) || a.line_start - b.line_start || a.line_end - b.line_end);
  assert.deepEqual(result.claims[0].selected_source_evidence, ordered); assert.deepEqual(selection.selected_source_evidence, ordered);
  assert.equal(selection.selected_evidence.length, references.length, 'identical native and original reference ranges are not duplicated');
  const rawCandidates = selection.candidates.filter(item => item.definition_kind === 'source_reference');
  assert.equal(rawCandidates.length, references.length);
  for (const candidate of rawCandidates) {
    const file = input.snapshot.files.find(item => item.path === candidate.path);
    assert.equal(candidate.definition_id, 'ER-' + semanticDigest({ protocol: 'architecture-reference-source-1.0.0', snapshot_id: input.snapshot.snapshot_id, path: candidate.path, line_start: candidate.line_start, line_end: candidate.line_end, file_sha256: file.sha256 }));
    assert.equal(candidate.file_sha256, file.sha256); assert.equal('text' in candidate, false);
  }
  assert.equal(rawCandidates.find(item => item.path === 'tests/access.test.ts').source_kind, 'test');
  assert.equal(rawCandidates.find(item => item.path.endsWith('.yml')).source_kind, 'document');
  assert.equal(rawCandidates.find(item => item.path === 'src/types.ts').source_kind, 'code');
  assert.equal('supported' in selection, false); assert.equal('status' in result.claims[0], false);
  const altered = { ...input, snapshot: structuredClone(input.snapshot) }; altered.snapshot.files.find(item => item.path === 'README.md').sha256 = 'f'.repeat(64);
  const changed = await selectArchitectureClaimSources({ ...altered, parallel: input.parallel, client: mockClient().client });
  assert.notEqual(changed.claims[0].selection_catalog_sha256, result.claims[0].selection_catalog_sha256);
});

test('atomic retrieval omits paragraph prose but preserves it in immutable identity and permits a sole complete enclosing factory', async () => {
  const text = '绑定操作先校验当前状态，再处理同一基线。', paragraph = text + '其他操作包括启动、提交、取消和交接。';
  const original = claim('claim:bind', [range(120, 125)], { text, scope_context: { name: '任务闭环', field: 'flows.0.summary', field_text: paragraph, field_span: [0, text.length] } });
  const input = fixture([original], [definition('native:factory', 1, 900)]), before = semanticDigest(input.claims);
  const mock = mockClient(undefined, context => context.candidates.filter(item => item.definition_kind !== 'source_reference').map(item => item.definition_id));
  const result = await selectArchitectureClaimSources({ ...input, client: mock.client }), wire = mock.requests[0].input.contexts[0];
  assert.equal(wire.text, text); assert.equal('field_text' in wire.scope_context, false); assert.deepEqual(wire.scope_context.field_span, [0, text.length]);
  assert.match(mock.requests[0].input.task, /context\.text/); assert.match(mock.requests[0].input.task, /最小完整外层工厂/);
  assert.deepEqual(result.claims[0].primary_definition_ids, ['native:factory']); assert.deepEqual(result.claims[0].selected_source_evidence, []);
  assert.deepEqual(result.selections[0].excluded_containers, []); assert.equal(result.selections[0].original_claim.scope_context.field_text, paragraph);
  assert.equal(semanticDigest(input.claims), before); assert.equal(result.claims[0].selection_claim_sha256, semanticDigest(original));
});

test('a partial nested definition or local declaration does not exclude the complete enclosing operation', () => {
  const original = claim('claim:unindexed-method', [range(120, 150)]);
  for (const nested of [definition('native:local', 125, 125, { kind: 'variable' }), definition('native:partial-helper', 125, 135)]) {
    const prepared = prepareArchitectureClaimSourceSelection(fixture([original], [definition('native:factory', 1, 900), nested]));
    assert.deepEqual(prepared.plans[0].excluded_containers, []);
    assert(prepared.plans[0].eligible.some(candidate => candidate.definition_id === 'native:factory'));
  }
});

test('foreign original references and native/reference ID collisions fail closed', async () => {
  const input = fixture([claim('claim:first', [range(1, 10)]), claim('claim:second', [range(30, 40)])]);
  const cross = mockClient((raw, request) => { raw.selections[0].selected_definition_ids = [request.input.contexts[1].candidates.find(item => item.definition_kind === 'source_reference').definition_id]; });
  await assert.rejects(selectArchitectureClaimSources({ ...input, client: cross.client }), { code: 'code_analysis_model_invalid' });
  const ref = input.claims[0].evidence[0], id = 'ER-' + semanticDigest({ protocol: 'architecture-reference-source-1.0.0', snapshot_id: input.snapshot.snapshot_id, ...ref, file_sha256: input.snapshot.files[0].sha256 });
  const collision = fixture([input.claims[0]], [definition(id, 1, 10)]);
  assert.throws(() => prepareArchitectureClaimSourceSelection(collision), error => error.details.reason === 'architecture_source_selection_native_identity');
});

test('selector packs at most eight unchanged claims and measures the complete request including schema within 125KB', async () => {
  const input = fixture(Array.from({ length: 17 }, (_, i) => claim(`claim:${i}`))), before = semanticDigest(input.claims), prepared = prepareArchitectureClaimSourceSelection(input), mock = mockClient(), result = await selectArchitectureClaimSources({ ...input, client: mock.client });
  assert.deepEqual(mock.requests.map(request => request.input.contexts.length), [8, 8, 1]); assert.equal(result.claims.length, 17);
  assert.deepEqual(prepared.pages, mock.requests.map(request => request.input.contexts));
  assert.deepEqual(prepared.statistics.request_bytes, mock.requests.map(request => Buffer.byteLength(JSON.stringify({ analysis_phase: request.phase, ...request.input }))));
  for (const [key, value] of Object.entries(prepared.statistics)) assert.deepEqual(result.statistics[key], value);
  assert.equal(semanticDigest(input.claims), before);
  assert.deepEqual(result.claims.map(item => item.id), input.claims.map(item => item.id));
  for (const request of mock.requests) {
    assert.equal(request.phase, 'architecture-source-select'); assert.equal(request.maxTokens, 16000); assert.equal(request.input.selector_protocol, ARCHITECTURE_SOURCE_SELECTION_PROTOCOL);
    assert.ok(Buffer.byteLength(JSON.stringify({ analysis_phase: request.phase, ...request.input })) <= 125000);
    assert.equal(new Set(request.input.contexts.map(item => item.claim_id)).size, request.input.contexts.length);
  }
});

test('oversized catalogs split whole candidates deterministically without dropping a candidate or silently exceeding the final selection bound', async () => {
  const nodes = Array.from({ length: 800 }, (_, index) => definition(`native:${index}:` + 'x'.repeat(420), index * 2 + 1, index * 2 + 1, { label: 'operation-' + 'y'.repeat(270) })), input = fixture([claim('claim:large', [range(1, 2000)])], nodes);
  const choose = context => context.page === 1 ? [context.candidates[0].definition_id] : [], mock = mockClient(undefined, choose), result = await selectArchitectureClaimSources({ ...input, client: mock.client });
  assert.ok(mock.requests.length > 1); assert.equal(result.selections[0].candidates.length, nodes.length + 1); assert.equal(result.claims[0].primary_definition_ids.length, 1);
  const allContexts = mock.requests.flatMap(request => request.input.contexts), allCandidates = allContexts.flatMap(context => context.candidates.map(item => item.definition_id));
  assert.equal(new Set(allCandidates).size, nodes.length + 1); assert.equal(allCandidates.length, nodes.length + 1); assert.equal(allContexts.length, result.statistics.catalog_pages);
  assert.deepEqual(allContexts.map(context => context.page), allContexts.map((_, index) => index + 1)); assert.ok(allContexts.every(context => context.pages === allContexts.length));
  assert.ok(mock.requests.every(request => Buffer.byteLength(JSON.stringify({ analysis_phase: request.phase, ...request.input })) <= 125000));
  const repeated = mockClient(undefined, choose); await selectArchitectureClaimSources({ ...input, native: { ...input.native, nodes: [...nodes].reverse() }, client: repeated.client });
  assert.deepEqual(repeated.requests.map(request => semanticDigest(request.input)), mock.requests.map(request => semanticDigest(request.input)));
  assert.ok(allContexts.length > 8, 'fixture must exercise a genuinely ambiguous union across more than eight complete candidate pages');
  await assert.rejects(selectArchitectureClaimSources({ ...input, client: mockClient().client }), error => error.details.reason === 'architecture_source_selection_ambiguous');
});

test('an oversized indivisible claim fails before any model call instead of cropping text or source candidates', async () => {
  const input = fixture([claim('claim:oversized', undefined, { scope_context: { required: '完整上下文'.repeat(15000) } })]), mock = mockClient();
  await assert.rejects(selectArchitectureClaimSources({ ...input, client: mock.client }), error => error.details.reason === 'architecture_source_selection_input_budget'); assert.equal(mock.requests.length, 0);
});

test('cached retrieval is bound to the unchanged claim and complete candidate catalog, with private auditable bindings', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'tsp-source-selector-'));
  t.after(() => { assert.equal(path.dirname(root), path.resolve(tmpdir())); assert.ok(path.basename(root).startsWith('tsp-source-selector-')); rmSync(root, { recursive: true, force: true }); });
  const runDirectory = path.join(root, 'run'), cacheDirectory = path.join(root, 'cache'); mkdirSync(runDirectory); mkdirSync(cacheDirectory);
  const input = fixture(); let calls = 0;
  const client = createSemanticModelClient({ snapshotId: input.snapshot.snapshot_id, engineIdentity: 'same-native-engine', runDirectory, cacheDirectory, config: { modelUrl: 'http://127.0.0.1:1/v1', model: 'route/model', apiKey: '' }, fetchImpl: async (_url, request) => {
    calls++; const body = JSON.parse(request.body), prompt = JSON.parse(body.messages[1].content); assert.equal(body.max_tokens, 16000); assert.equal(body.reasoning_effort, 'low');
    return new Response(JSON.stringify({ model: 'model', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(response(prompt.contexts)) } }] }));
  } });
  const first = await selectArchitectureClaimSources({ ...input, client, runDirectory }), second = await selectArchitectureClaimSources({ ...input, client, runDirectory });
  assert.equal(calls, 1); assert.equal(second.statistics.cached_requests, 1); assert.deepEqual(first.claims, second.claims);
  const report = JSON.parse(readFileSync(path.join(runDirectory, 'semantic-source-selections.json'))); assert.equal(report.snapshot_id, input.snapshot.snapshot_id); assert.deepEqual(report.selections[0].original_claim, input.claims[0]); assert.equal(report.selections[0].candidates.length, 2); assert.equal('text' in report.selections[0].candidates[0], false);
  const changed = { ...input, native: structuredClone(input.native) }; changed.native.nodes[0].label = 'Different complete catalog';
  const altered = await selectArchitectureClaimSources({ ...changed, client }); assert.equal(calls, 2); assert.notEqual(altered.claims[0].selection_catalog_sha256, first.claims[0].selection_catalog_sha256);
  const changedText = { ...input, claims: structuredClone(input.claims) }; changedText.claims[0].text += ' 仍需独立校验。';
  await selectArchitectureClaimSources({ ...changedText, client }); assert.equal(calls, 3);
});
