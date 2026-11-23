import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const projectA = 'A'.repeat(20), projectB = 'B'.repeat(20), forbidden = 'C'.repeat(20);
const sourceA = 'S'.repeat(20), sourceB = 'T'.repeat(20);
const personalAccount = { source: 'N'.repeat(20), revisionSource: 'V'.repeat(20), revision: 1,
  text: 'Account preference only', status: 'active', applicability: 'account', projectCode: projectA,
  provenance: {}, projection: { status: 'pending', operation: 'upsert', cleanupPending: true }, history: [{ text: 'PRIVATE-HISTORY-SENTINEL' }] };
const personalProject = { ...personalAccount, source: 'W'.repeat(20), revisionSource: 'X'.repeat(20),
  text: 'FOREIGN-PROJECT-PREFERENCE-SENTINEL', applicability: 'project', projectCode: projectB };
const personalOriginProject = { ...personalProject, source: 'H'.repeat(20), revisionSource: 'J'.repeat(20),
  text: 'ORIGIN-PROJECT-ONLY-SENTINEL', projectCode: projectA };
const personalWithdrawn = { ...personalAccount, source: 'K'.repeat(20), revisionSource: 'M'.repeat(20),
  text: 'WITHDRAWN-PRIVATE-SENTINEL', status: 'withdrawn' };
const personalOtherAccount = { ...personalAccount, source: 'P'.repeat(20), revisionSource: 'Q'.repeat(20), text: 'OTHER-ACCOUNT-PRIVATE-SENTINEL' };
const parseContent = reply => {
  assert.ok(reply.result && !reply.result.isError, JSON.stringify(reply));
  return reply.result.content.filter(block => block.type === 'text').map(block => JSON.parse(block.text));
};
const toolError = (reply, pattern) => {
  assert.equal(reply.result?.isError, true, JSON.stringify(reply));
  assert.match(reply.result.content.map(block => block.text).join('\n'), pattern);
};

async function fixture(t, { auth = true, bound } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'tsp-mcp-connection-'));
  const cwd = path.join(root, 'unbound-startup'), account = path.join(root, 'account');
  mkdirSync(cwd); mkdirSync(account);
  const requests = [], children = new Set();
  const personalRecords = [personalAccount, personalProject, personalOriginProject, personalWithdrawn]
    .map(row => ({ actor: 'member', row })).concat({ actor: 'another-member', row: personalOtherAccount });
  const ownedPersonal = () => personalRecords.filter(entry => entry.actor === 'member').map(entry => entry.row);
  const personalEvidence = code => ownedPersonal().filter(row => row.status === 'active' && (row.applicability === 'account' || row.projectCode === code))
    .map(row => ({ source: row.revisionSource, scope: 'personal', state: 'preference', text: row.text, sourceRevision: row.revision }));
  const rows = {
    [projectA]: { source: sourceA, scope: 'project', state: 'confirmed', text: 'Alpha-only shared memory' },
    [projectB]: { source: sourceB, scope: 'project', state: 'discussed', text: 'Beta-only shared memory' },
  };
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    let raw = ''; for await (const part of req) raw += part;
    const url = new URL(req.url, 'http://fixture.invalid');
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body });
    const answer = data => res.end(JSON.stringify({ ok: true, data }));
    if (!['Bearer device-token-1', 'Bearer device-token-2'].includes(req.headers.authorization)) {
      res.statusCode = 401; res.end(JSON.stringify({ ok: false, error: { code: 'login_required', message: 'Login required' } })); return;
    }
    if (url.pathname === '/skills/platform/reader') {
      answer(url.searchParams.has('skill') ? { skill_code: sourceA, revision: 1, scope_type: 'platform', content: 'Platform-only guide' }
        : { items: [{ skill_code: sourceA, revision: 1, scope_type: 'platform' }], total: 1, nextOffset: null }); return;
    }
    if (url.pathname === '/auth/whoami') { answer({ user_code: 'member', account: 'member', display_name: 'Member', status: 'active' }); return; }
    if (url.pathname === '/memory/personal') {
      const origin = url.searchParams.get('projectCode'), status = url.searchParams.get('status') ?? 'active';
      answer({ items: ownedPersonal().filter(row => (!origin || row.projectCode === origin) && (status === 'all' || row.status === status)), truncated: false }); return;
    }
    if (url.pathname.startsWith('/memory/personal/')) {
      const row = ownedPersonal().find(row => url.pathname === '/memory/personal/' + row.source);
      if (row) { answer(row); return; }
    }
    if (url.pathname === '/projects') {
      answer([{ project_code: projectA, name: 'Alpha', team_code: 'D'.repeat(20), status: 'active' },
        { project_code: projectB, name: 'Beta', team_code: 'D'.repeat(20), status: 'active' }]); return;
    }
    const match = url.pathname.match(/^\/projects\/([^/]+)(.*)$/u);
    if (match && [projectA, projectB].includes(match[1])) {
      const code = match[1], suffix = match[2];
      if (suffix === '') { answer({ project_code: code, name: code === projectA ? 'Alpha' : 'Beta', status: 'active' }); return; }
      if (suffix === '/code-understanding/context') {
        answer({ project_code: code, repositories: [{ code: 'R'.repeat(20), name: code === projectA ? 'alpha-repo' : 'beta-repo' }], runs: [] }); return;
      }
      if (suffix === '/memory/binding') { answer({}); return; }
      if (suffix === '/memory/brief') { answer(body.scope === 'personal' ? personalEvidence(code) : [rows[code]]); return; }
      if (suffix === '/memory/sources') { answer([rows[code], ...personalEvidence(code)].filter(row => body.sources.includes(row.source))); return; }
      if (suffix === '/materials/list') { answer({ project_code: code, items: [{ title: code === projectA ? 'Alpha guide' : 'Beta guide' }] }); return; }
    }
    res.statusCode = 403;
    res.end(JSON.stringify({ ok: false, error: { code: 'project_forbidden', message: 'Project unavailable' } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const api = 'http://127.0.0.1:' + server.address().port;
  function writeAuth(token = 'device-token-1') {
    writeFileSync(path.join(account, 'auth.json'), JSON.stringify({ api_url: api, device_token: token,
      device_code: 'device', user_code: 'member', device_name: 'test' }));
  }
  function bind(code) {
    mkdirSync(path.join(cwd, '.agent'), { recursive: true });
    writeFileSync(path.join(cwd, '.agent', 'bound-project.yaml'),
      `project_code: ${code}\napi_url: ${api}\nbound_at: test\n`);
  }
  if (auth) writeAuth();
  if (bound) bind(bound);
  const env = { ...process.env, AGENTCTL_HOME: account, ACP_API_URL: api };
  delete env.TSP_MEMORY_SESSION; delete env.TSP_MEMORY_CONTEXT_MODE;
  t.after(async () => {
    const closing = [...children].map(child => once(child, 'close'));
    for (const child of children) { child.stdin.end(); child.kill(); }
    await Promise.allSettled(closing);
    await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('tsp-mcp-connection-'));
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  async function command(args) {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env, windowsHide: true });
    children.add(child);
    let out = '', err = '';
    child.stdout.setEncoding('utf8').on('data', data => out += data);
    child.stderr.setEncoding('utf8').on('data', data => err += data);
    const closing = once(child, 'close'); child.stdin.end();
    const [code] = await closing; children.delete(child);
    return { code, out, err, json: () => JSON.parse(out) };
  }
  async function mcp(flags = [], alias = false) {
    const child = spawn(process.execPath, [cli, ...(alias ? ['memory', 'mcp'] : ['mcp']), ...flags], { cwd, env, windowsHide: true });
    children.add(child);
    const pending = new Map(); let nextId = 0, err = '';
    child.stderr.setEncoding('utf8').on('data', data => err += data);
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      let frame; try { frame = JSON.parse(line); } catch { return; }
      const waiter = pending.get(frame.id);
      if (waiter) { pending.delete(frame.id); clearTimeout(waiter.timer); waiter.resolve(frame); }
    });
    child.on('close', code => {
      children.delete(child);
      for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error(`MCP exited ${code}: ${err}`)); }
      pending.clear();
    });
    function rpc(method, params = {}) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP ${method} timeout: ${err}`)); }, 5000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    }
    const initialized = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.ok(initialized.result?.capabilities?.tools);
    return { rpc, call: (name, args) => rpc('tools/call', { name, arguments: args }), close: () => child.stdin.end() };
  }
  return { cwd, account, requests, api, command, mcp, writeAuth, bind,
    assertUnbound: () => assert.equal(existsSync(path.join(cwd, '.agent')), false) };
}

test('unbound and unauthenticated MCP initializes, discovers tools and provides login guidance without filesystem writes', async t => {
  const f = await fixture(t, { auth: false });
  const client = await f.mcp();
  const tools = (await client.rpc('tools/list')).result.tools;
  for (const name of ['get_connection_context', 'list_projects', 'read_code_catalog']) assert.ok(tools.some(tool => tool.name === name), name);
  assert.equal(tools.find(tool => tool.name === 'get_connection_context').annotations.readOnlyHint, true);
  toolError(await client.call('list_platform_skills', {}), /login_required/u);
  const context = parseContent(await client.call('get_connection_context', {}));
  assert.match(JSON.stringify(context), /login|登录/iu);
  assert.equal(f.requests.length, 0);
  f.assertUnbound();
});

test('authenticated unbound discovery lists authorized projects without selecting or binding one', async t => {
  const f = await fixture(t), client = await f.mcp();
  const context = parseContent(await client.call('get_connection_context', {}));
  assert.match(JSON.stringify(context), /member/u);
  assert.doesNotMatch(JSON.stringify(context), /device-token-1/u);
  const projects = parseContent(await client.call('list_projects', { query: 'Alpha', limit: 1 }));
  assert.match(JSON.stringify(projects), /Alpha/u); assert.doesNotMatch(JSON.stringify(projects), /Beta/u);
  toolError(await client.call('read_code_catalog', {}), /project_selection_required/u);
  assert.ok(f.requests.some(request => request.path === '/projects'));
  assert.equal(f.requests.some(request => request.path.includes('/code-understanding/')), false);
  f.assertUnbound();
});

test('CLI preserves the stdio tool schemas and also lists the HTTP Connector workspace actions', async t => {
  const f = await fixture(t), client = await f.mcp();
  const listed = await f.command(['tools', 'list']); assert.equal(listed.code, 0, listed.err);
  const legacy = (await client.rpc('tools/list')).result.tools;
  const legacyNames = new Set(legacy.map(tool => tool.name));
  assert.deepEqual(legacy, listed.json().data.filter(tool => legacyNames.has(tool.name)));
  assert.ok(listed.json().data.some(tool => tool.name === 'create_project' && tool.inputSchema.required.includes('team_code')));
  const projectTool = listed.json().data.find(tool => tool.name === 'read_code_catalog');
  assert.ok(projectTool.inputSchema.properties.projectCode);
  assert.equal(projectTool.inputSchema.required?.includes('projectCode') ?? false, false);
  const managed = await f.command(['tools', 'list', '--allow-personal-management']);
  const managedClient = await f.mcp(['--allow-personal-management']);
  const managedLegacy = (await managedClient.rpc('tools/list')).result.tools;
  const managedLegacyNames = new Set(managedLegacy.map(tool => tool.name));
  assert.deepEqual(managedLegacy, managed.json().data.filter(tool => managedLegacyNames.has(tool.name)));
  f.assertUnbound();
});

test('per-call projects are isolated and never become an implicit default', async t => {
  const f = await fixture(t), client = await f.mcp();
  assert.match(JSON.stringify(parseContent(await client.call('read_code_catalog', { projectCode: projectA }))), /alpha-repo/u);
  assert.match(JSON.stringify(parseContent(await client.call('read_code_catalog', { projectCode: projectB }))), /beta-repo/u);
  assert.match(JSON.stringify(parseContent(await client.call('read_code_catalog', { projectCode: projectA }))), /alpha-repo/u);
  toolError(await client.call('read_code_catalog', {}), /project_selection_required/u);
  assert.deepEqual(f.requests.filter(request => request.path.endsWith('/code-understanding/context')).map(request => request.path),
    [projectA, projectB, projectA].map(code => `/projects/${code}/code-understanding/context`));
  f.assertUnbound();
});

test('missing, malformed and unauthorized projects fail closed while the MCP connection stays usable', async t => {
  const f = await fixture(t), client = await f.mcp();
  toolError(await client.call('read_code_catalog', {}), /project_selection_required/u);
  const before = f.requests.length;
  const invalid = await client.call('read_code_catalog', { projectCode: '../../private' });
  assert.ok(invalid.error || invalid.result?.isError, JSON.stringify(invalid));
  assert.equal(f.requests.length, before, 'invalid project input must fail before HTTP');
  toolError(await client.call('read_code_catalog', { projectCode: forbidden }), /project_forbidden/u);
  assert.match(JSON.stringify(parseContent(await client.call('read_code_catalog', { projectCode: projectA }))), /alpha-repo/u);
  f.assertUnbound();
});

test('startup --project works from an unbound cwd for both MCP entry points', async t => {
  const f = await fixture(t);
  for (const alias of [false, true]) {
    const client = await f.mcp(['--project', projectA], alias);
    assert.match(JSON.stringify(parseContent(await client.call('read_code_catalog', {}))), /alpha-repo/u);
    assert.match(JSON.stringify(parseContent(await client.call('read_code_catalog', { projectCode: projectB }))), /beta-repo/u);
    assert.match(JSON.stringify(parseContent(await client.call('read_code_catalog', {}))), /alpha-repo/u);
    client.close();
  }
  f.assertUnbound();
});

test('CLI explicit project flag and common projectCode input share MCP semantics and reject conflicts', async t => {
  const f = await fixture(t);
  const flag = await f.command(['tools', 'call', 'read_code_catalog', '--project', projectA]);
  assert.equal(flag.code, 0, flag.err); assert.match(flag.out, /alpha-repo/u);
  const input = await f.command(['tools', 'call', 'read_code_catalog', '--input', JSON.stringify({ projectCode: projectB })]);
  assert.equal(input.code, 0, input.err); assert.match(input.out, /beta-repo/u);
  const before = f.requests.length;
  const conflicting = await f.command(['tools', 'call', 'read_code_catalog', '--project', projectA,
    '--input', JSON.stringify({ projectCode: projectB })]);
  assert.notEqual(conflicting.code, 0); assert.equal(f.requests.length, before);
  f.assertUnbound();
});

test('account credential changes invalidate an already authenticated MCP connection', async t => {
  const f = await fixture(t), client = await f.mcp();
  parseContent(await client.call('read_code_catalog', { projectCode: projectA }));
  f.writeAuth('device-token-2');
  toolError(await client.call('read_code_catalog', { projectCode: projectA }), /memory_binding_changed/u);
  toolError(await client.call('list_projects', {}), /memory_binding_changed/u);
});

test('existing workspace defaults remain compatible and reject silent binding changes', async t => {
  const f = await fixture(t, { bound: projectA }), client = await f.mcp();
  parseContent(await client.call('read_code_catalog', {}));
  f.bind(projectB);
  toolError(await client.call('read_code_catalog', {}), /memory_binding_changed/u);
  assert.equal(f.requests.some(request => request.path === `/projects/${projectB}/code-understanding/context`), false);
});

test('memory receipts cannot cross per-call project boundaries', async t => {
  const f = await fixture(t), client = await f.mcp();
  const alpha = parseContent(await client.call('read_memory_brief', { scope: 'project', projectCode: projectA }));
  const receipt = alpha.find(block => typeof block?.context_receipt === 'string')?.context_receipt;
  assert.ok(receipt);
  const beta = parseContent(await client.call('read_memory_brief', { scope: 'project', projectCode: projectB }));
  assert.match(JSON.stringify(beta), /Beta-only/u); assert.doesNotMatch(JSON.stringify(beta), /Alpha-only/u);
  toolError(await client.call('read_memory_brief', { scope: 'project', projectCode: projectB, context_receipt: receipt }), /memory_context_mismatch/u);
  const continued = parseContent(await client.call('read_memory_brief', { scope: 'project', projectCode: projectA, context_receipt: receipt }));
  assert.ok(continued.some(block => block.unchanged_sources?.some(source => source.source === sourceA)));
  f.assertUnbound();
});

test('account-wide personal reads work unbound while project preferences and historical text stay excluded', async t => {
  const f = await fixture(t), client = await f.mcp();
  const listed = parseContent(await client.call('list_personal_memories', {}));
  assert.match(JSON.stringify(listed), /Account preference only/u);
  assert.doesNotMatch(JSON.stringify(listed), /FOREIGN-PROJECT-PREFERENCE-SENTINEL|ORIGIN-PROJECT-ONLY-SENTINEL|PRIVATE-HISTORY-SENTINEL|WITHDRAWN-PRIVATE-SENTINEL|OTHER-ACCOUNT-PRIVATE-SENTINEL/u);
  const read = parseContent(await client.call('read_personal_memory', { source: personalAccount.source }));
  assert.match(JSON.stringify(read), /Account preference only/u);
  assert.doesNotMatch(JSON.stringify(read), /PRIVATE-HISTORY-SENTINEL/u);
  toolError(await client.call('read_personal_memory', { source: personalProject.source }), /memory_scope_mismatch|project_selection_required/u);
  assert.equal(f.requests.some(request => request.path.startsWith('/projects/')), false);
  f.assertUnbound();
});

test('selected project personal lists include cross-origin account preferences and only its own project preferences', async t => {
  const f = await fixture(t), client = await f.mcp();
  const [listed] = parseContent(await client.call('list_personal_memories', { projectCode: projectB }));
  assert.deepEqual(listed.items.map(row => row.source), [personalAccount.source, personalProject.source]);
  assert.doesNotMatch(JSON.stringify(listed), /ORIGIN-PROJECT-ONLY-SENTINEL|PRIVATE-HISTORY-SENTINEL|WITHDRAWN-PRIVATE-SENTINEL|OTHER-ACCOUNT-PRIVATE-SENTINEL/u);
  const [known] = parseContent(await client.call('read_personal_memory', { projectCode: projectB, source: personalAccount.source }));
  const [brief] = parseContent(await client.call('read_memory_brief', { projectCode: projectB, scope: 'personal' }));
  assert.deepEqual(listed.items.map(row => ({ source: row.revisionSource, text: row.text })), brief.map(row => ({ source: row.source, text: row.text })));
  assert.equal(listed.items[0].revisionSource, known.revisionSource);
  toolError(await client.call('read_personal_memory', { projectCode: projectB, source: personalOriginProject.source }), /memory_scope_mismatch/u);
  toolError(await client.call('read_personal_memory', { projectCode: projectB, source: personalOtherAccount.source }), /project_forbidden/u);
  const sourceRequests = f.requests.filter(request => request.path === `/projects/${projectB}/memory/sources`);
  assert.deepEqual(sourceRequests[0].body.sources, [personalAccount.revisionSource, personalProject.revisionSource]);
  assert.deepEqual(f.requests.filter(request => request.path === '/memory/personal').map(request => request.query), [{ status: 'active' }]);
  f.assertUnbound();
});

test('global built-in tools use account authentication without resolving even a malformed startup project', async t => {
  const f = await fixture(t), client = await f.mcp(['--project', 'invalid-project']);
  const tools = (await client.rpc('tools/list')).result.tools;
  assert.equal('projectCode' in tools.find(tool => tool.name === 'list_platform_skills').inputSchema.properties, false);
  const [catalog] = parseContent(await client.call('list_platform_skills', {}));
  assert.equal(catalog.items[0].scope_type, 'platform');
  const input = { skill: sourceA, revision: 1 };
  const cliRead = (await f.command(['tools', 'call', 'read_platform_skill', '--input', JSON.stringify(input)])).json();
  assert.deepEqual(parseContent(await client.call('read_platform_skill', input)), [JSON.parse(cliRead.data.content[0].text)]);
  assert.ok(f.requests.every(request => request.path === '/skills/platform/reader'));
  f.assertUnbound();
  f.writeAuth('device-token-2');
  toolError(await client.call('list_platform_skills', {}), /memory_binding_changed/u);
});


test('read-only MCP cannot discover or invoke mutations or override its selected project', async t => {
  const f = await fixture(t, { bound: projectB });
  const client = await f.mcp(['--read-only', '--project', projectA, '--lock-project']);
  const available = (await client.rpc('tools/list')).result.tools;
  assert.ok(available.length > 0);
  assert.ok(available.every(tool => tool.annotations.readOnlyHint === true));
  assert.equal(available.some(tool => ['request_code_analysis', 'edit_personal_memory', 'withdraw_personal_memory'].includes(tool.name)), false);
  for (const name of ['request_code_analysis', 'edit_personal_memory', 'withdraw_personal_memory']) {
    const denied = await client.call(name, { projectCode: projectA });
    assert.equal(denied.error?.code, -32602);
    assert.match(denied.error.message, /Unknown or disabled tool/u);
  }
  toolError(await client.call('list_project_materials', { projectCode: projectB }), /agent_project_scope_mismatch/u);
  assert.equal(f.requests.length, 0);
  const projects = parseContent(await client.call('list_projects', {}))[0];
  assert.deepEqual(projects.items.map(row => row.projectCode), [projectA]);
  const materials = parseContent(await client.call('list_project_materials', {}))[0];
  assert.equal(materials.project_code, projectA);
  const auth = await f.command(['mcp', '--read-only', '--allow-personal-management']);
  assert.notEqual(auth.code, 0);
  assert.match(auth.err, /agent_options_conflict/u);
});

test('one-click OpenCode connection is interactive, idempotent and preserves unrelated settings and binding', async t => {
  const f = await fixture(t, { bound: projectB });
  const home = path.join(f.account, 'opencode-fixture');
  mkdirSync(home);
  const file = path.join(home, 'opencode.json');
  const before = { $schema: 'https://opencode.ai/config.json', mcp: { foreign: { type: 'remote', url: 'https://example.test' } }, plugin: ['external'] };
  writeFileSync(file, JSON.stringify(before));
  const args = ['agent', 'connect', '--harness', 'opencode', '--host-home', home, '--project', projectA];
  const first = await f.command(args);
  assert.equal(first.code, 0, first.out || first.err);
  assert.deepEqual(first.json().data, {
    harness: 'opencode', projectCode: projectA, workspace: f.cwd, serverName: 'team_synergy_local',
    status: 'configured', access: 'interactive', capture: 'not_requested', restartRequired: true,
  });
  const current = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(existsSync(path.join(f.cwd, 'opencode.json')), false);
  assert.deepEqual(current.mcp.foreign, before.mcp.foreign);
  assert.deepEqual(current.plugin, before.plugin);
  assert.deepEqual(current.mcp.team_synergy_local.command.slice(-4), ['mcp', '--project', projectA, '--lock-project']);
  assert.deepEqual(current.mcp.team_synergy_local.environment, { AGENTCTL_HOME: f.account });
  const client = await f.mcp(current.mcp.team_synergy_local.command.slice(3));
  const catalog = (await client.rpc('tools/list')).result.tools;
  assert.ok(catalog.some(tool => tool.name === 'request_code_analysis' && tool.annotations.readOnlyHint === false));
  assert.ok(catalog.some(tool => tool.name === 'read_personal_memory' && tool.annotations.readOnlyHint === true));
  assert.ok(!catalog.some(tool => ['edit_personal_memory', 'withdraw_personal_memory'].includes(tool.name)));
  assert.equal(existsSync(path.join(f.account, 'memory-harness')), false);
  assert.match(readFileSync(path.join(f.cwd, '.agent', 'bound-project.yaml'), 'utf8'), new RegExp(projectB, 'u'));
  const second = await f.command(args);
  assert.equal(second.code, 0, second.out || second.err);
  assert.equal(second.json().data.status, 'unchanged');
  const dirty = readFileSync(file, 'utf8');
  const different = await f.command([...args.slice(0, -1), projectB]);
  assert.equal(different.json().error.code, 'agent_mcp_conflict');
  assert.equal(readFileSync(file, 'utf8'), dirty);
  assert.ok(f.requests.every(request => request.method === 'GET'));
});

test('one-click capture rejects a conflicting binding or unsupported Claude Code before changing any settings', async t => {
  const f = await fixture(t, { bound: projectB });
  const args = ['agent', 'connect', '--project', projectA, '--capture', '--harness'];
  for (const [harness, errorCode] of [['opencode', 'agent_capture_workspace_mismatch'], ['claudecode', 'agent_capture_unsupported']]) {
    const result = await f.command([...args, harness]);
    assert.notEqual(result.code, 0);
    assert.equal(result.json().error.code, errorCode);
  }
  assert.equal(existsSync(path.join(f.cwd, 'opencode.json')), false);
  assert.equal(existsSync(path.join(f.account, 'memory-harness')), false);
  assert.ok(f.requests.every(request => request.method === 'GET'));
});

test('one-click DSH preserves existing patch entries and registers its local stdio service', async t => {
  const f = await fixture(t);
  const home = path.join(f.account, 'dsh-fixture');
  mkdirSync(home);
  const patchFile = path.join(home, 'cordis.patch.yml'), runtime = path.join(home, 'dsh-fixture.mjs');
  const existing = { insert: [{ id: 'configured-before', name: 'other-plugin' }] };
  writeFileSync(patchFile, JSON.stringify([existing]));
  writeFileSync(runtime, "console.log('dsh 0.2.1-rc.2');\n");
  const args = ['agent', 'connect', '--harness', 'dsh', '--project', projectA, '--host-home', home, '--runtime', runtime];
  const first = await f.command(args);
  assert.equal(first.code, 0, first.out || first.err);
  const [foreign, own] = JSON.parse(readFileSync(patchFile, 'utf8'));
  assert.deepEqual(foreign, existing);
  assert.equal(own.insert[0].name, '@deepseek-ai/dsh-mcp-client');
  assert.deepEqual(own.insert[0].config.args.slice(-4), ['mcp', '--project', projectA, '--lock-project']);
  const repeated = await f.command(args);
  assert.equal(repeated.json().data.status, 'unchanged');
  f.assertUnbound();
});


test('one-click Codex uses the native registration command without changing Hooks', async t => {
  const f = await fixture(t);
  const home = path.join(f.account, 'codex-fixture');
  mkdirSync(home);
  const runtime = path.join(home, 'codex-fixture.mjs'), hooks = path.join(home, 'hooks.json');
  const hookBytes = '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"preserve"}]}]}}';
  writeFileSync(hooks, hookBytes);
  writeFileSync(runtime, [
    "import { readFileSync, writeFileSync } from 'node:fs';",
    "import path from 'node:path';",
    "const file = path.join(process.env.CODEX_HOME, 'servers.json');",
    "const [, method, ...args] = process.argv.slice(2);",
    "let servers; try { servers = JSON.parse(readFileSync(file, 'utf8')); } catch { servers = [{ name: 'unrelated' }]; }",
    "if (method === 'list') console.log(JSON.stringify(servers));",
    "else if (method === 'get') console.log(JSON.stringify(servers.find(row => row.name === args[0])));",
    "else if (method === 'add') {",
    "  const [name, envFlag, env, separator, command, ...mcpArgs] = args;",
    "  if (envFlag !== '--env' || !env.startsWith('AGENTCTL_HOME=') || separator !== '--') process.exit(1);",
    "  servers.push({ name, enabled: true, transport: { type: 'stdio', command, args: mcpArgs, env: { AGENTCTL_HOME: env.slice(14) } } });",
    "  writeFileSync(file, JSON.stringify(servers));",
    "} else process.exit(1);",
  ].join('\n'));
  const args = ['agent', 'connect', '--harness', 'codex', '--project', projectA, '--host-home', home, '--runtime', runtime, '--read-only'];
  const first = await f.command(args);
  assert.equal(first.code, 0, first.out || first.err);
  assert.equal(first.json().data.access, 'read-only');
  assert.deepEqual(JSON.parse(readFileSync(path.join(home, 'servers.json'), 'utf8')).map(row => row.name), ['unrelated', 'team_synergy_local']);
  assert.equal(readFileSync(hooks, 'utf8'), hookBytes);
  assert.equal((await f.command(args)).json().data.restartRequired, false);
  f.assertUnbound();
});

test('explicit DSH capture and its local MCP coexist and do not enqueue any conversation', async t => {
  const f = await fixture(t, { bound: projectA });
  const home = path.join(f.account, 'dsh-opt-in-fixture');
  mkdirSync(home);
  const patchFile = path.join(home, 'cordis.patch.yml'), runtime = path.join(home, 'dsh-fixture.mjs');
  writeFileSync(runtime, "console.log('dsh 0.2.1-rc.2');\n");
  const args = ['agent', 'connect', '--harness', 'dsh', '--project', projectA, '--host-home', home, '--runtime', runtime, '--capture'];
  const first = await f.command(args);
  assert.equal(first.code, 0, first.out || first.err);
  assert.equal(first.json().data.capture, 'configured');
  const patch = JSON.parse(readFileSync(patchFile, 'utf8'));
  assert.equal(patch.length, 2);
  assert.match(patch[0].insert[0].id, /^tsp-memory-auto-/u);
  assert.equal(patch[1].insert[0].id, 'tsp-agent-local');
  const repeated = await f.command(args);
  assert.equal(repeated.code, 0, repeated.out || repeated.err);
  assert.equal(repeated.json().data.capture, 'unchanged');
  assert.equal(repeated.json().data.status, 'unchanged');
  assert.deepEqual(JSON.parse(readFileSync(patchFile, 'utf8')), patch);
  assert.ok(f.requests.every(request => request.method === 'GET'));
});
