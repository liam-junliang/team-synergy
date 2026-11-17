import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    if (url.pathname === '/auth/whoami') { answer({ user_code: 'member', account: 'member', display_name: 'Member', status: 'active' }); return; }
    if (url.pathname === '/memory/personal') { answer({ items: [personalAccount, personalProject], truncated: false }); return; }
    if (url.pathname === '/memory/personal/' + personalAccount.source) { answer(personalAccount); return; }
    if (url.pathname === '/memory/personal/' + personalProject.source) { answer(personalProject); return; }
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
      if (suffix === '/memory/brief') { answer([rows[code]]); return; }
      if (suffix === '/memory/sources') { answer(body.sources.includes(rows[code].source) ? [rows[code]] : []); return; }
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

test('CLI and MCP expose identical project-aware schemas, including optional governance tools', async t => {
  const f = await fixture(t), client = await f.mcp();
  const listed = await f.command(['tools', 'list']); assert.equal(listed.code, 0, listed.err);
  assert.deepEqual((await client.rpc('tools/list')).result.tools, listed.json().data);
  const projectTool = listed.json().data.find(tool => tool.name === 'read_code_catalog');
  assert.ok(projectTool.inputSchema.properties.projectCode);
  assert.equal(projectTool.inputSchema.required?.includes('projectCode') ?? false, false);
  const managed = await f.command(['tools', 'list', '--allow-personal-management']);
  const managedClient = await f.mcp(['--allow-personal-management']);
  assert.deepEqual((await managedClient.rpc('tools/list')).result.tools, managed.json().data);
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
  assert.doesNotMatch(JSON.stringify(listed), /FOREIGN-PROJECT-PREFERENCE-SENTINEL|PRIVATE-HISTORY-SENTINEL/u);
  const read = parseContent(await client.call('read_personal_memory', { source: personalAccount.source }));
  assert.match(JSON.stringify(read), /Account preference only/u);
  assert.doesNotMatch(JSON.stringify(read), /PRIVATE-HISTORY-SENTINEL/u);
  toolError(await client.call('read_personal_memory', { source: personalProject.source }), /memory_scope_mismatch|project_selection_required/u);
  assert.equal(f.requests.some(request => request.path.startsWith('/projects/')), false);
  f.assertUnbound();
});
