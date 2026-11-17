import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const project = 'A'.repeat(20), source = 'B'.repeat(20), run = 'C'.repeat(20);
async function fixture(t) {
  const requests = [];
  let denied = false, oversized = false, override;
  let personal = { source, revisionSource: run, revision: 1, text: '先验证再提交', status: 'active', applicability: 'account', projectCode: project,
    provenance: {}, projection: { status: 'pending', operation: 'upsert', cleanupPending: true }, history: [{ text: '历史私密哨兵' }] };
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer member-device');
    let raw = ''; for await (const chunk of req) raw += chunk;
    const url = new URL(req.url, 'http://fixture.invalid'), body = raw ? JSON.parse(raw) : undefined;
    requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body });
    if (denied) { res.end(JSON.stringify({ ok: false, error: { code: 'project_forbidden', message: 'unavailable' } })); return; }
    if (url.pathname.startsWith('/memory/personal/')) {
      if (req.method !== 'GET') {
        if (body.expectedRevision !== personal.revision) { res.end(JSON.stringify({ ok: false, error: { code: 'memory_source_changed', message: 'stale' } })); return; }
        personal = { ...personal, revision: personal.revision + 1, text: body.text ?? personal.text, status: req.method === 'PATCH' ? 'active' : 'withdrawn' };
      }
      res.end(JSON.stringify({ ok: true, data: personal })); return;
    }
    const data = override ?? (oversized ? { body: 'x'.repeat(129000) } : {
      sourceCitation: source, current: true, state: 'documented', version: { revision: 2, revisionCode: source },
      body: url.pathname.endsWith('/read') ? '方案已确认，实际落实需看运行证据。' : undefined,
      ...(url.pathname.includes('/materials/') ? { input: body } : { query: Object.fromEntries(url.searchParams) }),
    });
    res.end(JSON.stringify({ ok: true, data }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close());
  const api = 'http://127.0.0.1:' + server.address().port;
  return { ...workspaceClient(t, api, project), requests, deny: () => denied = true, oversize: () => oversized = true,
    foreignPersonal: () => personal = { ...personal, applicability: 'project', projectCode: 'D'.repeat(20) },
    override: value => override = value };
}

function workspaceClient(t, api, projectCode) {
  const root = mkdtempSync(path.join(tmpdir(), 'tsp-agent-tools-'));
  const cwd = path.join(root, 'workspace'), account = path.join(root, 'account');
  mkdirSync(path.join(cwd, '.agent'), { recursive: true }); mkdirSync(account);
  t.after(() => { assert.equal(path.dirname(root), path.resolve(tmpdir())); rmSync(root, { recursive: true, force: true }); });
  writeFileSync(path.join(account, 'auth.json'), JSON.stringify({ device_token: 'member-device', device_code: 'D', user_code: 'member', device_name: 'test', api_url: api }));
  writeFileSync(path.join(cwd, '.agent', 'bound-project.yaml'), `project_code: ${projectCode}\napi_url: ${api}\nbound_at: today\n`);
  async function command(args, input = '', env = {}) {
    const child = spawn(process.execPath, [cli, ...args], { cwd, windowsHide: true,
      env: { ...process.env, AGENTCTL_HOME: account, ACP_API_URL: api, ...env } });
    let out = '', err = ''; child.stdout.setEncoding('utf8').on('data', x => out += x);
    child.stderr.setEncoding('utf8').on('data', x => err += x);
    const closing = once(child, 'close'); child.stdin.end(input); const [code] = await closing;
    return { code, out, err, json: () => JSON.parse(out) };
  }
  async function mcp(frames, flags = []) {
    const result = await command(['mcp', ...flags], [{ id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }, ...frames]
      .map(frame => JSON.stringify({ jsonrpc: '2.0', ...frame })).join('\n') + '\n');
    assert.equal(result.code, 0, result.err); return result.out.trim().split('\n').map(x => JSON.parse(x));
  }
  const tool = (name, args, flags = []) => command(['tools', 'call', name, '--input', JSON.stringify(args), ...flags]);
  return { cwd, command, mcp, tool };
}

test('CLI and MCP discover the same read capabilities and optional governance schemas', async t => {
  const f = await fixture(t);
  const cliTools = (await f.command(['tools', 'list'])).json().data;
  const frames = await f.mcp([{ id: 2, method: 'tools/list' }]);
  assert.deepEqual(cliTools, frames[1].result.tools);
  for (const name of ['search_memory', 'read_memory_source', 'list_project_materials', 'glob_project_materials', 'grep_project_materials', 'read_project_material', 'read_code_catalog', 'query_code_graph', 'query_local_code', 'request_code_analysis', 'get_code_analysis_status', 'list_project_skills', 'read_project_skill']) {
    assert.ok(cliTools.some(tool => tool.name === name), name);
  }
  assert.equal(cliTools.some(tool => tool.name === 'edit_personal_memory'), false);
  assert.deepEqual(cliTools.find(tool => tool.name === 'request_code_analysis').annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: true });
  assert.equal(cliTools.find(tool => tool.name === 'get_code_analysis_status').annotations.readOnlyHint, true);
  const listSchema = cliTools.find(tool => tool.name === 'list_project_materials').inputSchema;
  assert.ok(!listSchema.required?.includes('limit'), 'input defaults must not become required model arguments');
  const managed = (await f.command(['tools', 'list', '--allow-personal-management'])).json().data;
  assert.deepEqual(managed, (await f.mcp([{ id: 2, method: 'tools/list' }], ['--allow-personal-management']))[1].result.tools);
  assert.equal(managed.find(tool => tool.name === 'withdraw_personal_memory').annotations.readOnlyHint, false);
  const omitted = await f.mcp([{ id: 2, method: 'tools/call', params: { name: 'read_code_catalog' } },
    { id: 3, method: 'tools/call', params: { name: 'list_project_materials' } },
    { id: 4, method: 'tools/call', params: { name: 'list_project_materials', arguments: null } }]);
  assert.ok(omitted[1].result); assert.ok(omitted[2].result); assert.equal(omitted[3].error.code, -32602);
});

test('hosted analysis CLI tools and MCP use the same project API and keep mutations separate from personal governance', async t => {
  const f = await fixture(t);
  const input = { repository_codes: [source], idempotency_key: 'hosted-tool-fixture' };
  assert.equal((await f.tool('request_code_analysis', input)).code, 0);
  const frames = await f.mcp([{ id: 2, method: 'tools/call', params: { name: 'request_code_analysis', arguments: input } },
    { id: 3, method: 'tools/call', params: { name: 'get_code_analysis_status', arguments: { job_code: run } } },
    { id: 4, method: 'tools/call', params: { name: 'get_code_analysis_status', arguments: {} } }]);
  assert.ok(frames.slice(1).every(frame => frame.result && !frame.result.isError));
  assert.deepEqual(f.requests.slice(0, 2).map(({ method, path, body }) => ({ method, path, body })), Array.from({ length: 2 }, () => ({ method: 'POST', path: `/projects/${project}/code-understanding/analyses`, body: input })));
  assert.equal(f.requests[2].path, `/projects/${project}/code-understanding/analyses/${run}`);
  assert.equal(f.requests[3].path, `/projects/${project}/code-understanding/analyses`);
  const before = f.requests.length;
  assert.notEqual((await f.tool('request_code_analysis', { ...input, local_path: 'C:\\private' })).code, 0);
  assert.equal(f.requests.length, before, 'tool inputs cannot inject local paths or a foreign project');
  f.deny();
  assert.notEqual((await f.tool('request_code_analysis', input)).code, 0, 'the server remains the final authorization gate');
});

test('docs creation and upload help and MCP discovery direct each kind of evidence to its owner', async t => {
  const f = await fixture(t);
  const frames = await f.mcp([{ id: 2, method: 'tools/list' }]);
  const guidance = [frames[1].result.tools.find(item => item.name === 'list_project_materials').description];
  for (const args of [['docs', '--help'], ['docs', 'create', '--help'], ['docs', 'upload', '--help']]) {
    const help = await f.command(args);
    assert.equal(help.code, 0, help.err);
    guidance.push(help.out);
  }
  for (const message of guidance) {
    assert.match(message, /长期复用/);
    assert.match(message, /源码包[^。；\n]*tsp task submit/);
    assert.match(message, /日志[^。；\n]*tsp test execution record/);
    assert.match(message, /截图[^。；\n]*tsp defect report/);
  }
  assert.equal(f.requests.length, 0, 'help and model tool discovery are local reads');
});

test('CLI and stdio MCP read the same skill directory and Unicode pages from the real project API', {
  skip: !process.env.TSP_TEST_RUN_FILE && 'Run with scripts/run-tests.mjs to create an isolated PostgreSQL database',
}, async t => {
  const { createHttpTestContext, insertUser, insertTeam, insertMember } = await import('./http-test-helpers.mjs');
  const { schema } = await import('@team-synergy/persistence');
  const { createSkillsUseCases } = await import('@team-synergy/application');
  const context = await createHttpTestContext(import.meta.url);
  t.after(() => context.cleanup());
  const owner = await insertUser(context.db, { account: 'reader.owner', displayName: 'Owner' });
  const viewer = await insertUser(context.db, { account: 'reader.viewer', displayName: 'Viewer' });
  const team = await insertTeam(context.db, { name: 'Reader team' });
  const [project] = await context.db.insert(schema.projects).values({ team_id: team.id, name: 'Reader project', owner_principal_id: owner.id,
    member_policy: 'private', created_at: '2026-11-12T00:00:00Z' }).returning();
  await insertMember(context.db, { principalId: viewer.id, projectId: project.id, role: 'viewer', displayName: 'Viewer' });
  await context.db.insert(schema.devices).values({ principal_id: viewer.id, device_name: 'Fixture device',
    credential_hash: createHash('sha256').update('member-device').digest('hex'), created_at: '2026-11-12T00:00:00Z' });
  const skills = createSkillsUseCases(context.db);
  const actor = { principalCode: owner.code };
  const file = (path, content) => ({ path, content_base64: Buffer.from(content).toString('base64') });
  const entry = '---\nname: reader\ndescription: Fixture reading guide\n---\nRead references/guide.md';
  const reference = '甲🙂乙丙';
  const script = 'FIXTURE_SCRIPT_BODY_MARKER';
  const binary = Buffer.from([0xff, 0x80, 0]);
  const files = [file('SKILL.md', entry), file('references/guide.md', reference), file('scripts/check.sh', script), file('assets/fixture.bin', binary)];
  const ok = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.data; };
  for (const [generation, alias] of ['first', 'second'].entries()) {
    const skill = ok(await skills.createSkill({ ...actor, input: { scope_type: 'project', scope_code: project.code, files } }));
    ok(await skills.publishSkill({ ...actor, code: skill.code, revision: 1 }));
    ok(await skills.installSkill({ ...actor, projectCode: project.code, code: skill.code, input: { alias, revision: 1, enabled: true, base_generation: generation } }));
  }
  const f = workspaceClient(t, context.apiUrl, project.code);
  async function both(name, args) {
    const [command, frames] = await Promise.all([f.tool(name, args), f.mcp([{ id: 2, method: 'tools/call', params: { name, arguments: args } }])]);
    assert.equal(command.code, 0, command.out + command.err);
    assert.deepEqual(frames[1].result, command.json().data);
    return JSON.parse(frames[1].result.content[0].text);
  }
  const first = await both('list_project_skills', { limit: 1 });
  const second = await both('list_project_skills', { limit: 1, offset: first.nextOffset });
  assert.deepEqual([first.items[0].alias, second.items[0].alias, first.nextOffset, second.nextOffset], ['first', 'second', 1, null]);
  assert.equal(first.items[0].revision, 1);
  assert.doesNotMatch(JSON.stringify(first), /files|scripts\/check\.sh|FIXTURE_SCRIPT_BODY_MARKER|content_base64/);
  const selected = { skill: first.items[0].skill_code, revision: first.items[0].revision };
  const guide = await both('read_project_skill', selected);
  assert.equal(guide.content, entry);
  assert.ok(guide.paths.includes('references/guide.md'));
  const referencePath = 'references/guide.md';
  const page = await both('read_project_skill', { ...selected, path: referencePath, limit: 2 });
  const last = await both('read_project_skill', { ...selected, path: referencePath, limit: 2, offset: page.nextOffset });
  assert.equal(page.content, '甲🙂');
  assert.equal(page.content + last.content, reference);
  assert.equal(last.nextOffset, null);
  assert.equal(last.sha256, createHash('sha256').update(reference).digest('hex'));
  const attachment = await both('read_project_skill', { ...selected, path: 'assets/fixture.bin' });
  assert.equal(attachment.encoding, 'binary');
  assert.ok(!('content' in attachment));
  assert.equal(attachment.download, `tsp skill sync --project ${project.code}`);
  const sync = await f.command(attachment.download.split(' ').slice(1));
  assert.equal(sync.code, 0, sync.out + sync.err);
  assert.deepEqual(readFileSync(path.join(sync.json().data.skills_directory, 'first', 'assets', 'fixture.bin')), binary);
  ok(await skills.reviseSkill({ ...actor, code: selected.skill, input: { base_revision: 1, files, change_summary: 'Second release' } }));
  ok(await skills.publishSkill({ ...actor, code: selected.skill, revision: 2 }));
  ok(await skills.installSkill({ ...actor, projectCode: project.code, code: selected.skill,
    input: { alias: 'first', revision: 2, enabled: true, base_generation: 2 } }));
  const staleCLI = await f.tool('read_project_skill', selected);
  assert.equal(staleCLI.json().error.code, 'skill_revision_conflict');
  const staleMCP = await f.mcp([{ id: 2, method: 'tools/call', params: { name: 'read_project_skill', arguments: selected } }]);
  assert.equal(staleMCP[1].result.isError, true);
  assert.match(staleMCP[1].result.content[0].text, /skill_revision_conflict/);
});

test('explicit governance checks project applicability before writing and never returns history or withdrawn text', async t => {
  const f = await fixture(t);
  const edited = await f.tool('edit_personal_memory', { source, expectedRevision: 1, text: '先列验证证据' }, ['--allow-personal-management']);
  assert.equal(edited.code, 0, edited.out + edited.err);
  const view = JSON.parse(edited.json().data.content[0].text);
  assert.equal(view.revision, 2); assert.equal(view.currentSourcesVerified, false);
  assert.equal('history' in view, false); assert.ok(!edited.out.includes('历史私密哨兵'));
  const frames = await f.mcp([{ id: 2, method: 'tools/call', params: { name: 'withdraw_personal_memory', arguments: { source, expectedRevision: 2 } } }], ['--allow-personal-management']);
  const withdrawn = JSON.parse(frames[1].result.content[0].text);
  assert.equal(withdrawn.status, 'withdrawn'); assert.equal('text' in withdrawn, false); assert.equal('history' in withdrawn, false);
  assert.equal((await f.tool('edit_personal_memory', { source, expectedRevision: 2, text: 'stale' }, ['--allow-personal-management'])).json().error.code, 'memory_source_changed');
  f.foreignPersonal(); const before = f.requests.length;
  assert.equal((await f.tool('edit_personal_memory', { source, expectedRevision: 3, text: 'foreign' }, ['--allow-personal-management'])).json().error.code, 'memory_scope_mismatch');
  assert.deepEqual(f.requests.slice(before).map(row => row.method), ['GET'], 'foreign applicability is rejected before mutation');
});

test('remote tour context is tied to the node page so unrelated overview text cannot defeat pagination', async t => {
  const f = await fixture(t);
  f.override({ nodes: [{ id: 'selected', run_code: run }], tour: Array.from({ length: 40 }, (_, n) => ({
    title: String(n), description: 'x'.repeat(4000), run_code: run, node_ids: ['selected'] })), evidence: [] });
  const result = await f.tool('query_code_graph', { run_code: run, limit: 1 });
  assert.equal(result.code, 0, result.out + result.err);
  const value = JSON.parse(result.json().data.content[0].text);
  assert.equal(value.tour_truncated, true); assert.equal(value.tour_scope, 'selected_nodes'); assert.ok(result.out.length < 20000);
});

test('all four material operations and code queries use identical inputs and results across transports', async t => {
  const f = await fixture(t);
  const cases = [
    ['list_project_materials', {}], ['glob_project_materials', { pattern: 'requirement/**' }],
    ['grep_project_materials', { pattern: '审核', contextLines: 2 }],
    ['read_project_material', { sourceCitation: source, limit: 600 }],
    ['read_code_catalog', {}], ['query_code_graph', { run_code: run, query: 'refund', limit: 5 }],
  ];
  for (const [name, args] of cases) {
    const fromCli = await f.tool(name, args); assert.equal(fromCli.code, 0, fromCli.err);
    const frames = await f.mcp([{ id: 2, method: 'tools/call', params: { name, arguments: args } }]);
    assert.deepEqual(fromCli.json().data, frames[1].result);
    assert.deepEqual(f.requests.at(-1), f.requests.at(-2), name);
  }
  const aliases = [
    [['docs', 'index'], 'list_project_materials', {}],
    [['docs', 'glob', 'project/**'], 'glob_project_materials', { pattern: 'project/**' }],
    [['docs', 'grep', '退款', '--mode', 'regex'], 'grep_project_materials', { pattern: '退款', mode: 'regex' }],
    [['docs', 'read', `project/${source}.md`, '--start-line', '2'], 'read_project_material', { path: `project/${source}.md`, startLine: 2 }],
  ];
  for (const [command, name, args] of aliases) {
    const result = await f.command(command); assert.equal(result.code, 0, result.out + result.err);
    assert.deepEqual(result.json().data, (await f.tool(name, args)).json().data);
  }
});

test('invalid selectors, injected actors, disabled mutations and authorization failures fail closed', async t => {
  const f = await fixture(t);
  for (const [name, args] of [
    ['read_project_skill', { skill: source }], ['list_project_skills', { project: source }],
    ['read_project_material', { path: '../private' }], ['read_project_material', { sourceCitation: source, path: 'project/*' }],
    ['grep_project_materials', { pattern: 'refund', principalCode: 'other' }],
    ['query_code_graph', { run_code: run, view_code: source }],
    ['edit_personal_memory', { source, expectedRevision: 1, text: '中文' }],
  ]) {
    const cliResult = await f.tool(name, args); assert.equal(cliResult.json().error.code, 'agent_invalid_input');
    const frames = await f.mcp([{ id: 2, method: 'tools/call', params: { name, arguments: args } }]);
    assert.equal(frames[1].error.code, -32602);
  }
  assert.equal(f.requests.length, 0);
  f.deny();
  assert.equal((await f.tool('list_project_materials', {})).json().error.code, 'project_forbidden');
  const frames = await f.mcp([{ id: 2, method: 'tools/call', params: { name: 'list_project_materials', arguments: {} } }]);
  assert.equal(frames[1].result.isError, true); assert.match(frames[1].result.content[0].text, /project_forbidden/);
});

test('local code never opens another project run or silently substitutes a missing snapshot; oversize results ask for pagination', async t => {
  const f = await fixture(t);
  const dir = path.join(f.cwd, '.agent', 'code-understanding', 'runs', run); mkdirSync(dir, { recursive: true });
  const local = { schema_version: 1, project_code: source, repository_code: source, run_code: run, snapshot: null, batch: { id: 'ua-overview' } };
  writeFileSync(path.join(dir, 'run.json'), JSON.stringify(local));
  assert.equal((await f.tool('query_local_code', { run, command: 'context', query: 'refund' })).json().error.code, 'code_project_mismatch');
  assert.equal(f.requests.length, 0, 'foreign run rejected before any query execution');
  local.project_code = project; writeFileSync(path.join(dir, 'run.json'), JSON.stringify(local));
  assert.equal((await f.tool('query_local_code', { run, command: 'context', query: 'refund' })).json().error.code, 'code_snapshot_mismatch');
  f.oversize();
  assert.equal((await f.tool('read_code_catalog', {})).json().error.code, 'agent_output_too_large');
});
