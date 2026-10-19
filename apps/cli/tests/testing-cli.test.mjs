import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bindProject } from '../dist/project-binding.js';
import { renderContextPackFromTask } from '../dist/pack.js';

const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));
async function setup(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'tsp-testing-cli-'));
  const calls = [];
  const saved = new Map();
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
    res.setHeader('content-type', 'application/json');
    const url = new URL(req.url, 'http://localhost');
    const fail = (code, status = 400) => { res.statusCode = status; res.end(JSON.stringify({ ok: false, error: { code, message: code } })); };
    if (url.pathname.endsWith('/denied')) { fail('project_forbidden', 403); return; }
    const list = /^\/projects\/([^/]+)\/test-(cases|assets|executions)$/.exec(url.pathname);
    const detail = /^\/test-(cases|assets|executions)\/([^/]+)$/.exec(url.pathname);
    const defect = /^\/test-executions\/([^/]+)\/results\/([^/]+)\/defect$/.exec(url.pathname);
    if (list && req.method === 'GET') {
      res.end(JSON.stringify({ ok: true, data: [...saved.values()].filter(item => item.entity === list[2]).map(({ revisions, ...item }) => item) })); return;
    }
    if (defect && req.method === 'POST') { res.end(JSON.stringify({ ok: true, data: { result_code: defect[2], defect_code: body.defect_code ?? 'new-defect', ...body } })); return; }
    if (list && req.method === 'POST' || detail && req.method === 'PATCH') {
      const entity = list?.[2] ?? detail[1];
      const code = detail?.[2] ?? `${entity}-one`;
      const previous = saved.get(code);
      if (detail && body.base_revision !== previous?.current_revision) { fail('testing_revision_conflict', 409); return; }
      const { base_revision, ...content } = body;
      const revision = (previous?.current_revision ?? 0) + 1;
      const current = { ...previous, ...content, code, entity, project_code: 'project-one', current_revision: revision };
      const snapshot = { ...current, revision, revision_code: `${code}-revision-${revision}` };
      delete snapshot.revisions;
      current.revisions = [snapshot, ...(previous?.revisions ?? [])];
      saved.set(code, current);
      res.end(JSON.stringify({ ok: true, data: current })); return;
    }
    if (detail && req.method === 'GET' && saved.has(detail[2])) { res.end(JSON.stringify({ ok: true, data: saved.get(detail[2]) })); return; }
    fail('not_found', 404);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  bindProject(root, 'project-one', url);
  const run = async (...args) => {
    const child = spawn(process.execPath, [cli, 'test', ...args], {
      cwd: root, env: { ...process.env, AGENTCTL_HOME: path.join(root, 'auth'), ACP_API_URL: url,
        ACP_TOKEN: 'testing-cli-token', ACP_DEVICE_TOKEN: '', ACP_PRINCIPAL_CODE: '' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = ''; let err = '';
    child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { err += chunk; });
    const status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    return { status, ...JSON.parse(out || assert.fail(err)) };
  };
  const file = (name, value) => { const target = path.join(root, name); writeFileSync(target, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)); return target; };
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    assert.ok(calls.every(call => call.auth === 'Bearer testing-cli-token'));
    rmSync(root, { recursive: true, force: true });
  });
  return { root, run, calls, saved, file };
}

test('test case commands use project binding, structured JSON, revisions, filters and server errors', async t => {
  const { run, file, calls } = await setup(t);
  const input = { title: '登录冒烟', summary: '异常登录提示', priority: 'high', method: 'manual', suite: 'smoke', tags: ['auth'], module_code: 'module-one', requirement_codes: ['req-one'], asset_codes: [], preconditions: '用户已退出', steps: [{ action: '输入错误密码', expected: '显示错误提示' }] };
  const created = await run('case', 'create', '--file', file('case.json', '\uFEFF' + JSON.stringify(input)), '--notes-file', file('notes.md', '# 登录说明'));
  assert.equal(created.status, 0); assert.equal(created.data.title, input.title);
  assert.equal(calls[0].url, '/projects/project-one/test-cases'); assert.deepEqual(calls[0].body.steps, input.steps);
  assert.equal(calls[0].body.notes_markdown, '# 登录说明');
  const patch = file('patch.json', { title: '密码错误', steps: [{ action: '输入过期密码', expected: '请求重新设置' }] });
  const revised = await run('case', 'revise', 'cases-one', '--base-revision', '1', '--change', '补充过期密码', '--file', patch);
  assert.equal(revised.status, 0); assert.equal(revised.data.current_revision, 2); assert.equal(calls.at(-1).body.base_revision, 1);
  const old = await run('case', 'show', 'cases-one', '--revision', '1');
  assert.equal(old.status, 0); assert.equal(old.data.title, input.title); assert.deepEqual(old.data.steps, input.steps); assert.equal(old.data.selected_revision, 1);
  assert.equal((await run('case', 'revise', 'cases-one', '--base-revision', '1', '--change', '冲突', '--file', patch)).error.code, 'testing_revision_conflict');
  assert.equal((await run('case', 'show', 'cases-one', '--revision', '99')).error.code, 'testing_revision_not_found');
  await run('case', 'search', '登录 错误', '--project', 'project-other', '--module', 'module-one', '--requirement', 'req-one', '--suite', 'smoke', '--method', 'manual');
  const searched = new URL(calls.at(-1).url, 'http://localhost');
  assert.equal(searched.pathname, '/projects/project-other/test-cases'); assert.equal(searched.searchParams.get('q'), '登录 错误'); assert.equal(searched.searchParams.get('requirement_code'), 'req-one');
  const denied = await run('case', 'show', 'denied'); assert.equal(denied.status, 1); assert.equal(denied.error.code, 'project_forbidden');
});

test('test asset uploads preserve exact bytes and download immutable revisions without implicit overwrite', async t => {
  const { run, file, calls, root, saved } = await setup(t);
  const bytes = Buffer.from([0, 255, 13, 10, 0, 42]);
  const created = await run('asset', 'create', '--title', '回归数据', '--purpose', 'data', '--file', file('input.bin', bytes), '--mime', 'application/octet-stream');
  assert.equal(created.status, 0); assert.equal(created.data.storage_kind, 'file'); assert.equal(calls[0].body.file.size_bytes, bytes.length);
  assert.equal(calls[0].body.file.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal((await run('asset', 'revise', 'assets-one', '--base-revision', '1', '--change', '替换为说明', '--file', file('guide.md', '# 回归说明'))).status, 0);
  const output = path.join(root, 'download.bin');
  const old = await run('asset', 'download', 'assets-one', '--revision', '1', '--output', output);
  assert.equal(old.status, 0); assert.deepEqual(readFileSync(output), bytes); assert.equal(old.data.selected_revision, 1);
  const before = calls.length;
  assert.equal((await run('asset', 'download', 'assets-one', '--output', output)).error.code, 'output_exists'); assert.equal(calls.length, before);
  assert.equal((await run('asset', 'download', 'assets-one', '--output', output, '--force')).status, 0); assert.equal(readFileSync(output, 'utf8'), '# 回归说明');
  assert.equal((await run('asset', 'download', 'assets-one', '--output', root, '--force')).error.code, 'output_invalid');
  const missing = path.join(root, 'missing.bin');
  assert.equal((await run('asset', 'download', 'assets-one', '--revision', '99', '--output', missing)).error.code, 'testing_revision_not_found'); assert.equal(existsSync(missing), false);
  saved.get('assets-one').revisions[1].file.sha256 = '0'.repeat(64);
  assert.equal((await run('asset', 'download', 'assets-one', '--revision', '1', '--output', missing)).error.code, 'api_bad_response'); assert.equal(existsSync(missing), false);
});

test('test asset Git and URL sources are metadata references and never fetched or executed', async t => {
  const { run, file, root, calls } = await setup(t);
  const git = { repository_code: 'repo-one', path: 'tests/login.spec.ts', ref: 'main', commit: 'a'.repeat(40), command: 'pnpm test', setup: 'pnpm install' };
  const input = file('asset.json', { title: '登录脚本', purpose: 'script', tags: ['smoke'], requirement_codes: ['req-one'] });
  const result = await run('asset', 'create', '--input', input, '--git-file', file('git.json', git), '--notes-file', file('setup.md', '# 执行说明'));
  assert.equal(result.status, 0); assert.deepEqual(calls.at(-1).body.git, git); assert.equal(calls.at(-1).body.storage_kind, 'git');
  assert.equal((await run('asset', 'show', 'assets-one')).data.content, '# 执行说明');
  assert.equal((await run('asset', 'download', 'assets-one', '--output', path.join(root, 'must-not-fetch'))).error.code, 'testing_download_unsupported');
  assert.equal(existsSync(path.join(root, 'must-not-fetch')), false);
  const revised = await run('asset', 'revise', 'assets-one', '--base-revision', '1', '--change', '报告链接', '--url', 'https://example.invalid/report/42', '--purpose', 'report');
  assert.equal(revised.status, 0); assert.equal(calls.at(-1).body.git, null); assert.equal(calls.at(-1).body.url, 'https://example.invalid/report/42');
  await run('asset', 'search', '登录', '--purpose', 'report', '--kind', 'url');
  const query = new URL(calls.at(-1).url, 'http://localhost').searchParams; assert.equal(query.get('storage_kind'), 'url'); assert.equal(query.get('purpose'), 'report');
});

test('test execution records exact revision references and supports creating or linking defects', async t => {
  const { run, calls, file } = await setup(t);
  const input = { title: '登录冒烟 #42', environment: 'staging Chrome', tested_version: 'v0.1.0', commit_sha: 'b'.repeat(40), source: 'agent', task_code: 'task-one', asset_refs: [{ asset_code: 'asset-one', revision: 3 }], results: [{ case_code: 'case-one', case_revision: 2, result: 'fail', actual_result: '返回 500', notes: '重复两次', report_urls: ['https://example.invalid/report/42'] }] };
  const result = await run('execution', 'record', '--file', file('execution.json', input));
  assert.equal(result.status, 0); assert.deepEqual(calls[0].body, input); assert.equal(calls[0].url, '/projects/project-one/test-executions');
  assert.equal((await run('execution', 'show', 'executions-one')).data.results[0].case_revision, 2);
  assert.equal((await run('execution', 'list', '--query', '#42')).status, 0); assert.equal(new URL(calls.at(-1).url, 'http://localhost').searchParams.get('q'), '#42');
  const linked = await run('execution', 'defect', 'executions-one', 'result-one', '--defect', 'defect-one'); assert.equal(linked.status, 0);
  assert.equal(calls.at(-1).url, '/test-executions/executions-one/results/result-one/defect'); assert.deepEqual(calls.at(-1).body, { defect_code: 'defect-one' });
  const created = await run('execution', 'defect', 'executions-one', 'result-one', '--feature', 'feature-one', '--title', '登录返回 500', '--severity', 'high');
  assert.equal(created.status, 0); assert.deepEqual(calls.at(-1).body, { feature_code: 'feature-one', title: '登录返回 500', severity: 'high' });
  assert.ok(calls.every(call => !call.url.startsWith('/tasks/')), 'Recording a test must not verify or close the task');
});

test('malformed inputs, source conflicts and invalid revisions fail before writes', async t => {
  const { run, calls, file } = await setup(t);
  const invalid = file('invalid.json', '{'); const array = file('array.json', []); const empty = file('empty.json', {});
  const source = file('script.sh', 'echo test'); const oversized = file('large.bin', Buffer.alloc(6 * 1024 * 1024 + 1));
  for (const args of [
    ['case', 'create', '--file', invalid], ['case', 'create', '--file', array],
    ['case', 'show', 'case-one', '--revision', '0'], ['case', 'show', 'case-one', '--revision', '1e2'],
    ['case', 'revise', 'case-one', '--base-revision', '-1', '--change', 'bad', '--file', empty],
    ['asset', 'create', '--file', source], ['asset', 'create', '--title', 'bad', '--file', oversized],
    ['asset', 'create', '--title', 'bad', '--file', source, '--url', 'https://example.invalid'],
    ['asset', 'create', '--title', 'bad', '--file', source, '--kind', 'git'],
    ['asset', 'create', '--title', 'bad', '--kind', 'file'],
    ['execution', 'record', '--file', array],
    ['execution', 'defect', 'one', 'two', '--defect', 'three', '--title', 'bad'],
    ['execution', 'defect', 'one', 'two', '--feature', 'feature-one', '--title', 'bad', '--severity', 'major'],
  ]) assert.equal((await run(...args)).status, 1, args.join(' '));
  assert.equal(calls.length, 0);
});

test('context packs keep testing assets opt-in and provide search/read/download guidance', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'tsp-testing-pack-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pack = renderContextPackFromTask({ task_code: 'task-one', title: 'Task' }, { workspaceRoot: root, runCode: 'run-one', principalCode: 'user-one' },
    { project_code: 'project-one', title: 'Project', content: 'Project overview', revision: 1 }, undefined,
    { folders: [], documents: [{ document_code: 'asset-one', source_kind: 'testing', title: 'Large test archive', summary: '', folder_code: null, kind: 'doc', content: 'Do not duplicate file bytes', current_revision: 2, status: 'active' }] });
  assert.equal(pack.handoffDocumentPaths.length, 0);
  const content = readFileSync(pack.briefPath, 'utf8') + readFileSync(pack.handoffIndexPath, 'utf8');
  assert.match(content, /tsp test case search/); assert.match(content, /tsp test asset show/); assert.match(content, /tsp test asset download/);
  assert.doesNotMatch(content, /Large test archive|Do not duplicate file bytes/);
});
