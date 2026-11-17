import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INTAKE_SKILL_VERSION, IntakeBundleSchema } from '@team-synergy/contracts';
import { bindProject } from '../dist/project-binding.js';
import { captureCodeSnapshot } from '../dist/code-understanding-snapshot.js';

const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const project = 'A'.repeat(20), repository = 'B'.repeat(20), runCode = 'C'.repeat(20), nextRun = 'D'.repeat(20);
const write = (root, relative, content) => { const file = path.join(root, relative); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, content); return file; };
function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
}
async function fixture(t, kind = 'commit') {
  const root = mkdtempSync(path.join(tmpdir(), 'tsp-intake-code-'));
  const live = path.join(root, 'repo'); mkdirSync(live);
  git(live, ['init']);
  write(live, 'src/access.ts', 'export function allow(role: string) {\n  return role === "admin";\n}\n');
  write(live, 'tests/access.test.ts', 'test("admin allowed", () => assert.equal(allow("admin"), true));\n');
  git(live, ['add', '.']); git(live, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']);
  if (kind === 'draft') write(live, 'src/access.ts', 'export function allow(role: string) {\n  return role === "owner";\n}\n');
  const runDirectory = path.join(root, '.agent', 'code-understanding', 'runs', runCode);
  const source = path.join(runDirectory, 'source');
  const snapshot = captureCodeSnapshot(live, source, { repositoryCode: repository, kind, scope: ['src', 'tests'] });
  const local = { schema_version: 1, project_code: project, repository_code: repository, run_code: runCode, revision: 4, snapshot, materials: {}, batch: { id: 'ua-overview', revision: 1, input_digest: snapshot.manifest_sha256, result_digest: 'a'.repeat(64) } };
  write(runDirectory, 'run.json', JSON.stringify(local));
  const { files, ...summary } = snapshot;
  const scope = { run_code: runCode, repository_code: repository, snapshot_id: snapshot.snapshot_id };
  const remote = { code: runCode, repository_code: repository, requested_ref: 'HEAD', kind, status: 'succeeded', revision: 4, plugins: [{ plugin_id: 'ua', engine_version: '2.9.8', adapter_version: '1.0.0', protocol_version: 1 }, { plugin_id: 'codegraph', engine_version: '1.6.2', adapter_version: '1.0.0', protocol_version: 1 }], snapshot: { ...summary, file_count: files.length }, artifact_sha256: 'b'.repeat(64), message: null, created_at: snapshot.captured_at, updated_at: snapshot.captured_at };
  const graph = { source: 'published_projection', runs: [remote], view: null, nodes: [{ ...scope, id: 'ua:flow:access', provider: 'ua', native_id: 'flow:access', kind: 'flow', label: 'Access', evidence_ids: ['proof'], verification: 'inferred' }], edges: [], evidence: [{ ...scope, id: 'proof', path: 'src/access.ts', sha256: files.find(file => file.path === 'src/access.ts').sha256, line_start: 2, line_end: 2 }], tour: [], coverage: [{ ...scope, provider: 'codegraph', analyzed_files: 2, total_files: 2, limitations: ['Static calls are navigation leads.'] }], total_nodes: 3, offset: 0, limit: 100, truncated: true, capabilities: ['projection'] };
  const calls = [], state = { graph, denied: false };
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    calls.push({ method: req.method, url: req.url, body: raw ? JSON.parse(raw) : null });
    res.setHeader('content-type', 'application/json');
    if (state.denied) { res.statusCode = 403; res.end(JSON.stringify({ ok: false, error: { code: 'project_forbidden', message: 'denied' } })); return; }
    const data = req.url.includes('/code-understanding/graph?') ? state.graph : req.url.endsWith('/context') ? { project_code: project, repositories: [{ code: repository, name: 'fixture' }], targets: [], bindings: [], skill_version: INTAKE_SKILL_VERSION } : { code: 'E'.repeat(20), status: 'draft' };
    res.end(JSON.stringify({ ok: true, data }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const api = `http://127.0.0.1:${server.address().port}`;
  bindProject(root, project, api);
  write(root, '.agent/repositories.local.yaml', `repositories:\n  - repository_code: "${repository}"\n    path: "repo"\n    remote_name: "origin"\n`);
  const invoke = async args => {
    const child = spawn(process.execPath, [cli, 'intake', ...args], { cwd: root, env: { ...process.env, ACP_API_URL: api, ACP_TOKEN: 'fixture-token', ACP_DEVICE_TOKEN: '', ACP_PRINCIPAL_CODE: '', AGENTCTL_HOME: path.join(root, 'auth') }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = ''; child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    const status = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    return { status, ...JSON.parse(stdout || assert.fail(stderr)) };
  };
  function fill(out = 'pack') {
    const file = path.join(root, out, 'intake.json');
    const bundle = JSON.parse(readFileSync(file, 'utf8'));
    const evidence = { ...bundle.source.files.find(file => file.path === 'src/access.ts'), line_start: 1, line_end: 3 };
    bundle.items = [{ key: 'access-module', kind: 'module', title: 'Access', summary: 'Observed role gate', content_markdown: 'Role gate observed in captured source; runtime was not tested.', evidence: [evidence], assessment: 'observed_in_code', tests: [], gaps: ['Runtime checks not executed.'] }];
    writeFileSync(file, JSON.stringify(bundle));
    return { bundle, file };
  }
  const prepare = (out = 'pack', args = []) => invoke(['prepare', '--code-run', runCode, '--out', out, ...args]);
  t.after(async () => { await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); });
  return { root, live, source, runDirectory, snapshot, local, state, calls, invoke, prepare, fill };
}

test('code-run prepares original snapshot evidence and rule handoff despite a different live HEAD', async t => {
  const f = await fixture(t);
  write(f.live, 'src/access.ts', 'export const replaced = true;\n');
  git(f.live, ['add', '.']); git(f.live, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'different HEAD']);
  write(f.live, 'tests/new.test.ts', 'untracked current file');
  const result = await f.prepare('pack', ['--code-query', '权限 & rules', '--code-node', 'ua:flow:access']);
  assert.equal(result.status, 0, JSON.stringify(result));
  assert.equal(result.data.source.commit, f.snapshot.commit);
  assert.notEqual(result.data.source.commit, git(f.live, ['rev-parse', 'HEAD']));
  assert.equal(result.data.source.dirty, false);
  assert.deepEqual(result.data.source.files.filter(file => !file.path.startsWith('materials/')).map(file => file.path), ['src/access.ts', 'tests/access.test.ts']);
  assert.equal(result.data.source.inputs[0].revision, `snapshot:${f.snapshot.snapshot_id}`);
  assert.equal(result.data.code_knowledge.local_source_reverified, true);
  assert.equal(result.data.code_knowledge.scope.truncated, true);
  const document = JSON.parse(readFileSync(path.join(f.root, 'pack', 'code-knowledge.json'), 'utf8'));
  assert.equal(document.version.repositories[0].artifact_sha256, 'b'.repeat(64));
  assert.equal(document.version.repositories[0].plugins.length, 2);
  assert.equal(document.verification.verified_snapshot_id, f.snapshot.snapshot_id);
  assert.ok(existsSync(path.join(f.root, 'pack', 'AGENT.md')));
  assert.ok(existsSync(path.join(f.root, 'pack', 'references', 'business-rules.md')));
  const { bundle, file } = f.fill();
  assert.equal(IntakeBundleSchema.safeParse(bundle).success, true);
  assert.equal((await f.invoke(['validate', file])).status, 0);
  assert.equal((await f.invoke(['submit', file, '--idempotency-key', 'snapshot-submit'])).status, 0);
  const graphCall = f.calls.find(call => call.url.includes('/code-understanding/graph?'));
  const params = new URL(graphCall.url, 'http://fixture').searchParams;
  assert.equal(params.get('run_code'), runCode); assert.equal(params.get('query'), '权限 & rules'); assert.equal(params.get('node_id'), 'ua:flow:access');
  assert.equal(JSON.stringify(bundle).includes(f.root), false, 'Machine roots stay in local mapping only');
  const posted = f.calls.find(call => call.method === 'POST');
  assert.deepEqual(posted.body.bundle, bundle);
  assert.ok(f.calls.filter(call => call !== posted).every(call => call.method === 'GET'), 'prepare never submits or applies');
});

test('snapshot identity, authorization, captured scope and explicit options fail before candidate creation', async t => {
  const f = await fixture(t), original = structuredClone(f.state.graph);
  for (const mutate of [graph => { graph.runs[0].snapshot.manifest_sha256 = 'f'.repeat(64); }, graph => { graph.runs[0].repository_code = 'Z'.repeat(20); }, graph => { graph.runs[0].status = 'awaiting_agent'; }, graph => { graph.nodes[0].snapshot_id = 'e'.repeat(64); }]) {
    f.state.graph = structuredClone(original); mutate(f.state.graph);
    const result = await f.prepare(); assert.equal(result.ok, false); assert.equal(existsSync(path.join(f.root, 'pack')), false);
  }
  f.state.graph = original;
  assert.equal((await f.prepare('repo-mismatch', ['--repository', 'Z'.repeat(20)])).error.code, 'intake_repository_mismatch');
  assert.equal((await f.prepare('bad-scope', ['--scope', '.'])).error.code, 'intake_scope_invalid');
  assert.equal((await f.prepare('untracked', ['--include-untracked'])).error.code, 'intake_scope_invalid');
  assert.equal((await f.invoke(['prepare', '--code-query', 'rules', '--out', 'no-run'])).error.code, 'intake_code_run_required');
  f.state.denied = true; assert.equal((await f.prepare()).error.code, 'project_forbidden');
  assert.equal(existsSync(path.join(f.root, 'pack')), false);
});

test('fixed code and generated knowledge drift are rejected before validate/submit/replace network calls', async t => {
  const f = await fixture(t); assert.equal((await f.prepare()).status, 0);
  const { file } = f.fill(), previous = f.calls.length;
  const original = readFileSync(path.join(f.source, 'src/access.ts'));
  write(f.source, 'src/access.ts', 'changed snapshot');
  for (const args of [['validate', file], ['submit', file, '--idempotency-key', 'snapshot-submit'], ['replace', 'E'.repeat(20), file, '--base-revision', '1']]) assert.equal((await f.invoke(args)).error.code, 'code_snapshot_changed');
  assert.equal(f.calls.length, previous);
  write(f.source, 'src/access.ts', original);
  write(f.root, 'pack/code-knowledge.json', '{"modified":true}\n');
  assert.equal((await f.invoke(['submit', file, '--idempotency-key', 'snapshot-submit'])).error.code, 'intake_source_changed');
  assert.equal(f.calls.length, previous);
});

test('snapshot mapping cannot redirect to another root or silently fall back to the live checkout', async t => {
  const f = await fixture(t); assert.equal((await f.prepare()).status, 0);
  const { file } = f.fill(); const mapPath = path.join(f.root, 'pack', 'intake.sources.local.json');
  const mapping = JSON.parse(readFileSync(mapPath, 'utf8'));
  mapping.code_snapshot.root = f.live; writeFileSync(mapPath, JSON.stringify(mapping));
  assert.equal((await f.invoke(['validate', file])).error.code, 'intake_code_run_mismatch');
  delete mapping.code_snapshot; writeFileSync(mapPath, JSON.stringify(mapping));
  assert.equal((await f.invoke(['validate', file])).error.code, 'intake_source_changed');
});

test('snapshot additions and directory links are rejected; captured scopes can be narrowed', async t => {
  const f = await fixture(t);
  assert.equal((await f.prepare('narrow', ['--scope', 'src'])).status, 0);
  const { bundle, file } = f.fill('narrow');
  assert.deepEqual(bundle.source.files.filter(file => !file.path.startsWith('materials/')).map(file => file.path), ['src/access.ts']);
  write(f.source, 'extra.ts', 'export const extra = true;');
  assert.equal((await f.invoke(['validate', file])).error.code, 'code_snapshot_changed');
  rmSync(path.join(f.source, 'extra.ts'));
  symlinkSync(f.live, path.join(f.source, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await f.invoke(['validate', file])).error.code, 'intake_symlink');
});

test('draft snapshot state stays explicit and namespace remains stable across analysis runs', async t => {
  const f = await fixture(t, 'draft');
  const first = await f.prepare(); assert.equal(first.status, 0); assert.equal(first.data.source.dirty, true);
  const secondDir = path.join(f.root, '.agent', 'code-understanding', 'runs', nextRun);
  const secondSnapshot = captureCodeSnapshot(f.live, path.join(secondDir, 'source'), { repositoryCode: repository, kind: 'draft', scope: ['src', 'tests'] });
  write(secondDir, 'run.json', JSON.stringify({ ...f.local, run_code: nextRun, snapshot: secondSnapshot }));
  const graph = f.state.graph; graph.runs[0].code = nextRun;
  graph.runs[0].snapshot = { ...secondSnapshot, file_count: secondSnapshot.files.length }; delete graph.runs[0].snapshot.files;
  for (const item of [...graph.nodes, ...graph.evidence, ...graph.coverage]) { item.run_code = nextRun; item.snapshot_id = secondSnapshot.snapshot_id; }
  const second = await f.invoke(['prepare', '--code-run', nextRun, '--out', 'next-pack']);
  assert.equal(second.status, 0, JSON.stringify(second));
  assert.equal(second.data.namespace, first.data.namespace);
  assert.equal(second.data.code_knowledge.source_key, first.data.code_knowledge.source_key);
  assert.ok(f.calls.every(call => call.method === 'GET'));
});
