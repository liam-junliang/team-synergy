import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const rootSource = '0'.repeat(20), project = '5'.repeat(20), foreignProject = '6'.repeat(20);

async function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'tsp-personal-cli-'));
  const account = path.join(dir, 'account'), cwd = path.join(dir, 'repo');
  mkdirSync(account); mkdirSync(cwd);
  t.after(() => { assert.equal(path.dirname(dir), path.resolve(tmpdir())); rmSync(dir, { recursive: true, force: true }); });
  const requests = [], sourceReads = [];
  let row = { source: rootSource, revisionSource: '1'.repeat(20), revision: 1, text: '提交说明用中文；推送仍按本次授权',
    status: 'active', applicability: 'account', projectCode: project, createdAt: '2026-11-11T00:00:00.000Z', updatedAt: '2026-11-11T00:00:00.000Z',
    provenance: { receiptCode: '4'.repeat(20), sessionId: 'native-chat', eventId: 'operator-1' },
    projection: { status: 'synced', operation: 'upsert', generation: 1, cleanupPending: false }, history: [] };
  row.history.push({ source: row.revisionSource, revision: row.revision, text: row.text, status: row.status, createdAt: row.createdAt });
  let malformed = false, forbidden = false, unavailableSource = false;
  const evidence = () => row.status === 'active' && !unavailableSource && (row.applicability === 'account' || row.projectCode === project)
    ? [{ source: row.revisionSource, scope: 'personal', state: 'preference', text: row.text, sourceRevision: row.revision }] : [];
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer own-device');
    const url = new URL(request.url, 'http://fixture.local');
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body });
    const error = code => { response.end(JSON.stringify({ ok: false, error: { code, message: code } })); };
    let data;
    if (url.pathname === '/memory/personal') {
      assert.equal(request.method, 'GET');
      assert.ok([...url.searchParams.keys()].every(key => ['projectCode', 'status'].includes(key)));
      const status = url.searchParams.get('status') ?? 'active';
      const origin = url.searchParams.get('projectCode');
      data = { items: (status === 'all' || status === row.status) && (!origin || origin === row.projectCode) ? [row] : [], truncated: false };
    } else if (url.pathname.startsWith('/memory/personal/')) {
      const parts = url.pathname.split('/');
      assert.equal(parts[3], rootSource);
      if (forbidden) { error('memory_source_unavailable'); return; }
      if (request.method !== 'GET') {
        assert.deepEqual(Object.keys(body).sort(), (request.method === 'PATCH' ? ['expectedRevision', 'text', ...(body.reason ? ['reason'] : [])] : ['expectedRevision', ...(body.reason ? ['reason'] : [])]).sort());
        if (body.expectedRevision !== row.revision) { error('memory_source_changed'); return; }
        row = { ...row, revision: row.revision + 1, revisionSource: String(row.revision + 1).repeat(20),
          status: request.method === 'PATCH' ? 'active' : 'withdrawn', text: body.text ?? row.text,
          updatedAt: '2026-11-11T00:01:00.000Z',
          projection: { status: 'pending', operation: request.method === 'PATCH' ? 'upsert' : 'delete', generation: row.revision + 1, cleanupPending: true } };
        row.history = [...row.history, { source: row.revisionSource, revision: row.revision, text: row.text, status: row.status, reason: body.reason, createdAt: row.updatedAt }];
      }
      data = malformed ? { ...row, revisionSource: 'wrong' } : row;
    } else if (url.pathname === `/projects/${project}/memory/brief`) {
      assert.equal(body.scope, 'personal'); data = evidence();
    } else if (url.pathname === `/projects/${project}/memory/sources`) {
      sourceReads.push(body.sources); data = evidence().filter(item => body.sources.includes(item.source));
    } else { error('unexpected_fixture_route'); return; }
    response.end(JSON.stringify({ ok: true, data }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  const api = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(path.join(account, 'auth.json'), JSON.stringify({ device_token: 'own-device', device_code: 'own-code', user_code: 'own-user', device_name: 'fixture', api_url: api }));
  const env = { ...process.env, AGENTCTL_HOME: account, ACP_API_URL: api };
  const bind = () => {
    mkdirSync(path.join(cwd, '.agent'), { recursive: true });
    writeFileSync(path.join(cwd, '.agent', 'bound-project.yaml'), `project_code: ${project}\napi_url: ${api}\nbound_at: today\n`);
  };
  const spawnCli = (args, extra = {}) => spawn(process.execPath, [cli, 'memory', ...args], { cwd, env: { ...env, ...extra }, windowsHide: true });
  async function run(args, input = '') {
    const child = spawnCli(args), exited = once(child, 'close');
    let out = ''; child.stdout.setEncoding('utf8').on('data', value => { out += value; }); child.stderr.resume(); child.stdin.end(input);
    const [code] = await exited; return { code, ...JSON.parse(out) };
  }
  async function withMcp(work) {
    bind(); const child = spawnCli(['mcp'], { TSP_MEMORY_SESSION: 'personal-governance-chat' }), exited = once(child, 'close'); child.stderr.resume();
    const reader = createInterface({ input: child.stdout }), lines = reader[Symbol.asyncIterator](); let id = 0;
    const rpc = async (method, params) => {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) + '\n');
      const item = await lines.next(); assert.equal(item.done, false); const result = JSON.parse(item.value); assert.equal(result.id, id); return result;
    };
    try { await rpc('initialize', { protocolVersion: '2025-11-25' }); await work(rpc); }
    finally { child.stdin.end(); await exited; reader.close(); }
  }
  return { run, withMcp, requests, sourceReads, row: () => row, change: fields => { row = { ...row, ...fields }; },
    malformed: () => { malformed = true; }, forbidden: () => { forbidden = true; }, unavailableSource: () => { unavailableSource = true; } };
}

test('account management requires no project binding and preserves source, versions, history and projection state', async t => {
  const f = await fixture(t);
  const first = await f.run(['personal', 'list']); assert.equal(first.ok, true); assert.equal(first.data.items[0].source, rootSource);
  assert.equal(first.data.items[0].revisionSource, '1'.repeat(20));
  const changed = await f.run(['personal', 'edit', rootSource, '--expected-revision', '1', '--reason', '纠正风格'], '  默认先展示diff，推送需本次确认  ');
  assert.equal(changed.data.text, '默认先展示diff，推送需本次确认'); assert.equal(changed.data.revision, 2);
  assert.equal(changed.data.source, rootSource); assert.equal(changed.data.provenance.eventId, 'operator-1');
  assert.equal(changed.data.history.length, 2); assert.equal(changed.data.projection.status, 'pending'); assert.equal(changed.data.projection.cleanupPending, true);
  const stale = await f.run(['personal', 'withdraw', rootSource, '--expected-revision', '1']);
  assert.equal(stale.error.code, 'memory_source_changed'); assert.equal(f.row().revision, 2);
  const withdrawn = await f.run(['personal', 'withdraw', rootSource, '--expected-revision', '2', '--reason', '撤回']);
  assert.equal(withdrawn.data.status, 'withdrawn'); assert.equal(withdrawn.data.projection.operation, 'delete');
  assert.equal((await f.run(['personal', 'list'])).data.items.length, 0);
  assert.equal((await f.run(['personal', 'list', '--status', 'all', '--project', project])).data.items[0].revision, 3);
  const restored = await f.run(['personal', 'edit', rootSource, '--expected-revision', '3', '--text', '只保留中文提交说明风格']);
  assert.equal(restored.data.status, 'active'); assert.equal(restored.data.revision, 4); assert.equal(restored.data.applicability, 'account');
  const read = await f.run(['personal', 'read', rootSource]); assert.deepEqual(read.data, restored.data);
  assert.ok(f.requests.every(request => request.path.startsWith('/memory/personal')), 'personal content never goes to project or engine routes');
  assert.ok(f.requests.every(request => !request.body || !('owner' in request.body) && !('actor' in request.body) && !('applicability' in request.body)));
});

test('personal commands reject malformed input before network and surface unauthorized or malformed views', async t => {
  const f = await fixture(t);
  for (const args of [['read', '../another-user'], ['edit', rootSource, '--expected-revision', 'NaN', '--text', 'x'],
    ['edit', rootSource, '--expected-revision', '1', '--text', ' '], ['list', '--status', 'other'], ['list', '--project', 'bad']]) {
    assert.equal((await f.run(['personal', ...args])).error.code, 'memory_personal_invalid_input');
  }
  assert.equal(f.requests.length, 0);
  f.malformed(); assert.equal((await f.run(['personal', 'read', rootSource])).error.code, 'memory_personal_invalid_response');
  f.forbidden(); assert.equal((await f.run(['personal', 'read', rootSource])).error.code, 'memory_source_unavailable');
});

test('personal MCP reads are management-only, applicability-scoped and expose no model-callable mutations', async t => {
  const f = await fixture(t);
  await f.withMcp(async rpc => {
    const tools = (await rpc('tools/list', {})).result.tools;
    assert.equal(tools.filter(tool => tool.name.includes('personal')).length, 2); assert.ok(!tools.some(tool => /edit|withdraw|capture/u.test(tool.name)));
    const listing = await rpc('tools/call', { name: 'list_personal_memories', arguments: {} });
    assert.deepEqual(JSON.parse(listing.result.content[1].text), { managementOnly: true, citationSourceField: 'revisionSource', currentSourcesVerified: true });
    assert.deepEqual(f.requests.find(row => row.path === '/memory/personal').query, { status: 'active' });
    assert.equal('history' in JSON.parse(listing.result.content[0].text).items[0], false);
    for (const status of ['all', 'withdrawn']) assert.equal((await rpc('tools/call', { name: 'list_personal_memories', arguments: { status } })).error.code, -32602);
    assert.equal((await rpc('tools/call', { name: 'read_personal_memory', arguments: { source: rootSource, actor: 'someone' } })).error.code, -32602);
    assert.equal((await rpc('tools/call', { name: 'read_personal_memory', arguments: { source: rootSource } })).result.isError, undefined);
    f.change({ applicability: 'project', projectCode: foreignProject });
    const denied = await rpc('tools/call', { name: 'read_personal_memory', arguments: { source: rootSource } });
    assert.equal(denied.result.isError, true); assert.match(denied.result.content[0].text, /memory_scope_mismatch/u);
    assert.doesNotMatch(JSON.stringify(denied), /推送仍/u);
    const excluded = await rpc('tools/call', { name: 'list_personal_memories', arguments: {} });
    assert.deepEqual(JSON.parse(excluded.result.content[0].text).items, []);
    assert.doesNotMatch(JSON.stringify(excluded), /推送仍/u);
  });
});

test('MCP lists account preferences from another origin consistently with ID and brief while governance keeps origin filtering', async t => {
  const f = await fixture(t);
  f.change({ projectCode: foreignProject });
  assert.deepEqual((await f.run(['personal', 'list', '--project', project])).data.items, []);
  assert.equal((await f.run(['personal', 'list', '--project', foreignProject])).data.items[0].source, rootSource);
  await f.withMcp(async rpc => {
    const call = async (name, args = {}) => {
      const result = await rpc('tools/call', { name, arguments: args });
      assert.equal(result.result.isError, undefined, JSON.stringify(result));
      return JSON.parse(result.result.content[0].text);
    };
    const listed = await call('list_personal_memories');
    assert.equal(listed.items.length, 1);
    const known = await call('read_personal_memory', { source: rootSource });
    const brief = await call('read_memory_brief', { scope: 'personal' });
    assert.equal(listed.items[0].revisionSource, known.revisionSource);
    assert.equal(listed.items[0].revisionSource, brief[0].source);
    assert.equal(listed.items[0].text, known.text);
    assert.equal(listed.items[0].text, brief[0].text);
    assert.equal('history' in listed.items[0], false);
    assert.ok(f.sourceReads.some(sources => sources.includes(known.revisionSource)));
  });
});

test('personal MCP never exposes old history or withdrawn text and rejects a revision invalidated during management read', async t => {
  const f = await fixture(t);
  await f.run(['personal', 'edit', rootSource, '--expected-revision', '1', '--text', '当前有效新风格']);
  await f.withMcp(async rpc => {
    const active = await rpc('tools/call', { name: 'read_personal_memory', arguments: { source: rootSource } });
    assert.equal(active.result.isError, undefined); assert.match(JSON.stringify(active), /当前有效新风格/u);
    assert.doesNotMatch(JSON.stringify(active), /推送仍按本次授权/u); assert.equal('history' in JSON.parse(active.result.content[0].text), false);
    // Emulate a stale management response: the source endpoint has withdrawn
    // the record, although its management view still reports active.
    f.unavailableSource();
    const stale = await rpc('tools/call', { name: 'read_personal_memory', arguments: { source: rootSource } });
    assert.equal(stale.result.isError, true); assert.match(stale.result.content[0].text, /memory_source_unavailable/u);
    assert.doesNotMatch(JSON.stringify(stale), /当前有效新风格|推送仍按本次授权/u);
    const staleList = await rpc('tools/call', { name: 'list_personal_memories', arguments: {} });
    assert.equal(staleList.result.isError, true); assert.match(staleList.result.content[0].text, /memory_source_unavailable/u);
    assert.doesNotMatch(JSON.stringify(staleList), /当前有效新风格|推送仍按本次授权/u);
    f.change({ status: 'withdrawn' });
    const withdrawn = await rpc('tools/call', { name: 'read_personal_memory', arguments: { source: rootSource } });
    assert.equal(withdrawn.result.isError, true); assert.match(withdrawn.result.content[0].text, /memory_source_unavailable/u);
    assert.doesNotMatch(JSON.stringify(withdrawn), /当前有效新风格|推送仍按本次授权/u);
    const withdrawnList = await rpc('tools/call', { name: 'list_personal_memories', arguments: {} });
    assert.deepEqual(JSON.parse(withdrawnList.result.content[0].text).items, []);
    assert.doesNotMatch(JSON.stringify(withdrawnList), /当前有效新风格|推送仍按本次授权/u);
  });
});

test('edits and withdrawals invalidate cited revisions in a running MCP and after process restart', async t => {
  const f = await fixture(t);
  await f.withMcp(async rpc => {
    const read = async args => {
      const result = await rpc('tools/call', { name: 'read_memory_brief', arguments: { scope: 'personal', ...args } });
      assert.equal(result.result.isError, undefined); return { rows: JSON.parse(result.result.content[0].text), meta: JSON.parse(result.result.content[1].text) };
    };
    const first = await read({}); assert.equal(first.rows[0].source, '1'.repeat(20));
    await f.run(['personal', 'edit', rootSource, '--expected-revision', '1', '--text', '新的中文风格，推送仍逐次确认']);
    const changed = await read({ context_receipt: first.meta.context_receipt });
    assert.equal(changed.rows[0].source, '2'.repeat(20)); assert.deepEqual(changed.meta.unavailable_sources, ['1'.repeat(20)]);
    const old = await rpc('tools/call', { name: 'read_memory_source', arguments: { source: '1'.repeat(20) } });
    assert.equal(old.result.isError, true); assert.match(old.result.content[0].text, /memory_source_unavailable/u);
  });
  await f.run(['personal', 'withdraw', rootSource, '--expected-revision', '2']);
  await f.withMcp(async rpc => {
    const brief = await rpc('tools/call', { name: 'read_memory_brief', arguments: { scope: 'personal' } });
    assert.equal(brief.result.isError, undefined); assert.deepEqual(JSON.parse(brief.result.content[0].text), []);
    assert.deepEqual(JSON.parse(brief.result.content[1].text).unavailable_sources, ['2'.repeat(20)]);
    assert.doesNotMatch(JSON.stringify(brief), /新的中文风格/u);
    const result = await rpc('tools/call', { name: 'read_memory_source', arguments: { source: '2'.repeat(20) } });
    assert.equal(result.result.isError, true); assert.match(result.result.content[0].text, /memory_source_unavailable/u);
  });
  assert.ok(f.sourceReads.some(sources => sources.includes('1'.repeat(20))));
});
