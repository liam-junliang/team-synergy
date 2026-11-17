import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodeArtifactSchema, CodeDomainMetaSchema, CodeSnapshotSchema, CodeGraphQuerySchema, CodeRunRegisterSchema, CodeUaGraphSchema, validateCodeArtifact, isCodePublicationSensitiveText } from '../dist/code-understanding.js';

const hash = 'a'.repeat(64), file = { path: 'src/auth.ts', sha256: hash, byte_count: 500, line_count: 100 };
const snapshot = { snapshot_id: hash, kind: 'commit', commit: 'b'.repeat(40), tree: 'c'.repeat(40), manifest_sha256: hash, captured_at: '2026-10-27T00:00:00Z', scope: ['src'], exclusions: [], files: [file] };
const node = { id: 'ua:auth', native_id: 'auth', provider: 'ua', kind: 'module', label: 'Auth', evidence_ids: ['e'], verification: 'inferred' };
const artifact = { schema_version: 1, snapshot_id: hash, nodes: [node], edges: [], evidence: [{ id: 'e', path: file.path, sha256: hash, line_start: 2, line_end: 4 }], tour: [], coverage: ['ua', 'codegraph'].map(provider => ({ provider, analyzed_files: 1, total_files: 1, limitations: [] })), semantic_author: { kind: 'agent', model: null, prompt_version: '1' } };

test('optional purposes and open questions preserve strict bounded metadata and legacy artifacts', () => {
  const metadata = { userPurposes: ['帮助成员理解任务背景'], unknowns: ['服务端并发行为尚未执行验证'] };
  assert.deepEqual(CodeDomainMetaSchema.parse(metadata), metadata);
  assert(CodeDomainMetaSchema.safeParse({}).success);
  assert(CodeArtifactSchema.safeParse(artifact).success);
  for (const field of ['userPurposes', 'unknowns']) {
    assert(CodeDomainMetaSchema.safeParse({ [field]: Array(100).fill('x'.repeat(4000)) }).success);
    assert.equal(CodeDomainMetaSchema.safeParse({ [field]: Array(101).fill('x') }).success, false);
    assert.equal(CodeDomainMetaSchema.safeParse({ [field]: ['x'.repeat(4001)] }).success, false);
    assert.equal(CodeDomainMetaSchema.safeParse({ [field]: [7] }).success, false);
  }
  assert.equal(CodeDomainMetaSchema.safeParse({ ...metadata, unreviewedNotes: ['raw'] }).success, false);
});

test('strict code projections reject raw extras, local paths, unknown providers and unbounded query inputs', () => {
  assert(CodeSnapshotSchema.safeParse(snapshot).success); assert(CodeArtifactSchema.safeParse(artifact).success);
  for (const path of ['C:/source.ts', '../secret', '.env', '/tmp/code.ts', 'node_modules/a.ts']) assert.equal(CodeSnapshotSchema.safeParse({ ...snapshot, files: [{ ...file, path }] }).success, false);
  for (const extra of [{ raw: {} }, { source_content: 'secret' }, { repository_root: 'C:/src' }]) assert.equal(CodeArtifactSchema.safeParse({ ...artifact, ...extra }).success, false);
  assert.equal(CodeArtifactSchema.safeParse({ ...artifact, nodes: [{ ...node, docstring: 'raw' }] }).success, false);
  for (const query of [{ limit: 201 }, { offset: -1 }, { sql: 'select *' }, { direction: 'all' }]) assert.equal(CodeGraphQuerySchema.safeParse(query).success, false);
});

test('graph validation checks coverage, evidence, duplicate identities and dangling edges', () => {
  assert.deepEqual(validateCodeArtifact(artifact, snapshot), []);
  assert(validateCodeArtifact({ ...artifact, nodes: [node, node] }, snapshot).length);
  assert(validateCodeArtifact({ ...artifact, coverage: [artifact.coverage[0]] }, snapshot).length);
  assert(validateCodeArtifact({ ...artifact, evidence: [{ ...artifact.evidence[0], line_end: 101 }] }, snapshot).length);
  assert(validateCodeArtifact({ ...artifact, edges: [{ id: 'x', source: node.id, target: 'missing', type: 'calls', provider: 'bridge', provenance: 'agent', evidence_ids: [], verification: 'inferred' }] }, snapshot).length);
  assert(validateCodeArtifact({ ...artifact, evidence: [{ ...artifact.evidence[0], line_start: 1, line_end: 100, snippet: 'full source' }] }, snapshot).length);
});

test('optional semantic provenance preserves cache routes without allowing a live model identity substitution', () => {
  assert(CodeArtifactSchema.safeParse({ ...artifact, semantic_author: { ...artifact.semantic_author, model: '' } }).success);
  const current = 'workbuddy-ai/deepseek-v4.1-flash-sg', previous = 'workbuddy/deepseek-v4.1-flash';
  const value = structuredClone(artifact);
  value.semantic_author = { kind: 'agent', model: current, prompt_version: '1', provenance: { requested_model: current, mixed_origins: true, origins: [
    { kind: 'cache', requested_model: previous, response_model: 'deepseek-v4.1-flash', uses: 228 },
    { kind: 'live', requested_model: current, response_model: current, uses: 89 },
  ] } };
  assert.deepEqual(validateCodeArtifact(value, snapshot), []);
  const original = value.semantic_author.provenance.origins[0];
  assert.equal(CodeArtifactSchema.parse(value).semantic_author.provenance.origins[0].response_model, original.response_model);
  for (const mutate of [
    candidate => { candidate.semantic_author.model = previous; },
    candidate => { candidate.semantic_author.provenance.mixed_origins = false; },
    candidate => { candidate.semantic_author.provenance.origins[0].kind = 'live'; },
    candidate => { candidate.semantic_author.provenance.origins[0].response_model = current; },
    candidate => { candidate.semantic_author.provenance.origins[0].uses = 0; },
    candidate => { candidate.semantic_author.provenance.origins.push({ ...original }); },
    candidate => { candidate.semantic_author.provenance.origins[0].raw_response = 'not public'; },
  ]) { const candidate = structuredClone(value); mutate(candidate); assert.equal(CodeArtifactSchema.safeParse(candidate).success, false); }
  const aliases = structuredClone(value);
  aliases.semantic_author.provenance.origins = [
    { kind: 'cache', requested_model: current, response_model: 'deepseek-v4.1-flash-sg', uses: 1 },
    { kind: 'live', requested_model: current, response_model: current, uses: 1 },
  ];
  aliases.semantic_author.provenance.mixed_origins = false;
  assert(CodeArtifactSchema.safeParse(aliases).success);
  const sensitive = structuredClone(value);
  sensitive.semantic_author.provenance.origins[0].response_model = sensitive.semantic_author.provenance.origins[0].requested_model = 'C:/Users/private/model';
  assert(validateCodeArtifact(sensitive, snapshot).includes('Publication contains a local absolute path or known credential pattern'));
});

test('registration requires both pinned engine descriptors', () => {
  const plugin = { plugin_id: 'ua', engine_version: '2.9.8', adapter_version: '1', protocol_version: 1 };
  const request = { idempotency_key: 'run1', repository_code: '00000000000000000001', requested_ref: 'HEAD', kind: 'commit', plugins: [plugin, { ...plugin, plugin_id: 'codegraph' }] };
  assert(CodeRunRegisterSchema.safeParse(request).success);
  assert.equal(CodeRunRegisterSchema.safeParse({ ...request, plugins: [plugin, plugin] }).success, false);
});

test('sensitive text is rejected even when hidden inside allowed semantic or native ID fields', () => {
  for (const text of ['C:\\Users\\private\\repo', 'F:/workspace/private', '\\\\server\\share\\code', '/home/alice/code', 'file:/Users/alice/code', 'Read /workspace/private', '-----BEGIN PRIVATE KEY-----', 'ghp_' + 'A'.repeat(30), 'Bearer ' + 'a'.repeat(32), 'password = "super-secret-value"', 'postgres://user:private-password@localhost/db']) {
    assert(isCodePublicationSensitiveText(text), text);
    for (const field of ['summary', 'native_id', 'label']) assert(validateCodeArtifact({ ...artifact, nodes: [{ ...node, [field]: text }] }, snapshot).includes('Publication contains a local absolute path or known credential pattern'));
    assert(validateCodeArtifact({ ...artifact, tour: [{ title: 'Intro', description: text, node_ids: [node.id] }] }, snapshot).length);
  }
  for (const text of ['src/auth.ts', 'Call auth/login and read /api/users', 'https://example.test/home/alice', 'Use password validation', 'module:auth']) assert.equal(isCodePublicationSensitiveText(text), false, text);
});

test('native UA graph validates directed edge parity and matching source evidence without accepting arbitrary metadata', () => {
  const value = structuredClone(artifact);
  value.nodes[0] = { ...node, kind: 'function', path: file.path, line_start: 2, line_end: 4, summary: 'Checks access' };
  value.nodes.push({ ...node, id: 'ua:module', native_id: 'module', kind: 'module', label: 'Module' });
  value.edges = [
    { id: 'reverse', source: 'ua:module', target: 'ua:auth', type: 'calls', provider: 'ua', provenance: 'agent', evidence_ids: [], verification: 'inferred' },
    { id: 'both-a', source: 'ua:auth', target: 'ua:module', type: 'related', provider: 'ua', provenance: 'agent', evidence_ids: [], verification: 'inferred' },
    { id: 'both-b', source: 'ua:module', target: 'ua:auth', type: 'related', provider: 'ua', provenance: 'agent', evidence_ids: [], verification: 'inferred' },
  ];
  value.ua_graph = { version: '1', project: { name: 'Example', languages: ['TypeScript'], frameworks: [], description: '', analyzedAt: snapshot.captured_at, gitCommitHash: snapshot.commit },
    nodes: [{ id: 'auth', type: 'function', name: 'Auth', summary: 'Checks access', filePath: file.path, lineRange: [2, 4], tags: [], complexity: 'simple' },
      { id: 'module', type: 'module', name: 'Module', summary: '', tags: [], complexity: 'moderate' }],
    edges: [{ source: 'auth', target: 'module', type: 'calls', direction: 'backward', weight: 0.5 }, { source: 'auth', target: 'module', type: 'related', direction: 'bidirectional', weight: 0.7 }], layers: [], tour: [] };
  assert(CodeUaGraphSchema.safeParse(value.ua_graph).success); assert.deepEqual(validateCodeArtifact(value, snapshot), []);
  const missingDirection = structuredClone(value); missingDirection.edges.pop(); assert(validateCodeArtifact(missingDirection, snapshot).includes('UA metadata edges do not match projection'));
  const range = structuredClone(value); range.ua_graph.nodes[0].lineRange = [3, 4]; assert(validateCodeArtifact(range, snapshot).length);
  const evidenceMismatch = structuredClone(value); evidenceMismatch.evidence[0].line_start = 1; assert(validateCodeArtifact(evidenceMismatch, snapshot).includes('UA metadata source lacks matching evidence'));
  for (const extra of [{ knowledgeMeta: { content: 'raw body' } }, { content: 'raw source' }, { figmaMeta: { thumbnailUrl: 'https://example.invalid/image' } }]) assert.equal(CodeUaGraphSchema.safeParse({ ...value.ua_graph, nodes: [{ ...value.ua_graph.nodes[0], ...extra }] }).success, false);
  assert.equal(CodeUaGraphSchema.safeParse({ ...value.ua_graph, nodes: [{ ...value.ua_graph.nodes[0], tags: ['a'.repeat(101)] }] }).success, false);
});

test('optional full semantic reports enforce complete byte identities without asserting correctness', () => {
  const value = structuredClone(artifact);
  const domainMeta = { businessRules: ['Refunds require review'], userPurposes: ['Inspect a refund decision'], unknowns: ['Runtime results remain unknown'] };
  value.nodes[0] = { ...node, kind: 'file', path: file.path, summary: '', domain_meta: structuredClone(domainMeta) };
  value.evidence[0] = { ...value.evidence[0], line_start: 1, line_end: 100 };
  value.ua_graph = { version: '1.0.0', project: { name: 'Example', languages: [], frameworks: [], description: '', analyzedAt: snapshot.captured_at, gitCommitHash: snapshot.commit }, nodes: [{ id: 'auth', type: 'file', name: 'Auth', filePath: file.path, summary: '', tags: [], complexity: 'simple', domainMeta: structuredClone(domainMeta) }], edges: [], layers: [], tour: [] };
  value.semantic_analysis = {
    protocol_version: 2, mode: 'full', snapshot_id: snapshot.snapshot_id, manifest_sha256: snapshot.manifest_sha256, prompt_version: 'full-2',
    file_coverage: [{ path: file.path, sha256: file.sha256, total_bytes: 500, covered_bytes: 500, segments: [{ id: `segment:${'1'.repeat(32)}`, byte_start: 0, byte_end: 500, input_sha256: '1'.repeat(64), completed: true, line_start: 1, line_end: 100 }] }],
    node_evidence: [{ node_id: node.id, evidence_ids: ['e'] }], relation_evidence: [],
    counts: { total_files: 1, total_bytes: 500, covered_bytes: 500, total_segments: 1, completed_segments: 1, supported_nodes: 1, supported_relations: 0, native_dependency_relations: 0, semantic_inference_relations: 0, unresolved_items: 0 },
    uncertainty: { semantic_correctness: 'requires_independent_evaluation', unresolved_items: 0, limitations: ['Input coverage is not semantic correctness'] },
  };
  assert(CodeArtifactSchema.safeParse(value).success); assert.deepEqual(validateCodeArtifact(value, snapshot), []);
  for (const mutate of [
    candidate => { candidate.semantic_analysis.file_coverage[0].sha256 = '0'.repeat(64); },
    candidate => { candidate.semantic_analysis.file_coverage[0].segments[0].byte_start = 1; },
    candidate => { candidate.semantic_analysis.counts.total_segments++; },
    candidate => { candidate.semantic_analysis.node_evidence[0].evidence_ids = ['missing']; },
    candidate => { candidate.semantic_analysis.uncertainty.semantic_correctness = 'certified'; },
    candidate => { candidate.semantic_analysis.source_content = 'arbitrary source'; },
    candidate => { candidate.nodes[0].domain_meta.businessRules = ['Another claim']; },
    candidate => { candidate.nodes[0].domain_meta.userPurposes = ['An unrelated purpose']; },
    candidate => { candidate.nodes[0].domain_meta.unknowns = []; },
  ]) { const candidate = structuredClone(value); mutate(candidate); assert(validateCodeArtifact(candidate, snapshot).length); }
  const legacy = structuredClone(value); delete legacy.semantic_analysis; delete legacy.nodes[0].domain_meta;
  assert.deepEqual(validateCodeArtifact(legacy, snapshot), []);
});
