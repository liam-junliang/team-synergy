import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createArchitectureNativeRecoveryContext, ARCHITECTURE_NATIVE_CALL_RECOVERY_PROTOCOL } from '../dist/code-analysis-semantic-reachability.js';
import { semanticDigest } from '../dist/code-analysis-semantic-source.js';

const range = (path, line_start = 1, line_end = line_start) => ({ path, line_start, line_end });
const edge = (id, source, target, extra = {}) => ({ id, source, target, type: 'calls', provider: 'codegraph', provenance: 'native', verification: 'inferred', evidence_ids: [], ...extra });
function fixture(count = 4) {
  const files = Array.from({ length: count }, (_, index) => ({ path: `src/${index}.ts`, sha256: semanticDigest(String(index)), line_count: 1000, byte_count: 10000 }));
  const nodes = files.map((file, index) => ({ id: `n${index}`, native_id: `n${index}`, provider: 'codegraph', kind: 'function', label: `operation${index}`, path: file.path, line_start: 10, line_end: 20, evidence_ids: [`e${index}`], verification: 'observed' }));
  const evidence = nodes.map((node, index) => ({ id: `e${index}`, path: node.path, line_start: node.line_start, line_end: node.line_end, sha256: files[index].sha256 }));
  return { snapshot: { snapshot_id: 'a'.repeat(64), manifest_sha256: 'b'.repeat(64), files }, native: { nodes, edges: [edge('a', 'n0', 'n1'), edge('b', 'n1', 'n2'), edge('c', 'n2', 'n3')], evidence }, original: [range(files[0].path, 12, 13)] };
}
const prepare = input => createArchitectureNativeRecoveryContext(input).catalog(input.original);
const failure = reason => error => error.code === 'code_analysis_model_invalid' && error.details?.reason === reason && error.details.repairable === false;

test('two-hop native recovery locates an outside-reference helper with complete path and unchanged original evidence', () => {
  const input = fixture(), before = structuredClone(input), catalog = prepare(input);
  assert.deepEqual(input, before); assert.equal(catalog.protocol, ARCHITECTURE_NATIVE_CALL_RECOVERY_PROTOCOL);
  assert.deepEqual(catalog.anchor_definition_ids, ['n0']); assert.deepEqual(catalog.eligible_definition_ids, ['n0', 'n1', 'n2']);
  assert.deepEqual(catalog.reachable_definitions.map(row => row.definition_id), ['n1', 'n2']);
  assert.deepEqual(catalog.reachable_definitions[1].retrieval_path, { definition_id: 'n2', depth: 2, anchor_definition_id: 'n0', edge_ids: ['a', 'b'] });
  assert.deepEqual(catalog.traversed_edges, input.native.edges.slice(0, 2));
  assert.deepEqual(catalog.depth_frontier, [{ edge_id: 'c', source: 'n2', target: 'n3', reason: 'depth_limit' }]);
  assert.equal(catalog.reachable_definitions[1].file_sha256, input.snapshot.files[2].sha256);
  assert.equal('supported' in catalog, false); assert.equal('replacement_text' in catalog, false);
});

test('reverse, disconnected and third-hop nodes stay ineligible', () => {
  const input = fixture(5); input.native.edges.push(edge('reverse', 'n4', 'n0'));
  const catalog = prepare(input); assert.equal(catalog.eligible_definition_ids.includes('n3'), false); assert.equal(catalog.eligible_definition_ids.includes('n4'), false);
});

test('only native outgoing codegraph calls navigate, including inferred edges with no edge evidence IDs', () => {
  for (const changed of [{ provider: 'ua' }, { provenance: 'bridge' }, { provenance: 'manual' }, { type: 'imports' }, { type: 'contains' }]) {
    const input = fixture(); Object.assign(input.native.edges[0], changed); assert.deepEqual(prepare(input).reachable_definitions, []);
  }
  assert.equal(prepare(fixture()).reachable_definitions.length, 2);
});

test('multiple paths and cycles have stable shortest paths while full projection identity remains bound', () => {
  const input = fixture(5); input.native.edges = [edge('z', 'n0', 'n2'), edge('a', 'n0', 'n1'), edge('cycle', 'n1', 'n0'), edge('b', 'n1', 'n3'), edge('c', 'n2', 'n3')];
  const first = prepare(input); input.native.nodes.reverse(); input.native.edges.reverse(); input.native.evidence.reverse();
  const second = prepare(input);
  assert.deepEqual(first.anchor_definition_ids, second.anchor_definition_ids); assert.deepEqual(first.reachable_definitions, second.reachable_definitions); assert.deepEqual(first.traversed_edges, second.traversed_edges);
  assert.deepEqual(first.reachable_definitions.find(row => row.definition_id === 'n3').retrieval_path.edge_ids, ['a', 'b']);
  assert.notEqual(first.native_projection_sha256, second.native_projection_sha256, 'the actual projection preimage, including array order, is not silently normalized away');
});

test('recovery derives the same narrow original anchor and excludes unrelated outer-container calls', () => {
  const input = fixture(), outer = { ...input.native.nodes[0], id: 'outer', line_start: 1, line_end: 900, evidence_ids: ['outer-e'] };
  input.native.nodes.push(outer); input.native.evidence.push({ id: 'outer-e', path: outer.path, line_start: 1, line_end: 900, sha256: input.snapshot.files[0].sha256 }); input.native.edges.push(edge('outer-call', 'outer', 'n3'));
  const catalog = prepare(input);
  assert.deepEqual(catalog.excluded_containers, [{ definition_id: 'outer', reason: 'outer_container_of_narrow_operation', nested_definition_ids: ['n0'] }]);
  assert.deepEqual(catalog.anchor_definition_ids, ['n0']); assert.equal(catalog.eligible_definition_ids.includes('n3'), false);
});

test('missing and non-definition endpoints remain explicit without inventing target definitions', () => {
  const input = fixture(); input.native.edges.push(edge('missing', 'n0', 'missing')); input.native.nodes.push({ id: 'external', provider: 'codegraph', kind: 'external', label: 'SDK' }); input.native.edges.push(edge('external-edge', 'n0', 'external'));
  const catalog = prepare(input);
  assert.deepEqual(catalog.unavailable, [{ edge_id: 'external-edge', source: 'n0', target: 'external', reason: 'target_not_snapshot_definition' }, { edge_id: 'missing', source: 'n0', target: 'missing', reason: 'target_absent' }]);
  assert.equal(catalog.eligible_definition_ids.includes('missing'), false); assert.equal(catalog.eligible_definition_ids.includes('external'), false);
});

test('256 additional definitions are all retained; overflow withholds the catalog instead of returning a prefix', () => {
  const input = fixture(257); input.native.edges = input.native.nodes.slice(1).map((node, index) => edge(`edge:${index}`, 'n0', node.id));
  assert.equal(prepare(input).reachable_definitions.length, 256);
  const extra = fixture(258); extra.native.edges = extra.native.nodes.slice(1).map((node, index) => edge(`edge:${index}`, 'n0', node.id));
  assert.throws(() => prepare(extra), error => { assert(failure('architecture_native_recovery_overflow')(error)); assert.equal(error.details.actual_additional_definitions, 257); assert.equal(error.details.additional_definition_ids.length, 257); assert.equal(error.details.withheld_catalog, true); return true; });
});

test('context and memoized catalogs cannot be mutated through original input or returned ledger objects', () => {
  const input = fixture(), context = createArchitectureNativeRecoveryContext(input), first = context.catalog(input.original), expected = structuredClone(first);
  first.reachable_definitions[0].label = 'mutated'; first.traversed_edges[0].target = 'foreign'; first.anchor_definition_ids.push('foreign');
  input.native.nodes[1].label = 'changed outside context'; input.native.edges[0].target = 'foreign'; input.snapshot.files[1].sha256 = 'f'.repeat(64);
  assert.deepEqual(context.catalog(input.original), expected); assert(Object.isFrozen(context));
});

test('snapshot and manifest identities remain part of recovery catalog binding', () => {
  const input = fixture(), first = prepare(input); input.snapshot.snapshot_id = 'c'.repeat(64); const changedSnapshot = prepare(input);
  assert.notEqual(first.catalog_sha256, changedSnapshot.catalog_sha256); input.snapshot.manifest_sha256 = 'd'.repeat(64); assert.notEqual(prepare(input).catalog_sha256, changedSnapshot.catalog_sha256);
});

test('duplicate native IDs, invalid ranges and changed source SHA fail before producing a catalog', () => {
  let input = fixture(); input.native.nodes.push(structuredClone(input.native.nodes[0])); assert.throws(() => prepare(input), failure('architecture_native_recovery_node_identity'));
  input = fixture(); input.native.edges.push({ ...input.native.edges[0], target: 'n3' }); assert.throws(() => prepare(input), failure('architecture_native_recovery_edge_identity'));
  input = fixture(); input.native.nodes[1].line_end = 1001; assert.throws(() => prepare(input), failure('architecture_native_recovery_range'));
  input = fixture(); input.snapshot.files[1].sha256 = 'f'.repeat(64); assert.throws(() => prepare(input), failure('architecture_native_recovery_source_sha'));
  input = fixture(); input.native.evidence[1].line_end = 21; assert.throws(() => prepare(input), failure('architecture_native_recovery_node_evidence'));
});

test('recovery requires actual native node evidence and safe original source ranges', () => {
  let input = fixture(); delete input.native.evidence; assert.throws(() => prepare(input), failure('architecture_native_recovery_identity'));
  input = fixture(); input.native.nodes[1].evidence_ids = []; assert.throws(() => prepare(input), failure('architecture_native_recovery_node_evidence'));
  input = fixture(); input.original[0].line_start = 0; assert.throws(() => prepare(input), failure('architecture_native_recovery_range'));
  input = fixture(); input.snapshot.files[0].path = '../outside.ts'; assert.throws(() => prepare(input), failure('architecture_native_recovery_manifest'));
});

test('mutating any retained native edge property changes the independently rebuilt catalog identity', () => {
  const input = fixture(), original = prepare(input); input.native.edges[0].verification = 'observed'; const rebuilt = prepare(input);
  assert.deepEqual(rebuilt.eligible_definition_ids, original.eligible_definition_ids); assert.notEqual(rebuilt.catalog_sha256, original.catalog_sha256);
});
