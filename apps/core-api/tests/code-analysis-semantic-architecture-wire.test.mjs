import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DomainError } from '@team-synergy/domain';
import { createSemanticModelClient, semanticInferencePolicy } from '../dist/code-analysis-semantic-model.js';
import { architectureGroundingClaims, reduceArchitectureProposalBatch, synthesizeSemanticArchitecture, validateArchitecture } from '../dist/code-analysis-semantic-architecture.js';
import { ARCHITECTURE_EVIDENCE_PROTOCOL, ARCHITECTURE_REQUEST_BUDGET, ARCHITECTURE_REVIEW_OUTPUT_SCHEMA, GLOBAL_ARCHITECTURE_OUTPUT_SCHEMA, architectureEvidenceRequestBytes, architectureOwnershipOutputSchema, architectureTourOutputSchema, architectureProposalOutputSchema, assertArchitectureWireShape, budgetArchitectureEvidencePages, createArchitectureEvidenceRequest, createArchitectureEvidenceWire, createArchitectureProposalPathRequest, encodeArchitectureEvidence, encodeArchitectureRelatedPaths, wireList, wireObject, wireText } from '../dist/code-analysis-semantic-architecture-wire.js';
import { overviewFixture, globalRuleReferenceFixture } from './overview-fixture.mjs';

const support = (file, line = 1, end = line) => ({ path: file, line_start: line, line_end: end });
const scope = { snapshotId: 'a'.repeat(64), phase: 'architecture-map', name: 'page-0' };
const sampleShape = wireObject({ evidence_ids: wireList(20, wireText(100), 1), rules: wireList(20, wireObject({ description: wireText(500), evidence_ids: wireList(20, wireText(100), 1) })) });
const response = value => new Response(JSON.stringify({ model: 'deepseek-v4.1-flash', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] }));
function temporary(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'tsp-architecture-wire-'));
  t.after(() => { assert.equal(path.dirname(root), path.resolve(tmpdir())); assert.ok(path.basename(root).startsWith('tsp-architecture-wire-')); rmSync(root, { recursive: true, force: true }); });
  const runDirectory = path.join(root, 'run'), cacheDirectory = path.join(root, 'cache'); mkdirSync(runDirectory); mkdirSync(cacheDirectory); return { root, runDirectory, cacheDirectory };
}

test('wire schemas allow an explicitly empty withdrawal value while ordinary text remains nonempty', () => {
  const optionalText = { type: 'string', minLength: 0, maxLength: 80 };
  assert.doesNotThrow(() => assertArchitectureWireShape('', optionalText));
  assert.throws(() => assertArchitectureWireShape('', wireText(80)), error => error.details.reason === 'schema');
  assert.throws(() => assertArchitectureWireShape(' ', wireText(80)), error => error.details.reason === 'schema');
  assert.throws(() => assertArchitectureWireShape('x', { ...optionalText, minLength: 2 }), error => error.details.reason === 'schema');
});

test('global grounding covers unchanged field spans without importing other rules or step sources into each obligation', () => {
  const node = { id: 'module:records', name: 'Records', summary: '读取记录。\n由有权者修改！', evidence: [support('src/records.ts', 2, 9)], business_rules: [], state_owners: ['记录状态'], user_purposes: ['检索记录'] };
  const flow = { id: 'flow:publish', name: 'Publish', summary: '读取后发布。', business_rules: [], evidence: [support('src/flow.ts', 1, 3)], steps: [{ capability_id: 'capability:read', description: '读取公开记录。\n保留版本。', evidence: [support('src/read.ts', 10, 14)] }] };
  const architecture = { description: '供成员协作。', modules: [node], capabilities: [], flows: [flow], relations: [] };
  const origin_scope = { name: 'Narrow record operation', responsibility: 'Only this operation', related_paths: ['src/narrow.ts'], state_owners: [], user_purposes: [], source_file_ids: [1], evidence: [support('src/narrow.ts', 4, 8)] };
  const parent = { parent_rule_id: 'parent:one', origin_scope_id: 'scope:one', origin_scope, description: '仅限该操作的权限。', evidence: origin_scope.evidence, epistemic_status: 'source_inference' };
  const claims = architectureGroundingClaims(architecture, [{ ...parent, node_id: node.id, rule_index: 0 }, { ...parent, node_id: flow.id, rule_index: 0 }]);
  assert.equal(new Set(claims.map(claim => claim.id)).size, claims.length);
  const summary = claims.filter(claim => claim.scope_context.field === 'modules.0.summary');
  assert.equal(summary.map(claim => claim.text).join('').replace(/\s/gu, ''), node.summary.replace(/\s/gu, ''));
  for (const claim of summary) { const [start, end] = claim.scope_context.field_span; assert.equal(claim.text, node.summary.slice(start, end)); assert.deepEqual(claim.evidence, node.evidence); }
  const steps = claims.filter(claim => claim.scope_context.field === 'flows.0.steps.0.description');
  assert.equal(steps.map(claim => claim.text).join('').replace(/\s/gu, ''), flow.steps[0].description.replace(/\s/gu, ''));
  for (const claim of steps) assert.deepEqual(claim.evidence, flow.steps[0].evidence);
  const rules = claims.filter(claim => claim.kind === 'rule_application');
  assert.equal(rules.length, 1); assert.equal(rules[0].text, parent.description); assert.deepEqual(rules[0].scope_context.application_nodes, [node.id, flow.id]);
  assert.deepEqual(rules[0].evidence, origin_scope.evidence); assert.deepEqual(rules[0].scope_context.original_scope, origin_scope);
  assert.ok(claims.some(claim => claim.text === node.state_owners[0])); assert.ok(claims.some(claim => claim.text === node.user_purposes[0]));
  const withdrawn = architectureGroundingClaims(architecture, [{ ...parent, node_id: node.id, rule_index: 0 }], new Set(['modules.0.summary']));
  assert.equal(withdrawn.some(claim => claim.scope_context?.field === 'modules.0.summary'), false);
  assert.ok(withdrawn.some(claim => claim.scope_context?.field === 'flows.0.summary'));
  assert.ok(withdrawn.some(claim => claim.text === node.state_owners[0]));
  const declarations = architectureGroundingClaims(architecture, [{ ...parent, node_id: node.id, rule_index: 0, evidence: [support('.github/workflows/release.yml', 2, 8)] }], new Set(), new Set(['modules.0.summary']));
  assert.ok(declarations.filter(claim => claim.scope_context?.field === 'modules.0.summary').every(claim => claim.assertion_scope === 'source_definition'));
  assert.equal(declarations.find(claim => claim.text === node.state_owners[0]).assertion_scope, undefined);
  const declarationRule = declarations.find(claim => claim.kind === 'rule_application');
  assert.equal(declarationRule.assertion_scope, 'source_definition');
  assert.equal(declarationRule.text, parent.description, 'the source rule predicate remains immutable; qualification is host metadata');
  assert.equal(rules[0].assertion_scope, undefined, 'an implementation rule is not silently reclassified as a declaration');
});

test('architecture catalog losslessly encodes only actual nested supports and scopes IDs to complete request identity', () => {
  const original = { facts: [{ name: 'owner', evidence: [support('a.ts', 1, 4), support('a.ts', 8, 9)], rules: [{ description: '拒绝未授权状态变更', evidence: [support('b.ts', 3, 5)] }] }], native_dependencies: [{ source: 'a.ts', target: 'b.ts', type: 'calls', count: 42 }], related_paths: ['a.ts', 'b.ts'] };
  const before = JSON.stringify(original), wire = createArchitectureEvidenceWire(original, scope);
  assert.equal(JSON.stringify(original), before); assert.equal(wire.catalog.length, 3);
  assert.deepEqual(wire.input.related_paths, original.related_paths); assert.deepEqual(wire.input.native_dependencies, original.native_dependencies);
  assert.equal('evidence' in wire.input.facts[0], false); assert.equal('evidence' in wire.input.facts[0].rules[0], false);
  assert.deepEqual(wire.evidence.sort((a, b) => a.path.localeCompare(b.path) || a.line_start - b.line_start), [support('a.ts', 1, 4), support('a.ts', 8, 9), support('b.ts', 3, 5)]);
  const canonical = { evidence: [support('a.ts', 1, 4)], rules: [{ description: '拒绝未授权状态变更', evidence: [support('b.ts', 3, 5)] }] };
  assert.deepEqual(wire.decode(encodeArchitectureEvidence(canonical, wire.catalog), sampleShape), canonical);
  for (const nextScope of [{ ...scope, snapshotId: 'b'.repeat(64) }, { ...scope, phase: 'review' }, { ...scope, name: 'page-1' }]) assert.notEqual(createArchitectureEvidenceWire(original, nextScope).catalog[0].id, wire.catalog[0].id);
  assert.notEqual(createArchitectureEvidenceWire({ ...original, related_paths: ['a.ts'] }, scope).catalog[0].id, wire.catalog[0].id);
  assert.throws(() => encodeArchitectureEvidence({ evidence: [support('a.ts', 1, 9)] }, wire.catalog), error => error.details.reason === 'architecture_input_evidence');
});

test('architecture decoder rejects free ranges, duplicate, unknown and cross-request IDs without exposing provider text', () => {
  const wire = createArchitectureEvidenceWire({ facts: [{ evidence: [support('a.ts', 2, 3)] }] }, scope), other = createArchitectureEvidenceWire({ facts: [{ evidence: [support('b.ts', 4, 5)] }] }, scope);
  const valid = { evidence_ids: [wire.catalog[0].id], rules: [] };
  for (const invalid of [{ evidence: [support('a.ts', 2, 3)], rules: [] }, { ...valid, evidence_ids: ['untrusted-id-secret-42'] }, { ...valid, evidence_ids: [other.catalog[0].id] }, { ...valid, evidence_ids: [wire.catalog[0].id, wire.catalog[0].id] }, { ...valid, 'untrusted-field-secret-42': 'untrusted-value-secret-42' }]) {
    assert.throws(() => wire.decode(invalid, sampleShape), error => {
      assert.equal(error.code, 'code_analysis_model_invalid'); assert.ok(error.details.schema_issues.length);
      assert.equal(JSON.stringify(error.details).includes('secret-42'), false); return true;
    });
  }
});

test('proposal assignment IDs distinguish all input files from foreign callee evidence and retain exact coverage', () => {
  const canonical = { proposals: [{ name: '受约束状态', responsibility: '调用外部定义核验状态归属。', state_owners: ['项目状态'], user_purposes: ['执行受约束操作'], business_rules: [{ description: '由被调用定义解释拒绝条件。', evidence: [support('callee.ts', 2, 4)] }], evidence: [support('a.ts', 1, 2)], related_paths: ['a.ts', 'config.json'], unknowns: ['尚未运行测试'] }] };
  const request = { task: '完整考虑本页归属文件及实际callee证据。', output_shape: canonical, briefs: [{ path: 'a.ts', summary: '记录正常与拒绝规则。', evidence: [support('a.ts', 1, 2)], behaviors: canonical.proposals[0].business_rules }, { path: 'config.json', evidence: [support('config.json')] }], native_dependencies: [{ source: 'a.ts', target: 'callee.ts', type: 'calls', count: 3 }] };
  const before = JSON.stringify(request), options = { paths: ['a.ts', 'config.json'], maximumPaths: 45, unknowns: 12 };
  for (const phase of ['architecture-map', 'architecture-reduce']) {
    const wire = createArchitectureProposalPathRequest(request, { ...scope, phase }, options), encode = value => encodeArchitectureRelatedPaths(encodeArchitectureEvidence(value, wire.catalog), wire.pathCatalog), valid = encode(canonical);
    assert.equal(JSON.stringify(request), before); assert.ok(wire.catalog.some(entry => entry.path === 'callee.ts')); assert.equal(wire.pathCatalog.some(entry => entry.path === 'callee.ts'), false);
    assert.deepEqual(wire.decode(valid), canonical); assert.equal(wire.input.briefs[0].summary, request.briefs[0].summary); assert.deepEqual(wire.input.native_dependencies, request.native_dependencies);
    assert.deepEqual(wire.input.output_schema.properties.proposals.items.properties.related_path_ids.items.enum, wire.pathCatalog.map(entry => entry.id));
    const other = createArchitectureProposalPathRequest(request, { ...scope, phase, name: 'other-page' }, options), first = valid.proposals[0], malformed = [
      { proposals: [{ ...first, related_path_ids: ['untrusted-path-marker-42'] }] },
      { proposals: [{ ...first, related_path_ids: [other.pathCatalog[0].id, wire.pathCatalog[1].id] }] },
      { proposals: [{ ...first, related_path_ids: [wire.pathCatalog[0].id] }] },
      { proposals: [{ ...first, related_path_ids: [...first.related_path_ids, first.related_path_ids[0]] }] },
      { proposals: [] },
      { proposals: [{ ...first, related_path_ids: first.related_path_ids, related_paths: ['untrusted-path-marker-42'] }] },
    ];
    for (const value of malformed) assert.throws(() => wire.decode(value), error => error.code === 'code_analysis_model_invalid' && error.details.schema_issues.length > 0 && !JSON.stringify(error.details).includes('untrusted-path-marker-42'));
    assert.throws(() => encode({ proposals: [{ ...canonical.proposals[0], related_paths: ['callee.ts'] }] }), error => error.details.reason === 'architecture_input_paths');
  }
});

test('ownership and tour schemas enumerate actual supplied identities and preserve exact row/step requirements', () => {
  const ownership = architectureOwnershipOutputSchema(2, ['module:state'], ['a.ts', 'config.json']);
  assert.equal(ownership.properties.assignments.minItems, 2); assert.equal(ownership.properties.assignments.maxItems, 2);
  assert.deepEqual(ownership.properties.assignments.items.properties.path.enum, ['a.ts', 'config.json']);
  assert.throws(() => assertArchitectureWireShape({ assignments: [{ path: 'a.ts', module_id: 'module:state', rationale: 'Owns state.' }] }, ownership), error => error.details.schema_issues.some(issue => issue.rule === 'min_items' && issue.minimum === 2));
  assert.throws(() => assertArchitectureWireShape({ assignments: [{ path: 'callee.ts', module_id: 'module:state', rationale: 'Owns state.' }, { path: 'config.json', module_id: 'module:state', rationale: 'Configures state.' }] }, ownership), error => error.details.schema_issues.some(issue => issue.path === '$.assignments[0].path' && issue.rule === 'enum'));
  const tourIds = ['module:state', 'flow:submit', 'file:config.json'], tour = architectureTourOutputSchema(tourIds), steps = Array.from({ length: 5 }, (_, order) => ({ order, title: '了解职责', description: '解释状态与规则。', nodeIds: [tourIds[order % tourIds.length]] }));
  assert.deepEqual(tour.properties.tour.items.properties.nodeIds.items.enum, tourIds); assertArchitectureWireShape({ tour: steps }, tour);
  assert.throws(() => assertArchitectureWireShape({ tour: [{ ...steps[0], nodeIds: ['file:unsupplied.ts'] }, ...steps.slice(1)] }, tour), error => error.details.schema_issues.some(issue => issue.path === '$.tour[0].nodeIds[0]' && issue.rule === 'enum'));
});

test('valid full-coverage legacy map cache is revalidated and reused while an incomplete legacy proposal remains a miss', async t => {
  for (const missing of [false, true]) {
    const input = temporary(t), files = ['a.ts', 'config.json'].map(name => ({ path: name, sha256: 'a'.repeat(64), byte_count: 10, line_count: 2 })), briefs = files.map(file => ({ path: file.path, input_sha256: 'b'.repeat(64), segment_ids: [file.path], summary: '管理项目状态。', responsibility: '有明确状态所有者与拒绝规则。', behaviors: [], dependencies: [], state_owners: [], user_purposes: [], evidence: [support(file.path)], unknowns: [] }));
    const snapshot = { snapshot_id: scope.snapshotId, files }, model = createSemanticModelClient({ ...input, config: { modelUrl: 'http://127.0.0.1:1/v1', model: 'workbuddy/deepseek-v4.1-flash', apiKey: '' }, snapshotId: scope.snapshotId, engineIdentity: 'fixture', fetchImpl: async () => assert.fail('No model request') });
    const proposal = paths => ({ proposals: [{ name: '状态管理', responsibility: '管理受约束状态。', state_owners: [], user_purposes: [], business_rules: [], evidence: [support('a.ts')], related_paths: paths, unknowns: [] }] });
    let initialized = false, newCalls = 0; const stop = new Error('stop-after-map'), outputs = [];
    const client = { cacheRequest(request) {
      if (!initialized) { initialized = true; model.save({ phase: request.phase, input: request.input, inference_policy: semanticInferencePolicy(request.phase) }, encodeArchitectureEvidence(proposal(missing ? ['a.ts'] : files.map(file => file.path)), request.input.evidence_catalog), 'deepseek-v4.1-flash'); }
      return model.cacheRequest(request);
    }, async call(request) { newCalls++; assert.ok(request.input.related_path_catalog); return { value: request.validate(encodeArchitectureRelatedPaths(encodeArchitectureEvidence(proposal(files.map(file => file.path)), request.input.evidence_catalog), request.input.related_path_catalog)) }; } };
    await assert.rejects(synthesizeSemanticArchitecture({ ...input, snapshot, briefs, dependencies: [], repositoryName: 'fixture', client, onPhase: async () => {}, parallel: async (items, action) => { for (let index = 0; index < items.length; index++) outputs.push(await action(items[index], index)); throw stop; } }), error => error === stop);
    assert.equal(newCalls, missing ? 1 : 0); assert.deepEqual(new Set(outputs.flat().flatMap(item => item.related_paths)), new Set(files.map(file => file.path)));
  }
});

test('an all-empty map page records observed-empty scope without model calls or invented evidence and business rules', async t => {
  const input = temporary(t), files = ['empty.ts', 'empty.json'].map(name => ({ path: name, sha256: 'a'.repeat(64), byte_count: 0, line_count: 0 })), briefs = files.map(file => ({ path: file.path, input_sha256: 'b'.repeat(64), segment_ids: [file.path], summary: 'observed-empty', responsibility: '文件为空，无可分析实现。', behaviors: [], dependencies: [], state_owners: [], user_purposes: [], evidence: [], unknowns: ['observed-empty'] })), outputs = [], stop = new Error('stop-after-map');
  const client = { cacheRequest: () => assert.fail('Empty pages need no model/cache interpretation'), call: async () => assert.fail('Empty pages cannot invent semantic evidence') };
  await assert.rejects(synthesizeSemanticArchitecture({ ...input, snapshot: { snapshot_id: scope.snapshotId, files }, briefs, dependencies: [], repositoryName: 'empty-fixture', client, onPhase: async () => {}, parallel: async (items, action) => { for (let index = 0; index < items.length; index++) outputs.push(await action(items[index], index)); throw stop; } }), error => error === stop);
  const proposal = outputs.flat()[0]; assert.deepEqual(proposal.related_paths, files.map(file => file.path)); assert.deepEqual(proposal.evidence, []); assert.deepEqual(proposal.business_rules, []); assert.deepEqual(proposal.state_owners, []); assert.match(proposal.name, /observed-empty/);
});

test('truncated architecture reductions partition whole proposals losslessly, rescope catalogs and keep concurrency within four slots', async t => {
  const input = temporary(t), originals = Array.from({ length: 48 }, (_, index) => ({ name: `候选${index}`, responsibility: `保留完整职责${index}。`, state_owners: [`状态${index}`], user_purposes: [`目的${index}`], business_rules: [{ description: `规则${index}：拒绝不满足条件的状态变更。`, evidence: [support('callee.ts', 3, 5)] }], evidence: [support(`file${index}.ts`)], related_paths: [`file${index}.ts`], unknowns: [`未知${index}`] })), before = JSON.stringify(originals), catalogs = new Map(), partitions = [];
  let active = 0, peak = 0, calls = 0;
  const client = createSemanticModelClient({ ...input, config: { modelUrl: 'http://127.0.0.1:1/v1', model: 'workbuddy/deepseek-v4.1-flash', apiKey: '' }, snapshotId: scope.snapshotId, engineIdentity: 'fixture', fetchImpl: async (_url, request) => {
    calls++; active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 2)); active--;
    const body = JSON.parse(request.body), prompt = JSON.parse(body.messages[1].content); assert.equal(body.max_tokens, 32768);
    if (prompt.proposals.length > 2) return new Response(JSON.stringify({ model: 'deepseek-v4.1-flash', choices: [{ finish_reason: 'length', message: { content: '{truncated-poison-not-json' } }], usage: { completion_tokens: 32768 } }));
    return response({ proposals: prompt.proposals.map(proposal => { const { related_paths, ...rest } = proposal; return { ...rest, related_path_ids: related_paths.map(file => prompt.related_path_catalog.find(entry => entry.path === file).id) }; }) });
  } });
  const execute = async (items, name) => {
    const wire = createArchitectureProposalPathRequest({ task: '保留全部输入事实、规则和出处，合并重复候选。', proposals: items, output_shape: { proposals: [{ ...items[0] }] } }, { ...scope, phase: 'architecture-reduce', name }, { paths: [...new Set(items.flatMap(item => item.related_paths))], maximumPaths: originals.length, unknowns: 20 });
    catalogs.set(name, { evidence: wire.catalog.map(entry => entry.id), paths: wire.pathCatalog.map(entry => entry.id) });
    return (await client.call({ phase: 'architecture-reduce', name, input: wire.input, validate: raw => wire.decode(raw).proposals })).value;
  };
  const groups = Array.from({ length: 4 }, (_, index) => originals.slice(index * 12, index * 12 + 12)), outputs = await Promise.all(groups.map((group, index) => reduceArchitectureProposalBatch(group, `group-${index}`, execute, partition => partitions.push(partition))));
  assert.deepEqual(outputs.flat(), originals); assert.equal(JSON.stringify(originals), before); assert.ok(outputs.every(group => group.length === 12), 'concatenated children must not be cropped to the per-response ten-proposal limit');
  assert.ok(peak > 1 && peak <= 4); assert.equal(client.metrics().calls, calls); assert.ok(partitions.length > 0);
  for (const partition of partitions) {
    assert.deepEqual(partition.children.flatMap(child => child.proposal_hashes), partition.proposal_hashes);
    for (const child of partition.children) { const parentIds = catalogs.get(partition.name), childIds = catalogs.get(child.name); assert.ok(childIds.evidence.every(id => !parentIds.evidence.includes(id))); assert.ok(childIds.paths.every(id => !parentIds.paths.includes(id))); }
  }
  for (const file of readdirSync(input.runDirectory).filter(file => file.endsWith('.audit.json'))) assert.equal(readFileSync(path.join(input.runDirectory, file), 'utf8').includes('truncated-poison-not-json'), false);
  assert.equal(readdirSync(input.cacheDirectory).length, 32, 'only the 32 complete leaf responses can enter the cache');
});

test('a single truncated proposal and non-length failures remain hard failures without adaptive output repair', async () => {
  const proposal = { related_paths: ['a.ts'] };
  for (const [code, reason, count] of [['code_analysis_model_invalid', 'output_truncated', 1], ['code_analysis_model_invalid', 'model_identity', 2], ['code_analysis_model_invalid', 'evidence_catalog_id', 2], ['code_analysis_model_invalid', 'schema', 2], ['code_analysis_model_invalid', 'sensitive_output', 2], ['code_analysis_model_failed', 'transport_or_timeout', 2], ['code_analysis_cancelled', 'cancelled', 2], ['code_analysis_model_invalid', 'consistency_source_changed', 2]]) {
    let calls = 0, partitions = 0; const error = new DomainError(code, 'Expected fixture failure', { reason });
    await assert.rejects(reduceArchitectureProposalBatch(Array(count).fill(proposal), 'group', async () => { calls++; throw error; }, () => partitions++), found => found === error);
    assert.equal(calls, 1); assert.equal(partitions, 0);
  }
});

test('global flow support counts base, rules and all steps with the exact publication compaction before accepting a response', () => {
  const graph = ranges => {
    const evidence = [ranges[0]], common = { name: '状态职责', summary: '核对状态归属与变更规则。', business_rules: [{ description: '拒绝不满足前置条件的状态变化。', evidence }], evidence };
    return { description: '受约束状态工作流。', languages: ['TypeScript'], frameworks: [], modules: [{ ...common, id: 'module:state', state_owners: [], user_purposes: [] }], capabilities: [{ ...common, id: 'capability:transition', module_ids: ['module:state'] }], flows: [{ ...common, id: 'flow:transition', steps: Array.from({ length: Math.ceil(ranges.length / 20) }, (_, index) => ({ capability_id: 'capability:transition', description: '核对这一步的真实条件和结果。', evidence: ranges.slice(index * 20, index * 20 + 20) })) }], relations: [], unknowns: [] };
  };
  for (const kind of ['overlap', 'adjacent']) {
    const ranges = Array.from({ length: 120 }, (_, index) => support('flow.ts', index + 1, index + (kind === 'overlap' ? 2 : 1))), before = JSON.stringify(ranges);
    const result = validateArchitecture(graph(ranges), [support('flow.ts', 1, 200)]);
    assert.equal(result.flows[0].steps.length, 6); assert.equal(result.flows[0].steps.flatMap(step => step.evidence).length, 120); assert.equal(JSON.stringify(ranges), before, 'no references may be dropped or expanded by the guard');
  }
  const boundary = Array.from({ length: 100 }, (_, index) => support(`file${index}.ts`)); assert.equal(validateArchitecture(graph(boundary), boundary).flows[0].steps.length, 5);
  for (const ranges of [Array.from({ length: 120 }, (_, index) => support(`file${index}.ts`)), Array.from({ length: 120 }, (_, index) => support('flow.ts', index * 2 + 1))]) {
    assert.throws(() => validateArchitecture(graph(ranges), ranges), error => error.code === 'code_analysis_model_invalid' && error.details.repairable === true && error.details.reason === 'architecture_evidence_budget' && error.details.schema_issues.some(issue => issue.path === '$.flows[0]' && issue.rule === 'max_items' && issue.observed_count === 120 && issue.maximum === 100));
  }
});

test('all architecture production shape limits are explicit and invalid shape feedback carries only safe field paths and counts', () => {
  const schemas = [GLOBAL_ARCHITECTURE_OUTPUT_SCHEMA, architectureProposalOutputSchema({ relatedPaths: 45, unknowns: 12, requireProposal: false }), ARCHITECTURE_REVIEW_OUTPUT_SCHEMA];
  for (const schema of schemas) { assert.equal(schema.additionalProperties, false); assert.ok(schema.required.length); }
  assert.equal(GLOBAL_ARCHITECTURE_OUTPUT_SCHEMA.properties.modules.maxItems, 10); assert.equal(GLOBAL_ARCHITECTURE_OUTPUT_SCHEMA.properties.capabilities.maxItems, 24); assert.equal(GLOBAL_ARCHITECTURE_OUTPUT_SCHEMA.properties.flows.items.properties.steps.maxItems, 12); assert.equal(GLOBAL_ARCHITECTURE_OUTPUT_SCHEMA.properties.relations.maxItems, 80);
  assert.equal(GLOBAL_ARCHITECTURE_OUTPUT_SCHEMA.properties.modules.items.properties.business_rules.items.properties.description.maxLength, 500);
  assert.throws(() => assertArchitectureWireShape({ findings: [{ severity: 'warning', scope: 'system', description: 'x'.repeat(1201), evidence_ids: Array(21).fill('id') }], unknowns: [], 'private-unknown-property': 'private-unknown-value' }, ARCHITECTURE_REVIEW_OUTPUT_SCHEMA), error => {
    assert.ok(error.details.schema_issues.some(issue => issue.path === '$.findings[0].description' && issue.maximum === 1200 && issue.observed_length === 1201));
    assert.ok(error.details.schema_issues.some(issue => issue.path === '$.findings[0].evidence_ids' && issue.maximum === 20 && issue.observed_count === 21));
    assert.equal(JSON.stringify(error.details).includes('private-unknown'), false); return true;
  });
});

test('encoded page budgeting includes the actual local catalog and schema without cropping facts, ranges or dependencies', () => {
  const facts = Array.from({ length: 70 }, (_, index) => ({ file: `${index}/${'long-scope/'.repeat(45)}source.ts`, evidence: Array.from({ length: 5 }, (_, line) => support(`${index}/${'long-scope/'.repeat(45)}source.ts`, line + 1)), related_paths: [`${index}/source.ts`], dependencies: [{ target: `${index + 1}/source.ts`, type: 'calls', count: 8 }], business_rule: `rule-${index}` }));
  const prepare = page => createArchitectureEvidenceRequest({ task: '保留所有输入和证据。', facts: page, output_shape: { evidence: [] } }, scope, sampleShape);
  assert.ok(architectureEvidenceRequestBytes(prepare(facts), scope.phase) > ARCHITECTURE_REQUEST_BUDGET);
  const pages = budgetArchitectureEvidencePages([facts], prepare, scope.phase);
  assert.ok(pages.length > 1); assert.deepEqual(pages.flat(), facts);
  for (const page of pages) { const request = prepare(page); assert.ok(architectureEvidenceRequestBytes(request, scope.phase) <= ARCHITECTURE_REQUEST_BUDGET); assert.equal(request.catalog.length, page.length * 5); assert.deepEqual(request.input.facts.map(item => item.business_rule), page.map(item => item.business_rule)); }
  assert.throws(() => budgetArchitectureEvidencePages([[{ summary: 'x'.repeat(180001) }]], prepare, scope.phase), error => error.details.reason === 'architecture_input_budget');
});

test('raw architecture wire checkpoints are decoded again on cache replay and invalid references get bounded safe repair', async t => {
  const input = temporary(t), wire = createArchitectureEvidenceWire({ facts: [{ evidence: [support('a.ts', 2, 3)] }] }, scope);
  const canonical = { evidence: [support('a.ts', 2, 3)], rules: [] }, valid = encodeArchitectureEvidence(canonical, wire.catalog), prompts = [];
  const config = { modelUrl: 'http://127.0.0.1:1/v1', model: 'workbuddy/deepseek-v4.1-flash', apiKey: '', concurrency: 1 };
  const client = createSemanticModelClient({ ...input, config, snapshotId: scope.snapshotId, engineIdentity: 'test', fetchImpl: async (_url, request) => {
    const prompt = JSON.parse(JSON.parse(request.body).messages[1].content); prompts.push(prompt);
    if (prompts.length === 1) return response({ ...valid, evidence_ids: ['untrusted-reference-secret-42'] });
    assert.ok(prompt.correction.fields.includes('$.evidence_ids')); assert.ok(prompt.correction.constraints.some(issue => issue.rule === 'enum')); assert.equal(JSON.stringify(prompt.correction).includes('secret-42'), false); return response(valid);
  } });
  let decodes = 0;
  const request = { phase: 'architecture', name: 'cached', input: { evidence_protocol: ARCHITECTURE_EVIDENCE_PROTOCOL, ...wire.input, evidence_catalog: wire.catalog, output_schema: sampleShape }, validate: raw => { decodes++; return wire.decode(raw, sampleShape); } };
  assert.deepEqual((await client.call(request)).value, canonical); assert.equal(prompts.length, 2);
  assert.deepEqual((await client.call(request)).value, canonical); assert.equal(prompts.length, 2); assert.equal(decodes, 3);
  const cacheFile = path.join(input.cacheDirectory, readdirSync(input.cacheDirectory)[0]), cached = JSON.parse(readFileSync(cacheFile, 'utf8'));
  assert.deepEqual(cached.output, valid); assert.equal(JSON.stringify(cached.output).includes('line_start'), false);
  for (const name of readdirSync(input.runDirectory).filter(name => name.endsWith('.audit.json'))) assert.equal(readFileSync(path.join(input.runDirectory, name), 'utf8').includes('secret-42'), false);
  // A digest-valid legacy/free-range payload must still be rejected by the wire validator.
  const legacyTask = { phase: 'architecture', input: request.input, inference_policy: { thinking: { type: 'enabled' }, reasoning_effort: 'high', max_tokens: 32768 } };
  client.save(legacyTask, canonical, 'deepseek-v4.1-flash');
  assert.equal(client.cache(legacyTask, raw => wire.decode(raw, sampleShape)), null);
});

test('hierarchical architecture synthesis preserves proposal paths, rules, all native pairs, modules, flows and tour with scoped references', async t => {
  const input = temporary(t), files = Array.from({ length: 90 }, (_, index) => ({ path: index === 0 ? 'README.md' : `src/f${index}.ts`, sha256: 'a'.repeat(64), byte_count: 4000, line_count: 1000 }));
  const briefs = files.map(file => ({ path: file.path, input_sha256: 'b'.repeat(64), segment_ids: [file.path], summary: '完整事实与状态边界。'.repeat(100), responsibility: '属于具备状态所有权约束的功能，拒绝非法操作。'.repeat(35), behaviors: Array.from({ length: 10 }, (_, index) => ({ description: `业务规则${index}：只有状态所有者有权执行，其他成员不能越权。`.repeat(8), evidence: [support(file.path)] })), state_owners: ['业务状态'], user_purposes: ['完成受约束的操作'], dependencies: [], evidence: [support(file.path)], unknowns: ['未执行测试'] }));
  // This real failure shape contains 137 raw supports: a whole file plus 136
  // overlapping/adjacent callee ranges in 28 separated groups. Its exact union is 29.
  briefs[0].evidence = Array.from({ length: 136 }, (_, index) => support('src/f1.ts', Math.floor(index / 5) * 10 + index % 5 + 1, Math.floor(index / 5) * 10 + index % 5 + 2));
  const dependencies = files.slice(1).map((file, index) => ({ id: `dep-${index}`, source: files[index].path, target: file.path, type: 'calls', evidence: [support(files[index].path), support(file.path)], native_ids: [`native-${index}`], count: 1 }));
  const repeatedDependencySupports = Array.from({ length: 95 }, (_, index) => [support('src/f2.ts', index * 2 + 3), support('src/f3.ts', index * 2 + 3)]);
  dependencies.push(...repeatedDependencySupports.map((evidence, index) => ({ id: `repeated-${index}`, source: 'src/f2.ts', target: 'src/f3.ts', type: 'calls', evidence, native_ids: [], count: 1 })));
  const snapshot = { snapshot_id: scope.snapshotId, manifest_sha256: 'c'.repeat(64), commit: 'd'.repeat(40), tree: 'e'.repeat(40), kind: 'commit', files, scope: ['.'], captured_at: new Date().toISOString(), exclusions: [] };
  const calls = [], mappedPaths = new Set(), reductions = [], sourceRule = '仅状态所有者可以执行操作，其他成员被拒绝。';
  const client = { cacheRequest: () => null, call: async request => {
    const prompt = request.input; calls.push({ phase: request.phase, bytes: Buffer.byteLength(JSON.stringify(prompt)) }); assert.ok(calls.at(-1).bytes < 180000);
    let value;
    if (request.phase === 'architecture-reduce' && prompt.overview_protocol) {
      value = overviewFixture(prompt); reductions.push({ before: prompt.related_path_catalog.map(item => item.id), after: value.covered_file_ids });
    } else if (request.phase === 'architecture-map' || request.phase === 'architecture-reduce') {
      const paths = request.phase === 'architecture-map' ? prompt.briefs.map(brief => brief.path) : [...new Set(prompt.proposals.flatMap(item => item.related_paths))];
      const ids = request.phase === 'architecture-map' ? [...new Set(prompt.briefs.flatMap(brief => brief.evidence_ids))] : [...new Set(prompt.proposals.flatMap(proposal => proposal.evidence_ids))];
      paths.forEach(file => mappedPaths.add(file)); assert.equal(prompt.evidence_protocol, ARCHITECTURE_EVIDENCE_PROTOCOL); assert.ok(prompt.evidence_catalog.every(item => paths.includes(item.path)));
      const evidence_ids = ids.slice(0, 2), prototype = { name: '状态所有权模块', responsibility: request.phase === 'architecture-map' ? '状态所有者的跨模块职责。'.repeat(85) : '统一状态所有权与拒绝路径。', state_owners: ['业务状态'], user_purposes: ['完成受约束的操作'], business_rules: Array.from({ length: 4 }, () => ({ description: sourceRule.repeat(9), evidence_ids })), evidence_ids, related_paths: paths, unknowns: ['未执行测试'] };
      value = { proposals: request.phase === 'architecture-map' ? Array.from({ length: 10 }, () => structuredClone(prototype)) : [prototype] };
      if (request.phase === 'architecture-reduce') reductions.push({ before: paths, after: value.proposals.flatMap(item => item.related_paths) });
    } else if (request.phase === 'architecture') {
      const evidence_ids = [prompt.evidence_catalog[0].id], common = { summary: '管理状态所有权以及拒绝规则。', business_rules: [{ description: sourceRule, evidence_ids }], evidence_ids };
      value = { description: '受约束的业务状态协作。', languages: ['TypeScript'], frameworks: [], modules: [{ ...common, id: 'module:state', name: '状态管理', state_owners: ['业务状态'], user_purposes: ['提交操作'] }], capabilities: [{ ...common, id: 'capability:submit', name: '提交受约束操作', module_ids: ['module:state'] }], flows: [{ ...common, id: 'flow:submit', name: '状态提交流程', steps: [{ capability_id: 'capability:submit', description: '核验状态所有者再执行。', evidence_ids }] }], relations: [], unknowns: ['静态分析未执行测试'] };
    } else if (request.phase === 'ownership') value = { assignments: prompt.files.map(file => ({ path: file.path, module_id: 'module:state', rationale: '文件支撑受约束状态变更。' })) };
    else if (request.phase === 'tour') {
      assert.ok(prompt.output_schema.properties.tour.items.properties.nodeIds.items.enum.includes('file:src/f1.ts'));
      value = { tour: ['file:README.md', 'module:state', 'capability:submit', 'flow:submit', 'file:src/f1.ts'].map((id, order) => ({ order, title: `导览${order}`, description: '从项目目标到业务状态和约束。', nodeIds: [id] })) };
    }
    else if (request.phase === 'review') value = { findings: [], unknowns: ['需独立质量评估'] };
    else assert.fail(request.phase);
    value = globalRuleReferenceFixture(value, prompt);
    if (request.phase === 'architecture') value.modules[0].business_rules[0].epistemic_status = 'uncertain';
    return { value: request.validate(prompt.related_path_protocol ? encodeArchitectureRelatedPaths(value, prompt.related_path_catalog) : value) };
  } };
  const result = await synthesizeSemanticArchitecture({ ...input, snapshot, briefs, dependencies, repositoryName: '架构协议回归', client, onPhase: async () => {}, parallel: async (items, action) => Promise.all(items.map(action)) });
  assert.equal(mappedPaths.size, files.length); assert.ok(reductions.length); for (const reduction of reductions) assert.deepEqual(new Set(reduction.after), new Set(reduction.before));
  assert.equal(result.graph.nodes.filter(node => node.type === 'file').length, files.length); assert.equal(result.ownership.length, files.length); assert.equal(result.graph.layers[0].nodeIds.length, files.length + 3);
  assert.equal(result.graph.tour.length, 5); assert.equal(result.statistics.native_file_dependencies, dependencies.length);
  assert.equal(result.relation_evidence.filter(item => item.basis === 'native_dependency').length, files.length - 1); assert.ok(result.graph.nodes.find(node => node.id === 'module:state').domainMeta.businessRules.some(rule => rule.startsWith('待确认／源码推断（适用范围：') && rule.endsWith(`）：${sourceRule.repeat(9)}`)));
  const rows = ranges => [...new Set(ranges.flatMap(range => Array.from({ length: range.line_end - range.line_start + 1 }, (_, index) => `${range.path}:${range.line_start + index}`)))].sort();
  const contains = result.relation_evidence.find(item => item.source === 'module:state' && item.target === 'file:README.md' && item.type === 'contains');
  const originalContains = [support('README.md', 1, 1000), ...briefs[0].evidence];
  assert.equal(originalContains.length, 137); assert.equal(contains.evidence.length, 29);
  assert.deepEqual(rows(contains.evidence), rows(originalContains), 'initial relation compaction must preserve every covered row and every gap');
  const repeated = result.relation_evidence.find(item => item.source === 'file:src/f2.ts' && item.target === 'file:src/f3.ts' && item.type === 'depends_on');
  const originalRepeated = dependencies.filter(item => item.source === 'src/f2.ts' && item.target === 'src/f3.ts').flatMap(item => item.evidence);
  assert.equal(repeated.evidence.length, 192, 'disjoint relation supports must not be silently clipped to 90 or 100; downstream publication limits remain authoritative');
  assert.deepEqual(rows(repeated.evidence), rows(originalRepeated), 'merged relations must preserve every original support');
  const lineage = JSON.parse(readFileSync(path.join(input.runDirectory, 'semantic-global-rule-lineage.json'), 'utf8'));
  assert.equal(lineage.rules.find(row => row.node_id === 'module:state').epistemic_status, 'uncertain'); assert.equal(lineage.rules.find(row => row.node_id === 'module:state').description, sourceRule.repeat(9));
  for (const node of result.graph.nodes.filter(node => ['module', 'domain', 'flow'].includes(node.type))) { assert.match(node.summary, /概览／源码推断/); assert.match(node.summary, /90条未知条目/); assert.match(node.summary, /未提供计数（不可视为0）/); assert.match(node.summary, /file:/); assert.match(node.languageNotes, /不等于已确认共识/); }
  assert.ok(result.graph.edges.some(edge => edge.type === 'flow_step')); assert.equal(result.graph.edges.some(edge => edge.type === 'contains_flow'), false);
  assert.ok(calls.some(call => call.phase === 'architecture-reduce')); assert.ok(calls.every(call => call.bytes < 180000));
});
