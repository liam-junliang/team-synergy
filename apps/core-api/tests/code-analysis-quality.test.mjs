import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { digest, freezeBenchmark, inspectGraph, buildReviewPacket, validateReview } from './code-analysis-quality.mjs';

function fixture(t) {
  const source = mkdtempSync(path.join(tmpdir(), 'tsp-quality-'));
  t.after(() => { assert.equal(path.dirname(source), path.resolve(tmpdir())); assert(path.basename(source).startsWith('tsp-quality-')); rmSync(source, { recursive: true, force: true }); });
  const content = 'export const state = "pending";\nrejectUnlessRecipient();\n';
  writeFileSync(path.join(source, 'case.ts'), content);
  const snapshot = { commit: 'a'.repeat(40), snapshot_id: 'b'.repeat(64), files: [{ path: 'case.ts', sha256: digest(content), line_count: 3 }] };
  const definition = { commit: snapshot.commit, cases: [{ id: 'Q1', question: 'Who can accept?', evidence: [{ path: 'case.ts', start: 1, end: 2 }] }] };
  const benchmark = freezeBenchmark(definition, snapshot, source);
  const graph = { project: { gitCommitHash: snapshot.commit }, nodes: [{ id: 'file', type: 'file', filePath: 'case.ts', name: 'case', summary: 'Only the actual recipient may accept a pending request.' }], edges: [], layers: [], tour: [] };
  const review = { reviewer: 'independent', reviewed_at: '2026-11-12T00:00:00Z', method: 'manual_source_cross_check', benchmark_sha256: benchmark.benchmark_sha256, graph_sha256: digest(JSON.stringify(graph)), cases: [{ id: 'Q1', score: 2, rationale: 'Manual comparison with the source guard.', missing_facts: ['expiry'], false_claims: [], graph_evidence: [{ node_id: 'file', quote: 'actual recipient may accept' }], source_refs: ['case.ts:1-2'] }] };
  return { source, content, snapshot, definition, benchmark, graph, review };
}
test('freezing quality evidence rejects changed source, commit drift and escaped paths', t => {
  const f = fixture(t);
  assert.equal(f.benchmark.cases[0].evidence[0].sha256, f.snapshot.files[0].sha256);
  assert.throws(() => freezeBenchmark({ ...f.definition, commit: 'other' }, f.snapshot, f.source));
  assert.throws(() => freezeBenchmark({ ...f.definition, cases: [{ id: 'Q1', evidence: [{ path: '../case.ts', start: 1, end: 1 }] }] }, f.snapshot, f.source));
  writeFileSync(path.join(f.source, 'case.ts'), 'modified');
  assert.throws(() => freezeBenchmark(f.definition, f.snapshot, f.source), /fixed manifest/);
});
test('mechanical coverage detects missing ownership and invalid graph identity without grading meaning', t => {
  const f = fixture(t);
  const inspected = inspectGraph({ ...f.graph, nodes: [...f.graph.nodes, { id: 'bad', type: 'file', filePath: 'missing.ts', lineRange: [1, 2] }], edges: [{ source: 'bad', target: 'absent', type: 'depends_on' }] }, f.snapshot);
  assert.equal(inspected.source_issues.length, 1); assert.equal(inspected.dangling_edges.length, 1);
  assert.equal(inspected.explicit_single_owner_files, 0);
  assert.equal(inspected.semantic_score, undefined);
});
test('a review cannot fabricate graph quotes, silently change the graph or duplicate scored questions', t => {
  const f = fixture(t);
  assert.equal(validateReview(f.benchmark, f.graph, f.review).score, 2);
  const forged = structuredClone(f.review); forged.cases[0].graph_evidence[0].quote = 'Everyone can accept any transfer.';
  assert.throws(() => validateReview(f.benchmark, f.graph, forged), /actual node/);
  const duplicate = structuredClone(f.review); duplicate.cases.push(duplicate.cases[0]);
  assert.throws(() => validateReview(f.benchmark, f.graph, duplicate));
  assert.throws(() => validateReview(f.benchmark, { ...f.graph, edges: [{ source: 'file', target: 'file' }] }, f.review), /exact graph/);
  const unsourced = structuredClone(f.review); unsourced.cases[0].source_refs = [];
  assert.throws(() => validateReview(f.benchmark, f.graph, unsourced), /source reference/);
});
test('review packets expand one relevant hop and do not accidentally absorb the entire connected graph', t => {
  const f = fixture(t), graph = { ...f.graph, nodes: [...f.graph.nodes, { id: 'module', type: 'module' }, { id: 'unrelated', type: 'module' }], edges: [{ source: 'module', target: 'file', type: 'contains' }, { source: 'module', target: 'unrelated', type: 'depends_on' }] };
  const packet = buildReviewPacket(f.benchmark, graph)[0];
  assert.deepEqual(packet.nodes.map(node => node.id), ['file', 'module']);
});
