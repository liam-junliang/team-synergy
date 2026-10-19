import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));
function git(cwd, ...args) { const result = spawnSync('git', args, { cwd, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); }
async function run(cwd, home, url, token, args) {
  const child = spawn(process.execPath, [cli, ...args], { cwd, env: { ...process.env, AGENTCTL_HOME: home, ACP_API_URL: url, ACP_TOKEN: token, ACP_PRINCIPAL_CODE: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  try { return JSON.parse(stdout); } catch { throw new Error(`Invalid CLI output ${stdout} ${stderr}`); }
}

test('handover CLI transports reviewed context and an exact Git snapshot between two users without database access', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'acp-handover-cli-'));
  const calls = [];
  const contextManifest = { schema_version: 1, sources: [
    { code: 'doc-one', content: 'Fixed original requirement text', title: 'Requirement' },
    { code: 'design-url', content: 'URL notes', content_kind: 'url', external_url: 'https://example.com/preview', html_content: '', kind: 'design_prototype', revision: 2, title: 'External prototype' },
    { code: 'design-file', content: 'File notes', content_kind: 'file', download_path: '/design-prototypes/design-file/file?revision=3', file_mime_type: 'application/octet-stream', file_name: 'source.fig', file_sha256: 'fixed-file-hash', file_size: 10, html_content: '', kind: 'design_prototype', revision: 3, title: 'Original source' },
    { code: 'home-guide', content: 'Frozen onboarding and project standards', home_roles: ['guide', 'standards'], kind: 'project_document', revision: 7, title: 'Contributor rules' },
    { code: 'home-api-standards', content: 'Frozen API conventions', home_roles: ['standards'], kind: 'project_document', revision: 4, title: 'API standards' },
  ], task_contract: { title: 'Continue this task' } };
  const contextHash = createHash('sha256').update(JSON.stringify(contextManifest)).digest('hex');
  const targetRun = '22222222222222222222';
  const content = Buffer.from('---\nname: portable-review\ndescription: Fixed review steps\n---\nRead original instructions\n');
  const file = { path: 'SKILL.md', content_base64: content.toString('base64'), size_bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') };
  const skills = { project_code: '11111111111111111111', generation: 1, skills: [{ skill_code: '33333333333333333333', revision: 1, alias: 'portable-review', name: 'portable-review', description: 'Fixed review steps', scope_type: 'project', scope_code: '11111111111111111111', files: [file], package_sha256: createHash('sha256').update(JSON.stringify([[file.path, file.sha256, file.size_bytes]])).digest('hex') }] };
  const detail = { handover_code: 'handover-one', task_code: 'task-one', source_run_code: 'run-A', target_run_code: targetRun, version: 1, context_snapshot_code: 'context-one', context_snapshot_hash: contextHash };
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    calls.push({ method: req.method, url: req.url, body, authorization: req.headers.authorization, key: req.headers['idempotency-key'], lease: req.headers['x-run-lease'], epoch: req.headers['x-execution-epoch'] });
    let data;
    if (req.url === '/tasks/task-one') data = { base_snapshot: 1, project_code: 'project-one' };
    else if (req.url === '/projects/project-one/repositories') data = [{ repository_code: 'repository-one', status: 'active', remote_url: remote }];
    else if (req.url === '/tasks/task-one/handovers/prepare') data = { handover_code: detail.handover_code, preparation_grant: 'private-grant', source_epoch: 2 };
    else if (req.method === 'GET' && req.url === '/handovers/handover-one') data = detail;
    else if (req.url === '/handovers/handover-one/draft') { Object.assign(detail, body); data = detail; }
    else if (req.url === '/handovers/handover-one/restore') data = { attempt_code: 'attempt-B', target_run_code: targetRun };
    else if (req.url === `/runs/${targetRun}/skills`) data = skills;
    else if (req.url === '/context-snapshots/context-one') data = { content_hash: contextHash, manifest: contextManifest, summary: detail.summary };
    else if (req.url === '/handovers/handover-one/activate') data = { run_code: targetRun, workspace_code: 'workspace-B', execution_epoch: 3, lease: { lease_token: 'private-B-lease' } };
    else data = { done: true };
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, data }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); rmSync(root, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const remote = path.join(root, 'remote.git'); const source = path.join(root, 'A'); const target = path.join(root, 'B');
  git(root, 'init', '--bare', remote); git(root, 'clone', remote, source);
  git(source, 'config', 'user.name', 'Test'); git(source, 'config', 'user.email', 'test@example.invalid'); git(source, 'config', 'core.autocrlf', 'false');
  writeFileSync(path.join(source, 'work.txt'), 'original\n'); git(source, 'add', '.'); git(source, 'commit', '-m', 'Fixture'); git(source, 'push', 'origin', 'HEAD');
  git(root, 'clone', remote, target); git(target, 'config', 'core.autocrlf', 'false');
  writeFileSync(path.join(source, 'work.txt'), 'A unfinished work\n');
  const summary = path.join(root, 'reviewed.json'); writeFileSync(summary, JSON.stringify({ goal: 'Continue feature', next_actions: ['Complete tests'] }));
  const aHome = path.join(root, 'A-home'); const bHome = path.join(root, 'B-home');
  const baseArgs = ['task', 'handover', 'prepare', 'task-one', '--target', 'user-B', '--run', 'run-A', '--summary', summary, '--repository', 'repository-one', '--repo', source];
  const blocked = await run(source, aHome, url, 'token-A', baseArgs);
  assert.equal(blocked.error.code, 'source_stop_required'); assert.equal(calls.length, 0);
  const prepared = await run(source, aHome, url, 'token-A', [...baseArgs, '--agent-stopped']); assert.equal(prepared.ok, true, JSON.stringify(prepared));
  assert.equal((await run(source, aHome, url, 'token-A', ['task', 'handover', 'publish', 'handover-one'])).ok, true);
  assert.equal((await run(target, bHome, url, 'token-B', ['task', 'handover', 'accept', 'handover-one'])).ok, true);
  const worktree = path.join(root, 'B-independent-worktree');
  const restored = await run(target, bHome, url, 'token-B', ['task', 'handover', 'restore', 'handover-one', '--repo', target, '--dir', worktree]);
  assert.equal(restored.ok, true, JSON.stringify(restored)); assert.equal(readFileSync(path.join(worktree, 'work.txt'), 'utf8'), 'A unfinished work\n');
  const activated = await run(target, bHome, url, 'token-B', ['task', 'handover', 'activate', 'handover-one']);
  assert.equal(activated.ok, true, JSON.stringify(activated)); assert.equal(activated.data.run_code, targetRun);
  assert.equal(readFileSync(path.join(worktree, '.agent', 'runs', targetRun, '.tsp', 'skills', 'portable-review', 'SKILL.md'), 'utf8'), content.toString());
  assert.equal(calls.filter(call => call.url === `/runs/${targetRun}/skills`).length, 2, 'Restore and activation recheck the exact Run grant');
  assert.ok(!JSON.stringify(activated).includes('private-B-lease'));
  const mutations = calls.filter((call) => call.method !== 'GET'); assert.ok(mutations.every((call) => call.key));
  assert.equal(calls.find((call) => call.url.endsWith('/draft')).authorization, 'Bearer token-A');
  assert.equal(calls.find((call) => call.url.endsWith('/ready')).authorization, 'Bearer token-B');
  assert.equal(calls.find((call) => call.url.endsWith('/source-stop-ack')).body.assurance, 'manual_confirmation');
  assert.equal(calls.find((call) => call.url.endsWith('/ready')).body.context_snapshot_hash, contextHash);
  const context = JSON.parse(readFileSync(activated.data.context_path, 'utf8'));
  assert.equal(context.summary.next_actions[0], 'Complete tests');
  assert.ok(!JSON.stringify(context).includes('private-grant'));
  assert.ok(readFileSync(activated.data.brief_path, 'utf8').includes('Complete tests'));
  assert.ok(readFileSync(path.join(bHome, 'handovers', 'handover-one.materials', 'source-0001.md'), 'utf8').includes('Fixed original requirement text'));
  const materials = path.join(bHome, 'handovers', 'handover-one.materials');
  assert.match(readFileSync(path.join(materials, 'source-0002.md'), 'utf8'), /https:\/\/example.com\/preview/);
  assert.match(readFileSync(path.join(materials, 'source-0003.md'), 'utf8'), /tsp design download design-file --revision 3 --out <local-path>/);
  assert.match(readFileSync(path.join(materials, 'source-0003.md'), 'utf8'), /fixed-file-hash/);
  assert.equal(existsSync(path.join(materials, 'source-0002.html')), false);
  assert.equal(existsSync(path.join(materials, 'source-0003.html')), false);
  assert.ok(!calls.some((call) => call.url.includes('/design-prototypes/')), 'Handover must not auto-download attachments');
  const frozenBrief = readFileSync(activated.data.brief_path, 'utf8');
  assert.match(frozenBrief, /项目说明：交接时尚未配置/);
  assert.match(frozenBrief, /参与指引：\[Contributor rules\].*source-0004.md.*Revision 7/);
  assert.match(frozenBrief, /项目规范：\[Contributor rules\].*source-0004.md.*Revision 7/);
  assert.match(frozenBrief, /项目规范：\[API standards\].*source-0005.md.*Revision 4/);
  assert.equal(frozenBrief.match(/^- 项目规范：/gm).length, 2);
  assert.doesNotMatch(frozenBrief, /Frozen onboarding and project standards|Frozen API conventions/);
  assert.match(readFileSync(path.join(materials, 'source-0004.md'), 'utf8'), /首页角色：参与指引、项目规范/);
  assert.match(readFileSync(path.join(materials, 'source-0005.md'), 'utf8'), /版本：4/);
  assert.match(readFileSync(path.join(materials, 'source-0005.md'), 'utf8'), /Frozen API conventions/);
  assert.ok(!calls.some((call) => call.url.endsWith('/home')), 'Frozen handover must not replace standards with live home documents');
  const submitted = await run(target, bHome, url, 'token-B', ['task', 'submit', 'task-one', '--run-code', targetRun, '--artifact-kind', 'commit', '--artifact-uri', 'git:current', '--artifact-hash', 'hash', '--evidence-type', 'self_test', '--evidence-result', 'pass', '--acceptance-refs', 'AC-1']);
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  const submitCall = calls.find((call) => call.url.endsWith('/submit'));
  assert.equal(submitCall.lease, 'private-B-lease'); assert.equal(submitCall.epoch, '3');
  context.context.manifest.task_contract.title = 'Tampered after restore';
  writeFileSync(activated.data.context_path, JSON.stringify(context));
  const tampered = await run(target, bHome, url, 'token-B', ['task', 'handover', 'activate', 'handover-one']);
  assert.equal(tampered.error.code, 'context_hash_mismatch');
  assert.equal(calls.filter((call) => call.url.endsWith('/activate')).length, 1);
});
