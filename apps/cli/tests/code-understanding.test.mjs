import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { captureCodeSnapshot, verifyCodeSnapshot } from '../dist/code-understanding-snapshot.js';
import { acceptCodeCheckpoint, loadCodeRun, queryLocalCodeArtifact, registerCodeUnderstandingCommands } from '../dist/code-understanding.js';
import { exportCodeRequirementsContext } from '../dist/code-understanding-context.js';

const project = 'A'.repeat(20), repository = 'B'.repeat(20), run = 'C'.repeat(20);

test('local projection only returns bounded tour context associated with the selected node page', () => {
  const artifact = { snapshot_id: 'snapshot', nodes: [{ id: 'selected', provider: 'ua', label: 'selected', evidence_ids: [] }],
    edges: [], evidence: [], coverage: [], tour: [
      { title: 'unrelated', description: 'x'.repeat(4000), node_ids: ['different'] },
      ...Array.from({ length: 40 }, (_, n) => ({ title: String(n), description: 'x'.repeat(4000), node_ids: ['selected'] })),
    ] };
  const page = queryLocalCodeArtifact(artifact, { limit: '1' }, { run_code: run, repository_code: repository });
  assert.equal(page.nodes.length, 1);
  assert.equal(page.tour.length, 1);
  assert.equal(page.tour_truncated, true);
  assert.equal(page.tour_scope, 'selected_nodes');
  assert.ok(JSON.stringify(page).length < 10000);
  assert.equal(queryLocalCodeArtifact(artifact, { query: 'absent', limit: '1' }, { run_code: run, repository_code: repository }).tour.length, 0);
});
function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
}
function fixture(t) {
  const workspace = mkdtempSync(path.join(tmpdir(), 'tsp-code-understanding-'));
  const root = path.join(workspace, 'repo'); mkdirSync(root);
  git(root, ['init']);
  writeFileSync(path.join(root, 'service.ts'), 'export function allow() {\n  return true;\n}\n');
  writeFileSync(path.join(root, '.env'), 'SECRET=hidden');
  writeFileSync(path.join(root, 'secret.txt'), '-----BEGIN PRIVATE KEY-----\nsecret');
  git(root, ['add', '.']); git(root, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture']);
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  return { workspace, root };
}
test('commit capture reads Git blobs while explicit draft captures working changes and opts into untracked files', t => {
  const { workspace, root } = fixture(t);
  writeFileSync(path.join(root, 'service.ts'), 'export const dirty = true;\n');
  writeFileSync(path.join(root, 'new.ts'), 'export const added = true;\n');
  const committed = captureCodeSnapshot(root, path.join(workspace, 'committed'), { repositoryCode: repository, kind: 'commit' });
  assert.match(readFileSync(path.join(workspace, 'committed', 'service.ts'), 'utf8'), /function allow/);
  assert.deepEqual(committed.files.map(f => f.path), ['service.ts']);
  const repeat = captureCodeSnapshot(root, path.join(workspace, 'repeat'), { repositoryCode: repository, kind: 'commit' });
  assert.equal(repeat.snapshot_id, committed.snapshot_id);
  const draft = captureCodeSnapshot(root, path.join(workspace, 'draft'), { repositoryCode: repository, kind: 'draft' });
  assert.match(readFileSync(path.join(workspace, 'draft', 'service.ts'), 'utf8'), /dirty/);
  assert.notEqual(draft.snapshot_id, committed.snapshot_id);
  const untracked = captureCodeSnapshot(root, path.join(workspace, 'untracked'), { repositoryCode: repository, kind: 'draft', includeUntracked: true });
  assert.deepEqual(untracked.files.map(f => f.path), ['new.ts', 'service.ts']);
  verifyCodeSnapshot(path.join(workspace, 'committed'), committed);
  writeFileSync(path.join(workspace, 'committed', 'service.ts'), 'modified');
  assert.throws(() => verifyCodeSnapshot(path.join(workspace, 'committed'), committed), { code: 'code_snapshot_changed' });
});
test('capture rejects unsafe scopes, implicit untracked commit and output junctions', t => {
  const { workspace, root } = fixture(t);
  assert.throws(() => captureCodeSnapshot(root, path.join(workspace, 'unsafe'), { repositoryCode: repository, kind: 'commit', scope: ['../outside'] }));
  assert.throws(() => captureCodeSnapshot(root, path.join(workspace, 'implicit'), { repositoryCode: repository, kind: 'commit', includeUntracked: true }), { code: 'code_snapshot_options' });
  const outside = path.join(workspace, 'outside'); mkdirSync(outside);
  const link = path.join(workspace, 'linked'); symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => captureCodeSnapshot(root, path.join(link, 'capture'), { repositoryCode: repository, kind: 'commit' }), { code: 'intake_symlink' });
});
for (const kind of ['commit', 'draft']) test(`${kind} capture excludes repository-supplied engine configuration and reserved directories`, t => {
  const { workspace, root } = fixture(t);
  for (const directory of ['.codegraph', '.ua', '.understand-anything']) {
    mkdirSync(path.join(root, directory));
    writeFileSync(path.join(root, directory, 'config.json'), '{"plugins":["unsafe"]}');
  }
  writeFileSync(path.join(root, 'codegraph.json'), '{"exclude": ["**"]}');
  git(root, ['add', '.']); git(root, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'engine-config']);
  const destination = path.join(workspace, 'captured');
  const snapshot = captureCodeSnapshot(root, destination, { repositoryCode: repository, kind });
  assert.deepEqual(snapshot.files.map(f => f.path), ['service.ts']);
  assert.match(snapshot.exclusions.join('\n'), /repository configuration cannot control/);
  verifyCodeSnapshot(destination, snapshot);
  writeFileSync(path.join(destination, 'codegraph.json'), '{}');
  assert.throws(() => verifyCodeSnapshot(destination, snapshot), { code: 'code_snapshot_changed' });
});
test('durable checkpoint validates identity and optimistic revision, detects altered records on reload', t => {
  const { workspace, root } = fixture(t);
  const directory = path.join(workspace, '.agent', 'code-understanding', 'runs', run);
  const snapshot = captureCodeSnapshot(root, path.join(directory, 'source'), { repositoryCode: repository, kind: 'commit' });
  const local = { schema_version: 1, project_code: project, repository_code: repository, run_code: run, revision: 2, snapshot, materials: {}, batch: { id: 'ua-overview', revision: 0, input_digest: snapshot.manifest_sha256, result_digest: null } };
  const input = path.join(workspace, 'result.json');
  writeFileSync(input, JSON.stringify({ snapshot_id: snapshot.snapshot_id, batch_id: 'ua-overview', input_digest: snapshot.manifest_sha256, graph: { nodes: [{ id: 'module' }], edges: [] } }));
  const accepted = acceptCodeCheckpoint(directory, local, input, 0);
  assert.equal(accepted.batch.revision, 1);
  assert.equal(loadCodeRun(workspace, run).local.batch.result_digest, accepted.batch.result_digest);
  assert.throws(() => acceptCodeCheckpoint(directory, accepted, input, 0), { code: 'code_checkpoint_conflict' });
  const wrong = JSON.parse(readFileSync(input, 'utf8')); wrong.snapshot_id = '0'.repeat(64); writeFileSync(input, JSON.stringify(wrong));
  assert.throws(() => acceptCodeCheckpoint(directory, accepted, input, 1), { code: 'code_checkpoint_invalid' });
});
test('local projection follows UA/codegraph bridges with direction, filters and explicit pagination', () => {
  const artifact = { snapshot_id: 'a'.repeat(64), nodes: [{ id: 'ua:module', provider: 'ua', label: 'Authentication', evidence_ids: ['proof'] }, { id: 'cg:function', provider: 'codegraph', label: 'allow', evidence_ids: ['proof'] }, { id: 'cg:caller', provider: 'codegraph', label: 'caller', evidence_ids: [] }], edges: [{ id: 'bridge', source: 'ua:module', target: 'cg:function', evidence_ids: ['proof'] }, { id: 'call', source: 'cg:caller', target: 'cg:function', evidence_ids: [] }], evidence: [{ id: 'proof' }], tour: [], coverage: [] };
  const result = queryLocalCodeArtifact(artifact, { node: 'cg:function', direction: 'in' }, { run_code: run, repository_code: repository });
  assert.equal(result.nodes.length, 3); assert.equal(result.edges.length, 2); assert.equal(result.evidence.length, 1);
  assert.equal(queryLocalCodeArtifact(artifact, { query: 'authentication' }, { run_code: run, repository_code: repository }).nodes[0].id, 'ua:module');
  assert.equal(queryLocalCodeArtifact(artifact, { limit: '1' }, { run_code: run, repository_code: repository }).truncated, true);
  assert.throws(() => queryLocalCodeArtifact(artifact, { limit: '201' }, { run_code: run, repository_code: repository }), { code: 'code_limit_invalid' });
});
test('remote projection and explicit view selection use shared project API; native remote query is rejected', async () => {
  const calls = [], results = [];
  const invoke = async args => {
    const program = new Command();
    registerCodeUnderstandingCommands(program, { requireApiClient: () => ({ request: async (method, route, body) => { calls.push({ method, route, body }); return { ok: true, data: { accepted: true } }; } }), resolveProjectCode: async () => project, printResult: result => results.push(result), failResult: error => ({ ok: false, error: { code: error.code, message: error.message } }) });
    await program.parseAsync(args, { from: 'user' });
  };
  await invoke(['code', 'overview', '--remote', '--run', run, '--engine', 'ua']);
  assert.match(calls[0].route, new RegExp(`/projects/${project}/code-understanding/graph\\?`));
  assert.match(calls[0].route, /provider=ua/);
  await invoke(['code', 'view', 'select', '--view', run, '--expected-current', 'empty']);
  assert.deepEqual(calls[1].body, { expected_current: null });
  await invoke(['code', 'context', '--remote', '--run', run]);
  assert.equal(results.at(-1).error.code, 'unsupported_capability');
  assert.equal(calls.length, 2); process.exitCode = 0;
});
test('hosted analysis requests and job queries need only project identity and send no local workspace data', async () => {
  const calls = [], results = [], projects = [];
  const invoke = async args => {
    const program = new Command();
    registerCodeUnderstandingCommands(program, { requireApiClient: () => ({ request: async (method, route, body) => {
      calls.push({ method, route, body }); return { ok: true, data: method === 'POST' ? [{ job_code: run, status: 'queued' }] : [] };
    } }), resolveProjectCode: async explicit => { projects.push(explicit); return explicit ?? project; }, printResult: row => results.push(row), failResult: error => ({ ok: false, error: { code: error.code, message: error.message } }) });
    await program.parseAsync(args, { from: 'user' });
  };
  await invoke(['code', 'analyze', 'remote', '--project', project, '--repository', repository, '--idempotency-key', 'hosted-fixture']);
  assert.deepEqual(calls[0], { method: 'POST', route: `/projects/${project}/code-understanding/analyses`, body: { idempotency_key: 'hosted-fixture', repository_codes: [repository] } });
  await invoke(['code', 'analyze', 'remote-status', '--project', project, '--job', run]);
  assert.equal(calls[1].route, `/projects/${project}/code-understanding/analyses/${run}`);
  await invoke(['code', 'analyze', 'remote-list', '--project', project]);
  assert.equal(calls[2].route, `/projects/${project}/code-understanding/analyses`);
  await invoke(['code', 'analyze', 'remote', '--project', project]);
  assert.deepEqual(Object.keys(calls[3].body), ['idempotency_key']);
  assert.match(calls[3].body.idempotency_key, /^[a-f0-9-]{36}$/);
  assert.ok(projects.every(code => code === project));
  assert.ok(results.every(row => row.ok));
  assert.doesNotMatch(JSON.stringify(calls), /workspace|cwd|sourceDirectory|[A-Z]:\\/);
  await invoke(['code', 'analyze', 'remote', '--project', project, '--repository', '../local']);
  assert.equal(calls.length, 4, 'invalid repository input must fail before requesting a server mutation');
  assert.equal(results.at(-1).ok, false);
  process.exitCode = 0;
});
test('requirements context exports fixed scoped evidence as a document with a stable cross-version source key', t => {
  const { workspace, root } = fixture(t);
  const snapshot = captureCodeSnapshot(root, path.join(workspace, 'snapshot'), { repositoryCode: repository, kind: 'commit' });
  const summary = { code: run, repository_code: repository, status: 'succeeded', kind: 'commit', snapshot, artifact_sha256: 'a'.repeat(64), plugins: [] };
  const graph = { source: 'published_projection', runs: [summary], view: null, nodes: [{ id: 'ua:auth', repository_code: repository, run_code: run, snapshot_id: snapshot.snapshot_id }], edges: [], evidence: [{ id: 'proof', path: 'service.ts', line_start: 1, line_end: 2, repository_code: repository, run_code: run, snapshot_id: snapshot.snapshot_id }], tour: [], coverage: [], offset: 0, limit: 100, total_nodes: 500, truncated: true };
  const first = exportCodeRequirementsContext(project, graph, path.join(workspace, 'context1'));
  const document = JSON.parse(readFileSync(first.material_path, 'utf8'));
  assert.equal(document.verification.local_source_reverified, false);
  assert.equal(document.version.repositories[0].run_code, run);
  assert.equal(document.evidence[0].snapshot_id, snapshot.snapshot_id);
  assert.equal(document.scope.truncated, true);
  assert.match(readFileSync(first.instructions_path, 'utf8'), /只复验 knowledge.json 文档字节/);
  assert.match(first.example, /--material/);
  const secondRun = 'D'.repeat(20);
  const second = exportCodeRequirementsContext(project, { ...graph, runs: [{ ...summary, code: secondRun, artifact_sha256: 'b'.repeat(64) }], nodes: graph.nodes.map(node => ({ ...node, run_code: secondRun })), evidence: graph.evidence.map(item => ({ ...item, run_code: secondRun })) }, path.join(workspace, 'context2'));
  assert.equal(first.source_key, second.source_key);
  assert.notEqual(first.document_sha256, second.document_sha256);
  assert.throws(() => exportCodeRequirementsContext(project, graph, path.join(workspace, 'context1')), { code: 'code_context_output_exists' });
  assert.throws(() => exportCodeRequirementsContext(project, { ...graph, runs: [{ ...summary, status: 'awaiting_agent' }] }, path.join(workspace, 'incomplete')), { code: 'code_context_unpublished' });
  assert.throws(() => exportCodeRequirementsContext(project, { ...graph, nodes: [{ ...graph.nodes[0], run_code: secondRun }] }, path.join(workspace, 'mismatch')), { code: 'code_context_scope_mismatch' });
});
