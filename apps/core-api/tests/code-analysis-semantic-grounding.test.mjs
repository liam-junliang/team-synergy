import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GROUNDING_BINDING_RESPONSE_PROTOCOL, STATIC_CONDITIONAL_SOURCE_SEMANTICS, architectureClaimRequiresSourceSupport, decodeSemanticArchitectureGroundingResponse, formatSemanticArchitectureGroundingSources, groundingSelectionDigest, prepareLegacySemanticArchitectureGroundingRequest, prepareSemanticArchitectureGrounding, prepareSemanticArchitectureGroundingRequest, reviewSemanticArchitectureClaims, splitSemanticArchitectureGroundingGroups } from '../dist/code-analysis-semantic-grounding.js';
import { parseClaimBindings } from '../dist/code-analysis-semantic-claim-bindings.js';
import { selectArchitectureClaimSources } from '../dist/code-analysis-semantic-selector.js';
import { createSemanticModelClient, semanticInferencePolicy } from '../dist/code-analysis-semantic-model.js';
import { semanticDigest } from '../dist/code-analysis-semantic-source.js';
import { createArchitectureNativeRecoveryContext } from '../dist/code-analysis-semantic-reachability.js';

test('workflow order and relation direction require source support without depending on permission keywords', () => {
  const claim = { kind: 'narrative', text: 'The browser forwards a message into the embedded frame.' };
  for (const field of ['flows.2.summary:0-65', 'flows.2.steps.0.description:0-65', 'relations.4.description:0-65']) assert.equal(architectureClaimRequiresSourceSupport({ ...claim, field }), true);
  assert.equal(architectureClaimRequiresSourceSupport({ ...claim, field: 'modules.2.summary:0-65' }), false);
  assert.equal(architectureClaimRequiresSourceSupport({ ...claim, field: 'modules.2.summary:0-65', text: 'Only an owner may change this state.' }), true);
});

function fixture(t, contents = {
  'caller.ts': 'import { canManage } from "./access.js";\nexport function closeRecord(actor) {\n  if (!canManage(actor)) throw Error("forbidden");\n  return "closed";\n}\n',
  'access.ts': 'export function canManage(actor) {\n  return actor.role === "manager";\n}\n',
}) {
  const root = mkdtempSync(path.join(tmpdir(), 'tsp-architecture-grounding-'));
  t.after(() => { assert.equal(path.dirname(root), path.resolve(tmpdir())); assert.ok(path.basename(root).startsWith('tsp-architecture-grounding-')); rmSync(root, { recursive: true, force: true }); });
  const sourceDirectory = path.join(root, 'source'), runDirectory = path.join(root, 'run'), cacheDirectory = path.join(root, 'cache');
  mkdirSync(sourceDirectory); mkdirSync(runDirectory); mkdirSync(cacheDirectory);
  const files = Object.entries(contents).map(([file, text]) => { const location = path.join(sourceDirectory, file); mkdirSync(path.dirname(location), { recursive: true }); writeFileSync(location, text); return { path: file, sha256: semanticDigest(Buffer.from(text)), byte_count: Buffer.byteLength(text), line_count: text.split('\n').length }; });
  return { root, sourceDirectory, runDirectory, cacheDirectory, snapshot: { snapshot_id: 'a'.repeat(64), manifest_sha256: semanticDigest(files), files },
    native: { nodes: [{ id: 'cg:close', kind: 'function', label: 'closeRecord', path: 'caller.ts', line_start: 2, line_end: 5 }, { id: 'cg:manage', kind: 'function', label: 'canManage', path: 'access.ts', line_start: 1, line_end: 3 }], edges: [{ id: 'cg:call', source: 'cg:close', target: 'cg:manage', type: 'calls' }] },
    claims: [{ id: 'flow:close/summary', node_id: 'flow:close', field: '$.flows[0]', text: 'A reviewer may verify and close the record.', evidence: [{ path: 'caller.ts', line_start: 3, line_end: 4 }], kind: 'narrative', scope_context: { name: 'Review completion', responsibility: 'Verify records; management performs closing.' } }] };
}
const parallel = async (items, action) => Promise.all(items.map(action));
function hydrate(request) {
  const sources = new Map(request.source_catalog.map(source => [source.id, source])), dependencies = request.dependency_catalog;
  const callers = new Map(dependencies.callers.map(row => [row.id, row])), boundaries = new Map(dependencies.call_boundaries.map(row => [row.id, row]));
  const imports = new Map(dependencies.package_imports.map(row => [row.id, row])), proofs = new Map(dependencies.package_sources.map(row => [row.id, row]));
  return { ...request, contexts: request.contexts.map(context => ({ ...context,
    sources: context.sources.map(metadata => { const source = sources.get(metadata.id); const { text: _text, ...expected } = source; assert.deepEqual(metadata, expected); return source; }),
    unexpanded_call_boundaries: context.unexpanded_call_boundaries.map(row => { const caller = callers.get(row.caller_ref), { id: _id, ...boundary } = boundaries.get(row.boundary_ref); return { caller_definition_id: caller.definition_id, caller: caller.label, ...boundary }; }),
    resolved_package_imports: context.resolved_package_imports.map(row => { const caller = callers.get(row.caller_ref), { id: _id, proof_refs, ...symbol } = imports.get(row.import_ref); return { ...symbol, proof: proof_refs.map(id => { const { id: _id, ...proof } = proofs.get(id); return proof; }), caller_definition_id: caller.definition_id }; }),
  })) };
}
function row(context, status = 'supported', ids = context.sources.map(source => source.id)) {
  return { context_id: context.context_id, claim_id: context.claim_id, text_sha256: context.text_sha256, status, reason: status === 'contradicted' ? 'The actual guard requires management; reviewing does not grant that permission.' : 'The provided complete code establishes this scope.', evidence_ids: ids };
}
function envelope(request, checks) {
  return request.grounding_response_protocol ? { checks: Object.fromEntries(checks.map(({ context_id, ...value }) => [context_id, value])) } : { checks };
}
function client(input, decide = request => request.contexts.map(context => row(context)), calls = [], options = {}) {
  const model = options.model ?? 'deepseek-v4.1-flash';
  return createSemanticModelClient({ config: { modelUrl: 'http://127.0.0.1:3425/v1', model, apiKey: '', cacheOriginModels: options.cacheOriginModels }, snapshotId: input.snapshot.snapshot_id, engineIdentity: options.engineIdentity ?? 'grounding-fixture', runDirectory: input.runDirectory, cacheDirectory: input.cacheDirectory,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body), request = JSON.parse(body.messages[1].content); calls.push(request);
      assert.equal(body.max_tokens, 32768); assert(Buffer.byteLength(JSON.stringify(request)) <= 140_000);
      return new Response(JSON.stringify({ model, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(envelope(request, decide(hydrate(request)))) } }] }));
    } });
}
function select(input, primary_definition_ids) {
  for (const node of input.native.nodes) node.provider ??= 'codegraph';
  const { primary_definition_ids: _primary, selection_sha256: _selection, selection_claim_sha256: _claim, selection_catalog_sha256: _catalog, ...original } = input.claims[0];
  const selection_claim_sha256 = semanticDigest(original), selection_catalog_sha256 = semanticDigest(input.native.nodes);
  input.claims[0] = { ...original, primary_definition_ids, selection_claim_sha256, selection_catalog_sha256, selection_sha256: groundingSelectionDigest({ snapshot_id: input.snapshot.snapshot_id, claim_id: original.id, text_sha256: semanticDigest(original.text), claim_sha256: selection_claim_sha256, catalog_sha256: selection_catalog_sha256, primary_definition_ids }) };
  return input;
}
function seedLegacy(c, input, contexts, output) {
  const legacy = prepareLegacySemanticArchitectureGroundingRequest(input.snapshot.snapshot_id, contexts);
  c.save({ phase: 'architecture-grounding', input: legacy.input, inference_policy: { ...semanticInferencePolicy('architecture-grounding'), max_tokens: 32768 } }, output, 'deepseek-v4.1-flash');
}

test('unsupported workflow direction blocks publication and preserves a stable dependency audit across later reviews', async t => {
  const input = fixture(t);
  input.claims[0] = { ...input.claims[0], field: 'flows.0.summary:0-37', text: 'A message travels between components.' };
  const result = await reviewSemanticArchitectureClaims({ ...input, parallel, client: client(input, request => request.contexts.map(context => row(context, 'insufficient'))) });
  assert.equal(result.checks[0].high_risk, false); assert.equal(result.checks[0].requires_source_support, true);
  assert.equal(result.blocking.length, 1);
  const ref = result.feedback[0].source_contexts[0].dependency_ledger_ref;
  const file = ref.split('.json.')[0] + '.json', audit = readFileSync(path.join(input.runDirectory, file));
  input.claims[0] = { ...input.claims[0], text: 'Another source interpretation.' };
  await reviewSemanticArchitectureClaims({ ...input, parallel, client: client(input, request => request.contexts.map(context => row(context, 'insufficient'))) });
  assert.deepEqual(readFileSync(path.join(input.runDirectory, file)), audit);
});

test('concrete checks bind each context key to its own claim, SHA and source vocabulary before host attribution', t => {
  const input = fixture(t, { 'a.ts': 'export function browseA() { return true; }', 'b.ts': 'export function browseB() { return true; }' });
  input.native = { nodes: [{ id: 'a', provider: 'codegraph', kind: 'function', label: 'browseA', path: 'a.ts', line_start: 1, line_end: 1 }, { id: 'b', provider: 'codegraph', kind: 'function', label: 'browseB', path: 'b.ts', line_start: 1, line_end: 1 }], edges: [] };
  input.claims = ['a', 'b'].map(id => ({ id, node_id: `module:${id}`, field: `$.${id}`, text: 'Provides browsing.', kind: 'narrative', evidence: [{ path: `${id}.ts`, line_start: 1, line_end: 1 }] }));
  const prepared = prepareSemanticArchitectureGrounding(input), contexts = prepared.groups[0], request = prepareSemanticArchitectureGroundingRequest(input.snapshot.snapshot_id, contexts);
  assert.equal(request.input.grounding_response_protocol, 'context-evidence-bindings-1.1.0');
  assert.deepEqual(Object.keys(request.input.output_shape.checks), contexts.map(context => context.context_id));
  for (const context of contexts) {
    const properties = request.schema.properties.checks.properties[context.context_id].properties;
    assert.deepEqual(properties.claim_id.enum, [context.claim_id]); assert.deepEqual(properties.text_sha256.enum, [context.text_sha256]);
    assert.deepEqual(properties.evidence_ids.items.enum, context.sources.map(source => source.id));
  }
  const valid = envelope(request.input, contexts.map(context => row(context)));
  assert.equal(decodeSemanticArchitectureGroundingResponse(valid, input.snapshot.snapshot_id, contexts).length, 2);
  const wrongSource = structuredClone(valid); wrongSource.checks[contexts[0].context_id].evidence_ids = contexts[1].sources.map(source => source.id);
  assert.throws(() => decodeSemanticArchitectureGroundingResponse(wrongSource, input.snapshot.snapshot_id, contexts), error => error.details.reason === 'schema');
  const wrongClaim = structuredClone(valid); wrongClaim.checks[contexts[0].context_id].claim_id = contexts[1].claim_id;
  assert.throws(() => decodeSemanticArchitectureGroundingResponse(wrongClaim, input.snapshot.snapshot_id, contexts), error => error.details.reason === 'schema');
  assert.throws(() => decodeSemanticArchitectureGroundingResponse({ checks: contexts.map(context => row(context)) }, input.snapshot.snapshot_id, contexts), error => error.details.reason === 'schema');
});

test('valid legacy checkpoints remain audit-readable but never seed new static-conditional verdicts', async t => {
  const input = fixture(t), calls = [], c = client(input, undefined, calls), prepared = prepareSemanticArchitectureGrounding(input), contexts = prepared.legacy_groups[0];
  seedLegacy(c, input, contexts, { checks: contexts.map(context => row(context, 'contradicted')) });
  const legacy = prepareLegacySemanticArchitectureGroundingRequest(input.snapshot.snapshot_id, contexts);
  const audit = c.cacheRequest({ phase: 'architecture-grounding', input: legacy.input, maxTokens: 32768, validate: raw => decodeSemanticArchitectureGroundingResponse(raw, input.snapshot.snapshot_id, contexts, true) });
  assert.equal(audit.value[0].status, 'contradicted');
  const result = await reviewSemanticArchitectureClaims({ ...input, parallel, client: c });
  assert.equal(result.statistics.legacy_cached_groups, 0); assert.equal(result.statistics.context_evaluated, 1); assert.equal(calls.length, 1);
  assert.equal(result.checks[0].status, 'supported'); assert.equal(calls[0].static_source_semantics, STATIC_CONDITIONAL_SOURCE_SEMANTICS);
  assert.equal(c.metrics().cacheHits, 1, 'only the explicit audit read used the legacy cache');
});

test('invalid legacy checkpoints miss without a legacy live request and new raw object checkpoints revalidate', async t => {
  const input = fixture(t), calls = [], c = client(input, request => {
    assert.equal(request.grounding_response_protocol, 'context-evidence-bindings-1.1.0'); return request.contexts.map(context => row(context));
  }, calls), prepared = prepareSemanticArchitectureGrounding(input);
  const bad = { checks: prepared.legacy_groups[0].map(context => row(context)) }; bad.checks[0].evidence_ids = ['GS-not-from-this-context'];
  seedLegacy(c, input, prepared.legacy_groups[0], bad); const oldFile = readdirSync(input.cacheDirectory)[0], oldBytes = readFileSync(path.join(input.cacheDirectory, oldFile));
  const first = await reviewSemanticArchitectureClaims({ ...input, parallel, client: c });
  assert.equal(first.statistics.legacy_cached_groups, 0); assert.equal(first.statistics.concrete_evaluated_groups, 1); assert.equal(calls.length, 1);
  assert.deepEqual(readFileSync(path.join(input.cacheDirectory, oldFile)), oldBytes, 'invalid historic cache is neither overwritten nor relabelled');
  const fresh = readdirSync(input.cacheDirectory).find(file => file !== oldFile), saved = JSON.parse(readFileSync(path.join(input.cacheDirectory, fresh)));
  assert.equal(Array.isArray(saved.output.checks), false); assert.deepEqual(Object.keys(saved.output.checks), prepared.groups[0].map(context => context.context_id));
  await reviewSemanticArchitectureClaims({ ...input, parallel, client: c }); assert.equal(calls.length, 1); assert.equal(c.metrics().cacheHits, 1);
});

test('the new producer verifies visible static conditionals without requiring external primitive implementations', async t => {
  const input = fixture(t, { 'caller.ts': 'export function inspect(store, sink) {\n  const value = store.getItem("mode");\n  if (value === "ready") sink.write(value);\n}\n' });
  input.native = { nodes: [{ id: 'inspect', kind: 'function', label: 'inspect', path: 'caller.ts', line_start: 1, line_end: 4 }], edges: [] };
  input.claims[0] = { ...input.claims[0], field: 'flows.0.steps.0.description:0-50', text: 'If the stored value equals ready, the function calls the sink.', evidence: [{ path: 'caller.ts', line_start: 1, line_end: 4 }] };
  const prepared = prepareSemanticArchitectureGrounding(input), request = prepareSemanticArchitectureGroundingRequest(input.snapshot.snapshot_id, prepared.contexts);
  assert.equal(request.input.static_source_semantics, 'static-conditional-1.3.0');
  assert(request.input.task.includes('不是证明运行时实际值或外部系统保证')); assert(request.input.task.includes('不是反驳'));
  assert(request.input.task.includes('本地业务守卫、授权助手')); assert(request.input.task.includes('正面证据'));
  assert.equal(prepared.contexts[0].dependency_closure_complete, false);
  const result = await reviewSemanticArchitectureClaims({ ...input, parallel, client: client(input) });
  assert.equal(result.checks[0].status, 'supported');
  const missing = select(fixture(t), ['cg:close']); missing.native.nodes = missing.native.nodes.filter(node => node.id !== 'cg:manage'); missing.native.edges = [];
  const blocked = await reviewSemanticArchitectureClaims({ ...missing, parallel, client: client(missing) });
  assert.equal(blocked.checks[0].status, 'insufficient', 'new semantics cannot relax the missing local authorization guard');
});

function cacheFixture(t, count = 5) {
  const input = fixture(t, Object.fromEntries(Array.from({ length: count }, (_, index) => [`feature${index}.ts`, `export function feature${index}() { return ${index}; }\n`])));
  input.native = { nodes: Array.from({ length: count }, (_, index) => ({ id: `feature${index}`, kind: 'function', label: `feature${index}`, path: `feature${index}.ts`, line_start: 1, line_end: 1 })), edges: [] };
  input.claims = input.native.nodes.map(node => ({ id: node.id, node_id: `module:${node.id}`, field: `modules.0.summary:0-${node.id.length}`, text: `Provides ${node.label} browsing.`, kind: 'narrative', evidence: [{ path: node.path, line_start: 1, line_end: 1 }] }));
  return input;
}
function updateSource(input, file, text) {
  writeFileSync(path.join(input.sourceDirectory, file), text);
  Object.assign(input.snapshot.files.find(row => row.path === file), { sha256: semanticDigest(Buffer.from(text)), byte_count: Buffer.byteLength(text), line_count: text.split('\n').length });
  input.snapshot.manifest_sha256 = semanticDigest(input.snapshot.files);
}

function preciseSelection(input, primary, supplemental = []) {
  select(input, primary);
  const claim = input.claims[0]; claim.selected_source_evidence = structuredClone(supplemental);
  claim.selection_sha256 = groundingSelectionDigest({ snapshot_id: input.snapshot.snapshot_id, claim_id: claim.id, text_sha256: semanticDigest(claim.text), claim_sha256: claim.selection_claim_sha256, catalog_sha256: claim.selection_catalog_sha256, primary_definition_ids: primary, selected_source_evidence: supplemental });
  return input;
}

test('precise retrieval preserves broad original provenance while keeping the complete operation and guards in one proof pack', t => {
  const contents = { 'caller.ts': 'import { canManage } from "./access.js";\nexport function closeRecord(actor) {\n  if (!canManage(actor)) throw Error("forbidden");\n  return "closed";\n}\n', 'access.ts': 'export function canManage(actor) {\n  return actor.role === "manager";\n}\n', ...Object.fromEntries(Array.from({ length: 4 }, (_, index) => [`unrelated${index}.ts`, '// ' + String(index).repeat(45_000)])) };
  const input = fixture(t, contents);
  input.claims[0].evidence.push(...Array.from({ length: 4 }, (_, index) => ({ path: `unrelated${index}.ts`, line_start: 1, line_end: 1 })));
  select(input, ['cg:close']); const wide = prepareSemanticArchitectureGrounding(input);
  const original = structuredClone(input.claims[0].evidence), originalClaimSha = input.claims[0].selection_claim_sha256;
  input.claims[0].selected_source_evidence = [];
  input.claims[0].selection_sha256 = groundingSelectionDigest({ snapshot_id: input.snapshot.snapshot_id, claim_id: input.claims[0].id, text_sha256: semanticDigest(input.claims[0].text), claim_sha256: originalClaimSha, catalog_sha256: input.claims[0].selection_catalog_sha256, primary_definition_ids: ['cg:close'], selected_source_evidence: [] });
  const before = semanticDigest(input.claims), precise = prepareSemanticArchitectureGrounding(input);
  assert(wide.contexts.length > 1); assert(wide.contexts.some(context => !context.can_assert_supported));
  assert.equal(precise.contexts.length, 1); assert.equal(precise.contexts[0].can_assert_supported, true);
  assert.deepEqual(precise.contexts[0].required_definition_ids, wide.contexts[0].required_definition_ids);
  assert.deepEqual(precise.contexts[0].guard_definition_ids, wide.contexts[0].guard_definition_ids);
  assert.deepEqual(precise.contexts[0].sources.map(source => source.path), ['access.ts', 'caller.ts']);
  assert.deepEqual(input.claims[0].evidence, original); assert.equal(input.claims[0].selection_claim_sha256, originalClaimSha);
  assert.equal(semanticDigest(input.claims), before); assert(precise.statistics.source_bytes < wide.statistics.source_bytes / 10);
});

test('explicit supplemental references support mixed code, declaration, configuration, documentation and test retrieval without changing source kinds', t => {
  const input = fixture(t, { 'caller.ts': 'import { canManage } from "./access.js";\nexport function closeRecord(actor) {\n  if (!canManage(actor)) throw Error("forbidden");\n  return "closed";\n}\n', 'access.ts': 'export function canManage(actor) {\n  return actor.role === "manager";\n}\n', 'README.md': '# Operator guide\nOnly describes intended behavior.\n', 'ci.yml': 'jobs:\n  build: {}\n', 'tests/example.test.ts': 'test("defined, not executed", () => {});\n', 'types.ts': 'export interface RecordView { id: string }\n' });
  const refs = ['README.md', 'ci.yml', 'tests/example.test.ts', 'types.ts'].map(path => ({ path, line_start: 1, line_end: 1 }));
  input.claims[0].evidence.push(...refs); preciseSelection(input, ['cg:close'], refs);
  const before = semanticDigest(input.claims), context = prepareSemanticArchitectureGrounding(input).contexts[0];
  for (const ref of refs) {
    const source = context.sources.find(source => source.path === ref.path);
    assert(source); assert.equal(source.text_sha256, semanticDigest(source.text));
    assert.equal(source.file_sha256, input.snapshot.files.find(file => file.path === ref.path).sha256);
    assert.equal(source.definition_complete, false, 'raw references do not become complete native operation definitions');
  }
  assert.equal(context.sources.find(source => source.path === 'README.md').source_kind, 'document');
  assert.equal(context.sources.find(source => source.path === 'ci.yml').source_kind, 'document');
  assert.equal(context.sources.find(source => source.path.startsWith('tests/')).source_kind, 'test');
  assert.equal(semanticDigest(input.claims), before);
});

test('explicit empty choices do not fall back to broad provenance or approve a runtime claim', async t => {
  const input = preciseSelection(fixture(t), []), c = client(input, () => assert.fail('no selected sources must not call a verifier'));
  const context = prepareSemanticArchitectureGrounding(input).contexts[0];
  assert.deepEqual(context.sources, []); assert.equal(context.can_assert_supported, false);
  const checked = await reviewSemanticArchitectureClaims({ ...input, parallel, client: c });
  assert.equal(checked.checks[0].status, 'insufficient'); assert.equal(checked.blocking.length, 1); assert.equal(c.metrics().calls, 0);
});

test('explicit reference ranges and presence are bound to the original claim and new selection digest', t => {
  const input = fixture(t, { 'caller.ts': 'export function closeRecord() { return "closed"; }\n', 'access.ts': 'export function canManage() { return true; }\n', 'README.md': '# A\nA detail.\n' });
  input.native.nodes[0].line_start = 1; input.native.nodes[0].line_end = 1; input.native.nodes[1].line_end = 1;
  const ref = { path: 'README.md', line_start: 1, line_end: 1 }; input.claims[0].evidence = [{ path: 'caller.ts', line_start: 1, line_end: 1 }, ref];
  preciseSelection(input, ['cg:close'], [ref]); prepareSemanticArchitectureGrounding(input);
  for (const mutate of [claim => { claim.selected_source_evidence[0].line_end = 2; }, claim => { claim.selected_source_evidence.push(ref); }, claim => { claim.selected_source_evidence[0] = null; }, claim => { delete claim.selected_source_evidence; }, claim => { claim.primary_definition_ids = ['ER-not-a-native-definition']; }]) {
    const changed = { ...input, claims: structuredClone(input.claims) }; mutate(changed.claims[0]);
    assert.throws(() => prepareSemanticArchitectureGrounding(changed), { code: 'code_analysis_model_invalid' });
  }
});

test('paragraph scope preserves exact preceding conditions and rejects detached or forged target spans', t => {
  const input = fixture(t), target = 'If the item is submitted, the verifier branch creates its run.';
  const prefix = 'The operation first checks access, pending handover and absence of an active run. ';
  input.claims[0] = { ...input.claims[0], text: target, field: `flows.0.summary:${prefix.length}-${prefix.length + target.length}`, scope_context: { field: 'flows.0.summary', field_text: prefix + target, field_span: [prefix.length, prefix.length + target.length] } };
  const prepared = prepareSemanticArchitectureGrounding(input), request = prepareSemanticArchitectureGroundingRequest(input.snapshot.snapshot_id, prepared.contexts);
  assert.deepEqual(request.input.contexts[0].scope_context, input.claims[0].scope_context);
  assert.match(request.input.task, /前文已明确写出/); assert.match(request.input.task, /不能从后文、无关操作/);
  for (const mutate of [context => { context.field_span[0]--; }, context => { context.field_text = target; }, context => { delete context.field_span; }, context => { context.field_span = [0, 0]; }, context => { context.field = 'another.field'; }]) {
    const changed = { ...input, claims: structuredClone(input.claims) }; mutate(changed.claims[0].scope_context);
    assert.throws(() => prepareSemanticArchitectureGrounding(changed), error => error.details.reason === 'grounding_paragraph_identity');
  }
});

test('old static verdicts cannot seed the paragraph-aware semantics', async t => {
  const input = cacheFixture(t, 1), calls = [], c = client(input, undefined, calls), contexts = prepareSemanticArchitectureGrounding(input).contexts;
  const request = prepareSemanticArchitectureGroundingRequest(input.snapshot.snapshot_id, contexts), oldInput = { ...request.input, static_source_semantics: 'static-conditional-1.2.0' };
  c.save({ phase: 'architecture-grounding', input: oldInput, inference_policy: { ...semanticInferencePolicy('architecture-grounding'), max_tokens: 32768 } }, envelope(oldInput, contexts.map(context => row(context))), 'deepseek-v4.1-flash');
  const result = await reviewSemanticArchitectureClaims({ ...input, parallel, client: c });
  assert.equal(result.statistics.context_cached, 0); assert.equal(calls.length, 1); assert.equal(calls[0].static_source_semantics, 'static-conditional-1.3.0');
});

test('singleton verdicts survive regrouping, deleted siblings and reorder with zero further model calls', async t => {
  const input = cacheFixture(t), calls = [], c = client(input, undefined, calls), progress = [];
  const first = await reviewSemanticArchitectureClaims({ ...input, parallel, client: c });
  assert.equal(first.statistics.context_evaluated, 5); assert.equal(calls.length, 2);
  const subset = { ...input, claims: [input.claims[4], input.claims[1], input.claims[0]] };
  const second = await reviewSemanticArchitectureClaims({ ...subset, parallel, client: c, onProgress: async (...args) => { progress.push(args); } });
  assert.equal(second.statistics.context_cached, 3); assert.equal(second.statistics.context_evaluated, 0); assert.equal(calls.length, 2);
  assert.deepEqual(progress, [[0, 3], [1, 3], [2, 3], [3, 3]]);
  const changed = { ...subset, claims: [input.claims[4], { ...input.claims[1], text: 'Provides a revised browser action.' }, input.claims[0]] };
  const third = await reviewSemanticArchitectureClaims({ ...changed, parallel, client: c });
  assert.equal(third.statistics.context_cached, 2); assert.equal(third.statistics.context_evaluated, 1); assert.equal(calls.length, 3);
  assert.equal(calls[2].contexts.length, 1, 'only the changed whole context is evaluated');
});

test('repeated mixed-context citation errors repartition whole contexts without accepting or caching the rejected group', async t => {
  const input = cacheFixture(t, 4), calls = [], c = client(input, request => request.contexts.map((context, index) =>
    row(context, 'supported', request.contexts.length > 2 ? [request.contexts[(index + 1) % request.contexts.length].sources[0].id] : undefined)), calls);
  const original = prepareSemanticArchitectureGrounding(input).contexts;
  const result = await reviewSemanticArchitectureClaims({ ...input, parallel, client: c });
  assert.deepEqual(calls.map(request => request.contexts.length), [4, 4, 2, 2]);
  assert.deepEqual(calls.slice(2).flatMap(request => hydrate(request).contexts), original, 'no context, source text or dependency ledger is cropped');
  assert.equal(result.statistics.citation_repartitioned_groups, 1);
  assert.equal(result.statistics.context_evaluated, 4); assert.equal(result.checks.length, 4);
  assert(result.checks.every(check => check.status === 'supported'));
  const group = prepareSemanticArchitectureGroundingRequest(input.snapshot.snapshot_id, original);
  const key = c.key({ phase: 'architecture-grounding', input: group.input, inference_policy: { ...semanticInferencePolicy('architecture-grounding'), max_tokens: 32768 } });
  assert.equal(readdirSync(input.cacheDirectory).includes(key + '.json'), false, 'rejected parent response is never cached');
  const auditFile = readdirSync(input.runDirectory).find(file => file.startsWith('semantic-grounding-repartition-'));
  const audit = JSON.parse(readFileSync(path.join(input.runDirectory, auditFile)));
  assert.deepEqual(audit.partitions[0].children.flat(), original.map(context => context.context_id));
  const again = await reviewSemanticArchitectureClaims({ ...input, claims: [...input.claims].reverse(), parallel, client: c });
  assert.equal(again.statistics.context_cached, 4); assert.equal(calls.length, 4);
});

test('citation repartition stops at intact singleton contexts and never relaxes evidence identity', async t => {
  const input = cacheFixture(t, 4), calls = [], c = client(input, request => request.contexts.map((context, index) =>
    row(context, 'supported', request.contexts.length > 1 ? [request.contexts[(index + 1) % request.contexts.length].sources[0].id] : undefined)), calls);
  const result = await reviewSemanticArchitectureClaims({ ...input, parallel, client: c });
  assert.deepEqual(calls.map(request => request.contexts.length), [4, 4, 2, 2, 1, 1, 2, 2, 1, 1]);
  assert.equal(result.statistics.citation_repartitioned_groups, 3); assert.equal(result.checks.length, 4);
  const invalid = cacheFixture(t, 1), invalidCalls = [], bad = client(invalid, request => request.contexts.map(context => row(context, 'supported', ['GS-foreign'])), invalidCalls);
  await assert.rejects(reviewSemanticArchitectureClaims({ ...invalid, parallel, client: bad }), error => error.details.reason === 'schema');
  assert.equal(invalidCalls.length, 2); assert.deepEqual(readdirSync(invalid.cacheDirectory), []);
});

test('non-citation schema errors and cancellation do not trigger repartition', async t => {
  const input = cacheFixture(t, 4), calls = [], c = client(input, request => request.contexts.map(context => ({ ...row(context), text_sha256: 'f'.repeat(64) })), calls);
  await assert.rejects(reviewSemanticArchitectureClaims({ ...input, parallel, client: c }), error => error.details.reason === 'schema');
  assert.deepEqual(calls.map(request => request.contexts.length), [4, 4]); assert.deepEqual(readdirSync(input.cacheDirectory), []);
  const stopped = { ...client(input), call: async () => { throw Object.assign(new Error('cancelled'), { code: 'code_analysis_cancelled' }); } };
  await assert.rejects(reviewSemanticArchitectureClaims({ ...input, parallel, client: stopped }), { code: 'code_analysis_cancelled' });
});

test('singleton cache identities include source bytes, local guards, selection, model, engine and inference policy', async t => {
  for (const dimension of ['source', 'guard', 'selection', 'model', 'engine', 'policy', 'snapshot']) {
    const input = select(fixture(t), ['cg:close']), calls = []; const firstClient = client(input, undefined, calls);
    if (dimension === 'policy') {
      const contexts = prepareSemanticArchitectureGrounding(input).contexts, request = prepareSemanticArchitectureGroundingRequest(input.snapshot.snapshot_id, contexts);
      firstClient.save({ phase: 'architecture-grounding', input: request.input, inference_policy: { ...semanticInferencePolicy('architecture-grounding'), max_tokens: 20000 } }, envelope(request.input, contexts.map(context => row(context, 'contradicted'))), 'deepseek-v4.1-flash');
    } else await reviewSemanticArchitectureClaims({ ...input, parallel, client: firstClient });
    if (dimension === 'source') updateSource(input, 'caller.ts', 'import { canManage } from "./access.js";\nexport function closeRecord(actor) {\n  if (!canManage(actor)) throw Error("forbidden");\n  return "updated";\n}\n');
    if (dimension === 'guard') updateSource(input, 'access.ts', 'export function canManage(actor) {\n  return actor.role === "owner";\n}\n');
    if (dimension === 'selection') { input.claims[0].selection_catalog_sha256 = 'f'.repeat(64); input.claims[0].selection_sha256 = groundingSelectionDigest({ snapshot_id: input.snapshot.snapshot_id, claim_id: input.claims[0].id, text_sha256: semanticDigest(input.claims[0].text), claim_sha256: input.claims[0].selection_claim_sha256, catalog_sha256: input.claims[0].selection_catalog_sha256, primary_definition_ids: input.claims[0].primary_definition_ids }); }
    if (dimension === 'snapshot') { input.snapshot.snapshot_id = 'b'.repeat(64); select(input, ['cg:close']); }
    const before = calls.length, next = client(input, undefined, calls, { model: dimension === 'model' ? 'replacement-model' : undefined, engineIdentity: dimension === 'engine' ? 'changed-engine' : undefined });
    const result = await reviewSemanticArchitectureClaims({ ...input, parallel, client: next });
    assert.equal(calls.length, before + 1, dimension); assert.equal(result.statistics.context_cached, 0, dimension);
    assert.equal(result.statistics.context_evaluated, 1, dimension);
  }
});

test('derived singleton rows retain the original model origin when a new-semantics grouped cache is reused', async t => {
  const input = cacheFixture(t, 2), contexts = prepareSemanticArchitectureGrounding(input).contexts, request = prepareSemanticArchitectureGroundingRequest(input.snapshot.snapshot_id, contexts);
  const previous = client(input); previous.save({ phase: 'architecture-grounding', input: request.input, inference_policy: { ...semanticInferencePolicy('architecture-grounding'), max_tokens: 32768 } }, envelope(request.input, contexts.map(context => row(context))), 'deepseek-v4.1-flash');
  const calls = [], next = client(input, () => { assert.fail('explicit origin group and singleton caches need no live request'); }, calls, { model: 'replacement-model', cacheOriginModels: ['deepseek-v4.1-flash'] });
  const first = await reviewSemanticArchitectureClaims({ ...input, parallel, client: next }); assert.equal(first.statistics.context_cached, 2); assert.equal(first.statistics.concrete_cached_groups, 1);
  const second = await reviewSemanticArchitectureClaims({ ...input, claims: [input.claims[1]], parallel, client: next });
  assert.equal(second.statistics.context_cached, 1); assert.equal(calls.length, 0);
  const singleton = prepareSemanticArchitectureGroundingRequest(input.snapshot.snapshot_id, [contexts[1]]);
  const currentKey = next.key({ phase: 'architecture-grounding', input: singleton.input, inference_policy: { ...semanticInferencePolicy('architecture-grounding'), max_tokens: 32768 } });
  assert.equal(readdirSync(input.cacheDirectory).includes(currentKey + '.json'), false, 'derived row is never relabelled as the current model');
  assert(next.metrics().provenance.origins.every(origin => origin.requested_model === 'deepseek-v4.1-flash'));
});

test('singleton checkpoints revalidate their raw context vocabulary before reuse', async t => {
  const input = cacheFixture(t, 2), calls = [], c = client(input, undefined, calls);
  await reviewSemanticArchitectureClaims({ ...input, parallel, client: c });
  const files = readdirSync(input.cacheDirectory).map(file => ({ file, data: JSON.parse(readFileSync(path.join(input.cacheDirectory, file))) }));
  const saved = files.find(({ data }) => Object.values(data.output.checks).length === 1 && Object.values(data.output.checks)[0].claim_id === input.claims[0].id);
  Object.values(saved.data.output.checks)[0].evidence_ids = ['GS-foreign']; saved.data.output_sha256 = semanticDigest(saved.data.output); writeFileSync(path.join(input.cacheDirectory, saved.file), JSON.stringify(saved.data));
  const result = await reviewSemanticArchitectureClaims({ ...input, claims: [input.claims[0]], parallel, client: c });
  assert.equal(result.statistics.context_evaluated, 1); assert.equal(result.statistics.context_cached, 0); assert.equal(calls.length, 2);
});

test('new wire overflow splits only whole contexts deterministically while single oversized contexts fail', t => {
  const input = fixture(t); input.claims = Array.from({ length: 4 }, (_, index) => ({ ...structuredClone(input.claims[0]), id: `claim-${index}`, field: `$.${index}` }));
  const original = prepareSemanticArchitectureGrounding(input).contexts;
  const padded = count => original.map(context => ({ ...structuredClone(context), scope_context: { exact: 'x'.repeat(count) } }));
  let low = 0, high = 40_000;
  while (low < high) { const middle = Math.ceil((low + high) / 2); if (prepareSemanticArchitectureGroundingRequest(input.snapshot.snapshot_id, padded(middle)).byteLength <= 140_000) low = middle; else high = middle - 1; }
  const contexts = padded(low + 100);
  assert(prepareSemanticArchitectureGroundingRequest(input.snapshot.snapshot_id, contexts).byteLength > 140_000);
  const children = splitSemanticArchitectureGroundingGroups(input.snapshot.snapshot_id, contexts);
  assert(children.length > 1); assert.deepEqual(children.flat(), contexts); assert(children.every(child => child.length <= 4 && prepareSemanticArchitectureGroundingRequest(input.snapshot.snapshot_id, child).byteLength <= 140_000));
  assert.deepEqual(splitSemanticArchitectureGroundingGroups(input.snapshot.snapshot_id, contexts), children);
  assert.throws(() => splitSemanticArchitectureGroundingGroups(input.snapshot.snapshot_id, [{ ...contexts[0], scope_context: { exact: 'x'.repeat(150_000) } }]), error => error.details.reason === 'grounding_request_budget');
});

test('source plan expands a caller excerpt to full caller and actual callee definitions, binding exact frozen identities', t => {
  const input = fixture(t), prepared = prepareSemanticArchitectureGrounding(input), context = prepared.contexts[0];
  assert.equal(prepared.statistics.claims, 1); assert.equal(prepared.groups.length, 1); assert.equal(context.can_assert_supported, true);
  assert.equal(context.text_sha256, semanticDigest(input.claims[0].text)); assert.deepEqual(context.scope_context, input.claims[0].scope_context);
  assert.deepEqual(context.sources.map(({ path, line_start, line_end, definition_complete, defines }) => ({ path, line_start, line_end, definition_complete, defines })), [
    { path: 'access.ts', line_start: 1, line_end: 3, definition_complete: true, defines: ['canManage'] },
    { path: 'caller.ts', line_start: 2, line_end: 5, definition_complete: true, defines: ['closeRecord'] },
  ]);
  for (const source of context.sources) {
    assert.equal(source.text_sha256, semanticDigest(source.text));
    assert.equal(source.file_sha256, input.snapshot.files.find(file => file.path === source.path).sha256);
  }
  assert.equal(context.guard_definition_ids.length, 1); assert.equal(context.callee_definition_ids.length, 1);
});

test('built-in receiver methods are not missing guards and relative imported aliases resolve without a CodeGraph call edge', t => {
  const input = fixture(t, { 'caller.ts': 'import { canManage as mayChange } from "./access.js";\nexport function closeRecord(actor) {\n  if (!Array.isArray(actor.rows) || !Number.isSafeInteger(actor.id) || !actor.stat.isFile()) return;\n  if (!mayChange(actor)) throw Error("forbidden");\n  return "closed";\n}\n', 'access.ts': 'export function canManage(actor) {\n  return actor.role === "manager";\n}\n' });
  input.native.nodes[0].line_end = 6; input.native.edges = [];
  const prepared = prepareSemanticArchitectureGrounding(input), context = prepared.contexts[0];
  assert.deepEqual(context.missing_guard_definitions, []); assert.equal(context.can_assert_supported, true);
  assert(context.sources.some(source => source.path === 'access.ts' && source.definition_complete));
  assert.equal(context.guard_definition_ids.length, 1);
});

function stateSetterFixture(t, text, label = 'Panel', start = 2, end = text.trimEnd().split('\n').length) {
  const input = fixture(t, { 'panel.tsx': text });
  input.native = { nodes: [{ id: 'panel', kind: 'function', label, path: 'panel.tsx', line_start: start, line_end: end }], edges: [] };
  input.claims[0] = { ...input.claims[0], text: 'The panel only changes local role and policy state.', evidence: [{ path: 'panel.tsx', line_start: start, line_end: end }] };
  return input;
}

test('React tuple setters with proven imports are local state rather than missing authority guards', t => {
  const text = 'import { useState } from "react";\nexport function Panel() {\n  const [role, setRole] = useState<Options["role"]>("member");\n  const [policy, setPolicy] = useState<ProjectMemberPolicy>("private");\n  const [preview, setPreviewedPolicy] = useState<ProjectMemberPolicy | null>(null);\n  function refresh() { setRole("viewer"); setPolicy("team_read"); setPreviewedPolicy(null); }\n  return refresh;\n}\n';
  const input = stateSetterFixture(t, text), context = prepareSemanticArchitectureGrounding(input).contexts[0];
  assert.deepEqual(context.missing_guard_definitions, []);
  assert.equal(context.can_assert_supported, true);
  assert.deepEqual(prepareSemanticArchitectureGrounding(input).contexts, [context], 'same immutable inputs retain the same identities');
  const nested = stateSetterFixture(t, text, 'refresh', 6, 6);
  assert.deepEqual(prepareSemanticArchitectureGrounding(nested).contexts[0].missing_guard_definitions, [], 'a nested caller can use the proven enclosing tuple');
});

test('custom, shadowed, reassigned and spoofed state setter bindings remain fail closed', t => {
  const cases = [
    'import { useState } from "custom-hooks";\nexport function Panel() {\n const [role, setRole] = useState();\n setRole("viewer");\n}\n',
    'import { useState } from "react";\nexport function Panel(useState) {\n const [role, setRole] = useState();\n setRole("viewer");\n}\n',
    'import { useState } from "react";\nexport function Panel() {\n const [role, setRole] = useState();\n function nested(setRole) { setRole("viewer"); } return nested;\n}\n',
    'import { useState } from "react";\nexport function Panel() { let [role, setRole] = useState(); setRole = authority; setRole("viewer"); }\n',
    'import { useState } from "react";\nexport function Panel() {\n const [role, setRole] = useState();\n const alias = setRole; setRole("viewer");\n}\n',
    '/* import { useState } from "react"; */\nexport function Panel() {\n const [role, setRole] = useState();\n setRole("viewer");\n}\n',
    'const fake = `\nimport { useState } from "react";\n`;\nexport function Panel() {\n const [role, setRole] = useState();\n setRole("viewer");\n}\n',
    'import { useState } from "react";\nexport function Panel() { const fake = "const [role, setRole] = useState()"; setRole("viewer"); }\n',
    'import { useState } from "react";\nexport function Panel() {\n const [role, setRole] = useState();\n return `${(() => { const setRole = authority; return setRole(); })()}`;\n}\n',
    'import { setRole } from "authority-sdk";\nexport function Panel() { setRole("viewer"); }\n',
  ];
  for (const text of cases) {
    const start = text.split('\n').findIndex(line => line.startsWith('export function Panel')) + 1;
    const context = prepareSemanticArchitectureGrounding(stateSetterFixture(t, text, 'Panel', start)).contexts[0];
    assert(context.missing_guard_definitions.includes('panel.tsx:setRole'), text);
    assert.equal(context.can_assert_supported, false, text);
  }
});

test('escaped identifier shadows cannot prove React setter bindings', async t => {
  for (const [name, text] of [
    ['hook parameter', 'import { useState } from "react";\nexport function Panel(\\u0075seState) {\n const [role, setRole] = useState();\n setRole("viewer");\n}\n'],
    ['nested setter parameter', 'import { useState } from "react";\nexport function Panel() {\n const [role, setRole] = useState();\n function nested(\\u0073etRole) { setRole("viewer"); } return nested;\n}\n'],
  ]) await t.test(name, t => {
    const context = prepareSemanticArchitectureGrounding(stateSetterFixture(t, text)).contexts[0];
    assert(context.missing_guard_definitions.includes('panel.tsx:setRole'));
    assert.equal(context.can_assert_supported, false);
  });
});

test('an actually called selected primary remains a callee without inventing calls among other primaries', t => {
  const input = fixture(t, { 'drawio.ts': 'export function session(value) { return validateDrawioSource(value); }\nexport function validateDrawioSource(value) { return value.length > 0; }\nexport function decodePreview(value) { return value; }\n' });
  input.native = { nodes: ['session', 'validateDrawioSource', 'decodePreview'].map((label, index) => ({ id: label, kind: 'function', label, path: 'drawio.ts', line_start: index + 1, line_end: index + 1 })), edges: [{ id: 'native-call', source: 'session', target: 'validateDrawioSource', type: 'calls', provider: 'codegraph', provenance: 'native', verification: 'inferred' }] };
  input.claims[0] = { ...input.claims[0], text: 'The session requires source validation before continuing.', evidence: [{ path: 'drawio.ts', line_start: 1, line_end: 3 }] };
  select(input, ['session', 'validateDrawioSource', 'decodePreview']);
  const names = context => context.callee_definition_ids.flatMap(id => context.sources.find(source => source.id === id).defines);
  const context = prepareSemanticArchitectureGrounding(input).contexts[0];
  assert.deepEqual(names(context), ['validateDrawioSource']);
  const proof = context.sources.filter(source => source.defines.some(name => name !== 'decodePreview')).map(source => source.id);
  const request = prepareSemanticArchitectureGroundingRequest(input.snapshot.snapshot_id, [context]);
  assert.equal(decodeSemanticArchitectureGroundingResponse(envelope(request.input, [row(context, 'supported', proof)]), input.snapshot.snapshot_id, [context])[0].status, 'supported');
  for (const edges of [[], [{ id: 'self', source: 'session', target: 'session', type: 'calls', provider: 'codegraph', provenance: 'native' }], [{ ...input.native.edges[0], provider: 'ua' }], [{ ...input.native.edges[0], provenance: 'inferred' }], [{ ...input.native.edges[0], target: 'not-in-snapshot' }]]) {
    assert.deepEqual(names(prepareSemanticArchitectureGrounding({ ...input, native: { ...input.native, edges } }).contexts[0]), []);
  }
  const sdk = fixture(t, { 'caller.ts': 'import { validateDrawioSource } from "diagram-sdk";\nexport function session(value) { return validateDrawioSource(value); }\n', 'helper.ts': 'export function validateDrawioSource(value) { return value; }\n' });
  sdk.native = { nodes: [{ id: 'session', kind: 'function', label: 'session', path: 'caller.ts', line_start: 2, line_end: 2 }, { id: 'validation', kind: 'function', label: 'validateDrawioSource', path: 'helper.ts', line_start: 1, line_end: 1 }], edges: [{ id: 'namesake', source: 'session', target: 'validation', type: 'calls', provider: 'codegraph', provenance: 'native' }] };
  sdk.claims[0].evidence = [{ path: 'caller.ts', line_start: 2, line_end: 2 }, { path: 'helper.ts', line_start: 1, line_end: 1 }];
  select(sdk, ['session', 'validation']);
  assert.deepEqual(names(prepareSemanticArchitectureGrounding(sdk).contexts[0]), [], 'an external SDK import cannot borrow a snapshot namesake');
  const recursive = fixture(t, { 'caller.ts': 'export function session() { return session(); }\n' });
  recursive.native = { nodes: [{ id: 'session', kind: 'function', label: 'session', path: 'caller.ts', line_start: 1, line_end: 1 }], edges: [{ id: 'self', source: 'session', target: 'session', type: 'calls', provider: 'codegraph', provenance: 'native' }] };
  recursive.claims[0].evidence = [{ path: 'caller.ts', line_start: 1, line_end: 1 }]; select(recursive, ['session']);
  assert.deepEqual(names(prepareSemanticArchitectureGrounding(recursive).contexts[0]), [], 'self-recursion is not an independent helper proof');
});

test('primary callee promotion rejects caller shadows and opaque call text', async t => {
  for (const [name, caller] of [
    ['parameter shadow', 'export function session(validateDrawioSource) { return validateDrawioSource("x"); }'],
    ['local shadow', 'export function session(value) {\n const validateDrawioSource = resolver;\n return validateDrawioSource(value);\n}'],
    ['escaped parameter shadow', 'export function session(\\u0076alidateDrawioSource) { return validateDrawioSource("x"); }'],
    ['string only', 'export function session() { return "validateDrawioSource(value)"; }'],
    ['comment only', 'export function session() { /* validateDrawioSource(value); */ return true; }'],
    ['regex only', 'export function session() { return /validateDrawioSource()/; }'],
  ]) await t.test(name, t => {
    const count = caller.split('\n').length, text = caller + '\nexport function validateDrawioSource(value) { return value; }\n';
    const input = fixture(t, { 'drawio.ts': text });
    input.native = { nodes: [{ id: 'session', kind: 'function', label: 'session', path: 'drawio.ts', line_start: 1, line_end: count }, { id: 'validation', kind: 'function', label: 'validateDrawioSource', path: 'drawio.ts', line_start: count + 1, line_end: count + 1 }], edges: [{ id: 'loose-native-match', source: 'session', target: 'validation', type: 'calls', provider: 'codegraph', provenance: 'native' }] };
    input.claims[0].evidence = [{ path: 'drawio.ts', line_start: 1, line_end: count + 1 }]; select(input, ['session', 'validation']);
    assert.deepEqual(prepareSemanticArchitectureGrounding(input).contexts[0].callee_definition_ids, []);
  });
});

test('relative namespace guards resolve while unknown SDK receiver methods do not fabricate local dependencies', t => {
  const input = fixture(t, { 'caller.ts': 'import * as permissions from "./access.js";\nexport function closeRecord(actor) {\n  if (!permissions.canManage(actor) || !actor.sdk.isReady()) return;\n  return "closed";\n}\n', 'access.ts': 'export function canManage(actor) {\n  return actor.role === "manager";\n}\n' });
  input.native.edges = [];
  const context = prepareSemanticArchitectureGrounding(input).contexts[0];
  assert.deepEqual(context.missing_guard_definitions, []); assert(context.sources.some(source => source.path === 'access.ts'));
});

test('explicit primary selection and narrow legacy evidence avoid unrelated factory operations and guards', t => {
  const text = 'export function build() {\n  const value = 1;\n  function operate(actor) {\n    if (!canOperate(actor)) throw Error("forbidden");\n    return value;\n  }\n  function unrelatedAdmin(actor) {\n    return requireSuperAdmin(actor);\n  }\n  return operate;\n}\nexport function canOperate(actor) {\n  return actor.kind === "member";\n}\nexport function requireSuperAdmin(actor) {\n  return actor.kind === "super-admin";\n}\n';
  const input = fixture(t, { 'factory.ts': text });
  input.native = { nodes: [{ id: 'factory', kind: 'function', label: 'build', path: 'factory.ts', line_start: 1, line_end: 11 }, { id: 'operation', kind: 'function', label: 'operate', path: 'factory.ts', line_start: 3, line_end: 6 }, { id: 'unrelated', kind: 'function', label: 'unrelatedAdmin', path: 'factory.ts', line_start: 7, line_end: 9 }, { id: 'guard', kind: 'function', label: 'canOperate', path: 'factory.ts', line_start: 12, line_end: 14 }, { id: 'unrelated-guard', kind: 'function', label: 'requireSuperAdmin', path: 'factory.ts', line_start: 15, line_end: 17 }], edges: [{ id: 'call', type: 'calls', source: 'operation', target: 'guard' }] };
  input.claims[0].text = 'Only members may operate.'; input.claims[0].evidence = [{ path: 'factory.ts', line_start: 4, line_end: 4 }];
  const fallback = prepareSemanticArchitectureGrounding(input).contexts[0];
  assert.deepEqual(fallback.primary_definition_ids, ['operation']); assert.equal(fallback.sources.some(source => source.text.includes('requireSuperAdmin')), false);
  select(input, ['operation']); const selected = prepareSemanticArchitectureGrounding(input).contexts[0];
  assert.deepEqual(selected.primary_definition_ids, ['operation']); assert.equal(selected.selection_sha256, input.claims[0].selection_sha256);
  assert.deepEqual(selected.sources.map(source => source.defines[0]), ['operate', 'canOperate']);
  assert.equal(selected.sources.some(source => source.text.includes('requireSuperAdmin')), false);
});

test('an empty operation selection retrieves original source context but cannot prove runtime role predicates', async t => {
  const input = select(fixture(t), []), calls = [], prepared = prepareSemanticArchitectureGrounding(input);
  assert.equal(prepared.contexts[0].sources.length, 1); assert.equal(prepared.contexts[0].sources[0].path, 'caller.ts'); assert.equal(prepared.groups.length, 1); assert.equal(prepared.contexts[0].can_assert_supported, false);
  const result = await reviewSemanticArchitectureClaims({ ...input, parallel, client: client(input, undefined, calls) });
  assert.equal(result.checks[0].status, 'insufficient'); assert.equal(result.blocking.length, 1); assert.equal(calls.length, 1);
  assert(result.feedback[0].missing_guard_definitions.includes('no_primary_definition_selected')); assert.equal(result.feedback[0].sources.length, 1); assert.equal(result.feedback[0].source_scope, 'source_definition');
});

test('selection metadata binds the snapshot, original claim/catalog hashes, chosen identity and exact native ranges', t => {
  for (const mutate of [
    claim => { delete claim.selection_catalog_sha256; },
    claim => { claim.selection_sha256 = 'b'.repeat(64); },
    claim => { claim.selection_claim_sha256 = 'b'.repeat(64); },
    claim => { claim.selection_catalog_sha256 = 'b'.repeat(64); },
    claim => { claim.primary_definition_ids = ['unknown']; },
    claim => { claim.primary_definition_ids.push('cg:close'); },
    claim => { claim.evidence[0].line_end--; },
    claim => { claim.text += ' Additional predicate.'; },
    claim => { claim.assertion_scope = 'source_definition'; },
  ]) {
    const input = select(fixture(t), ['cg:close']); mutate(input.claims[0]);
    assert.throws(() => prepareSemanticArchitectureGrounding(input), error => ['grounding_selection_identity', 'grounding_selection_definition', 'grounding_selection_evidence'].includes(error.details.reason));
  }
});

test('a different valid primary selection cannot reuse the prior source-review cache', async t => {
  const input = fixture(t), calls = [], c = client(input, undefined, calls); input.claims[0].evidence.push({ path: 'access.ts', line_start: 1, line_end: 3 }); const original = structuredClone(input.claims[0]);
  input.claims[0].text = 'Provides record information.'; original.text = input.claims[0].text;
  select(input, ['cg:close']); await reviewSemanticArchitectureClaims({ ...input, parallel, client: c });
  await reviewSemanticArchitectureClaims({ ...input, parallel, client: c }); assert.equal(calls.length, 1);
  input.claims = [original]; select(input, ['cg:manage']); await reviewSemanticArchitectureClaims({ ...input, parallel, client: c });
  assert.equal(calls.length, 2); assert.notEqual(calls[0].contexts[0].selection_sha256, calls[1].contexts[0].selection_sha256);
});

test('real selector output is accepted as retrieval metadata and a separate raw-source review can still contradict it', async t => {
  const input = fixture(t), original = structuredClone(input.claims); for (const node of input.native.nodes) node.provider = 'codegraph';
  const selectorClient = { call: async request => ({ value: request.validate({ selections: request.input.contexts.map(context => ({ context_id: context.context_id, claim_id: context.claim_id, text_sha256: context.text_sha256, catalog_sha256: context.catalog_sha256, page_sha256: context.page_sha256, selected_definition_ids: ['cg:close'], missing_reasons: [] })) }), cached: false }) };
  const selected = await selectArchitectureClaimSources({ ...input, parallel, client: selectorClient });
  assert.deepEqual(input.claims, original); assert.equal(selected.claims[0].selection_claim_sha256, semanticDigest(original[0]));
  const prepared = prepareSemanticArchitectureGrounding({ ...input, claims: selected.claims });
  assert.equal(prepared.contexts[0].selection_sha256, selected.claims[0].selection_sha256);
  const result = await reviewSemanticArchitectureClaims({ ...input, claims: selected.claims, parallel, client: client(input, request => request.contexts.map(context => row(context, 'contradicted', context.guard_definition_ids))) });
  assert.equal(result.blocking.length, 1); assert.equal(result.checks[0].status, 'contradicted'); assert.equal(result.feedback[0].sources.length, 1);
});

test('guard closure follows actual relative imports and nested same-file guards recursively with visited identities', t => {
  const input = fixture(t, { 'caller.ts': 'import { requireEdit } from "./access.js";\nexport function closeRecord(actor) {\n  requireEdit(actor);\n  return "closed";\n}\n', 'access.ts': 'export function requireEdit(actor) {\n  return canManage(actor);\n}\n\nexport function canManage(actor) {\n  return isManager(actor);\n}\n\nexport function isManager(actor) {\n  if (actor.retry) return requireEdit(actor);\n  return actor.role === "manager";\n}\n' });
  input.native = { nodes: [{ id: 'caller', kind: 'function', label: 'closeRecord', path: 'caller.ts', line_start: 2, line_end: 5 }, { id: 'require', kind: 'function', label: 'requireEdit', path: 'access.ts', line_start: 1, line_end: 3 }, { id: 'can', kind: 'function', label: 'canManage', path: 'access.ts', line_start: 5, line_end: 7 }, { id: 'is', kind: 'function', label: 'isManager', path: 'access.ts', line_start: 9, line_end: 12 }], edges: [] };
  select(input, ['caller']); const context = prepareSemanticArchitectureGrounding(input).contexts[0];
  assert.deepEqual(context.sources.map(source => source.defines[0]), ['requireEdit', 'canManage', 'isManager', 'closeRecord']);
  assert.equal(context.sources.length, 4); assert.equal(new Set(context.sources.map(source => source.id)).size, 4); assert.deepEqual(context.missing_guard_definitions, []); assert.equal(context.can_assert_supported, true);
});

function lexicalFixture(t, body, options = {}) {
  const prefix = options.namespace ? 'import * as gate from "./guard.js";\nimport { hasAccess } from "./guard.js";' : 'import { hasAccess } from "./guard.js";';
  const text = [prefix, 'export function run(actor) {', ...body, '}'].join('\n');
  const start = prefix.split('\n').length + 1, end = start + body.length + 1;
  const input = fixture(t, { 'operation.ts': text, 'guard.ts': 'export function hasAccess(actor) {\n  return actor.role === "manager";\n}\n' });
  input.native = { nodes: [{ id: 'action', provider: 'codegraph', kind: 'function', label: 'run', path: 'operation.ts', line_start: start, line_end: end }, ...(!options.missing ? [{ id: 'guard', provider: 'codegraph', kind: 'function', label: 'hasAccess', path: 'guard.ts', line_start: 1, line_end: 3 }] : [])], edges: [] };
  input.claims[0].text = 'Only managers may perform the operation.'; input.claims[0].evidence = [{ path: 'operation.ts', line_start: start, line_end: end }];
  return { ...select(input, ['action']), expectedSource: text.split('\n').slice(start - 1).join('\n') };
}

test('function and object method declarations are not calls while actual nested guard calls remain available', t => {
  const input = lexicalFixture(t, [
    '  function hasDormantRole() { return false; }',
    '  const dormant = function hasUnusedRole() { return false; };',
    '  const session = {',
    '    hasPendingValue() { return false; },',
    '    hasAttribute(name) { return name !== undefined; },',
    '    verify(actor) { return hasAccess(actor); },',
    '  };',
    '  return session;',
  ]);
  const context = prepareSemanticArchitectureGrounding(input).contexts[0];
  assert.deepEqual(context.missing_guard_definitions, []); assert(context.sources.some(source => source.defines.includes('hasAccess')));
  assert.equal(context.unexpanded_call_boundaries.some(boundary => ['hasDormantRole', 'hasUnusedRole', 'hasPendingValue', 'hasAttribute', 'verify'].includes(boundary.callee)), false);
  const raw = context.sources.find(source => source.defines.includes('run'));
  assert.equal(raw.text, input.expectedSource); assert.equal(raw.text_sha256, semanticDigest(input.expectedSource));
});

test('a real call is not hidden by a same-name method declaration elsewhere in the supplied body', t => {
  const input = lexicalFixture(t, ['  const fake = { hasAttribute(name) { return Boolean(name); } };', '  return hasAttribute(actor);']);
  const context = prepareSemanticArchitectureGrounding(input).contexts[0];
  assert(context.missing_guard_definitions.some(name => name.endsWith(':hasAttribute'))); assert.equal(context.can_assert_supported, false);
});

test('comment receivers do not attach to the next real call and block-comment calls are not inspected', t => {
  const input = lexicalFixture(t, ['  // An explanatory fake gate.', '  /* hiddenNamespace.', '     hasMissingPermission(actor); */', '  return hasAccess(actor);'], { namespace: true });
  const context = prepareSemanticArchitectureGrounding(input).contexts[0];
  assert.deepEqual(context.missing_guard_definitions, []); assert(context.sources.some(source => source.defines.includes('hasAccess')));
  assert.equal(context.unexpanded_call_boundaries.some(boundary => boundary.callee.includes('hasMissingPermission')), false);
  assert.equal(context.sources.find(source => source.defines.includes('run')).text, input.expectedSource);
});

test('real property access across newlines is retained rather than mistaken for a comment artifact', t => {
  const input = lexicalFixture(t, ['  return gate', '    .', '    hasAccess(actor);'], { namespace: true });
  const context = prepareSemanticArchitectureGrounding(input).contexts[0];
  assert.deepEqual(context.missing_guard_definitions, []); assert(context.sources.some(source => source.defines.includes('hasAccess')));
});

test('URLs, regex literals and template expressions never cause comment masking to hide real calls', t => {
  for (const expression of [
    '  const url = "http://example.invalid/"; return hasAccess(actor);',
    '  const pattern = /[/*]/; return hasAccess(actor);',
    '  const label = `role:${hasAccess(actor)}`;',
    '  const label = `outer ${`inner http://example.invalid/${hasAccess(actor)}`}`;',
    '  const label = `outer ${"}" + `inner http://example.invalid/${hasAccess(actor)}`}`;',
    '  return hasAccess(`outer ${`inner ) {`}`);',
  ]) {
    const input = lexicalFixture(t, [expression]), context = prepareSemanticArchitectureGrounding(input).contexts[0];
    assert(context.sources.some(source => source.defines.includes('hasAccess')), expression);
    assert.equal(context.sources.find(source => source.defines.includes('run')).text, input.expectedSource);
  }
});

test('a bare real guard call followed by a newline block is not an object method declaration', t => {
  const input = lexicalFixture(t, ['  hasAccess(actor)', '  { const unrelated = 1; }'], { missing: true });
  const context = prepareSemanticArchitectureGrounding(input).contexts[0];
  assert(context.missing_guard_definitions.some(name => name.endsWith(':hasAccess'))); assert.equal(context.can_assert_supported, false);
});

function adapterFixture(t) {
  const input = fixture(t, { 'operation.ts': 'import { memberInGroup } from "./membership.js";\nexport function changeItem(actor) {\n  const member = memberInGroup(actor);\n  return member.kind === "editor";\n}\n', 'membership.ts': 'import { effectiveMemberRecord } from "./access.js";\nexport function memberInGroup(actor) {\n  return effectiveMemberRecord(actor);\n}\n', 'access.ts': 'export function effectiveMemberRecord(actor) {\n  return resolveAccessDecision(actor);\n}\n\nexport function resolveAccessDecision(actor) {\n  return actor.memberRecord;\n}\n' });
  input.native = { nodes: [{ id: 'action', provider: 'codegraph', kind: 'function', label: 'changeItem', path: 'operation.ts', line_start: 2, line_end: 5 }, { id: 'member', provider: 'codegraph', kind: 'function', label: 'memberInGroup', path: 'membership.ts', line_start: 2, line_end: 4 }, { id: 'effective', provider: 'codegraph', kind: 'function', label: 'effectiveMemberRecord', path: 'access.ts', line_start: 1, line_end: 3 }, { id: 'resolve', provider: 'codegraph', kind: 'function', label: 'resolveAccessDecision', path: 'access.ts', line_start: 5, line_end: 7 }], edges: [{ id: 'one', source: 'action', target: 'member', type: 'calls' }, { id: 'two', source: 'member', target: 'effective', type: 'calls' }, { id: 'three', source: 'effective', target: 'resolve', type: 'calls' }] };
  input.claims[0].evidence = [{ path: 'operation.ts', line_start: 3, line_end: 4 }]; input.claims[0].text = 'Only an editor may change the item.';
  return select(input, ['action']);
}

test('member/access result adapters expand beyond assert/is prefixes through actual calls and relative imports', t => {
  for (const nativeCalls of [true, false]) {
    const input = adapterFixture(t); if (!nativeCalls) input.native.edges = [];
    const context = prepareSemanticArchitectureGrounding(input).contexts[0];
    assert.deepEqual(context.sources.flatMap(source => source.defines).sort(), ['changeItem', 'effectiveMemberRecord', 'memberInGroup', 'resolveAccessDecision'].sort());
    assert.equal(context.guard_definition_ids.length, 3); assert.deepEqual(context.missing_guard_definitions, []);
    assert.equal(context.can_assert_supported, true); assert.equal(context.dependency_closure_complete, true); assert.deepEqual(context.unexpanded_call_boundaries, []);
  }
});

test('a missing authorization adapter cannot be hidden by a complete caller or another adapter', t => {
  const input = adapterFixture(t); input.native.nodes = input.native.nodes.filter(node => node.id !== 'effective');
  const context = prepareSemanticArchitectureGrounding(input).contexts[0];
  assert.equal(context.can_assert_supported, false); assert.equal(context.dependency_closure_complete, false);
  assert(context.missing_guard_definitions.some(value => value.includes('effectiveMemberRecord')));
});

test('unexpanded business/unknown call boundaries are explicit in both model context and persisted dependency ledger', async t => {
  const input = fixture(t, { 'caller.ts': 'import { resolveAccessDecision } from "./access.js";\nexport function closeRecord(actor) {\n  const access = resolveAccessDecision(actor);\n  return access.allowed;\n}\n', 'access.ts': 'export function resolveAccessDecision(actor) {\n  const label = displayLabel(actor);\n  notifyUnknown(label);\n  actor.sdk.observe(label);\n  return actor.access;\n}\nexport function displayLabel(actor) {\n  return actor.label;\n}\n' });
  input.native = { nodes: [{ id: 'action', provider: 'codegraph', kind: 'function', label: 'closeRecord', path: 'caller.ts', line_start: 2, line_end: 5 }, { id: 'access', provider: 'codegraph', kind: 'function', label: 'resolveAccessDecision', path: 'access.ts', line_start: 1, line_end: 6 }, { id: 'display', provider: 'codegraph', kind: 'function', label: 'displayLabel', path: 'access.ts', line_start: 7, line_end: 9 }], edges: [{ id: 'one', type: 'calls', source: 'action', target: 'access' }, { id: 'two', type: 'calls', source: 'access', target: 'display' }] };
  select(input, ['action']); const context = prepareSemanticArchitectureGrounding(input).contexts[0];
  assert.equal(context.sources.some(source => source.defines.includes('displayLabel')), false);
  assert(context.unexpanded_call_boundaries.some(boundary => boundary.callee_definition_id === 'display' && boundary.kind === 'unexpanded_native_call'));
  assert(context.unexpanded_call_boundaries.some(boundary => boundary.callee === 'notifyUnknown' && boundary.kind === 'unresolved_standalone_call'));
  assert(context.unexpanded_call_boundaries.some(boundary => boundary.callee === 'sdk.observe' && boundary.kind === 'external_or_dynamic_receiver'));
  assert.equal(context.dependency_closure_complete, false); assert.deepEqual(context.missing_guard_definitions, []);
  const result = await reviewSemanticArchitectureClaims({ ...input, parallel, client: client(input, request => request.contexts.map(context => {
    assert.equal(context.dependency_closure_complete, false); assert(context.unexpanded_call_boundaries.length >= 3); return row(context, 'insufficient');
  })) });
  assert.equal(result.dependencies[0].dependency_closure_complete, false); assert.equal(result.blocking.length, 1);
  const persisted = JSON.parse(readFileSync(path.join(input.runDirectory, 'semantic-architecture-grounding.json'), 'utf8'));
  assert.deepEqual(persisted.dependencies[0].unexpanded_call_boundaries, context.unexpanded_call_boundaries);
});

test('generic explicitly imported SDK predicates remain external boundaries rather than missing project guards', async t => {
  const input = fixture(t, { 'caller.ts': 'import { isEmpty as hasRows } from "shape-sdk";\nexport function closeRecord(actor) {\n  if (hasRows(actor.rows)) return;\n  if (!canManage(actor)) return;\n  return "closed";\n}\nexport function canManage(actor) {\n  return actor.role === "manager";\n}\n' });
  input.native = { nodes: [{ id: 'action', provider: 'codegraph', kind: 'function', label: 'closeRecord', path: 'caller.ts', line_start: 2, line_end: 6 }, { id: 'guard', provider: 'codegraph', kind: 'function', label: 'canManage', path: 'caller.ts', line_start: 7, line_end: 9 }], edges: [] };
  select(input, ['action']); const context = prepareSemanticArchitectureGrounding(input).contexts[0];
  assert.deepEqual(context.missing_guard_definitions, []); assert.equal(context.can_assert_supported, true);
  assert.equal(context.dependency_closure_complete, false); assert(context.unexpanded_call_boundaries.some(boundary => boundary.callee === 'hasRows' && boundary.kind === 'external_import' && boundary.import_specifier === 'shape-sdk'));
  assert.deepEqual(context.sources.flatMap(source => source.defines), ['closeRecord', 'canManage']);
  const result = await reviewSemanticArchitectureClaims({ ...input, parallel, client: client(input, request => request.contexts.map(context => row(context, 'insufficient'))) });
  assert.equal(result.blocking.length, 1, 'an SDK import is not an implementation approval');
});

test('authority-relevant SDK imports stay unproven and cannot borrow an unrelated local definition', t => {
  for (const expression of ['isAdmin(actor)', 'policy.hasPermission(actor)']) {
    const importLine = expression.startsWith('policy') ? 'import * as policy from "authority-sdk";' : 'import { isAdmin } from "authority-sdk";';
    const input = fixture(t, { 'caller.ts': `${importLine}\nexport function closeRecord(actor) {\n  return ${expression};\n}\nfunction isAdmin(actor) {\n  return actor.localRole;\n}\n` });
    input.native = { nodes: [{ id: 'action', provider: 'codegraph', kind: 'function', label: 'closeRecord', path: 'caller.ts', line_start: 2, line_end: 4 }, { id: 'unrelated', provider: 'codegraph', kind: 'function', label: 'isAdmin', path: 'caller.ts', line_start: 5, line_end: 7 }], edges: [] };
    select(input, ['action']); const context = prepareSemanticArchitectureGrounding(input).contexts[0];
    assert.equal(context.can_assert_supported, false); assert.equal(context.dependency_closure_complete, false);
    assert(context.missing_guard_definitions.some(value => value.includes(expression.split('(')[0])));
    assert(context.unexpanded_call_boundaries.some(boundary => boundary.kind === 'external_import' && boundary.import_specifier === 'authority-sdk'));
    assert.equal(context.sources.some(source => source.defines.includes('isAdmin')), false);
  }
});

function packageFixture(t, namespace = false, privateGuard = false) {
  const input = fixture(t, {
    'app.ts': `${namespace ? 'import * as policy from "@acme/policy";' : 'import { canChange as allowed } from "@acme/policy";'}\nexport function mutate(actor) {\n  if (!${namespace ? 'policy.canChange' : 'allowed'}(actor)) return;\n  return "changed";\n}\n`,
    'packages/policy/package.json': JSON.stringify({ name: '@acme/policy', main: 'dist/index.js', exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } } }),
    'packages/policy/tsconfig.json': JSON.stringify({ extends: '../../tsconfig.base.json', compilerOptions: { rootDir: 'src', outDir: 'dist' } }),
    'tsconfig.base.json': JSON.stringify({ compilerOptions: { target: 'ES2023' } }),
    'packages/policy/src/index.ts': "export * from './public.js';\n",
    'packages/policy/src/public.ts': privateGuard ? "export * from './guards.js';\n" : "export { canEdit as canChange } from './guards.js';\n",
    'packages/policy/src/guards.ts': privateGuard ? '/*\nexport { canChange };\n*/\nfunction canChange(actor) {\n  return actor.role === "editor";\n}\n' : 'export function canEdit(actor) {\n  return actor.role === "editor";\n}\n',
  });
  input.native = { nodes: [{ id: 'action', provider: 'codegraph', kind: 'function', label: 'mutate', path: 'app.ts', line_start: 2, line_end: 5 }, { id: 'policy-guard', provider: 'codegraph', kind: 'function', label: privateGuard ? 'canChange' : 'canEdit', path: 'packages/policy/src/guards.ts', line_start: privateGuard ? 4 : 1, line_end: privateGuard ? 6 : 3 }], edges: [] };
  input.claims[0].text = 'Only an editor may mutate the record.'; input.claims[0].evidence = [{ path: 'app.ts', line_start: 3, line_end: 3 }];
  return select(input, ['action']);
}

test('workspace package names, declared entries, compiler paths and export aliases bind the actual exported guard', t => {
  for (const namespace of [false, true]) {
    const input = packageFixture(t, namespace), context = prepareSemanticArchitectureGrounding(input).contexts[0];
    assert.deepEqual(context.missing_guard_definitions, []); assert(context.sources.some(source => source.path === 'packages/policy/src/guards.ts' && source.defines.includes('canEdit')));
    const binding = context.resolved_package_imports.find(binding => binding.specifier === '@acme/policy');
    assert.equal(binding.exported_name, 'canChange'); assert.equal(binding.definition_id, 'policy-guard');
    assert.deepEqual(binding.proof.map(file => file.path), ['packages/policy/package.json', 'packages/policy/src/guards.ts', 'packages/policy/src/index.ts', 'packages/policy/src/public.ts', 'packages/policy/tsconfig.json', 'tsconfig.base.json']);
    for (const file of binding.proof) assert.equal(file.sha256, input.snapshot.files.find(source => source.path === file.path).sha256);
    assert.equal(context.unexpanded_call_boundaries.some(boundary => boundary.kind === 'external_import' && boundary.import_specifier === '@acme/policy'), false);
  }
});

test('private matching names and commented export text never grant workspace package visibility', t => {
  for (const namespace of [false, true]) {
    const input = packageFixture(t, namespace, true), context = prepareSemanticArchitectureGrounding(input).contexts[0];
    assert.equal(context.can_assert_supported, false); assert(context.missing_guard_definitions.length);
    assert.equal(context.sources.some(source => source.path === 'packages/policy/src/guards.ts'), false);
    assert(context.unexpanded_call_boundaries.some(boundary => boundary.kind === 'unresolved_package_export' && boundary.import_specifier === '@acme/policy'));
    input.native.edges.push({ id: 'loose-call', type: 'calls', source: 'action', target: 'policy-guard' });
    const nativeLooseMatch = prepareSemanticArchitectureGrounding(input).contexts[0];
    assert.equal(nativeLooseMatch.can_assert_supported, false); assert.equal(nativeLooseMatch.sources.some(source => source.path === 'packages/policy/src/guards.ts'), false);
  }
});

test('workspace package source identity is verified before reuse rather than downgraded to an unknown SDK', async t => {
  const input = packageFixture(t), calls = []; writeFileSync(path.join(input.sourceDirectory, 'packages/policy/package.json'), '{"name":"@acme/policy"}');
  await assert.rejects(reviewSemanticArchitectureClaims({ ...input, parallel, client: client(input, undefined, calls) }), error => error.details.reason === 'grounding_source_changed'); assert.equal(calls.length, 0);
});

test('wire catalogs deduplicate bodies, dependency rows and package proofs without changing any private context', t => {
  const input = packageFixture(t), original = input.claims[0]; input.claims.push({ ...structuredClone(original), id: 'second', field: '$.second' });
  const { primary_definition_ids: _ids, selection_sha256: _selection, selection_claim_sha256: _claimHash, selection_catalog_sha256: _catalog, ...secondOriginal } = input.claims[1];
  input.claims[1].selection_claim_sha256 = semanticDigest(secondOriginal);
  input.claims[1].selection_sha256 = groundingSelectionDigest({ snapshot_id: input.snapshot.snapshot_id, claim_id: 'second', text_sha256: semanticDigest(original.text), claim_sha256: input.claims[1].selection_claim_sha256, catalog_sha256: original.selection_catalog_sha256, primary_definition_ids: original.primary_definition_ids });
  const plan = prepareSemanticArchitectureGrounding(input), before = structuredClone(plan.contexts), wire = formatSemanticArchitectureGroundingSources(plan.contexts);
  assert(wire.source_catalog.length < plan.contexts.reduce((sum, context) => sum + context.sources.length, 0));
  assert(wire.dependency_catalog.package_sources.length < plan.contexts.flatMap(context => context.resolved_package_imports.flatMap(binding => binding.proof)).length);
  assert(wire.contexts.every(context => context.sources.every(source => !('text' in source))));
  assert.deepEqual(hydrate(wire).contexts, before); assert.deepEqual(plan.contexts, before);
  const request = prepareSemanticArchitectureGroundingRequest(input.snapshot.snapshot_id, plan.contexts);
  assert.equal(request.byteLength, Buffer.byteLength(JSON.stringify({ analysis_phase: 'architecture-grounding', ...request.input })));
  assert(request.byteLength <= 140_000); assert(plan.statistics.wire_source_bytes < plan.statistics.source_bytes);
  const collision = structuredClone(plan.contexts); collision[1].sources[0].text += 'changed';
  assert.throws(() => formatSemanticArchitectureGroundingSources(collision), error => error.details.reason === 'grounding_source_collision');
});

test('expanded private metadata above 25KB still fits the unchanged actual wire budgets without losing boundaries', t => {
  const calls = Array.from({ length: 350 }, (_, index) => `  work${index}(actor);`), text = ['export function action(actor) {', ...calls, '  return actor.result;', '}'].join('\n');
  const input = fixture(t, { 'action.ts': text }); input.native = { nodes: [{ id: 'action', provider: 'codegraph', kind: 'function', label: 'action', path: 'action.ts', line_start: 1, line_end: calls.length + 3 }], edges: [] };
  input.claims[0].text = 'Provides a browsing operation.'; input.claims[0].evidence = [{ path: 'action.ts', line_start: 1, line_end: calls.length + 3 }]; select(input, ['action']);
  const plan = prepareSemanticArchitectureGrounding(input), context = plan.contexts[0], { sources: _sources, ...privateMetadata } = context;
  assert(Buffer.byteLength(JSON.stringify(privateMetadata)) > 25_000); assert.equal(context.unexpanded_call_boundaries.length, 350);
  const wire = formatSemanticArchitectureGroundingSources([context]); assert(Buffer.byteLength(JSON.stringify(wire)) <= 125_000);
  assert.deepEqual(hydrate(wire).contexts, plan.contexts); assert(plan.groups.every(group => prepareSemanticArchitectureGroundingRequest(input.snapshot.snapshot_id, group).byteLength <= 140_000));
  input.claims[0].scope_context = { unchanged: 'x'.repeat(130_000) }; select(input, ['action']);
  assert.throws(() => prepareSemanticArchitectureGrounding(input), error => error.details.reason === 'grounding_claim_budget');
});

test('27 required guards are all cited under the bounded 100-reference private proof contract', async t => {
  const names = Array.from({ length: 27 }, (_, index) => `canRule${index}`), lines = ['export function action(actor) {', `  return ${names.map(name => `${name}(actor)`).join(' && ')};`, '}', ...names.map((name, index) => `export function ${name}(actor) { return actor.flag${index}; }`)];
  const input = fixture(t, { 'action.ts': lines.join('\n') });
  input.native = { nodes: [{ id: 'action', provider: 'codegraph', kind: 'function', label: 'action', path: 'action.ts', line_start: 1, line_end: 3 }, ...names.map((name, index) => ({ id: name, provider: 'codegraph', kind: 'function', label: name, path: 'action.ts', line_start: index + 4, line_end: index + 4 }))], edges: [] };
  input.claims[0].evidence = [{ path: 'action.ts', line_start: 1, line_end: 3 }];
  select(input, ['action']); const plan = prepareSemanticArchitectureGrounding(input); assert.equal(plan.contexts[0].guard_definition_ids.length, 27);
  const result = await reviewSemanticArchitectureClaims({ ...input, parallel, client: client(input) });
  assert.equal(result.checks[0].status, 'supported'); assert.equal(result.blocking.length, 0); assert.equal(result.checks[0].evidence.length, 28);
});

test('shared source catalogs never allow a claim to cite another context source', async t => {
  const input = fixture(t, { 'a.ts': 'export function browseA() { return true; }', 'b.ts': 'export function browseB() { return true; }' });
  input.native = { nodes: [{ id: 'a', provider: 'codegraph', kind: 'function', label: 'browseA', path: 'a.ts', line_start: 1, line_end: 1 }, { id: 'b', provider: 'codegraph', kind: 'function', label: 'browseB', path: 'b.ts', line_start: 1, line_end: 1 }], edges: [] };
  input.claims = ['a', 'b'].map(id => ({ id, node_id: `module:${id}`, field: `$.${id}`, text: 'Provides browsing.', kind: 'narrative', evidence: [{ path: `${id}.ts`, line_start: 1, line_end: 1 }] }));
  const foreign = prepareSemanticArchitectureGrounding(input).contexts.find(context => context.claim_id === 'b').sources[0].id;
  await assert.rejects(reviewSemanticArchitectureClaims({ ...input, parallel, client: client(input, request => request.contexts.map(context => row(context, 'supported', context.claim_id === 'a' ? [foreign] : context.sources.map(source => source.id)))) }), error => error.details.reason === 'schema');
});

test('private proof capacity accepts 100 distinct references and rejects 101 without cropping', async t => {
  for (const count of [100, 101]) {
    const names = Array.from({ length: 101 }, (_, index) => `browse${index}`), input = fixture(t, { 'wide.ts': names.map(name => `export function ${name}() { return true; }`).join('\n') });
    input.native = { nodes: names.map((name, index) => ({ id: name, provider: 'codegraph', kind: 'function', label: name, path: 'wide.ts', line_start: index + 1, line_end: index + 1 })), edges: [] };
    input.claims = [{ id: 'wide', node_id: 'module:wide', field: '$.wide', text: 'Provides browsing.', kind: 'narrative', evidence: [{ path: 'wide.ts', line_start: 1, line_end: 101 }] }];
    const run = reviewSemanticArchitectureClaims({ ...input, parallel, client: client(input, request => request.contexts.map(context => row(context, 'supported', context.sources.map(source => source.id).slice(0, count)))) });
    if (count === 100) assert.equal((await run).checks[0].evidence.length, 100);
    else await assert.rejects(run, error => error.details.reason === 'schema');
  }
});

test('actual guard contradiction blocks publication without rewriting the parent predicate', async t => {
  const input = fixture(t), before = structuredClone(input.claims), calls = [];
  const result = await reviewSemanticArchitectureClaims({ ...input, parallel, client: client(input, request => request.contexts.map(context => {
    assert.match(context.sources.find(source => source.path === 'access.ts').text, /role === "manager"/u);
    assert.equal(context.scope_context.name, 'Review completion'); return row(context, 'contradicted', context.guard_definition_ids);
  }), calls) });
  assert.equal(result.blocking.length, 1); assert.equal(result.checks[0].status, 'contradicted'); assert.deepEqual(input.claims, before);
  assert.equal(result.feedback[0].text_sha256, semanticDigest(input.claims[0].text)); assert(result.feedback[0].sources.some(source => source.path === 'access.ts'));
  assert.deepEqual(result.feedback[0].sources.map(source => source.path), ['access.ts']);
  assert.equal(result.feedback[0].snapshot_id, input.snapshot.snapshot_id); assert.equal(result.feedback[0].source_contexts[0].text_sha256, semanticDigest(input.claims[0].text));
  const reference = result.feedback[0].source_contexts[0], ledger = result.dependencies.find(row => row.context_id === reference.context_id);
  assert.equal('unexpanded_call_boundaries' in reference, false); assert.equal('resolved_package_imports' in reference, false);
  assert.equal(reference.dependency_ledger_sha256, semanticDigest({ required_definition_ids: ledger.required_definition_ids, callee_definition_ids: ledger.callee_definition_ids, guard_definition_ids: ledger.guard_definition_ids, missing_guard_definitions: ledger.missing_guard_definitions, unexpanded_call_boundaries: ledger.unexpanded_call_boundaries, resolved_package_imports: ledger.resolved_package_imports }));
  assert.equal(reference.unexpanded_call_boundary_count, ledger.unexpanded_call_boundaries.length);
  assert.equal(calls[0].grounding_protocol, 'architecture-source-grounding-1.0.0');
});

test('caller forwarding alone cannot support a role predicate even when a helper was provided', async t => {
  const input = fixture(t);
  const result = await reviewSemanticArchitectureClaims({ ...input, parallel, client: client(input, request => request.contexts.map(context => row(context, 'supported', context.sources.filter(source => source.path === 'caller.ts').map(source => source.id)))) });
  assert.equal(result.checks[0].status, 'insufficient'); assert.equal(result.blocking.length, 1); assert.match(result.checks[0].reason, /宿主未接受/u);
});

test('a complete cited implementation and guard can establish a correctly scoped rule', async t => {
  const input = fixture(t); input.claims[0].text = 'Only managers may close records after the canManage guard succeeds.';
  const result = await reviewSemanticArchitectureClaims({ ...input, parallel, client: client(input) });
  assert.equal(result.blocking.length, 0); assert.equal(result.checks[0].status, 'supported');
});

test('missing and oversized guard definitions never become complete implementation proof', async t => {
  const input = fixture(t); input.native.nodes = input.native.nodes.filter(node => node.id !== 'cg:manage'); input.native.edges = [];
  const prepared = prepareSemanticArchitectureGrounding(input); assert.equal(prepared.contexts[0].can_assert_supported, false); assert(prepared.contexts[0].missing_guard_definitions.some(name => name.includes('canManage')));
  const result = await reviewSemanticArchitectureClaims({ ...input, parallel, client: client(input) }); assert.equal(result.checks[0].status, 'insufficient');
  const huge = fixture(t, { 'caller.ts': 'import { canManage } from "./access.js";\nexport function closeRecord(actor) {\n  if (!canManage(actor)) throw Error("forbidden");\n  return "closed";\n}\n', 'access.ts': `export function canManage(actor) {\n/*${'x'.repeat(110_000)}*/\n  return actor.role === "manager";\n}\n` });
  huge.native.nodes[1].line_end = 4;
  const oversized = prepareSemanticArchitectureGrounding(huge); assert.equal(oversized.contexts[0].can_assert_supported, false); assert(oversized.contexts[0].missing_guard_definitions.some(name => name.includes('definition_exceeds_page_budget')));
  assert.equal(oversized.contexts[0].sources.some(source => source.path === 'access.ts'), false);
});

test('test definitions and documentation cannot prove implementation role/state permissions', async t => {
  const input = fixture(t, { 'policy.test.ts': 'function permitReviewer(actor) {\n  return actor.role === "reviewer";\n}\n', 'policy.md': 'Reviewers are expected to close records.\n' });
  input.native = { nodes: [{ id: 'cg:test', kind: 'function', label: 'permitReviewer', path: 'policy.test.ts', line_start: 1, line_end: 3 }], edges: [] };
  input.claims[0].evidence = [{ path: 'policy.test.ts', line_start: 1, line_end: 3 }, { path: 'policy.md', line_start: 1, line_end: 1 }];
  const prepared = prepareSemanticArchitectureGrounding(input); assert.equal(prepared.contexts[0].can_assert_supported, false);
  const result = await reviewSemanticArchitectureClaims({ ...input, parallel, client: client(input) }); assert.equal(result.checks[0].status, 'insufficient'); assert.equal(result.blocking.length, 1);
});

test('changed source bytes fail before using a cached or live model decision', async t => {
  const input = fixture(t), calls = []; writeFileSync(path.join(input.sourceDirectory, 'access.ts'), 'export function canManage() { return true; }\n');
  await assert.rejects(reviewSemanticArchitectureClaims({ ...input, parallel, client: client(input, undefined, calls) }), error => error.details.reason === 'grounding_source_changed'); assert.equal(calls.length, 0);
});

test('exact claim coverage, original text SHA and per-context source citations are mandatory', async t => {
  for (const mutate of [rows => [], rows => rows.map(row => ({ ...row, text_sha256: 'b'.repeat(64) })), rows => rows.map(row => ({ ...row, evidence_ids: ['GS-foreign'] })), rows => rows.map(row => ({ ...row, evidence_ids: [...row.evidence_ids, row.evidence_ids[0]] })), rows => rows.map(row => ({ ...row, claim_id: 'other-claim' }))]) {
    const input = fixture(t);
    await assert.rejects(reviewSemanticArchitectureClaims({ ...input, parallel, client: client(input, request => mutate(request.contexts.map(context => row(context)))) }), { code: 'code_analysis_model_invalid' });
  }
});

test('citation diagnostics direct repair to safe row paths and context-scoped constraints without echoing rejected text', async t => {
  for (const kind of ['duplicate', 'supported-empty', 'contradicted-empty', 'unknown']) {
    const input = fixture(t), prepared = prepareSemanticArchitectureGrounding(input), allowed = prepared.contexts[0].sources.map(source => source.id), marker = 'UNTRUSTED_RESPONSE_TEXT_MUST_NOT_BE_REFLECTED';
    const direct = { call: async request => {
      const contexts = hydrate(request.input).contexts, checks = contexts.map(context => row(context)); checks[0].reason = marker;
      if (kind === 'duplicate') checks[0].evidence_ids = [allowed[0], allowed[0]];
      else if (kind === 'unknown') checks[0].evidence_ids = [marker];
      else { checks[0].status = kind === 'contradicted-empty' ? 'contradicted' : 'supported'; checks[0].evidence_ids = []; }
      return { value: request.validate(envelope(request.input, checks)), cached: false };
    } };
    const before = semanticDigest(prepareSemanticArchitectureGroundingRequest(input.snapshot.snapshot_id, prepared.groups[0]).input);
    await assert.rejects(reviewSemanticArchitectureClaims({ ...input, parallel, client: direct }), error => {
      const expectedPath = '$.checks.' + prepared.contexts[0].context_id + '.evidence_ids' + (kind === 'unknown' ? '[0]' : '');
      assert.equal(error.details.repairable, true); assert.deepEqual(error.details.issue_paths, [expectedPath]);
      const issue = error.details.schema_issues[0]; assert.equal(issue.path, expectedPath);
      assert.equal(issue.rule, kind === 'duplicate' ? 'unique_items' : kind === 'unknown' ? 'enum' : 'min_items');
      assert.deepEqual(issue.allowed_values, allowed); if (kind.endsWith('-empty')) { assert.equal(issue.minimum, 1); assert.equal(issue.observed_count, 0); }
      assert.equal(JSON.stringify(error.details).includes(marker), false); return true;
    });
    assert.equal(semanticDigest(prepareSemanticArchitectureGroundingRequest(input.snapshot.snapshot_id, prepared.groups[0]).input), before);
  }
});

test('foreign-but-known source IDs receive the current context vocabulary, including combined duplicate diagnostics', async t => {
  const input = fixture(t, { 'a.ts': 'export function browseA() { return true; }', 'b.ts': 'export function browseB() { return true; }' });
  input.native = { nodes: [{ id: 'a', provider: 'codegraph', kind: 'function', label: 'browseA', path: 'a.ts', line_start: 1, line_end: 1 }, { id: 'b', provider: 'codegraph', kind: 'function', label: 'browseB', path: 'b.ts', line_start: 1, line_end: 1 }], edges: [] };
  input.claims = ['a', 'b'].map(id => ({ id, node_id: `module:${id}`, field: `$.${id}`, text: 'Provides browsing.', kind: 'narrative', evidence: [{ path: `${id}.ts`, line_start: 1, line_end: 1 }] }));
  const prepared = prepareSemanticArchitectureGrounding(input), contexts = prepared.legacy_groups[0], allowed = prepared.contexts[0].sources.map(source => source.id), other = prepared.contexts[1].sources[0].id;
  await assert.rejects(reviewSemanticArchitectureClaims({ ...input, parallel, client: { call: async request => {
    const checks = contexts.map(context => row(context)); checks[0].evidence_ids = [other, other]; return { value: decodeSemanticArchitectureGroundingResponse({ checks }, input.snapshot.snapshot_id, contexts, true), cached: false };
  } } }), error => {
    assert.equal(error.details.reason, 'grounding_evidence'); assert.deepEqual(error.details.issue_paths, ['$.checks[0].evidence_ids']);
    assert.deepEqual(error.details.schema_issues.map(issue => issue.rule), ['unique_items', 'enum']);
    const vocab = error.details.schema_issues.find(issue => issue.rule === 'enum').allowed_values;
    assert.deepEqual(vocab, allowed); assert.equal(vocab.includes(other), false); return true;
  });
});

test('directed citation repair preserves the original task and writes only the accepted wire result to the same cache', async t => {
  const input = fixture(t), calls = []; input.claims[0].text = 'Only managers may close records.';
  const c = client(input, request => {
    const checks = request.contexts.map(context => row(context));
    if (calls.length === 1) checks[0].evidence_ids.push(checks[0].evidence_ids[0]);
    else {
      assert.equal(readdirSync(input.cacheDirectory).length, 0, 'invalid first response is never cached');
      assert.equal(request.correction.reason, 'grounding_evidence'); assert.deepEqual(request.correction.fields, ['$.checks.' + request.contexts[0].context_id + '.evidence_ids']);
      assert.equal(request.correction.constraints[0].rule, 'unique_items'); assert.deepEqual(request.correction.constraints[0].allowed_values, request.contexts[0].sources.map(source => source.id));
    }
    return checks;
  }, calls);
  const result = await reviewSemanticArchitectureClaims({ ...input, parallel, client: c });
  assert.equal(result.checks[0].status, 'supported'); assert.equal(calls.length, 2);
  const { correction: _correction, ...repaired } = calls[1]; assert.deepEqual(repaired, calls[0]);
  assert.equal(readdirSync(input.cacheDirectory).length, 1);
  await reviewSemanticArchitectureClaims({ ...input, parallel, client: c }); assert.equal(calls.length, 2); assert.equal(c.metrics().cacheHits, 1);
});

test('cache binds exact claims and source contexts while ordinary JSON field names are not role predicates', async t => {
  const input = fixture(t), calls = [];
  input.claims[0].text = JSON.stringify({ state_owners: ['Record information'], summary: 'Provides record browsing.' });
  const c = client(input, undefined, calls), first = await reviewSemanticArchitectureClaims({ ...input, parallel, client: c });
  assert.equal(first.checks[0].high_risk, false); assert.equal(first.blocking.length, 0);
  await reviewSemanticArchitectureClaims({ ...input, parallel, client: c }); assert.equal(calls.length, 1);
  input.claims[0].text = JSON.stringify({ state_owners: ['Record information'], summary: 'Provides record search.' });
  await reviewSemanticArchitectureClaims({ ...input, parallel, client: c }); assert.equal(calls.length, 2);
});

test('generic validation labels alone are ordinary navigation rather than role or transition predicates', t => {
  const input = fixture(t); input.claims[0].text = '提供资料验证与输入校验流程。';
  assert.equal(prepareSemanticArchitectureGrounding(input).contexts[0].high_risk, false);
});

test('whole definitions split without clipping and a later contradiction wins over another page', async t => {
  const a = `export function inspectA() {\n/*${'a'.repeat(72_000)}*/\nreturn true;\n}\n`, b = `export function inspectB() {\n/*${'b'.repeat(72_000)}*/\nreturn true;\n}\n`;
  const input = fixture(t, { 'a.ts': a, 'b.ts': b });
  input.native = { nodes: [{ id: 'cg:a', kind: 'function', label: 'inspectA', path: 'a.ts', line_start: 1, line_end: 4 }, { id: 'cg:b', kind: 'function', label: 'inspectB', path: 'b.ts', line_start: 1, line_end: 4 }], edges: [] };
  input.claims[0].evidence = [{ path: 'a.ts', line_start: 1, line_end: 4 }, { path: 'b.ts', line_start: 1, line_end: 4 }];
  const prepared = prepareSemanticArchitectureGrounding(input); assert.equal(prepared.contexts.length, 2);
  assert.deepEqual(prepared.contexts.flatMap(context => context.sources.map(source => source.text)).sort(), [a.trimEnd(), b.trimEnd()].sort());
  assert(prepared.contexts.every(context => context.can_assert_supported === false));
  const result = await reviewSemanticArchitectureClaims({ ...input, parallel, client: client(input, request => request.contexts.map(context => row(context, context.page === 2 ? 'contradicted' : 'insufficient'))) });
  assert.equal(result.checks[0].status, 'contradicted'); assert.equal(result.blocking.length, 1); assert.equal(result.checks[0].context_ids.length, 2);
  assert.deepEqual(result.feedback[0].sources.map(source => source.path), ['b.ts']); assert.equal(result.feedback[0].source_contexts.length, 1);
  assert(result.feedback[0].source_bytes < prepared.statistics.source_bytes);
});

test('original document, config and type ranges survive empty retrieval and require explicit source-definition scope', async t => {
  for (const [file, text, nativeKind] of [
    ['policy.md', 'The document requires a reviewer to approve changes.\n'],
    ['pipeline.yml', 'jobs:\n  build:\n    needs: validate\n'],
    ['config.json', '{"permissions":{"reviewer":"approve"}}\n'],
    ['contract.ts', 'export interface Policy {\n  reviewer: string;\n}\n', 'interface'],
    ['defaults.ts', 'export const defaults = { role: "reviewer" };\n', 'variable'],
  ]) {
    const input = fixture(t, { [file]: text });
    input.native = { nodes: nativeKind ? [{ id: 'declaration', provider: 'codegraph', kind: nativeKind, label: 'Policy', path: file, line_start: 1, line_end: text.trimEnd().split('\n').length }] : [], edges: [] };
    input.claims[0] = { ...input.claims[0], text: 'The visible source definition declares reviewer permissions.', evidence: [{ path: file, line_start: 1, line_end: text.trimEnd().split('\n').length }] };
    select(input, nativeKind ? ['declaration'] : []);
    const plain = prepareSemanticArchitectureGrounding(input).contexts[0];
    assert.equal(plain.source_scope, 'source_definition'); assert.equal(plain.can_assert_supported, false);
    assert.equal(plain.sources.length, 1); assert.equal(plain.sources[0].text_sha256, semanticDigest(plain.sources[0].text));
    const runtime = await reviewSemanticArchitectureClaims({ ...input, parallel, client: client(input) });
    assert.equal(runtime.checks[0].status, 'insufficient');
    input.claims[0].assertion_scope = 'source_definition'; select(input, nativeKind ? ['declaration'] : []);
    const scoped = prepareSemanticArchitectureGrounding(input).contexts[0];
    assert.equal(scoped.assertion_scope, 'source_definition'); assert.equal(scoped.can_assert_supported, true);
    const result = await reviewSemanticArchitectureClaims({ ...input, parallel, client: client(input) });
    assert.equal(result.checks[0].status, 'supported');
    assert.notEqual(scoped.context_id, plain.context_id);
  }
});

test('test functions remain definition-only and cannot establish executed tests or deployed permissions', async t => {
  const input = fixture(t, { 'policy.test.ts': 'export function policyTest() {\n  assert.equal(role, "reviewer");\n}\n' });
  input.native = { nodes: [{ id: 'test', provider: 'codegraph', kind: 'function', label: 'policyTest', path: 'policy.test.ts', line_start: 1, line_end: 3 }], edges: [] };
  input.claims[0] = { ...input.claims[0], text: 'Tests executed successfully and reviewer permissions are deployed.', evidence: [{ path: 'policy.test.ts', line_start: 1, line_end: 3 }] };
  select(input, ['test']);
  const runtime = await reviewSemanticArchitectureClaims({ ...input, parallel, client: client(input) });
  assert.equal(runtime.checks[0].status, 'insufficient'); assert.equal(runtime.feedback[0].source_scope, 'source_definition');
  input.claims[0].text = 'The test definition asserts that the role equals reviewer.'; input.claims[0].assertion_scope = 'source_definition'; select(input, ['test']);
  const contexts = prepareSemanticArchitectureGrounding(input).contexts, request = prepareSemanticArchitectureGroundingRequest(input.snapshot.snapshot_id, contexts);
  assert(request.input.task.includes('测试已运行通过')); assert(request.input.task.includes('实际运行结果仍须insufficient'));
  const definition = await reviewSemanticArchitectureClaims({ ...input, parallel, client: client(input) });
  assert.equal(definition.checks[0].status, 'supported');
});

test('zero-cited insufficiency discloses complete bounded retrieval context without inventing verdict citations', async t => {
  const input = fixture(t, { 'policy.md': 'The document declares approval expectations.\n' }); input.native = { nodes: [], edges: [] };
  input.claims[0] = { ...input.claims[0], field: 'flows.0.summary:0-30', text: 'The reviewer completes approval.', evidence: [{ path: 'policy.md', line_start: 1, line_end: 1 }] }; select(input, []);
  const result = await reviewSemanticArchitectureClaims({ ...input, parallel, client: client(input, request => request.contexts.map(context => row(context, 'insufficient', []))) });
  const feedback = result.feedback[0]; assert.deepEqual(feedback.evidence, []); assert.deepEqual(feedback.verdict_source_ids, []);
  assert.equal(feedback.sources.length, 1); assert.deepEqual(feedback.retrieval_context_source_ids, [feedback.sources[0].id]);
  assert.equal(feedback.source_scope, 'source_definition'); assert.match(feedback.source_disclosure, /retrieval_context/);
});

test('an oversized original declaration remains an explicit unknown rather than a clipped source', async t => {
  const text = `Declared policy: ${'x'.repeat(110_000)}`, input = fixture(t, { 'policy.md': text }); input.native = { nodes: [], edges: [] };
  input.claims[0] = { ...input.claims[0], text: 'The document declares policy.', assertion_scope: 'source_definition', evidence: [{ path: 'policy.md', line_start: 1, line_end: 1 }] }; select(input, []);
  const contexts = prepareSemanticArchitectureGrounding(input).contexts;
  assert.deepEqual(contexts[0].sources, []); assert.equal(contexts[0].can_assert_supported, false);
  assert(contexts[0].missing_guard_definitions.some(value => value.includes('excerpt_exceeds_page_budget')));
  assert.equal(readFileSync(path.join(input.sourceDirectory, 'policy.md'), 'utf8'), text);
});

test('source selection cannot forge original ranges, declaration scope or unrelated native provenance', t => {
  const invalidScope = fixture(t); invalidScope.claims[0].assertion_scope = 'runtime';
  assert.throws(() => prepareSemanticArchitectureGrounding(invalidScope), error => error.details.reason === 'grounding_claim_identity');
  const changedScope = select(fixture(t), ['cg:close']); changedScope.claims[0].assertion_scope = 'source_definition';
  assert.throws(() => prepareSemanticArchitectureGrounding(changedScope), error => error.details.reason === 'grounding_selection_identity');
  const unrelated = select(fixture(t), ['cg:manage']);
  assert.throws(() => prepareSemanticArchitectureGrounding(unrelated), error => error.details.reason === 'grounding_selection_evidence');
  const invalidRange = fixture(t); invalidRange.claims[0].evidence[0].line_end = 900; select(invalidRange, ['cg:close']);
  assert.throws(() => prepareSemanticArchitectureGrounding(invalidRange), error => error.details.reason === 'grounding_source_range');
  const invalidNative = fixture(t); invalidNative.native.nodes.push({ id: 'bad-type', provider: 'codegraph', kind: 'type', label: 'Policy', path: 'caller.ts', line_start: 1, line_end: 900 });
  assert.throws(() => prepareSemanticArchitectureGrounding(invalidNative), error => error.details.reason === 'grounding_native_range');
});

test('the current verifier preserves subject quantifiers and conditional counterexamples without changing the legacy audit request', t => {
  const input = fixture(t), contexts = prepareSemanticArchitectureGrounding(input).contexts;
  const current = prepareSemanticArchitectureGroundingRequest(input.snapshot.snapshot_id, contexts), legacy = prepareLegacySemanticArchitectureGroundingRequest(input.snapshot.snapshot_id, contexts);
  assert.equal(current.input.static_source_semantics, 'static-conditional-1.3.0');
  for (const fragment of ['所有原始主体', 'A只支持P、B只支持Q', 'Bearer分支', 'A成立、C不成立']) assert(current.input.task.includes(fragment), fragment);
  assert.equal('static_source_semantics' in legacy.input, false); assert.equal(legacy.input.task.includes('A只支持P、B只支持Q'), false);
});

test('empty claims need no model request or invented source coverage', async t => {
  const input = fixture(t), calls = []; input.claims = [];
  const result = await reviewSemanticArchitectureClaims({ ...input, parallel, client: client(input, undefined, calls) });
  assert.deepEqual(result.checks, []); assert.deepEqual(result.blocking, []); assert.equal(result.statistics.requests, 0); assert.equal(calls.length, 0);
});

function recoveryFixture(t) {
  const input = fixture(t);
  input.native.nodes = input.native.nodes.map(node => ({ ...node, provider: 'codegraph', verification: 'observed', evidence_ids: ['e:' + node.id] }));
  input.native.edges = input.native.edges.map(edge => ({ ...edge, provider: 'codegraph', provenance: 'native', verification: 'inferred', evidence_ids: [] }));
  input.native.evidence = input.native.nodes.map(node => ({ id: 'e:' + node.id, path: node.path, line_start: node.line_start, line_end: node.line_end, sha256: input.snapshot.files.find(file => file.path === node.path).sha256 }));
  return input;
}
function retrievalClient(target) {
  return { call: async request => ({ cached: false, value: request.validate({ selections: request.input.contexts.map(context => {
    const selected_definition_ids = context.candidates.some(item => item.definition_id === target) ? [target] : [];
    return { context_id: context.context_id, claim_id: context.claim_id, text_sha256: context.text_sha256, catalog_sha256: context.catalog_sha256, page_sha256: context.page_sha256, selected_definition_ids, missing_reasons: selected_definition_ids.length ? [] : ['This page does not contain the operation.'] };
  }) }) }) };
}
async function recoveredFixture(t) {
  const input = recoveryFixture(t), original = structuredClone(input.claims[0]);
  const selected = await selectArchitectureClaimSources({ ...input, parallel, client: retrievalClient('cg:close') });
  const recovery = { context: createArchitectureNativeRecoveryContext(input), previous: selected.claims };
  const recovered = await selectArchitectureClaimSources({ ...input, parallel, client: retrievalClient('cg:manage'), recovery });
  return { input, original, selected, recovered };
}
function signSelection(snapshot, claim) {
  claim.selection_sha256 = groundingSelectionDigest({ snapshot_id: snapshot.snapshot_id, claim_id: claim.id, text_sha256: semanticDigest(claim.text), claim_sha256: claim.selection_claim_sha256, catalog_sha256: claim.selection_catalog_sha256, primary_definition_ids: claim.primary_definition_ids, selected_source_evidence: claim.selected_source_evidence, selection_recovery: claim.selection_recovery });
}

test('grounder independently accepts an actual native reachable helper outside immutable original references', async t => {
  const { input, original, recovered } = await recoveredFixture(t);
  assert.deepEqual(recovered.claims[0].evidence, original.evidence);
  assert.deepEqual(recovered.claims[0].primary_definition_ids, ['cg:manage']);
  assert.equal(recovered.claims[0].selection_claim_sha256, semanticDigest(original));
  const prepared = prepareSemanticArchitectureGrounding({ ...input, claims: recovered.claims });
  assert(prepared.contexts.some(context => context.sources.some(source => source.path === 'access.ts' && source.definition_complete && source.text.includes('actor.role === "manager"'))));
  assert.deepEqual(input.claims[0], original);
});

test('recovery metadata, native paths and graph identities are reconstructed rather than trusted', async t => {
  const { input, recovered } = await recoveredFixture(t);
  for (const mutate of [
    value => { value.claims[0].selection_recovery.catalog_sha256 = 'f'.repeat(64); signSelection(value.snapshot, value.claims[0]); },
    value => { value.claims[0].selection_recovery.protocol = 'unversioned'; signSelection(value.snapshot, value.claims[0]); },
    value => { value.claims[0].selection_recovery.extra = true; signSelection(value.snapshot, value.claims[0]); },
    value => { value.native.edges[0].source = 'cg:manage'; value.native.edges[0].target = 'cg:close'; },
    value => { value.native.edges[0].provenance = 'bridge'; },
    value => { delete value.claims[0].selection_recovery; signSelection(value.snapshot, value.claims[0]); },
  ]) {
    const changed = { ...input, claims: structuredClone(recovered.claims), native: structuredClone(input.native) }; mutate(changed);
    assert.throws(() => prepareSemanticArchitectureGrounding(changed), { code: 'code_analysis_model_invalid' });
  }
});

test('new recovery selection still validates complete source bytes and cannot reuse a mutated helper body', async t => {
  const { input, recovered } = await recoveredFixture(t);
  writeFileSync(path.join(input.sourceDirectory, 'access.ts'), 'export function canManage() { return true; }');
  assert.throws(() => prepareSemanticArchitectureGrounding({ ...input, claims: recovered.claims }), error => error.details.reason === 'grounding_source_changed');
});

function bindingFixture(t) {
  const input = fixture(t, {
    'caller.ts': 'import { canManage } from "./access.js"; const READY = "ready";\nexport function setMode(actor, slot) {\n  if (!canManage(actor)) throw Error("forbidden");\n  slot.left = READY;\n  slot.right = READY;\n}\n',
    'access.ts': 'export function canManage(actor) {\n  return actor.role === "manager";\n}\n',
  });
  input.native.nodes[0].label = 'setMode'; input.native.nodes[0].line_end = 6;
  input.claims[0].text = '管理权限满足后把 slot.left、slot.right 设为 READY。';
  return input;
}
function bindingRow(context, status = 'supported') {
  const value = row(context, status), plan = parseClaimBindings(context.text);
  if (!plan.bindings.length) return value;
  value.binding_checks = Object.fromEntries(plan.bindings.map(binding => [binding.id, { status: 'supported', reason: 'The cited definition covers this original-claim binding in its whole scope.', evidence_ids: [...value.evidence_ids] }]));
  const guardIds = context.high_risk && context.assertion_scope !== 'source_definition' ? context.guard_definition_ids : [];
  value.guard_reviews = Object.fromEntries(guardIds.map(id => {
    const source = context.sources.find(source => source.id === id);
    return [id, { assessment: source ? 'required_verified' : 'insufficient', reason: source ? 'The provided complete definition was reviewed.' : 'This page does not provide this guard.', source_quote: source?.text.slice(0, 80) ?? '' }];
  }));
  return value;
}

test('a binding contradiction vetoes whole support and retains its actual decisive reason', t => {
  const input = bindingFixture(t), contexts = prepareSemanticArchitectureGrounding(input).contexts;
  assert.equal(contexts.length, 1);
  const value = bindingRow(contexts[0]);
  value.reason = 'The whole statement was judged supported.';
  const atom = Object.values(value.binding_checks)[0]; atom.status = 'contradicted'; atom.reason = 'The actual assignment has a different right-hand side.';
  const request = prepareSemanticArchitectureGroundingRequest(input.snapshot.snapshot_id, contexts);
  assert.equal(request.input.grounding_response_protocol, GROUNDING_BINDING_RESPONSE_PROTOCOL);
  const decoded = decodeSemanticArchitectureGroundingResponse(envelope(request.input, [value]), input.snapshot.snapshot_id, contexts)[0];
  assert.equal(decoded.status, 'contradicted'); assert.equal(decoded.reason, atom.reason);
  assert.equal(decoded.binding_review.whole_claim_check.status, 'supported');
  assert.deepEqual(decoded.evidence_ids, value.evidence_ids, 'the host does not add or replace citations');
});

test('binding support cannot upgrade whole insufficiency and a binding unknown cannot preserve whole support', t => {
  const input = bindingFixture(t), contexts = prepareSemanticArchitectureGrounding(input).contexts;
  const wholeUnknown = bindingRow(contexts[0], 'insufficient'); wholeUnknown.reason = 'A whole-claim branch remains unknown.';
  const request = prepareSemanticArchitectureGroundingRequest(input.snapshot.snapshot_id, contexts);
  const first = decodeSemanticArchitectureGroundingResponse(envelope(request.input, [wholeUnknown]), input.snapshot.snapshot_id, contexts)[0];
  assert.equal(first.status, 'insufficient'); assert.equal(first.reason, wholeUnknown.reason);
  const bindingUnknown = bindingRow(contexts[0]);
  const atom = Object.values(bindingUnknown.binding_checks)[0]; atom.status = 'insufficient'; atom.reason = 'This original binding is not established.';
  const second = decodeSemanticArchitectureGroundingResponse(envelope(request.input, [bindingUnknown]), input.snapshot.snapshot_id, contexts)[0];
  assert.equal(second.status, 'insufficient'); assert.equal(second.reason, atom.reason);
});

test('binding keys, context-scoped evidence and explicit final citations cannot be dropped or forged', t => {
  const input = bindingFixture(t), contexts = prepareSemanticArchitectureGrounding(input).contexts;
  const request = prepareSemanticArchitectureGroundingRequest(input.snapshot.snapshot_id, contexts);
  for (const mutate of [
    value => { delete value.binding_checks[Object.keys(value.binding_checks)[0]]; },
    value => { value.binding_checks['CB-foreign'] = Object.values(value.binding_checks)[0]; },
    value => { Object.values(value.binding_checks)[0].evidence_ids = ['GS-foreign']; },
    value => { const atom = Object.values(value.binding_checks)[0]; atom.evidence_ids = [contexts[0].sources[0].id]; value.evidence_ids = value.evidence_ids.filter(id => id !== atom.evidence_ids[0]); },
    value => { Object.values(value.guard_reviews)[0].source_quote = 'not a quote in this guard'; },
    value => { Object.values(value.guard_reviews)[0].source_quote = ' \n '; },
  ]) {
    const value = bindingRow(contexts[0]); mutate(value);
    assert.throws(() => decodeSemanticArchitectureGroundingResponse(envelope(request.input, [value]), input.snapshot.snapshot_id, contexts), { code: 'code_analysis_model_invalid' });
  }
});

test('a guard without page-local body is insufficient and cannot be classified as outside scope', t => {
  const input = bindingFixture(t), contexts = prepareSemanticArchitectureGrounding(input).contexts;
  const context = contexts[0]; context.guard_definition_ids.push('GS-body-not-on-page');
  const request = prepareSemanticArchitectureGroundingRequest(input.snapshot.snapshot_id, contexts), value = bindingRow(context);
  const decoded = decodeSemanticArchitectureGroundingResponse(envelope(request.input, [value]), input.snapshot.snapshot_id, contexts)[0];
  assert.equal(decoded.status, 'insufficient');
  value.guard_reviews['GS-body-not-on-page'].assessment = 'outside_scope_verified';
  assert.throws(() => decodeSemanticArchitectureGroundingResponse(envelope(request.input, [value]), input.snapshot.snapshot_id, contexts), error => error.details.reason === 'grounding_binding_guard_source');
});

test('only asserted source-definition scope avoids runtime guard reviews', t => {
  const input = bindingFixture(t), context = prepareSemanticArchitectureGrounding(input).contexts[0];
  context.assertion_scope = 'source_definition';
  const qualified = prepareSemanticArchitectureGroundingRequest(input.snapshot.snapshot_id, [context]), value = bindingRow(context);
  assert.deepEqual(value.guard_reviews, {});
  assert.equal(decodeSemanticArchitectureGroundingResponse(envelope(qualified.input, [value]), input.snapshot.snapshot_id, [context])[0].status, 'supported');
  delete context.assertion_scope; context.source_scope = 'source_definition';
  const unqualified = prepareSemanticArchitectureGroundingRequest(input.snapshot.snapshot_id, [context]);
  assert.throws(() => decodeSemanticArchitectureGroundingResponse(envelope(unqualified.input, [value]), input.snapshot.snapshot_id, [context]), { code: 'code_analysis_model_invalid' });
});

test('old plain response rows cannot masquerade as the binding protocol even under a forged current cache key', async t => {
  const input = bindingFixture(t), calls = [], c = client(input, request => request.contexts.map(context => bindingRow(context)), calls);
  const contexts = prepareSemanticArchitectureGrounding(input).contexts, request = prepareSemanticArchitectureGroundingRequest(input.snapshot.snapshot_id, contexts);
  c.save({ phase: 'architecture-grounding', input: request.input, inference_policy: { ...semanticInferencePolicy('architecture-grounding'), max_tokens: 32768 } }, envelope(request.input, contexts.map(context => row(context))), 'deepseek-v4.1-flash');
  const result = await reviewSemanticArchitectureClaims({ ...input, parallel, client: c });
  assert.equal(result.statistics.context_cached, 0); assert.equal(calls.length, 1);
  assert.equal(result.checks[0].status, 'supported');
});

test('validated binding singleton caches survive reorder and retain their complete private audit', async t => {
  const input = bindingFixture(t), calls = [];
  input.claims.push({ ...structuredClone(input.claims[0]), id: 'second-claim', field: 'flows.1.summary' });
  const c = client(input, request => request.contexts.map(context => bindingRow(context)), calls);
  await reviewSemanticArchitectureClaims({ ...input, parallel, client: c });
  const count = calls.length;
  const again = await reviewSemanticArchitectureClaims({ ...input, claims: [...input.claims].reverse(), parallel, client: c });
  assert.equal(calls.length, count); assert.equal(again.statistics.context_cached, 2);
  const audit = JSON.parse(readFileSync(path.join(input.runDirectory, 'semantic-architecture-grounding.json'), 'utf8'));
  assert.equal(audit.binding_reviews.length, 2);
  assert(audit.binding_reviews.every(item => item.review.plan.bindings.length === 2 && Object.keys(item.review.guard_reviews).length));
});

test('binding metadata and response-schema cost are planned before fixing source pages', t => {
  const input = bindingFixture(t), original = readFileSync(path.join(input.sourceDirectory, 'caller.ts'));
  input.claims[0].text = '权限满足后把 ' + Array.from({ length: 64 }, (_, index) => 'slot_' + 'x'.repeat(35) + index).join('、') + ' 设为 ACTIVE。';
  assert.throws(() => prepareSemanticArchitectureGrounding(input), error => error.details.reason === 'grounding_claim_budget');
  assert.deepEqual(readFileSync(path.join(input.sourceDirectory, 'caller.ts')), original);
});

test('plain and binding contexts are packed and repartitioned in separate protocol groups', t => {
  const input = bindingFixture(t);
  input.claims.push({ ...structuredClone(input.claims[0]), id: 'plain-mode', field: 'modules.1.summary', text: 'The function updates the controlled state.' });
  const prepared = prepareSemanticArchitectureGrounding(input);
  assert.equal(prepared.groups.length, 2);
  for (const group of [...prepared.groups, ...splitSemanticArchitectureGroundingGroups(input.snapshot.snapshot_id, prepared.contexts)]) {
    const modes = new Set(group.map(context => Boolean(parseClaimBindings(context.text).bindings.length)));
    assert.equal(modes.size, 1);
    const request = prepareSemanticArchitectureGroundingRequest(input.snapshot.snapshot_id, group);
    assert.equal(request.input.grounding_response_protocol, modes.has(true) ? GROUNDING_BINDING_RESPONSE_PROTOCOL : 'context-evidence-bindings-1.1.0');
  }
});

function unboundWireFixture() {
  const text = 'The function returns true.', sourceText = 'export function sample() { return true; }';
  return { context_id: 'GC-wire-fixture', claim_id: 'claim-wire-fixture', node_id: 'module:sample', field: 'modules.0.summary', text_sha256: semanticDigest(text), text, kind: 'narrative', high_risk: false, primary_definition_ids: ['cg:sample'], sources: [{ id: 'GS-wire-fixture', path: 'sample.ts', line_start: 1, line_end: 1, file_sha256: 'b'.repeat(64), text_sha256: semanticDigest(sourceText), text: sourceText, defines: ['sample'], definition_complete: true, source_kind: 'code' }], required_definition_ids: ['GS-wire-fixture'], callee_definition_ids: [], guard_definition_ids: [], missing_guard_definitions: [], unexpanded_call_boundaries: [], dependency_closure_complete: true, resolved_package_imports: [], can_assert_supported: true, page: 1, pages: 1 };
}

test('unbound request bytes retain the frozen pre-binding 1.1/static1.3 identity', () => {
  const context = unboundWireFixture(), request = prepareSemanticArchitectureGroundingRequest('a'.repeat(64), [context]);
  assert.equal(request.input.grounding_response_protocol, 'context-evidence-bindings-1.1.0');
  assert.equal(request.input.static_source_semantics, 'static-conditional-1.3.0');
  assert.equal(semanticDigest(JSON.stringify(request.input)), '7ca31c2be1806cba7af0705b2b7700a59b332e478818a326175f4e4ffc2e2a14');
});

