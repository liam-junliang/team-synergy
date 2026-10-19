import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { bindProject } from '../dist/project-binding.js';
import { readSkillDirectory, skillPackageHash } from '../dist/skill-sync.js';

const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const runCode = 'A'.repeat(20);
async function setup(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'tsp-skills-cli-')); const calls = [];
  const source = path.join(root, 'source'); mkdirSync(path.join(source, 'references'), { recursive: true });
  writeFileSync(path.join(source, 'SKILL.md'), '---\nname: review\ndescription: Review changes\n---\n# Review safely');
  writeFileSync(path.join(source, 'references', 'rules.md'), 'Check ownership and evidence.');
  const files = readSkillDirectory(source);
  const item = { skill_code: 'skill-one', revision: 2, alias: 'review', name: 'review', description: 'Review changes', scope_type: 'team', scope_code: 'team-one', package_sha256: skillPackageHash(files), files };
  const state = { generation: 3, blocked: false, installations: [], manifests: { project_code: 'project-one', generation: 3, skills: [item] } };
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    const url = new URL(req.url, 'http://localhost');
    calls.push({ method: req.method, url: req.url, body, auth: req.headers.authorization });
    const send = data => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, data })); };
    const fail = code => { res.statusCode = 403; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: false, error: { code, message: code } })); };
    if (url.pathname.endsWith('/denied')) return fail('skill_forbidden');
    if (url.pathname === '/projects/project-one/skills/manifest' || url.pathname === `/runs/${runCode}/skills`) return state.blocked ? fail('skill_delivery_blocked') : send(state.manifests);
    if (url.pathname === '/projects/project-one/skills') return send({ project_code: 'project-one', generation: state.generation, can_manage: true, installations: state.installations });
    if (url.pathname === '/projects/project-one/skills/skill-one') {
      if (body.base_generation !== state.generation) return fail('skill_generation_conflict');
      state.installations = [{ ...item, ...body, files: undefined, blocked: false, blocked_reason: null }]; state.generation++;
      return send({ project_code: 'project-one', generation: state.generation, installations: state.installations });
    }
    if (url.pathname === '/skills/skill-one' && req.method === 'GET') return send({ code: 'skill-one', name: 'review', current_revision: 2, revisions: [{ ...item, revision: 1 }, { ...item, revision: 2 }] });
    return send({ code: 'skill-one', ...body });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const api = `http://127.0.0.1:${server.address().port}`; bindProject(root, 'project-one', api);
  async function run(...args) {
    const child = spawn(process.execPath, [cli, 'skill', ...args], { cwd: root, env: { ...process.env, AGENTCTL_HOME: path.join(root, 'auth'), ACP_API_URL: api, ACP_TOKEN: 'skill-test-token', ACP_DEVICE_TOKEN: '', ACP_PRINCIPAL_CODE: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = ''; child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { err += chunk; });
    const status = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    return { status, ...JSON.parse(out || assert.fail(err)) };
  }
  t.after(async () => { await new Promise(resolve => server.close(resolve)); assert.ok(calls.every(call => call.auth === 'Bearer skill-test-token')); rmSync(root, { recursive: true, force: true }); });
  return { root, source, calls, state, run };
}

test('skill CLI imports full directory, revisions, publish, share and revoke through existing identity', async t => {
  const { run, source, calls } = await setup(t);
  assert.equal((await run('create', '--directory', source, '--team', 'team-one')).status, 0);
  assert.equal(calls.at(-1).url, '/skills'); assert.equal(calls.at(-1).body.scope_type, 'team'); assert.equal(calls.at(-1).body.scope_code, 'team-one'); assert.equal(calls.at(-1).body.files.length, 2);
  assert.equal((await run('revise', 'skill-one', '--directory', source, '--base-revision', '2', '--change', 'Add evidence')).status, 0);
  assert.equal(calls.at(-1).method, 'PATCH'); assert.equal(calls.at(-1).body.base_revision, 2);
  await run('publish', 'skill-one', '--revision', '3'); assert.deepEqual(calls.at(-1).body, { revision: 3 });
  await run('share', 'skill-one', '--team', 'team-other', '--revisions', '1,3', '--allow-projects', '--allow-external');
  assert.deepEqual(calls.at(-1).body, { target_type: 'team', target_code: 'team-other', revisions: [1, 3], allow_projects: true, allow_external: true });
  await run('share', 'skill-one', '--project', 'project-other', '--revisions', '2'); assert.equal(calls.at(-1).body.allow_external, false);
  await run('revoke', 'skill-one', 'share-one'); assert.equal(calls.at(-1).method, 'DELETE'); assert.equal(calls.at(-1).url, '/skills/skill-one/shares/share-one');
  await run('archive', 'skill-one'); assert.deepEqual(calls.at(-1).body, { archived: true });
  await run('archive', 'skill-one', '--restore'); assert.deepEqual(calls.at(-1).body, { archived: false });
});

test('catalog, search and show retain explicit scope and exact authorized version', async t => {
  const { run, calls } = await setup(t);
  await run('catalog', '--team', 'team-one', '--view', 'owned'); let query = new URL(calls.at(-1).url, 'http://localhost');
  assert.equal(query.searchParams.get('team_code'), 'team-one'); assert.equal(query.searchParams.get('view'), 'owned');
  await run('search', '代码 评审', '--view', 'shared'); query = new URL(calls.at(-1).url, 'http://localhost');
  assert.equal(query.searchParams.get('project_code'), 'project-one'); assert.equal(query.searchParams.get('q'), '代码 评审');
  const revision = await run('show', 'skill-one', '--revision', '1', '--project', 'project-one'); assert.equal(revision.status, 0); assert.deepEqual(revision.data.revisions.map(item => item.revision), [1]);
  assert.equal(calls.at(-1).url, '/skills/skill-one?project_code=project-one');
  assert.equal((await run('show', 'skill-one', '--revision', '99')).error.code, 'skill_revision_not_found');
  assert.equal((await run('show', 'denied')).error.code, 'skill_forbidden');
});

test('enable/update/disable use generation guards and preserve project alias without implicit latest selection', async t => {
  const { run, state, calls } = await setup(t);
  const enabled = await run('enable', 'skill-one', '--revision', '1', '--alias', 'my-review'); assert.equal(enabled.status, 0);
  assert.deepEqual(calls.at(-1).body, { revision: 1, alias: 'my-review', enabled: true, base_generation: 3 });
  assert.equal((await run('update', 'skill-one', '--revision', '2', '--base-generation', '3')).error.code, 'skill_generation_conflict');
  assert.equal(state.installations[0].revision, 1);
  assert.equal((await run('update', 'skill-one', '--revision', '2')).status, 0); assert.equal(state.installations[0].alias, 'my-review');
  assert.equal((await run('disable', 'skill-one')).status, 0); assert.equal(state.installations[0].enabled, false); assert.equal(state.installations[0].revision, 2);
  assert.equal((await run('update', 'skill-one', '--revision', '1')).status, 0); assert.equal(state.installations[0].enabled, false);
});

test('sync supports dry run and pinned Run paths; revoked grant fails closed without altering local copy', async t => {
  const { run, root, state } = await setup(t);
  const check = await run('sync', '--check'); assert.equal(check.status, 0); assert.equal(check.data.changed, true); assert.equal(existsSync(path.join(root, '.tsp')), false);
  assert.equal((await run('sync')).status, 0);
  const local = path.join(root, '.tsp', 'skills', 'review', 'SKILL.md'); const bytes = readFileSync(local);
  state.blocked = true; const blocked = await run('sync'); assert.equal(blocked.status, 1); assert.equal(blocked.error.code, 'skill_delivery_blocked'); assert.deepEqual(readFileSync(local), bytes);
  state.blocked = false; const runRoot = path.join(root, '.agent', 'runs', runCode);
  assert.equal((await run('sync', '--run', runCode, '--check')).status, 0); assert.equal(existsSync(runRoot), false);
  const synced = await run('sync', '--run', runCode); assert.equal(synced.status, 0); assert.equal(synced.data.skills_directory, path.join(runRoot, '.tsp', 'skills'));
  assert.deepEqual(readFileSync(path.join(runRoot, '.tsp', 'skills', 'review', 'SKILL.md')), bytes);
  assert.equal((await run('manifest', '--run', runCode)).data.skills[0].revision, 2);
});

test('invalid input fails before network mutations', async t => {
  const { run, root, source, calls } = await setup(t);
  const bad = path.join(root, 'bad.json'); writeFileSync(bad, JSON.stringify({ files: [{ path: '../escape', content_base64: 'dGVzdA==' }] }));
  const realInput = path.join(root, 'json-source'); mkdirSync(realInput);
  writeFileSync(path.join(realInput, 'skill.json'), JSON.stringify({ files: readSkillDirectory(source) }));
  const linkedInput = path.join(root, 'linked-json'); symlinkSync(realInput, linkedInput, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await run('create', '--file', path.join(linkedInput, 'skill.json'))).error.code, 'skill_symlink_forbidden');
  for (const args of [
    ['create', '--directory', source, '--team', 't', '--project', 'p'],
    ['create', '--file', bad], ['share', 'skill-one', '--revisions', '1'], ['share', 'skill-one', '--team', 't', '--revisions', '1,1'],
    ['publish', 'skill-one', '--revision', '0'], ['catalog', '--view', 'private'],
    ['sync', '--run', '../outside'], ['sync', '--run', 'CON'], ['sync', '--run', runCode, '--project', 'project-one'],
  ]) assert.equal((await run(...args)).status, 1, args.join(' '));
  assert.equal(calls.length, 0);
});
