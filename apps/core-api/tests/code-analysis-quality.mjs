// Opt-in, offline quality evidence tooling. This module never calls a model or a platform database.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const digest = value => createHash('sha256').update(value).digest('hex');
const json = file => JSON.parse(readFileSync(file, 'utf8'));
function sourcePath(root, relative) {
  assert.equal(typeof relative, 'string');
  assert(relative && !relative.includes('\\') && !relative.split('/').includes('..') && !path.isAbsolute(relative));
  const absolute = path.resolve(root, relative), resolved = path.relative(path.resolve(root), absolute);
  assert(resolved && !resolved.startsWith('..') && !path.isAbsolute(resolved));
  return absolute;
}
export function freezeBenchmark(definition, snapshot, source) {
  assert.equal(definition.commit, snapshot.commit, 'Benchmark and snapshot must describe the same fixed commit');
  const manifest = new Map(snapshot.files.map(file => [file.path, file]));
  const cases = definition.cases.map(item => ({ ...item, evidence: item.evidence.map(ref => {
    const bytes = readFileSync(sourcePath(source, ref.path)), saved = manifest.get(ref.path);
    assert(saved && digest(bytes) === saved.sha256, 'Evidence source must match the fixed manifest: ' + ref.path);
    const lines = bytes.toString('utf8').split('\n');
    assert(Number.isSafeInteger(ref.start) && Number.isSafeInteger(ref.end) && ref.start > 0 && ref.end >= ref.start && ref.end <= lines.length);
    return { ...ref, sha256: saved.sha256, excerpt_sha256: digest(lines.slice(ref.start - 1, ref.end).join('\n')) };
  }) }));
  const result = { ...definition, snapshot_id: snapshot.snapshot_id, cases };
  return { ...result, benchmark_sha256: digest(JSON.stringify(result)) };
}
export function inspectGraph(graph, snapshot) {
  const manifest = new Map(snapshot.files.map(file => [file.path, file]));
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  const files = graph.nodes.filter(node => node.type === 'file' && node.filePath);
  const represented = new Set(files.map(node => node.filePath));
  const modules = graph.nodes.filter(node => ['module', 'domain', 'service', 'capability'].includes(node.type));
  const ownerIds = new Set(modules.map(node => node.id));
  const contains = graph.edges.filter(edge => edge.type === 'contains' && ownerIds.has(edge.source) && byId.get(edge.target)?.type === 'file');
  const ownership = new Map();
  for (const edge of contains) { const owners = ownership.get(edge.target) ?? new Set(); owners.add(edge.source); ownership.set(edge.target, owners); }
  const batchOf = id => /^b\d+:/.exec(id)?.[0] ?? null;
  const batchEdges = graph.edges.filter(edge => batchOf(edge.source) && batchOf(edge.target));
  const dependencies = graph.edges.filter(edge => ['imports', 'calls', 'depends_on', 'reads_from', 'writes_to', 'routes'].includes(edge.type));
  const sourceIssues = graph.nodes.flatMap(node => {
    if (!node.filePath) return node.lineRange ? [{ id: node.id, reason: 'range_without_file' }] : [];
    const saved = manifest.get(node.filePath);
    return !saved || node.lineRange && (node.lineRange[0] < 1 || node.lineRange[1] < node.lineRange[0] || node.lineRange[1] > saved.line_count)
      ? [{ id: node.id, path: node.filePath, reason: 'unknown_path_or_invalid_range' }] : [];
  });
  return {
    commit_matches: graph.project.gitCommitHash === snapshot.commit,
    graph_sha256: digest(JSON.stringify(graph)),
    nodes: graph.nodes.length, edges: graph.edges.length, file_nodes: files.length, unique_files: represented.size,
    total_source_files: snapshot.files.length, omitted_files: snapshot.files.filter(file => !represented.has(file.path)).map(file => file.path),
    duplicate_file_paths: [...represented].filter(file => files.filter(node => node.filePath === file).length > 1),
    modules: modules.length, layers: graph.layers.length, tour_steps: graph.tour.length,
    explicit_single_owner_files: files.filter(node => ownership.get(node.id)?.size === 1).length,
    unowned_files: files.filter(node => !ownership.has(node.id)).map(node => node.filePath),
    multiply_owned_files: files.filter(node => ownership.get(node.id)?.size > 1).map(node => node.filePath),
    named_batch_edge_count: batchEdges.length,
    cross_named_batch_edges: batchEdges.filter(edge => batchOf(edge.source) !== batchOf(edge.target)).length,
    dependency_edges: dependencies.length,
    dependency_edges_with_distinct_file_endpoints: dependencies.filter(edge => byId.get(edge.source)?.filePath && byId.get(edge.target)?.filePath && byId.get(edge.source).filePath !== byId.get(edge.target).filePath).length,
    dangling_edges: graph.edges.filter(edge => !byId.has(edge.source) || !byId.has(edge.target)),
    source_issues: sourceIssues,
    note: 'Coverage, valid paths and edge counts are mechanical signals, not judgments of semantic correctness. Cross-named-batch applies only to legacy bN IDs.',
  };
}
function textOf(node) {
  const strings = value => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings)
    : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
  return strings({ name: node.name, summary: node.summary, domainMeta: node.domainMeta, languageNotes: node.languageNotes }).join('\n');
}
export function buildReviewPacket(benchmark, graph) {
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  return benchmark.cases.map(item => {
    const paths = new Set(item.evidence.map(ref => ref.path));
    const directlyRelevant = graph.nodes.filter(node => paths.has(node.filePath));
    const ids = new Set(directlyRelevant.map(node => node.id));
    const directIds = new Set(ids);
    for (const edge of graph.edges) if (directIds.has(edge.source) || directIds.has(edge.target)) { ids.add(edge.source); ids.add(edge.target); }
    return { id: item.id, question: item.question, expected_facts: item.expected_facts, pitfalls: item.pitfalls,
      source_evidence: item.evidence, nodes: [...ids].map(id => byId.get(id)).filter(Boolean),
      edges: graph.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)),
      instruction: 'Read original evidence and the complete graph if needed. Select the score manually; paths/terms alone cannot establish rule correctness. A missing explanation is a gap, not a proven false claim.' };
  });
}
export function validateReview(benchmark, graph, review) {
  assert.equal(review.benchmark_sha256, benchmark.benchmark_sha256, 'Review must use the frozen benchmark');
  assert.equal(review.graph_sha256, digest(JSON.stringify(graph)), 'Review must refer to this exact graph');
  assert(review.reviewer && review.reviewed_at && review.method === 'manual_source_cross_check');
  assert.equal(review.cases.length, benchmark.cases.length);
  assert.equal(new Set(review.cases.map(item => item.id)).size, benchmark.cases.length);
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  for (const item of review.cases) {
    const question = benchmark.cases.find(candidate => candidate.id === item.id);
    assert(question && Number.isInteger(item.score) && item.score >= 0 && item.score <= 3);
    assert(item.rationale && Array.isArray(item.missing_facts) && Array.isArray(item.false_claims));
    assert(Array.isArray(item.graph_evidence));
    for (const evidence of item.graph_evidence) {
      const node = byId.get(evidence.node_id);
      assert(node && typeof evidence.quote === 'string' && evidence.quote.length > 0 && textOf(node).includes(evidence.quote), 'Graph quote must be present in the actual node');
    }
    if (item.score >= 2) assert(item.graph_evidence.length, 'Substantive semantic credit requires quoted graph evidence');
    assert(Array.isArray(item.source_refs) && item.source_refs.length > 0 && item.source_refs.every(ref => question.evidence.some(evidence => ref === `${evidence.path}:${evidence.start}-${evidence.end}`)), 'Manual source reference must exist in the frozen question');
  }
  const total = review.cases.reduce((sum, item) => sum + item.score, 0);
  return { score: total, maximum: benchmark.cases.length * 3, percent: Math.round(total / (benchmark.cases.length * 3) * 1000) / 10,
    questions_substantively_answered: review.cases.filter(item => item.score >= 2).length,
    questions_complete: review.cases.filter(item => item.score === 3).length,
    false_claims_found: review.cases.flatMap(item => item.false_claims.map(claim => ({ case_id: item.id, ...claim }))),
    method: review.method, semantic_score_is_human_judgment: true };
}
function main(args) {
  const options = {};
  for (let index = 1; index < args.length; index += 2) { assert(args[index].startsWith('--')); options[args[index].slice(2)] = args[index + 1]; }
  assert(options.out, 'Use --out <directory>'); mkdirSync(options.out, { recursive: true });
  const save = (file, value) => writeFileSync(path.join(options.out, file), JSON.stringify(value, null, 2) + '\n');
  const snapshot = json(options.snapshot), graph = options.graph ? json(options.graph) : null;
  if (args[0] === 'freeze') { save('benchmark.json', freezeBenchmark(json(options.definition), snapshot, options.source)); return; }
  const benchmark = json(options.benchmark);
  // Re-hash the evidence before every review so a mutable working tree cannot silently replace the oracle.
  const { benchmark_sha256: _frozenHash, snapshot_id: _snapshot, ...definition } = benchmark;
  assert.equal(freezeBenchmark(definition, snapshot, options.source).benchmark_sha256, benchmark.benchmark_sha256);
  assert(graph, 'Use --graph <ua-graph.json>');
  save('mechanical.json', inspectGraph(graph, snapshot));
  save('review-packet.json', buildReviewPacket(benchmark, graph));
  if (options.review) save('scorecard.json', validateReview(benchmark, graph, json(options.review)));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
