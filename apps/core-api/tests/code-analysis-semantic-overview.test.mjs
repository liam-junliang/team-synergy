import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOverviewContext, prepareOverviewRequest, prepareOverviewGlobalRequest, overviewLeafRules, overviewBytes, overviewFixedFloor, OVERVIEW_TEXT_BYTES } from '../dist/code-analysis-semantic-overview.js';
import { semanticDigest } from '../dist/code-analysis-semantic-source.js';
import { semanticCheckpointKey, semanticInferencePolicy } from '../dist/code-analysis-semantic-model.js';
import { budgetGroups } from '../dist/code-analysis-semantic-architecture.js';
import { overviewFixture, overviewBudgetFixture } from './overview-fixture.mjs';

function fixture(count = 8, prefix = 'src/') {
  const files = Array.from({ length: count }, (_, index) => ({ path: `${prefix}file${index}.ts`, sha256: semanticDigest(String(index)), line_count: 300, byte_count: 8000 }));
  const support = file => [{ path: file, line_start: 1, line_end: 4 }];
  const briefs = files.map(file => ({ path: file.path, sha256: file.sha256, input_sha256: semanticDigest(file), segment_ids: [file.path], summary: '详细文件职责和边界。', responsibility: '保留全部行为及其出处。', behaviors: [{ description: '详细正常路径。', evidence: support(file.path) }, { description: '详细拒绝路径。', evidence: support(file.path) }], dependencies: [], state_owners: ['业务状态'], user_purposes: ['完成操作'], evidence: support(file.path), unknowns: ['普通未知不会使整个文件的全部规则变未知。', '测试尚未执行。'] }));
  const audit = { uncertain_claims: 1, checks: [{ path: files[0].path, findings: [{ claim_id: 'summary', status: 'corrected', replacement: 'A proposed correction.' }] }, { path: files[0].path, findings: [{ claim_id: 'summary', status: 'uncertain', replacement: '' }] }] };
  const context = createOverviewContext({ snapshot: { snapshot_id: 'a'.repeat(64), files }, briefs, uncertaintyAudit: audit });
  const proposals = files.map(file => ({ name: '详细候选', responsibility: '职责与规则。'.repeat(40), state_owners: ['状态'], user_purposes: ['目的'], business_rules: Array.from({ length: 10 }, (_, index) => ({ description: `详细规则${index}：必须保留到file节点。`.repeat(8), evidence: support(file.path) })), evidence: support(file.path), related_paths: [file.path], unknowns: ['保留细节未知'] }));
  return { files, briefs, context, proposals, audit };
}
function globalPayload(wire, refs) {
  const evidence_ids = [wire.input.evidence_catalog[0].id], common = { name: '职责', summary: '原操作职责导航。', business_rules: refs, evidence_ids };
  return { description: '系统导航', languages: [], frameworks: [], modules: [{ ...common, id: 'module:state', state_owners: [], user_purposes: [] }], capabilities: [{ ...common, id: 'capability:submit', module_ids: ['module:state'] }], flows: [{ ...common, id: 'flow:submit', steps: [{ capability_id: 'capability:submit', description: '定位原操作入口。', evidence_ids }] }], relations: [], unknowns: [] };
}

test('overview is explicitly a bounded abstraction while complete file facts and independent uncertainty remain immutable', () => {
  const input = fixture(), before = semanticDigest(input.briefs), wire = prepareOverviewRequest(input.context, input.proposals, { name: 'overview-1-0', depth: 1 }), payload = overviewFixture(wire.input), result = wire.decode(payload);
  assert.deepEqual(result.covered_file_ids, input.files.map((_, index) => index)); assert.equal(result.uncertainty.unknown_entries, 16); assert.equal(result.uncertainty.uncertain_claims, 1);
  assert.deepEqual(result.uncertainty.uncertain_file_ids, [0]); assert.equal(result.candidates[0].epistemic_status, 'source_inference', 'ordinary file unknowns must not downgrade unrelated overview facts wholesale');
  assert.equal(result.detail_index_ref, input.context.indexRef); assert.equal(semanticDigest(input.briefs), before); assert.equal(input.briefs.reduce((n, file) => n + file.behaviors.length, 0), 16);
  assert.ok(overviewBytes(result) <= wire.accounting.maximumCanonicalBytes); assert.match(wire.input.task, /不能宣称概览列出所有细节/);
  assert.equal(wire.schema.properties.candidates.maxItems, 4); assert.equal(wire.schema.properties.shared_invariants.maxItems, 6); assert.equal(wire.schema.properties.boundary_contracts.maxItems, 4);
  assert.ok(wire.schema.properties.shared_invariants.items.properties.parent_rule_id.enum.length);
  assert.equal(wire.schema.properties.shared_invariants.items.properties.description, undefined); assert.equal(wire.schema.properties.shared_invariants.items.properties.evidence_ids, undefined);
});

test('419-file and 296-proposal offline budget replay converges on measured canonical bytes without changing details', () => {
  const input = fixture(419), before = semanticDigest(input.briefs), initial = input.proposals.slice(0, 296);
  for (let index = 296; index < input.files.length; index++) initial[index - 296].related_paths.push(input.files[index].path);
  let current = initial, depth = 0;
  const floor = overviewBytes({ detail_index: input.context.promptIndex, covered_file_ids: input.context.fileIds(initial) }), size = rows => overviewBytes({ detail_index: input.context.promptIndex, inputs: rows }), layers = [];
  while (size(current) > 115000) {
    assert.ok(++depth <= 4); const startBytes = size(current), groups = budgetGroups(current, 70000, 30);
    current = groups.map((group, index) => { const request = prepareOverviewRequest(input.context, group, { name: `offline-${depth}-${index}`, depth }); return request.decode(overviewBudgetFixture(request.input, request.decode)); });
    const outputBytes = size(current), ratio = (outputBytes - floor) / (startBytes - floor); layers.push({ input_bytes: startBytes, output_bytes: outputBytes, residual_ratio: ratio });
    assert.deepEqual(input.context.fileIds(current), input.files.map((_, index) => index));
    if (outputBytes > 115000) assert.ok(ratio <= 0.6);
  }
  assert.ok(depth >= 2); assert.ok(size(current) <= 115000); assert.equal(semanticDigest(input.briefs), before);
  assert.equal(input.briefs.reduce((n, file) => n + file.behaviors.length, 0), 838); assert.equal(input.briefs.reduce((n, file) => n + file.unknowns.length, 0), 838);
  assert.ok(layers.every(layer => layer.output_bytes < layer.input_bytes));
});

test('covered-file identities, candidate lineage, epistemic states and source citations stay strict', () => {
  const input = fixture(), wire = prepareOverviewRequest(input.context, input.proposals, { name: 'overview-1-0', depth: 1 }), valid = overviewFixture(wire.input);
  const cases = [
    value => { value.covered_file_ids.pop(); },
    value => { value.covered_file_ids[0] = 'foreign-project-id'; },
    value => { value.candidates[0].detail_file_ids = ['foreign-project-id']; },
    value => { value.shared_invariants[0].candidate_ids = ['C4']; },
    value => { value.candidates[0].epistemic_status = 'confirmed'; },
    value => { value.candidates[0].evidence_ids = ['foreign-evidence-id']; },
    value => { value.uncertain_claims = 0; },
  ];
  for (const change of cases) { const value = structuredClone(valid); change(value); assert.throws(() => wire.decode(value), { code: 'code_analysis_model_invalid' }); }
  const result = wire.decode(valid); assert.throws(() => input.context.fileIds([{ ...result, detail_index_ref: 'b'.repeat(64) }]), error => error.details.reason === 'overview_detail_identity');
  assert.throws(() => createOverviewContext({ snapshot: { snapshot_id: 'a'.repeat(64), files: input.files }, briefs: input.briefs, uncertaintyAudit: { ...input.audit, uncertain_claims: 0 } }), error => error.details.reason === 'overview_uncertainty_identity');
});

test('leaf references restore exact parent text and every support across levels without uncertainty upgrades or free rewrites', () => {
  const input = fixture(2), source = { description: '普通拒绝会终止操作；临时不可达且有效期未到时允许等待，只有到期或明确拒绝才终止。', evidence: [1, 20, 40].map(line => ({ path: input.files[0].path, line_start: line, line_end: line + 3 })) };
  input.proposals[0].business_rules = [source]; const detailBefore = semanticDigest(input.briefs);
  const first = prepareOverviewRequest(input.context, [input.proposals[0]], { name: 'first', depth: 1 }), payload = overviewFixture(first.input);
  payload.shared_invariants[0].epistemic_status = 'uncertain'; payload.boundary_contracts = [{ ...payload.shared_invariants[0], counterparty: '状态所有者' }];
  const result = first.decode(payload), leaf = result.shared_invariants[0];
  assert.equal(leaf.description, source.description); assert.deepEqual(leaf.evidence, source.evidence); assert.equal(leaf.evidence.length, 3);
  const second = prepareOverviewRequest(input.context, [result], { name: 'second', depth: 2 }), next = overviewFixture(second.input), restored = second.decode(next);
  assert.equal(restored.shared_invariants[0].parent_rule_id, leaf.parent_rule_id); assert.equal(restored.shared_invariants[0].description, source.description); assert.deepEqual(restored.shared_invariants[0].evidence, source.evidence);
  const upgraded = structuredClone(next); upgraded.shared_invariants[0].epistemic_status = 'source_inference'; assert.throws(() => second.decode(upgraded), error => error.details.reason === 'overview_rule_uncertainty');
  const rewritten = structuredClone(payload); rewritten.shared_invariants[0].description = '所有错误都终止'; assert.throws(() => first.decode(rewritten), error => error.details.reason === 'schema');
  const shortened = structuredClone(payload); shortened.shared_invariants[0].evidence_ids = [first.input.evidence_catalog[0].id]; assert.throws(() => first.decode(shortened), error => error.details.reason === 'schema');
  const foreign = structuredClone(payload); foreign.shared_invariants[0].parent_rule_id = overviewLeafRules(input.context, [input.proposals[1]])[0].parent_rule_id; assert.throws(() => first.decode(foreign), error => error.details.reason === 'schema');
  assert.throws(() => overviewLeafRules(input.context, [{ ...result, shared_invariants: [{ ...leaf, description: '改变原文' }] }]), error => error.details.reason === 'overview_rule_identity');
  assert.equal(semanticDigest(input.briefs), detailBefore);
});

test('global module, capability and flow business rules only restore current leaf references and keep private exact lineage', () => {
  const input = fixture(2), original = { description: '待确认：只有前置状态满足且没有例外时才迁移，详情尚缺运行验证。', evidence: [1, 20, 40].map(line => ({ path: input.files[0].path, line_start: line, line_end: line + 2 })) };
  input.proposals[0].business_rules = [original];
  const global = prepareOverviewGlobalRequest(input.context, [input.proposals[0]], { task: '只生成职责导航。', output_shape: {}, detailed_map_proposals: [input.proposals[0]] }, { name: 'system' });
  const parent = global.input.leaf_rule_catalog[0], evidence = [global.input.evidence_catalog[0].id], common = { name: '职责', summary: '状态所有者的职责导航。', business_rules: [{ parent_rule_id: parent.parent_rule_id, origin_scope_id: global.input.global_scope_catalog.find(scope => scope.parent_rule_id === parent.parent_rule_id).origin_scope_id, epistemic_status: 'uncertain' }], evidence_ids: evidence };
  const raw = { description: '系统导航', languages: [], frameworks: [], modules: [{ ...common, id: 'module:state', state_owners: [], user_purposes: [] }], capabilities: [{ ...common, id: 'capability:submit', module_ids: ['module:state'] }], flows: [{ ...common, id: 'flow:submit', steps: [{ capability_id: 'capability:submit', description: '导航至操作入口。', evidence_ids: evidence }] }], relations: [], unknowns: [] };
  const restored = global.decode(raw);
  for (const node of [...restored.modules, ...restored.capabilities, ...restored.flows]) assert.deepEqual(node.business_rules, [original]);
  assert.equal(global.lineage().length, 3); for (const item of global.lineage()) { assert.equal(item.description, original.description); assert.deepEqual(item.evidence, original.evidence); assert.equal(item.epistemic_status, 'uncertain'); }
  for (const mutate of [value => { value.modules[0].business_rules[0].description = '非法自由规则'; }, value => { value.modules[0].business_rules[0].evidence_ids = evidence; }, value => { value.modules[0].business_rules[0].parent_rule_id = overviewLeafRules(input.context, [input.proposals[1]])[0].parent_rule_id; }, value => { value.modules[0].business_rules[0].epistemic_status = 'source_inference'; }]) {
    const invalid = structuredClone(raw); mutate(invalid); assert.throws(() => global.decode(invalid), { code: 'code_analysis_model_invalid' });
  }
  assert.ok(global.input.global_rule_protocol); assert.equal(global.schema.properties.modules.items.properties.business_rules.items.properties.description, undefined);
});

test('one unchanged generic predicate retains both originating operation scopes rather than becoming a module-wide rule', () => {
  const input = fixture(2), rule = { description: '前置状态满足时进入下一步，否则终止当前操作。', evidence: [{ path: input.files[0].path, line_start: 20, line_end: 24 }] };
  const originals = [
    { ...input.proposals[0], name: '局部观察操作', responsibility: '仅描述指定观察流程的入口约束，不构成其他操作的权限条件。', state_owners: ['观察状态'], user_purposes: ['读取当前观察结果'], business_rules: [rule] },
    { ...input.proposals[1], name: '局部记录操作', responsibility: '仅描述选中记录流程的状态边界，其他动作需单独取证。', state_owners: ['记录状态'], user_purposes: ['追加当前记录'], business_rules: [rule] },
  ];
  const originalHash = semanticDigest(originals), before = semanticDigest(input.briefs);
  const overview = prepareOverviewRequest(input.context, originals, { name: 'unchanged-upstream', depth: 1 }), bundle = overview.decode(overviewFixture(overview.input));
  const global = prepareOverviewGlobalRequest(input.context, [bundle], { task: '只生成职责导航。', output_shape: {}, overview_bundles: [bundle] }, { name: 'system' }, originals);
  const scopes = global.input.global_scope_catalog;
  assert.equal(global.input.leaf_rule_catalog.length, 1); assert.equal(scopes.length, 2);
  assert.equal(new Set(scopes.map(scope => scope.origin_scope_id)).size, 2); assert.equal(new Set(scopes.map(scope => scope.parent_rule_id)).size, 1);
  for (const scope of scopes) {
    const source = originals.find(item => item.name === scope.name);
    assert.equal(scope.responsibility, source.responsibility); assert.deepEqual(scope.state_owners, source.state_owners); assert.deepEqual(scope.user_purposes, source.user_purposes);
    assert.deepEqual(scope.related_paths, source.related_paths); assert.deepEqual(scope.source_file_ids, [0]);
    const refs = [{ parent_rule_id: scope.parent_rule_id, origin_scope_id: scope.origin_scope_id, epistemic_status: 'source_inference' }], output = global.decode(globalPayload(global, refs));
    assert.deepEqual(output.modules[0].business_rules, [rule]);
    assert.equal(global.lineage()[0].origin_scope.name, source.name); assert.deepEqual(global.lineage()[0].origin_scope.evidence, rule.evidence);
    assert.equal(global.lineage()[0].description, rule.description);
  }
  assert.equal(global.input.global_rule_protocol, 'architecture-global-leaf-rules-1.1.0');
  assert.match(global.input.rule_constraints, /原操作/); assert.match(global.input.rule_constraints, /隐含角色权限/);
  assert.equal(semanticDigest(originals), originalHash); assert.equal(semanticDigest(input.briefs), before);
  assert.equal(bundle.uncertainty.unknown_entries, 4); assert.equal(bundle.uncertainty.uncertain_claims, 1);
});

test('global scope pairs fail closed against missing, cross-parent and forged scopes, and host lineage is immutable', () => {
  const input = fixture(2);
  input.proposals.forEach((proposal, index) => { proposal.business_rules = [{ description: `仅当前操作${index}满足前置状态时继续。`, evidence: proposal.evidence }]; });
  const global = prepareOverviewGlobalRequest(input.context, input.proposals, { task: '职责导航。', output_shape: {} }, { name: 'system' });
  const [first, second] = global.input.global_scope_catalog, ref = { parent_rule_id: first.parent_rule_id, origin_scope_id: first.origin_scope_id, epistemic_status: 'source_inference' };
  const valid = globalPayload(global, [ref]); global.decode(valid);
  for (const mutate of [
    value => { delete value.modules[0].business_rules[0].origin_scope_id; },
    value => { value.modules[0].business_rules[0].origin_scope_id = 'OS-' + 'f'.repeat(64); },
    value => { value.modules[0].business_rules[0].origin_scope = { name: '伪造扩大范围' }; },
  ]) {
    const invalid = structuredClone(valid); mutate(invalid); assert.throws(() => global.decode(invalid), error => error.details.reason === 'schema'); assert.deepEqual(global.lineage(), []);
  }
  const wrongPair = structuredClone(valid); wrongPair.modules[0].business_rules[0].origin_scope_id = second.origin_scope_id;
  assert.throws(() => global.decode(wrongPair), error => error.details.reason === 'global_origin_scope_reference'); assert.deepEqual(global.lineage(), []);
  const expectedName = first.name, expectedResponsibility = first.responsibility;
  first.name = '显示目录被改写'; first.responsibility = '所有操作都适用';
  global.decode(valid);
  const exposed = global.lineage(); assert.equal(exposed[0].origin_scope.name, expectedName); assert.equal(exposed[0].origin_scope.responsibility, expectedResponsibility);
  exposed[0].origin_scope.name = '调用者修改'; exposed[0].origin_scope.evidence[0].line_start = 299;
  assert.equal(global.lineage()[0].origin_scope.name, expectedName); assert.notEqual(global.lineage()[0].origin_scope.evidence[0].line_start, 299);
});

test('original context identity changes only the new global request while upstream overview and leaf cache identities remain unchanged', () => {
  const input = fixture(2), originals = [input.proposals[0]], upstream = prepareOverviewRequest(input.context, originals, { name: 'frozen-overview', depth: 1 });
  const upstreamBytes = JSON.stringify(upstream.input), leafHash = semanticDigest(overviewLeafRules(input.context, originals));
  const bundle = upstream.decode(overviewFixture(upstream.input)), context = { snapshotId: input.context.snapshotId, engineIdentity: 'same-engine', model: 'route/model', modelUrl: 'http://127.0.0.1:1/v1' };
  const key = (phase, value) => semanticCheckpointKey(context, { phase, input: value, inference_policy: semanticInferencePolicy(phase) });
  const beforeKey = key('architecture-reduce', upstream.input), prepare = scopes => prepareOverviewGlobalRequest(input.context, [bundle], { task: '职责导航。', output_shape: {}, overview_bundles: [bundle] }, { name: 'system' }, scopes);
  const global = prepare(originals), scope = global.input.global_scope_catalog[0], originalGlobalKey = key('architecture', global.input);
  for (const mutate of [value => { value.name += '（范围变化）'; }, value => { value.responsibility += ' 原范围上下文变化。'; }, value => { value.state_owners.push('另一个状态'); }, value => { value.user_purposes.push('另一个目的'); }, value => { value.related_paths.push(input.files[1].path); }]) {
    const changed = structuredClone(originals); mutate(changed[0]); const next = prepare(changed);
    assert.notEqual(next.input.global_scope_catalog[0].origin_scope_id, scope.origin_scope_id); assert.notEqual(key('architecture', next.input), originalGlobalKey);
    assert.throws(() => next.decode(globalPayload(next, [{ parent_rule_id: scope.parent_rule_id, origin_scope_id: scope.origin_scope_id, epistemic_status: 'source_inference' }])), { code: 'code_analysis_model_invalid' });
    assert.equal(semanticDigest(overviewLeafRules(input.context, changed)), leafHash);
  }
  const repeated = prepareOverviewRequest(input.context, originals, { name: 'frozen-overview', depth: 1 });
  assert.equal(JSON.stringify(repeated.input), upstreamBytes); assert.equal(key('architecture-reduce', repeated.input), beforeKey);
  assert.equal(repeated.input.overview_protocol, 'architecture-overview-1.1.0');
  assert.throws(() => prepareOverviewGlobalRequest(input.context, [bundle], { task: '职责导航。', output_shape: {} }, { name: 'missing-originals' }), error => error.details.reason === 'global_origin_scope_required');
  const changedEvidence = structuredClone(originals); changedEvidence[0].business_rules.forEach(rule => { rule.evidence[0].line_start = 2; });
  assert.throws(() => prepare(changedEvidence), error => error.details.reason === 'global_origin_scope_required');
});

test('actual UTF8 text and canonical expanded supports are bounded independently and cannot inflate the host floor', () => {
  const input = fixture(120), wire = prepareOverviewRequest(input.context, input.proposals, { name: 'large', depth: 1 }), valid = overviewFixture(wire.input);
  const overText = structuredClone(valid); overText.candidates = Array.from({ length: 4 }, (_, index) => ({ ...structuredClone(valid.candidates[0]), candidate_id: `C${index + 1}`, name: '中'.repeat(80), responsibility: '中'.repeat(200), state_owners: ['中'.repeat(80), '中'.repeat(80)], user_purposes: ['中'.repeat(80), '中'.repeat(80)] }));
  overText.shared_invariants = wire.input.leaf_rule_catalog.slice(0, 6).map(rule => ({ parent_rule_id: rule.parent_rule_id, candidate_ids: ['C1'], epistemic_status: 'uncertain' }));
  assert.throws(() => wire.decode(overText), error => error.details.reason === 'overview_text_budget' && error.details.schema_issues[0].observed_length > OVERVIEW_TEXT_BYTES);
  const small = prepareOverviewRequest(input.context, [input.proposals[0]], { name: 'small', depth: 1 });
  assert.ok(small.accounting.maximumCanonicalBytes >= small.accounting.floorBytes + 8192, 'measured small tails have 8KiB semantic room while the absolute/layer/global gates remain');
  assert.ok(overviewBytes(small.decode(overviewBudgetFixture(small.input, small.decode))) >= 6896, 'a valid 6.9k restored tail is no longer rejected by the former 1536 minimum');
  assert.ok(wire.accounting.maximumCanonicalBytes <= wire.accounting.floorBytes + 12 * 1024);
  const longPaths = fixture(40, 'src/' + 'scope/'.repeat(45)), normalPaths = fixture(40);
  for (const data of [longPaths, normalPaths]) for (const proposal of data.proposals) for (const rule of proposal.business_rules) rule.evidence = [1, 10, 20].map(line => ({ path: proposal.related_paths[0], line_start: line, line_end: line + 3 }));
  const long = prepareOverviewRequest(longPaths.context, longPaths.proposals, { name: 'expanded-supports', depth: 1 }), normal = prepareOverviewRequest(normalPaths.context, normalPaths.proposals, { name: 'expanded-supports', depth: 1 });
  assert.equal(long.accounting.floorBytes, normal.accounting.floorBytes, 'selected support size must not inflate the immutable host exemption');
  const expanded = overviewFixture(long.input), refs = index => long.input.evidence_catalog.slice(index, index + 2).map(row => row.id), detail = [long.input.related_path_catalog[0].id];
  expanded.candidates = Array.from({ length: 4 }, (_, index) => ({ candidate_id: `C${index + 1}`, name: '职责', responsibility: '边界', state_owners: [], user_purposes: [], epistemic_status: 'source_inference', detail_file_ids: detail, evidence_ids: refs(index * 2) }));
  expanded.shared_invariants = long.input.leaf_rule_catalog.slice(0, 6).map(rule => ({ parent_rule_id: rule.parent_rule_id, candidate_ids: ['C1'], epistemic_status: 'source_inference' }));
  expanded.boundary_contracts = long.input.leaf_rule_catalog.slice(6, 10).map(rule => ({ parent_rule_id: rule.parent_rule_id, counterparty: '边界', candidate_ids: ['C1'], epistemic_status: 'source_inference' }));
  expanded.important_unknowns = Array.from({ length: 4 }, (_, index) => ({ description: '待确认', detail_file_ids: detail, evidence_ids: refs(28 + index * 2) }));
  assert.throws(() => long.decode(expanded), error => error.details.reason === 'overview_convergence_budget' && error.details.schema_issues[0].observed_length > error.details.schema_issues[0].maximum);
  const current = wire.decode(valid), next = prepareOverviewRequest(input.context, [current], { name: 'next', depth: 2 });
  assert.equal(next.input.host_uncertainty.unknown_entries, current.uncertainty.unknown_entries); assert.equal(next.input.host_uncertainty.uncertain_claims, 1);
});

test('an irreducible host directory fails before overview calls rather than consuming all reduction levels', () => {
  const input = fixture(419, 'src/' + 'scope/'.repeat(65));
  assert.throws(() => overviewFixedFloor(input.context, input.proposals), error => error.details.reason === 'overview_irreducible_budget' && error.details.repairable === false && error.details.schema_issues[0].observed_length > 115000);
  assert.throws(() => prepareOverviewRequest(input.context, [], { name: 'empty', depth: 1 }), error => error.details.reason === 'overview_empty_scope');
});
