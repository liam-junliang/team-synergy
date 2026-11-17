import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('./probe.mjs', import.meta.url));
const mixed = '退款超过七天也许需要人工审核。我在这个项目习惯写中文提交说明。私密附件代号 WIND-495。';
const line = (role, text) => JSON.stringify({
  type: 'response_item',
  payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] },
}) + '\n';

function fixture(t) {
  const temp = realpathSync(tmpdir());
  const root = realpathSync(mkdtempSync(join(temp, 'tsp-harness-fixture-')));
  t.after(async () => {
    assert.equal(dirname(realpathSync(root)), temp);
    assert.ok(basename(root).startsWith('tsp-harness-fixture-'));
    await rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 120 });
  });
  const cwd = join(root, 'work');
  mkdirSync(cwd);
  const transcript = join(root, 'rollout.jsonl');
  writeFileSync(transcript, line('user', mixed));
  writeFileSync(join(root, 'synthetic-fixture.json'), JSON.stringify({
    members: { shop: ['alice', 'bob'], other: ['alice'] },
    sessions: [{ id: 'example-session', actor: 'alice', project: 'shop', cwd: 'work', transcript: 'rollout.jsonl' }],
  }));
  const event = { hook_event_name: 'Stop', session_id: 'example-session', cwd, transcript_path: transcript };
  const env = (actor = 'alice', project = 'shop') => ({
    ...process.env, TSP_PROBE_DIR: root, TSP_PROBE_ACTOR: actor, TSP_PROBE_PROJECT: project,
  });
  const run = (args, input = '', actor = 'alice', project = 'shop') => spawnSync(process.execPath, [script, ...args], {
    input, encoding: 'utf8', windowsHide: true, timeout: 4000, env: env(actor, project),
  });
  const ok = (...args) => {
    const res = run(...args);
    assert.equal(res.status, 0, res.stderr);
    return JSON.parse(res.stdout);
  };
  const capture = () => ok(['hook'], JSON.stringify(event)).appended;
  return { root, transcript, event, env, run, ok, capture };
}

test('MCP handshake and CLI on-demand recall use the same authorized result', { timeout: 15000 }, async t => {
  const f = fixture(t);
  assert.equal(f.capture(), 1);
  const cli = f.ok(['search', '退款']);
  assert.equal(cli[0].state, 'discussed');
  const child = spawn(process.execPath, [script, 'mcp'], { env: f.env(), windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const exit = once(child, 'exit');
  const output = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const send = msg => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  let id = 0;
  const request = async (method, params) => {
    send({ method, params, id: ++id });
    const next = await output.next();
    assert.equal(next.done, false);
    const response = JSON.parse(next.value);
    assert.equal(response.id, id);
    return response;
  };
  assert.equal((await request('tools/list', {})).error.code, -32002);
  const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fixture-client', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  send({ method: 'notifications/initialized' });
  const list = (await request('tools/list', {})).result;
  assert.deepEqual(list.tools.map(x => x.name), ['search_memory']);
  const call = args => request('tools/call', { name: 'search_memory', arguments: args });
  assert.deepEqual(JSON.parse((await call({ query: '退款' })).result.content[0].text), cli);
  assert.equal((await call({ query: '退款', actor: 'bob' })).error.code, -32602);
  assert.equal((await request('tools/call', { name: 'publish', arguments: {} })).error.code, -32602);
  child.stdin.end();
  assert.equal((await exit)[0], 0);
});

test('capture survives process restarts, duplicates, late callbacks and partial final lines', t => {
  const f = fixture(t);
  assert.equal(f.capture(), 1);
  assert.equal(f.capture(), 0);
  const first = f.ok(['search', '退款']);
  const assistant = line('assistant', '已了解该设想。');
  appendFileSync(f.transcript, assistant.slice(0, -1));
  assert.equal(f.capture(), 0);
  appendFileSync(f.transcript, '\n');
  assert.equal(f.capture(), 1);
  // A delayed notification now sees the latest durable stream.
  assert.equal(f.capture(), 0);
  writeFileSync(f.transcript, line('user', mixed));
  assert.match(f.run(['hook'], JSON.stringify(f.event)).stderr, /shortened/);
  writeFileSync(f.transcript, '');
  assert.match(f.run(['hook'], JSON.stringify(f.event)).stderr, /shortened/);
  writeFileSync(f.transcript, line('user', mixed) + assistant);
  assert.equal(f.capture(), 0);
  writeFileSync(f.transcript, line('user', '消息被重写') + assistant);
  assert.match(f.run(['hook'], JSON.stringify(f.event)).stderr, /diverged/);
  assert.deepEqual(f.ok(['search', '退款']), first);
});

test('workspace and speaker bindings contain mixed private text and reject misrouted events', t => {
  const f = fixture(t);
  f.capture();
  const read = (q, who, where = 'shop') => f.ok(['search', q], '', who, where);
  assert.equal(read('中文提交', 'alice')[0].scope, 'personal');
  assert.deepEqual(read('中文提交', 'bob'), []);
  assert.deepEqual(read('中文提交', 'alice', 'other'), []);
  assert.deepEqual(read('WIND-495', 'bob'), []);
  const shared = read('退款', 'bob');
  assert.equal(shared.length, 1);
  assert.doesNotMatch(JSON.stringify(shared), /中文提交|WIND-495/);
  assert.deepEqual(read('咖啡', 'alice'), []);
  assert.notEqual(f.run(['search', '退款'], '', 'bob', 'other').status, 0);
  for (const override of [{ cwd: f.root }, { session_id: 'wrong' }, { transcript_path: join(f.root, 'synthetic-fixture.json') }]) {
    assert.notEqual(f.run(['hook'], JSON.stringify({ ...f.event, ...override })).status, 0);
  }
  assert.notEqual(f.run(['hook'], JSON.stringify(f.event), 'bob').status, 0);
});

// Optional interoperability check with an existing official SDK installation.
// The server and first three checks run using only Node built-ins.
if (process.env.TSP_PROBE_MCP_SDK) {
  test('official MCP TypeScript SDK negotiates stdio, discovers and calls search_memory', { timeout: 12000 }, async t => {
    const sdk = realpathSync(process.env.TSP_PROBE_MCP_SDK);
    const moduleUrl = file => pathToFileURL(join(sdk, 'dist', 'esm', 'client', file)).href;
    const { Client } = await import(moduleUrl('index.js'));
    const { StdioClientTransport } = await import(moduleUrl('stdio.js'));
    const f = fixture(t);
    f.capture();
    const client = new Client({ name: 'independent-sdk-check', version: '1' });
    try {
      await client.connect(new StdioClientTransport({
        command: process.execPath, args: [script, 'mcp'],
        env: { TSP_PROBE_DIR: f.root, TSP_PROBE_ACTOR: 'bob', TSP_PROBE_PROJECT: 'shop' },
        stderr: 'ignore',
      }));
      assert.deepEqual((await client.listTools()).tools.map(x => x.name), ['search_memory']);
      const found = await client.callTool({ name: 'search_memory', arguments: { query: '退款' } });
      assert.deepEqual(JSON.parse(found.content[0].text), f.ok(['search', '退款'], '', 'bob'));
      const otherPrivate = await client.callTool({ name: 'search_memory', arguments: { query: '中文提交' } });
      assert.deepEqual(JSON.parse(otherPrivate.content[0].text), []);
    } finally {
      await client.close();
    }
  });
}

if (process.env.TSP_PROBE_CODEX) {
  test('isolated Codex app-server discovers the MCP tool and routes a read', { timeout: 45000 }, async t => {
    const f = fixture(t);
    f.capture();
    const home = join(f.root, 'codex-home');
    mkdirSync(home);
    const quote = value => JSON.stringify(value.replaceAll('\\', '/'));
    const harmlessHook = join(home, 'fixture-stop.mjs');
    writeFileSync(harmlessHook, "process.stdout.write('{}\\n')\n");
    writeFileSync(join(home, 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{
      type: 'command', command: quote(process.execPath) + ' ' + quote(harmlessHook), timeout: 3,
    }] }] } }));
    writeFileSync(join(home, 'config.toml'), [
      'model_provider = "fixture"',
      'model = "fixture-no-model"',
      '[model_providers.fixture]',
      'name = "Local fixture"',
      'base_url = "http://127.0.0.1:1/v1"',
      'wire_api = "responses"',
      '[features]',
      'plugins = false',
      'remote_plugin = false',
      'apps = false',
      '[analytics]',
      'enabled = false',
      '[mcp_servers.tsp_probe]',
      'command = ' + quote(process.execPath),
      'args = [' + quote(script) + ', "mcp"]',
      '[mcp_servers.tsp_probe.env]',
      'TSP_PROBE_DIR = ' + quote(f.root),
      'TSP_PROBE_PROJECT = "shop"',
      'TSP_PROBE_ACTOR = "bob"',
    ].join('\n'));
    const host = spawn(realpathSync(process.env.TSP_PROBE_CODEX), ['app-server', '--stdio'], {
      cwd: f.event.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
      env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TEMP: f.root, TMP: f.root, CODEX_HOME: home, GIT_ALLOW_PROTOCOL: 'file', GIT_TERMINAL_PROMPT: '0' },
    });
    const exited = once(host, 'exit');
    const reader = createInterface({ input: host.stdout })[Symbol.asyncIterator]();
    const send = msg => host.stdin.write(JSON.stringify(msg) + '\n');
    let lastId = 0;
    const request = async (method, params) => {
      const id = ++lastId;
      send({ id, method, params });
      const timer = setTimeout(() => host.kill(), 12000);
      try {
        for (;;) {
          const line = await reader.next();
          if (line.done) throw Error('Codex host closed during ' + method);
          const response = JSON.parse(line.value);
          if (response.id !== id || response.method) continue;
          assert.ok(!response.error, method + ': ' + JSON.stringify(response.error));
          return response.result;
        }
      } finally { clearTimeout(timer); }
    };
    try {
      await request('initialize', { clientInfo: { name: 'memory-pilot', version: '1' }, capabilities: { experimentalApi: true } });
      send({ method: 'initialized' });
      const inventory = await request('hooks/list', { cwds: [f.event.cwd] });
      const stop = inventory.data.flatMap(entry => entry.hooks).find(hook => hook.eventName === 'stop' && hook.source === 'user');
      assert.equal(stop?.trustStatus, 'untrusted');
      assert.equal(stop.isManaged, false);
      const list = await request('mcpServerStatus/list', { detail: 'full' });
      assert.ok(list.data.find(s => s.name === 'tsp_probe')?.tools.search_memory, 'Codex list lacks search_memory');
      const started = await request('thread/start', { ephemeral: true, cwd: f.event.cwd, approvalPolicy: 'never', sandbox: 'read-only' });
      const result = await request('mcpServer/tool/call', {
        threadId: started.thread.id, server: 'tsp_probe', tool: 'search_memory', arguments: { query: '退款' },
      });
      assert.deepEqual(JSON.parse(result.content[0].text), f.ok(['search', '退款'], '', 'bob'));
    } finally {
      host.stdin.end();
      const timer = setTimeout(() => host.kill(), 2200);
      try { await exited; } finally { clearTimeout(timer); }
    }
  });
}
