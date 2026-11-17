import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { CodeArtifactSchema, validateCodeArtifact } from '@team-synergy/contracts';
import { buildCodeArtifact, materializeCodeSemanticAnalysis, registerCodePlugin } from '../dist/index.js';

function builderFixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'tsp-builder-metadata-'));
  t.after(() => { const resolved = path.resolve(root); assert.equal(path.dirname(resolved), path.resolve(tmpdir())); assert.ok(path.basename(resolved).startsWith('tsp-builder-metadata-')); rmSync(resolved, { recursive: true, force: true }); });
  const write = (file, content) => { const target = path.join(root, file); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content)); };
  const uaRoot = path.join(root, 'ua'), cgRoot = path.join(root, 'codegraph'), runDirectory = path.join(root, 'run'), sourceDirectory = path.join(root, 'source');
  write('ua/.claude-plugin/plugin.json', { version: '2.9.8' }); write('ua/package.json', { type: 'module' }); write('ua/pnpm-lock.yaml', '');
  write('ua/understand-anything-plugin/package.json', { type: 'module', dependencies: { '@fixture/core': '1.0.0' } });
  for (const file of ['scan-project.mjs', 'extract-import-map.mjs', 'compute-batches.mjs', 'SKILL.md']) write(`ua/understand-anything-plugin/skills/understand/${file}`, '');
  write('ua/understand-anything-plugin/packages/core/package.json', { name: '@fixture/core', type: 'module', version: '1.0.0' });
  const zodUrl = pathToFileURL(createRequire(import.meta.url).resolve('zod')).href;
  // The real pinned UA schema uses passthrough domain metadata. Exercise that
  // boundary without executing external engines or requiring a local installation.
  write('ua/understand-anything-plugin/packages/core/dist/schema.js', `import { z } from ${JSON.stringify(zodUrl)}; export const KnowledgeGraphSchema = z.object({ nodes: z.array(z.object({ domainMeta: z.object({ entities: z.array(z.string()).optional() }).passthrough().optional() }).passthrough()) }).passthrough();`);
  write('ua/understand-anything-plugin/packages/core/dist/index.js', '');
  const modules = path.join(uaRoot, 'understand-anything-plugin/node_modules/@fixture'); mkdirSync(modules, { recursive: true });
  symlinkSync(path.join(uaRoot, 'understand-anything-plugin/packages/core'), path.join(modules, 'core'), 'junction');
  write('codegraph/package.json', { version: '1.6.2' }); write(`codegraph/${process.platform === 'win32' ? 'node.exe' : 'node'}`, '');
  write('codegraph/lib/package.json', { type: 'module' });
  for (const file of ['index.js', 'bin/codegraph.js', 'db/schema.sql']) write(`codegraph/lib/dist/${file}`, '');
  const content = 'export function readRecord() {\n  return 1;\n}\n\n// Local fixture only.\n';
  write('source/src/record.ts', content); mkdirSync(path.join(sourceDirectory, '.codegraph'), { recursive: true });
  const db = new DatabaseSync(path.join(sourceDirectory, '.codegraph/codegraph.db'));
  try {
    db.exec('CREATE TABLE nodes(id TEXT,kind TEXT,name TEXT,file_path TEXT,start_line INTEGER,end_line INTEGER); CREATE TABLE edges(id INTEGER,source TEXT,target TEXT,kind TEXT); CREATE TABLE files(path TEXT,errors TEXT); CREATE TABLE unresolved_refs(id INTEGER);');
    db.prepare('INSERT INTO nodes VALUES(?,?,?,?,?,?)').run('record-reader', 'function', 'readRecord', 'src/record.ts', 1, 3);
    db.prepare('INSERT INTO files VALUES(?,?)').run('src/record.ts', '[]');
  } finally { db.close(); }
  registerCodePlugin(root, 'ua', uaRoot); registerCodePlugin(root, 'codegraph', cgRoot);
  const registry = JSON.parse(readFileSync(path.join(root, '.agent/code-understanding/plugins.json'), 'utf8'));
  write('run/plugin-lock.json', [registry.plugins.ua, registry.plugins.codegraph]);
  const file = { path: 'src/record.ts', sha256: createHash('sha256').update(content).digest('hex'), byte_count: Buffer.byteLength(content), line_count: content.split('\n').length };
  const snapshot = { snapshot_id: 'a'.repeat(64), manifest_sha256: 'b'.repeat(64), kind: 'commit', commit: 'c'.repeat(40), tree: 'd'.repeat(40), captured_at: '2026-11-13T00:00:00Z', scope: ['src'], exclusions: [], files: [file] };
  const metadata = { userPurposes: ['帮助成员定位资料读取入口'], unknowns: ['并发执行结果仍需独立验证'] };
  const uaGraph = { version: '1.0.0', kind: 'codebase', project: { name: 'Records', description: 'Read recorded data.', languages: ['TypeScript'], frameworks: [], analyzedAt: snapshot.captured_at, gitCommitHash: snapshot.commit },
    nodes: [{ id: 'module:records', type: 'module', name: 'Records', summary: 'Coordinates record access.', tags: [], complexity: 'simple', domainMeta: metadata }, { id: 'file:record', type: 'file', name: 'Record source', filePath: file.path, summary: 'Defines the read entry point.', tags: [], complexity: 'simple', domainMeta: { ...metadata, unknowns: ['运行期访问限制未核对'] } }],
    edges: [{ source: 'module:records', target: 'file:record', type: 'contains', direction: 'forward', weight: 1 }], layers: [{ id: 'records', name: 'Records', description: 'Record responsibilities.', nodeIds: ['module:records', 'file:record'] }], tour: [{ order: 0, title: 'Read entry', description: 'Start with the record source.', nodeIds: ['file:record'] }] };
  const range = { path: file.path, line_start: 1, line_end: 3 }, segment = { id: `segment:${'f'.repeat(32)}`, input_sha256: 'f'.repeat(64), byte_start: 0, byte_end: file.byte_count, line_start: 1, line_end: file.line_count, completed: true };
  const quality = { protocol_version: 2, snapshot_id: snapshot.snapshot_id, manifest_sha256: snapshot.manifest_sha256, prompt_version: 'fixture-full', full_source_coverage: true, total_files: 1, total_segments: 1, completed_segments: 1, total_bytes: file.byte_count, covered_bytes: file.byte_count,
    file_coverage: [{ path: file.path, sha256: file.sha256, total_bytes: file.byte_count, covered_bytes: file.byte_count, segments: [segment] }], node_evidence: uaGraph.nodes.map(node => ({ node_id: node.id, evidence: [range] })), relation_evidence: [{ source: 'module:records', target: 'file:record', type: 'contains', basis: 'semantic_inference', evidence: [range] }], unresolved: [{ scope: 'system', description: metadata.unknowns[0] }] };
  const { completed: _completed, ...trustedSegment } = segment;
  const trustedPlan = { snapshot_id: snapshot.snapshot_id, manifest_sha256: snapshot.manifest_sha256, segments: [{ ...trustedSegment, path: file.path, file_sha256: file.sha256 }] };
  return { input: { workspace: root, runDirectory, sourceDirectory, snapshot, uaGraph }, metadata, quality, trustedPlan };
}

test('artifact builder preserves purposes and unknowns through passthrough UA parsing, publication and materialization', async t => {
  const f = builderFixture(t), before = structuredClone(f.input.uaGraph);
  const built = await buildCodeArtifact(f.input);
  assert.deepEqual(f.input.uaGraph, before);
  assert.deepEqual(built.ua_graph.nodes[0].domainMeta, f.metadata);
  assert.deepEqual(built.ua_graph.nodes[1].domainMeta, f.input.uaGraph.nodes[1].domainMeta);
  const materialized = materializeCodeSemanticAnalysis(built, f.input.snapshot, f.quality, f.trustedPlan);
  for (const node of f.input.uaGraph.nodes) assert.deepEqual(materialized.nodes.find(item => item.native_id === node.id && item.provider === 'ua').domain_meta, node.domainMeta);
  assert.deepEqual(validateCodeArtifact(materialized, f.input.snapshot), []);
  assert(CodeArtifactSchema.safeParse(materialized).success);
  for (const field of ['userPurposes', 'unknowns']) {
    const unsafe = structuredClone(f.input.uaGraph); unsafe.nodes[0].domainMeta[field] = ['F:/private/customer-records'];
    await assert.rejects(buildCodeArtifact({ ...f.input, uaGraph: unsafe }), { code: 'code_graph_sensitive' });
  }
});

function fixture() {
  const files = [{ path: 'src/a.ts', sha256: 'a'.repeat(64), byte_count: 100, line_count: 20 }, { path: 'src/b.ts', sha256: 'b'.repeat(64), byte_count: 80, line_count: 15 }];
  const snapshot = { snapshot_id: 'c'.repeat(64), manifest_sha256: 'd'.repeat(64), kind: 'commit', commit: 'e'.repeat(40), tree: 'f'.repeat(40), captured_at: '2026-11-12T00:00:00Z', scope: ['src'], exclusions: [], files };
  const uaNodes = [
    { id: 'file:a', type: 'file', name: 'A', filePath: files[0].path, summary: 'Requests a dependency', tags: ['request'], complexity: 'simple' },
    { id: 'file:b', type: 'file', name: 'B', filePath: files[1].path, summary: 'Provides a dependency', tags: ['dependency'], complexity: 'simple' },
    { id: 'module:core', type: 'module', name: 'Core', summary: 'Coordinates requests', tags: ['core'], complexity: 'moderate' },
  ];
  const uaEdges = [
    { source: 'file:a', target: 'file:b', type: 'imports', direction: 'forward', weight: 1 },
    { source: 'file:a', target: 'module:core', type: 'calls', direction: 'backward', weight: 0.6 },
    { source: 'file:a', target: 'file:b', type: 'related', direction: 'bidirectional', weight: 0.5 },
    { source: 'module:core', target: 'file:a', type: 'contains', direction: 'forward', weight: 1 },
  ];
  const evidence = files.map((file, index) => ({ id: `file-${index}`, path: file.path, sha256: file.sha256, line_start: 1, line_end: file.line_count }));
  const nodes = uaNodes.map((node, index) => ({ id: `ua:${node.id}`, provider: 'ua', native_id: node.id, kind: node.type, label: node.name, summary: node.summary, ...(node.filePath ? { path: node.filePath } : {}), evidence_ids: node.filePath ? [`file-${index}`] : [], verification: 'inferred' }));
  nodes.push(...files.map((file, index) => ({ id: `cg:${index}`, provider: 'codegraph', native_id: `native-${index}`, kind: 'function', label: `fn${index}`, path: file.path, line_start: index ? 2 : 3, line_end: index ? 4 : 5, evidence_ids: [`file-${index}`], verification: 'inferred' })));
  const edges = [];
  uaEdges.forEach((edge, index) => {
    const pair = edge.direction === 'backward' ? [edge.target, edge.source] : [edge.source, edge.target];
    edges.push({ id: `ua-edge:${index}`, source: `ua:${pair[0]}`, target: `ua:${pair[1]}`, type: edge.type, provider: 'ua', provenance: 'agent', evidence_ids: [], verification: 'inferred' });
    if (edge.direction === 'bidirectional') edges.push({ ...edges.at(-1), id: `ua-edge:${index}:reverse`, source: `ua:${pair[1]}`, target: `ua:${pair[0]}` });
  });
  edges.push({ id: 'cg-edge:12', source: 'cg:0', target: 'cg:1', type: 'imports', provider: 'codegraph', provenance: 'native', evidence_ids: [], verification: 'inferred' });
  const artifact = { schema_version: 1, snapshot_id: snapshot.snapshot_id, nodes, edges, evidence, tour: [], coverage: ['ua', 'codegraph'].map(provider => ({ provider, analyzed_files: 2, total_files: 2, limitations: [] })), semantic_author: { kind: 'agent', model: 'fixture', prompt_version: 'test' }, ua_graph: { version: '1.0.0', kind: 'codebase', project: { name: 'Fixture', languages: ['TypeScript'], frameworks: [], description: 'Requests and dependencies', analyzedAt: snapshot.captured_at, gitCommitHash: snapshot.commit }, nodes: uaNodes, edges: uaEdges, layers: [], tour: [] } };
  const ranges = files.map((file, index) => ({ path: file.path, line_start: index ? 2 : 3, line_end: index ? 4 : 5 }));
  const segment = (id, byte_start, byte_end, line_start, line_end) => ({ id: `segment:${String(id).repeat(32)}`, byte_start, byte_end, line_start, line_end, input_sha256: String(id).repeat(64), completed: true });
  const quality = {
    protocol_version: 2, snapshot_id: snapshot.snapshot_id, manifest_sha256: snapshot.manifest_sha256, prompt_version: 'full-2', full_source_coverage: true,
    total_files: 2, total_bytes: 180, covered_bytes: 180, total_segments: 3, completed_segments: 3,
    file_coverage: [{ path: files[0].path, sha256: files[0].sha256, total_bytes: 100, covered_bytes: 100, segments: [segment(1, 0, 40, 1, 8), segment(2, 40, 100, 8, 20)] }, { path: files[1].path, sha256: files[1].sha256, total_bytes: 80, covered_bytes: 80, segments: [segment(3, 0, 80, 1, 15)] }],
    node_evidence: [{ node_id: 'file:a', evidence: [ranges[0]] }, { node_id: 'file:b', evidence: [ranges[1]] }, { node_id: 'module:core', evidence: ranges }],
    relation_evidence: uaEdges.map((edge, index) => ({ source: edge.source, target: edge.target, type: edge.type, basis: index ? 'semantic_inference' : 'native_dependency', evidence: index === 3 ? [ranges[0]] : ranges, ...(index ? {} : { native_ids: ['cg-edge:12'] }) })),
    unresolved: [{ scope: 'runtime', description: 'Static inference requires independent verification' }], statistics: { correctness: 100 }, review: { accepted: true },
  };
  const trustedPlan = { snapshot_id: snapshot.snapshot_id, manifest_sha256: snapshot.manifest_sha256, segments: quality.file_coverage.flatMap(file => file.segments.map(({ completed: _completed, ...segment }) => ({ ...segment, path: file.path, file_sha256: file.sha256 }))) };
  return { artifact, snapshot, quality, trustedPlan };
}
const rejects = mutate => {
  const f = fixture(); mutate(f);
  assert.throws(() => materializeCodeSemanticAnalysis(f.artifact, f.snapshot, f.quality, f.trustedPlan), error => error.code === 'code_semantic_evidence_invalid');
};

test('full semantic attribution is immutable, deterministic, source-only and preserves normalized edge directions', () => {
  const f = fixture(), before = structuredClone(f.artifact), result = materializeCodeSemanticAnalysis(f.artifact, f.snapshot, f.quality, f.trustedPlan);
  assert.deepEqual(f.artifact, before); assert(CodeArtifactSchema.safeParse(result).success); assert.deepEqual(validateCodeArtifact(result, f.snapshot), []);
  assert.deepEqual(result, materializeCodeSemanticAnalysis(result, f.snapshot, f.quality, f.trustedPlan));
  const report = result.semantic_analysis;
  assert.deepEqual(report.counts, { total_files: 2, total_bytes: 180, covered_bytes: 180, total_segments: 3, completed_segments: 3, supported_nodes: 3, supported_relations: 5, native_dependency_relations: 1, semantic_inference_relations: 4, unresolved_items: 1 });
  assert.equal(report.uncertainty.semantic_correctness, 'requires_independent_evaluation'); assert.equal('statistics' in report, false); assert.equal('review' in report, false);
  assert(report.relation_evidence.some(row => row.edge_id === 'ua-edge:1' && row.source === 'ua:module:core' && row.target === 'ua:file:a'));
  assert(report.relation_evidence.some(row => row.edge_id === 'ua-edge:2:reverse' && row.source === 'ua:file:b'));
  assert.equal(result.evidence.filter(row => row.id.startsWith('semantic-e:')).length, 2);
  assert(result.evidence.filter(row => row.id.startsWith('semantic-e:')).every(row => !('snippet' in row) && row.sha256 === f.snapshot.files.find(file => file.path === row.path).sha256));
});

test('business metadata survives normalization and cannot drift from its native UA source', () => {
  const f = fixture();
  f.artifact.ua_graph.nodes[2].domainMeta = { entities: ['Refund'], businessRules: ['Older refunds require approval'], crossDomainInteractions: ['Notify finance after approval'] };
  const result = materializeCodeSemanticAnalysis(f.artifact, f.snapshot, f.quality, f.trustedPlan);
  assert.deepEqual(result.nodes.find(node => node.native_id === 'module:core').domain_meta, f.artifact.ua_graph.nodes[2].domainMeta);
  assert.equal(f.artifact.nodes.find(node => node.native_id === 'module:core').domain_meta, undefined);
  result.nodes.find(node => node.native_id === 'module:core').domain_meta.businessRules = ['Unrelated rule'];
  assert(validateCodeArtifact(result, f.snapshot).includes('UA domain metadata does not match projection'));
});

test('complete byte coverage rejects missing files, hash changes, gaps, overlap, duplicates and unfinished segments', () => {
  for (const mutate of [
    f => { f.quality.file_coverage.pop(); },
    f => { f.quality.file_coverage[0].sha256 = '0'.repeat(64); },
    f => { f.quality.file_coverage[0].segments[1].byte_start++; },
    f => { f.quality.file_coverage[0].segments[1].byte_start--; },
    f => { f.quality.file_coverage[0].segments[1].byte_end--; },
    f => { f.quality.file_coverage[0].segments[1].completed = false; },
    f => { f.quality.file_coverage[0].segments[1].input_sha256 = '0'.repeat(64); },
    f => { f.quality.file_coverage[0].segments[1].id = f.quality.file_coverage[0].segments[0].id; },
    f => { f.quality.file_coverage.push(f.quality.file_coverage[0]); },
    f => { f.quality.full_source_coverage = false; },
    f => { f.quality.covered_bytes--; },
    f => { f.quality.file_coverage[0].segments[1].line_end = 100; },
  ]) rejects(mutate);
});

test('full materialization requires the independent trusted plan and rejects jointly forged segment IDs and digests', () => {
  const f = fixture();
  assert.throws(() => materializeCodeSemanticAnalysis(f.artifact, f.snapshot, f.quality), error => error.code === 'code_semantic_evidence_invalid');
  rejects(f => { const segment = f.quality.file_coverage[0].segments[0]; segment.id = `segment:${'9'.repeat(32)}`; segment.input_sha256 = '9'.repeat(64); });
  rejects(f => {
    f.quality.file_coverage[0].segments = [{ id: `segment:${'9'.repeat(32)}`, input_sha256: '9'.repeat(64), byte_start: 0, byte_end: 100, line_start: 1, line_end: 20, completed: true }];
    f.quality.total_segments = 2; f.quality.completed_segments = 2;
  });
  rejects(f => { f.trustedPlan.snapshot_id = '0'.repeat(64); });
  rejects(f => { f.trustedPlan.segments[0].file_sha256 = '0'.repeat(64); });
});

test('file-node supports must refer to their own path and source range while abstract modules may span files', () => {
  rejects(f => { [f.quality.node_evidence[0].evidence, f.quality.node_evidence[1].evidence] = [f.quality.node_evidence[1].evidence, f.quality.node_evidence[0].evidence]; });
  rejects(f => {
    Object.assign(f.artifact.nodes[0], { line_start: 10, line_end: 12 }); f.artifact.ua_graph.nodes[0].lineRange = [10, 12];
    f.artifact.evidence[0].line_start = 10; f.artifact.evidence[0].line_end = 12;
  });
  const f = fixture(), result = materializeCodeSemanticAnalysis(f.artifact, f.snapshot, f.quality, f.trustedPlan);
  const a = result.semantic_analysis.node_evidence.find(row => row.node_id === 'ua:file:a');
  a.evidence_ids = result.semantic_analysis.node_evidence.find(row => row.node_id === 'ua:file:b').evidence_ids;
  result.nodes.find(row => row.id === 'ua:file:a').evidence_ids.push(...a.evidence_ids);
  assert(validateCodeArtifact(result, f.snapshot).includes('Semantic node support does not match its source location'));
  assert.equal(result.semantic_analysis.node_evidence.find(row => row.node_id === 'ua:module:core').evidence_ids.length, 2);
});

test('unknown source locations and fabricated node or relation support never enter the publication', () => {
  for (const mutate of [
    f => { f.quality.node_evidence[0].node_id = 'missing'; },
    f => { f.quality.node_evidence.pop(); },
    f => { f.quality.node_evidence[0].evidence[0].path = '../private.ts'; },
    f => { f.quality.node_evidence[0].evidence[0].line_end = 99; },
    f => { f.quality.node_evidence[0].evidence[0].sha256 = '0'.repeat(64); },
    f => { f.quality.relation_evidence[0].target = 'missing'; },
    f => { f.quality.relation_evidence.pop(); },
    f => { f.quality.relation_evidence[0].evidence = []; },
    f => { f.quality.relation_evidence[0].evidence[0].snippet = 'raw body'; },
  ]) rejects(mutate);
});

test('native attribution validates directed dependency IDs and both source locations independently of node support', () => {
  for (const mutate of [
    f => { f.quality.relation_evidence[0].native_ids = ['missing']; },
    f => { f.artifact.edges.find(row => row.id === 'cg-edge:12').source = 'cg:1'; f.artifact.edges.find(row => row.id === 'cg-edge:12').target = 'cg:0'; },
    f => { f.quality.relation_evidence[0].evidence = [f.quality.node_evidence[0].evidence[0]]; },
    f => { f.quality.node_evidence[0].evidence = [{ path: 'src/a.ts', line_start: 12, line_end: 13 }]; },
  ]) rejects(mutate);
  const f = fixture(); delete f.quality.relation_evidence[0].native_ids;
  const result = materializeCodeSemanticAnalysis(f.artifact, f.snapshot, f.quality, f.trustedPlan);
  assert.equal(result.semantic_analysis.counts.native_dependency_relations, 0);
  assert(result.semantic_analysis.uncertainty.limitations.some(note => note.includes('without native dependency')));
});

test('backward and bidirectional UA edges receive only the native dependency IDs supporting their normalized direction', () => {
  const f = fixture();
  f.artifact.edges.push({ ...f.artifact.edges.find(row => row.id === 'cg-edge:12'), id: 'cg-edge:13', source: 'cg:1', target: 'cg:0' });
  f.quality.relation_evidence[1].basis = 'native_dependency'; f.quality.relation_evidence[1].native_ids = ['cg-edge:13'];
  f.quality.relation_evidence[2].basis = 'native_dependency'; f.quality.relation_evidence[2].native_ids = ['cg-edge:12', 'cg-edge:13'];
  const report = materializeCodeSemanticAnalysis(f.artifact, f.snapshot, f.quality, f.trustedPlan).semantic_analysis;
  assert.deepEqual(report.relation_evidence.find(row => row.edge_id === 'ua-edge:1').native_ids, ['cg-edge:13']);
  assert.deepEqual(report.relation_evidence.find(row => row.edge_id === 'ua-edge:2').native_ids, ['cg-edge:12']);
  assert.deepEqual(report.relation_evidence.find(row => row.edge_id === 'ua-edge:2:reverse').native_ids, ['cg-edge:13']);
});

test('persisted full reports cannot be tampered after materialization and legacy artifacts remain compatible', () => {
  const f = fixture(), result = materializeCodeSemanticAnalysis(f.artifact, f.snapshot, f.quality, f.trustedPlan);
  assert.deepEqual(validateCodeArtifact(f.artifact, f.snapshot), []);
  for (const mutate of [
    a => { a.semantic_analysis.counts.total_bytes++; },
    a => { a.semantic_analysis.node_evidence[0].node_id = 'ua:missing'; },
    a => { a.semantic_analysis.relation_evidence[0].evidence_ids = ['file-0']; },
    a => { a.semantic_analysis.relation_evidence.find(row => row.basis === 'native_dependency').native_ids = ['missing']; },
    a => { a.semantic_analysis.file_coverage[0].segments[1].byte_start++; },
    a => { a.semantic_analysis.source_content = 'not allowed'; },
  ]) { const candidate = structuredClone(result); mutate(candidate); assert(validateCodeArtifact(candidate, f.snapshot).length); }
});
