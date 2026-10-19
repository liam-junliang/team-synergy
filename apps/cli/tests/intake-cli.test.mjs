import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { bindProject } from '../dist/project-binding.js';
import { intakeManifestText } from '@team-synergy/contracts';
import { sha256, normalizeIntakeScopes, scanIntakeSource } from '../dist/intake-source.js';

const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const projectCode = 'A'.repeat(20);
const repositoryCode = 'B'.repeat(20);
const batchCode = 'C'.repeat(20);
const otherProject = 'D'.repeat(20);
const planHash = 'a'.repeat(64);
function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
function write(root, relative, content) {
  const file = path.join(root, relative); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, content); return file;
}
async function setup(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'tsp-intake-'));
  const source = path.join(root, 'code'); mkdirSync(source);
  git(source, ['init']);
  write(source, 'src/service.ts', 'export function allow(role: string) {\n  return role === "admin";\n}\n');
  write(source, 'tests/service.test.ts', 'test("admin is allowed", () => assert.equal(allow("admin"), true));\n');
  write(source, '.env', 'API_TOKEN=do-not-read');
  write(source, '.npmrc', '//registry.npmjs.org/:_authToken=do-not-read');
  write(source, 'config/credentials.json', '{"password":"do-not-read"}');
  write(source, 'src/key.txt', '-----BEGIN PRIVATE KEY-----\nnot-real-test-key\n');
  write(source, 'node_modules/fixture/index.ts', 'export const dependency = true;');
  write(source, 'dist/index.js', 'compiled output');
  write(source, 'image.png', Buffer.from([0, 1, 2]));
  write(source, 'src/binary.ts', Buffer.from([0, 1, 2]));
  write(source, 'src/oversized.ts', 'x'.repeat(2 * 1024 * 1024 + 1));
  git(source, ['add', '--all']);
  git(source, ['-c', 'user.name=Intake Test', '-c', 'user.email=intake@example.invalid', 'commit', '-m', 'Fixture']);
  write(source, 'src/untracked.ts', 'not included in the first version');
  const calls = []; const state = { skill_version: '1.0.0', denied: false, creates: new Map(), apply: new Map() };
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    calls.push({ method: req.method, url: req.url, body, authorization: req.headers.authorization });
    const send = data => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, data })); };
    const fail = (status, code) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: false, error: { code, message: code } })); };
    if (state.denied) return fail(403, 'project_forbidden');
    if (req.url.endsWith('/context')) return send({ project_code: projectCode, repositories: [{ code: repositoryCode, name: 'fixture' }], targets: [], bindings: [], skill_version: state.skill_version });
    if (req.url.endsWith('/apply')) {
      if (!state.apply.has(body.idempotency_key)) state.apply.set(body.idempotency_key, body);
      return send({ code: batchCode, status: 'applied', plan_hash: planHash });
    }
    if (req.method === 'POST' && req.url === `/projects/${projectCode}/intake`) {
      const previous = state.creates.get(body.idempotency_key);
      if (previous && JSON.stringify(previous) !== JSON.stringify(body.bundle)) return fail(409, 'intake_idempotency_conflict');
      state.creates.set(body.idempotency_key, body.bundle);
      return send({ code: batchCode, status: 'draft', revision: 1, project_code: projectCode });
    }
    return send({ code: batchCode, status: 'ready', revision: 2, plan_hash: planHash, ...body });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const api = `http://127.0.0.1:${server.address().port}`;
  bindProject(root, projectCode, api);
  write(root, '.agent/repositories.local.yaml', `repositories:\n  - repository_code: "${repositoryCode}"\n    path: "code"\n    remote_name: "origin"\n`);
  async function run(args, extraEnv = {}) {
    const child = spawn(process.execPath, [cli, 'intake', ...args], { cwd: root, env: { ...process.env, AGENTCTL_HOME: path.join(root, 'auth'), ACP_API_URL: api, ACP_TOKEN: 'intake-test-token', ACP_DEVICE_TOKEN: '', ACP_PRINCIPAL_CODE: '', ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = ''; child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { err += chunk; });
    const status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    return { status, ...JSON.parse(out || assert.fail(err)) };
  }
  function fill(directory = path.join(root, 'out')) {
    const file = path.join(directory, 'intake.json'); const bundle = JSON.parse(readFileSync(file, 'utf8'));
    const evidence = bundle.source.files.find(item => item.path === 'src/service.ts');
    bundle.items = [{ key: 'module-auth-v1', kind: 'module', title: 'Access control', summary: 'Observed admin gate', content_markdown: 'Only admins pass the observed gate. Runtime was not checked.', evidence: [{ ...evidence, line_start: 1, line_end: 3, symbol: 'allow' }], assessment: 'observed_in_code', tests: [{ path: 'tests/service.test.ts', name: 'admin is allowed', status: 'defined' }], gaps: ['No runtime verification performed.'] }];
    writeFileSync(file, JSON.stringify(bundle)); return { file, bundle };
  }
  const prepare = (out = 'out', scopes = ['.']) => run(['prepare', '--repository', repositoryCode, '--scope', ...scopes, '--out', out]);
  t.after(async () => { await new Promise(resolve => server.close(resolve)); assert.ok(calls.every(call => call.authorization === 'Bearer intake-test-token')); rmSync(root, { recursive: true, force: true }); });
  return { root, source, api, calls, state, run, fill, prepare };
}

test('prepare uses bound tracked text only, stable namespace and pinned instructions without a model or business writes', async t => {
  const { root, calls, prepare, run, fill } = await setup(t);
  const first = await prepare(); assert.equal(first.status, 0); assert.equal(first.data.submitted, false);
  assert.deepEqual(first.data.source.files.map(item => item.path), ['src/service.ts', 'tests/service.test.ts']);
  assert.equal(first.data.source.dirty, true); assert.equal(first.data.source.complete, false);
  assert.equal(first.data.source.manifest_sha256, sha256(intakeManifestText(first.data.source.files)));
  const text = readFileSync(path.join(root, 'out', 'SKILL.md'), 'utf8');
  assert.match(text, /version: 1\.0\.0/); assert.match(text, /client-reported/); assert.match(text, /Do not fabricate/);
  assert.equal((await run(['validate', path.join(root, 'out', 'intake.json')])).error.code, 'intake_candidates_required');
  const { file } = fill(); assert.equal((await run(['validate', file])).status, 0);
  assert.equal((await prepare()).error.code, 'intake_output_exists');
  const second = await prepare('out-two'); assert.equal(second.status, 0); assert.equal(second.data.namespace, first.data.namespace);
  assert.ok(calls.every(call => call.method === 'GET' && call.url.endsWith('/context')));
  assert.equal(readFileSync(file, 'utf8').includes('do-not-read'), false);
});

test('submit/replace recheck local fingerprints and never upload a stale or cross-project package', async t => {
  const { source, calls, run, fill, prepare } = await setup(t); await prepare();
  const { file, bundle } = fill();
  const args = ['submit', file, '--idempotency-key', 'submit-test-1'];
  const submitted = await run(args); assert.equal(submitted.status, 0); assert.equal(submitted.data.status, 'draft');
  assert.equal(calls.at(-1).url, `/projects/${projectCode}/intake`); assert.deepEqual(calls.at(-1).body, { bundle, idempotency_key: 'submit-test-1' });
  assert.equal((await run(args)).status, 0);
  bundle.items[0].title = 'Different'; writeFileSync(file, JSON.stringify(bundle));
  assert.equal((await run(args)).error.code, 'intake_idempotency_conflict');
  assert.equal((await run(['replace', batchCode, file, '--base-revision', '1'])).status, 0);
  assert.equal(calls.at(-1).method, 'PUT'); assert.equal(calls.at(-1).body.base_revision, 1);
  const count = calls.length;
  assert.equal((await run(['submit', file, '--idempotency-key', 'submit-test-2', '--project', otherProject])).error.code, 'intake_project_mismatch');
  bundle.project_code = otherProject; writeFileSync(file, JSON.stringify(bundle));
  assert.equal((await run(args)).error.code, 'intake_project_mismatch');
  bundle.project_code = projectCode; writeFileSync(file, JSON.stringify(bundle));
  write(source, 'src/service.ts', 'export function allow() { return true; }\n');
  assert.equal((await run(args)).error.code, 'intake_source_changed');
  assert.equal((await run(['replace', batchCode, file, '--base-revision', '1'])).error.code, 'intake_source_changed');
  assert.equal(calls.length, count, 'No network request on local safety failure');
});

test('validate rejects unsafe schema, manifest tampering, invalid line anchors and new tracked source files', async t => {
  const { source, calls, run, fill, prepare } = await setup(t); await prepare();
  const { file, bundle } = fill(); const original = structuredClone(bundle); const count = calls.length;
  for (const mutate of [
    item => { item.source.files[0].path = '../outside.ts'; },
    item => { item.source.files[0].path = 'C:/outside.ts'; },
    item => { item.source.files[0].path = '/outside.ts'; },
    item => { item.source.files[0].path = '.env'; },
    item => { item.source.files[0].path = 'src\\windows.ts'; },
    item => { item.schema_version = 999; },
    item => { item.items.push(item.items[0]); },
    item => { item.items[0].tests[0].path = 'unseen.ts'; },
    item => { item.items[0].content_markdown = '-----BEGIN PRIVATE KEY-----'; },
  ]) {
    const invalid = structuredClone(original); mutate(invalid); writeFileSync(file, JSON.stringify(invalid));
    assert.equal((await run(['validate', file])).error.code, 'intake_bundle_invalid');
  }
  bundle.source.manifest_sha256 = '0'.repeat(64); writeFileSync(file, JSON.stringify(bundle));
  assert.equal((await run(['validate', file])).error.code, 'intake_manifest_invalid');
  bundle.source.manifest_sha256 = original.source.manifest_sha256; bundle.items[0].evidence[0].line_end = 1000; writeFileSync(file, JSON.stringify(bundle));
  assert.equal((await run(['validate', file])).error.code, 'intake_evidence_invalid');
  writeFileSync(file, JSON.stringify(original)); write(source, 'src/added.ts', 'export const added = true;'); git(source, ['add', 'src/added.ts']);
  assert.equal((await run(['validate', file])).error.code, 'intake_source_changed');
  assert.equal(calls.length, count);
});

test('preview/status/list/apply/stop preserve project, plan and durable attempt key without implicit review', async t => {
  const { calls, state, run } = await setup(t);
  for (const action of ['preview', 'status']) assert.equal((await run([action, batchCode])).status, 0);
  assert.equal((await run(['list'])).status, 0);
  const args = ['apply', batchCode, '--plan', planHash, '--idempotency-key', 'apply-test-1'];
  assert.equal((await run(args)).status, 0); assert.equal((await run(args)).status, 0);
  assert.equal(state.apply.size, 1); assert.deepEqual(calls.at(-1).body, { plan_hash: planHash, idempotency_key: 'apply-test-1' });
  assert.equal((await run(['stop', batchCode, '--base-revision', '2'])).status, 0);
  assert.equal(calls.at(-1).url, `/projects/${projectCode}/intake/${batchCode}/stop`);
  assert.deepEqual(calls.at(-1).body, { base_revision: 2 });
  assert.ok(calls.every(call => !call.url.endsWith('/review')));
  const count = calls.length;
  assert.equal((await run(['apply', batchCode, '--plan', 'wrong', '--idempotency-key', 'apply-test-2'])).error.code, 'intake_plan_invalid');
  assert.equal((await run(['apply', batchCode, '--plan', planHash, '--idempotency-key', 'short'])).error.code, 'intake_idempotency_invalid');
  assert.equal((await run(['stop', batchCode, '--base-revision', '0'])).error.code, 'intake_revision_invalid');
  assert.equal(calls.length, count);
  state.denied = true; assert.equal((await run(args)).error.code, 'project_forbidden');
});

test('prepare fails closed for mismatched platform, absent repository, unsafe scope and incompatible skill before output', async t => {
  const { root, calls, state, run, prepare } = await setup(t);
  const before = calls.length;
  assert.equal((await run(['prepare', '--repository', repositoryCode, '--scope', '.', '--out', 'out'], { ACP_API_URL: 'http://localhost:12345' })).error.code, 'intake_platform_mismatch');
  assert.equal((await run(['prepare', '--repository', 'E'.repeat(20), '--scope', '.', '--out', 'out'])).error.code, 'intake_repository_not_bound');
  for (const scope of ['../outside', '/absolute', 'C:/absolute', 'src\\windows', '.env', 'node_modules']) assert.equal((await prepare('out', [scope])).error.code, 'intake_scope_invalid');
  assert.equal(calls.length, before, 'Unsafe local arguments fail before requests');
  state.skill_version = '99.0.0'; assert.equal((await prepare()).error.code, 'intake_skill_version_mismatch');
  assert.equal(existsSync(path.join(root, 'out')), false);
});

test('directory links cannot escape a tracked source path or redirect prepared output', async t => {
  const { root, source, prepare } = await setup(t);
  const outside = path.join(root, 'outside'); mkdirSync(outside); write(outside, 'service.ts', 'do not read outside');
  renameSync(path.join(source, 'src'), path.join(source, 'src-original'));
  try { symlinkSync(outside, path.join(source, 'src'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Host forbids symbolic links'); return; } throw error; }
  const result = await prepare(); assert.equal(result.error.code, 'intake_symlink');
  symlinkSync(outside, path.join(root, 'output-link'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await prepare('output-link/nested')).error.code, 'intake_symlink');
  assert.equal(existsSync(path.join(outside, 'nested')), false);
});

test('scope paths are normalized deterministically and a staged repository without commits is supported', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'tsp-intake-unborn-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, ['init']); write(root, 'first.ts', 'export const start = true;\n'); git(root, ['add', 'first.ts']);
  assert.deepEqual(normalizeIntakeScopes(['src', '.', 'src']), ['.', 'src']);
  const source = scanIntakeSource(root, ['.']); assert.equal(source.commit, null); assert.equal(source.dirty, true); assert.equal(source.files.length, 1);
});

test('read-only intake does not execute repository fsmonitor or clean filter commands', async t => {
  const { root, source, prepare } = await setup(t);
  const marker = path.join(root, 'must-not-run');
  const command = `node -e "require('fs').writeFileSync('${marker.replaceAll('\\', '/')}', 'executed')"`;
  git(source, ['config', 'core.fsmonitor', command]);
  assert.equal((await prepare()).status, 0);
  assert.equal(existsSync(marker), false);
  git(source, ['-c', 'core.fsmonitor=false', 'config', 'filter.untrusted.clean', command]);
  git(source, ['-c', 'core.fsmonitor=false', 'config', 'filter.untrusted.process', command]);
  git(source, ['-c', 'core.fsmonitor=false', 'config', 'filter.untrusted.required', 'true']);
  write(source, '.gitattributes', '*.ts filter=untrusted\n');
  write(source, 'src/service.ts', 'export const changed = true;\n');
  const result = await prepare('out-filter');
  assert.equal(result.status, 0, JSON.stringify(result));
  assert.equal(existsSync(marker), false);
});
