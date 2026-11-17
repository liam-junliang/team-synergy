// Opt-in live probe: node apps/core-api/tests/native-memory-live.mjs
// Run through scripts/run-tests.mjs; all DB work uses the isolated test cluster and fresh leases.
// Set TSP_PROBE_CODEX to run real member sessions against loopback Ollama. Without it, Codex events are replayed.
// TSP_VERIFY_MEMORY_ENGINES=1 also exercises the local Tencent/OpenViking deployments, using isolated test content.
// --prepare-only checks database allocation, hardware-independent fixture setup and an optional Codex warm-up.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { appendFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createTestFixture, requireTestContext } from '../../../scripts/test-database-guard.mjs';
import { closeDb, openDb } from '@team-synergy/persistence';
import { buildServer } from '../dist/server.js';
import { insertFeature, insertProject, insertProjectMember, insertTeam, insertTeamMember, insertUser } from './test-db.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const cliFile = path.join(repo, 'apps/cli/dist/index.js');
const generatedCode = () => randomBytes(10).toString('hex').toUpperCase();
const evidence = {};

async function withDatabase(run) {
  requireTestContext();
  const owned = await createTestFixture('memorylive');
  const name = owned.databaseName;
  let db;
  try {
    const target = new URL(owned.databaseUrl);
    db = await openDb({ databaseUrl: target.href, migrationsFolder: path.join(repo, 'packages/persistence/drizzle') });
    const { rows } = await db.$client.query('SELECT current_database() AS name');
    assert.equal(rows[0].name, name);
    return await run(db);
  } finally {
    try {
      if (db) await closeDb(db);
      if (owned) {
        await owned.dispose();
        evidence.database = 'fresh local PostgreSQL database removed';
      }
    } finally { /* The central allocator owns and verifies database cleanup. */ }
  }
}

export async function invoke(member, args, input = '') {
  const env = { ...process.env, AGENTCTL_HOME: member.home, CODEX_HOME: member.codexHome };
  delete env.TSP_TEST_DATABASE_URL;
  delete env.ACP_API_URL;
  delete env.TSP_EVAL_GATEWAY_TOKEN;
  delete env.DEEPSEEK_API_KEY;
  const proc = spawn(process.execPath, [cliFile, ...args], {
    cwd: member.cwd, env,
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  proc.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  proc.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const done = once(proc, 'close');
  proc.stdin.end(input);
  const timer = setTimeout(() => proc.kill(), 120000);
  try {
    const [code] = await done;
    if (code !== 0) throw Error('tsp ' + args.slice(0, 2).join(' ') + ' failed: ' + (stdout || stderr).slice(-1000));
    return stdout.trim() ? JSON.parse(stdout) : {};
  } finally { clearTimeout(timer); }
}

async function fixture(db, api, dir, subject = {}) {
  const http = async (method, route, member, payload, extraHeaders = {}) => {
    const response = await fetch(api + route, {
      method, headers: { ...(member ? { authorization: 'Bearer ' + member.token } : {}),
        ...(payload ? { 'content-type': 'application/json' } : {}), ...extraHeaders },
      body: payload ? JSON.stringify(payload) : undefined, signal: AbortSignal.timeout(120000),
    });
    return { status: response.status, ...(await response.json()) };
  };
  const ok = async (...args) => {
    const result = await http(...args);
    assert.ok(result.status === 200 && result.ok === true, args[0] + ' ' + args[1] + ' ' + JSON.stringify(result.error));
    return result.data;
  };
  const created_at = new Date().toISOString();
  const team = await insertTeam(db, { code: generatedCode(), name: 'Memory integration', created_at });
  const projectValues = { team_id: team.id, member_policy: 'private', current_snapshot: 1, created_at };
  const project = await insertProject(db, { ...projectValues, code: generatedCode(), name: subject.project ?? 'Refund flow' });
  const foreign = await insertProject(db, { ...projectValues, code: generatedCode(), name: 'Unrelated project' });
  const users = [];
  for (const [name, role] of [['Alice', 'owner'], ['Bob', 'member']]) {
    const bindToken = randomBytes(32).toString('hex');
    const user = await insertUser(db, { code: generatedCode(), account: 'memory.' + name.toLowerCase(), display_name: name,
      status: 'active', bind_token_hash: createHash('sha256').update(bindToken).digest('hex'),
      bind_token_expires_at: new Date(Date.now() + 60000).toISOString(), created_at });
    const membership = { principal_id: user.id, role, display_name: name, created_at };
    await insertTeamMember(db, { ...membership, team_id: team.id });
    await insertProjectMember(db, { ...membership, project_id: project.id });
    if (role === 'owner') await insertProjectMember(db, { ...membership, project_id: foreign.id });
    const login = await ok('POST', '/auth/login', null, { bind_token: bindToken, device_name: name + ' test device' });
    const member = { code: user.code, token: login.device_token, home: path.join(dir, name + '-cli'),
      cwd: path.join(dir, name + '-workspace'), codexHome: path.join(dir, name + '-codex') };
    assert.equal((await ok('GET', '/auth/whoami', member)).user_code, user.code);
    for (const location of [member.cwd, member.home, member.codexHome]) await mkdir(location, { mode: 0o700 });
    await writeFile(path.join(member.home, 'auth.json'), JSON.stringify({ ...login, api_url: api }), { mode: 0o600 });
    assert.equal((await invoke(member, ['project', 'bind', project.code])).ok, true);
    users.push(member);
  }
  const [alice, bob] = users;
  const feature = await insertFeature(db, { code: generatedCode(), project_id: project.id, title: subject.feature ?? 'Refund requests', status: 'active' });
  const root = '/projects/' + project.code;
  const topic = await ok('POST', root + '/requirement-topics', alice, { title: subject.topic ?? '退款超期如何处理' });
  const requirement = await ok('POST', '/requirements', alice, { feature_code: feature.code, title: subject.requirement ?? '订单退款处理',
    body: subject.body ?? '订单页面支持申请退款。', status: 'draft',
    acceptance_criteria: [{ id: 'AC-1', text: subject.criterion ?? '用户可提交申请。' }] });
  assert.ok(topic.topic_code && requirement.requirement_code);
  evidence.setup = 'two device logins, two CLI workspaces, a project, a topic and an editable requirement';
  return { root, db, projectCode: project.code, foreign, http, ok, alice, bob, topicCode: topic.topic_code, requirementCode: requirement.requirement_code };
}

// Temporary host profiles use a loopback model endpoint. Explicit MCP probes
// and autonomous tool calls have separate counters.
async function withCodex(member, work, options = {}) {
  const quote = value => JSON.stringify(value.replaceAll('\\', '/'));
  const model = process.env.TSP_EVAL_MODEL || process.env.TSP_MEMORY_MODEL || 'hub-qwen2.5:latest';
  const catalog = path.join(member.codexHome,'models.json');
  const deepSeek = process.env.TSP_EVAL_FAMILY === 'deepseek-v4.1-flash';
  if (options.catalog || deepSeek) {
    // The official local gateway example sets the custom slug at startup.
    await writeFile(catalog, JSON.stringify({models:[{
      slug:model,display_name:deepSeek ? 'DeepSeek V4.1 Flash' : 'Local Qwen',base_instructions:'Help the user with project work.',
      supported_reasoning_levels:deepSeek ? [{effort:'low',description:'Fast reasoning'}] : [],shell_type:'shell_command',visibility:'list',supported_in_api:true,
      priority:0,support_verbosity:false,truncation_policy:{mode:'tokens',limit:10000},
      experimental_supported_tools:[],tool_mode:deepSeek ? null : 'non_code_mode_only',
      ...(deepSeek ? {prefer_websockets:false,supports_parallel_tool_calls:true,input_modalities:['text','image'],use_responses_lite:false,
        default_reasoning_level:'low',context_window:1048576,max_context_window:1048576} : {}),
    }]}));
  }
  await writeFile(path.join(member.codexHome, 'config.toml'), [
    'model_provider = "local"', 'model = ' + quote(model), ...(options.catalog || deepSeek ? ['model_catalog_json = '+quote(catalog)] : []),
    'web_search = "disabled"', '[model_providers.local]', 'name = "Evaluation provider"',
    'base_url = '+quote(options.modelUrl ?? 'http://127.0.0.1:11434/v1'), 'wire_api = "responses"', 'request_max_retries = 0', 'stream_max_retries = 0',
    '[features]', 'plugins = false', 'remote_plugin = false', 'apps = false', 'shell_tool = false',
    '[analytics]', 'enabled = false',
    '[mcp_servers.tsp_memory]', 'command = ' + quote(process.execPath),
    'args = [' + (options.mcpArgs ?? [cliFile,'memory','mcp']).map(quote).join(', ') + ']', 'cwd = ' + quote(member.cwd),
    '[mcp_servers.tsp_memory.env]', 'AGENTCTL_HOME = ' + quote(member.home),
  ].join('\n'));
  const host = spawn(process.env.TSP_PROBE_CODEX, ['app-server', '--stdio'], {
    cwd: member.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
    env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, CODEX_HOME: member.codexHome, NO_PROXY: '127.0.0.1,localhost',
      TEMP: member.codexHome, TMP: member.codexHome, GIT_ALLOW_PROTOCOL: 'file', GIT_TERMINAL_PROMPT: '0' },
  });
  const done = once(host, 'close');
  const reader = createInterface({ input: host.stdout })[Symbol.asyncIterator]();
  const send = msg => host.stdin.write(JSON.stringify(msg) + '\n');
  let id = 0;
  let threadId;
  const notifications = [];
  async function receive(until, operation) {
    const timer = setTimeout(() => host.kill(), 120000);
    try {
      for (;;) {
        const message = await reader.next();
        if (message.done) throw Error('Codex app-server closed during ' + operation);
        const msg = JSON.parse(message.value);
        if (options.dynamic && msg.method==='item/tool/call' && msg.id!==undefined) {
          const {tool,arguments:args,threadId:requested} = msg.params ?? {};
          const scope = tool==='project_memory' ? 'project' : tool==='personal_memory' ? 'personal' : null;
          if (!scope || requested!==threadId || !args || typeof args!=='object' || Object.keys(args).length) {
            send({id:msg.id,result:{success:false,contentItems:[{type:'inputText',text:'Unsupported memory request'}]}});
            continue;
          }
          const response = await rpc('mcpServer/tool/call',{threadId,server:'tsp_memory',tool:'read_memory_brief',arguments:{scope}});
          send({id:msg.id,result:{success:!response.isError,contentItems:response.content.filter(c=>c.type==='text')
            .map(c=>({type:'inputText',text:c.text}))}});
          continue;
        }
        if (msg.method && msg.id === undefined) notifications.push(msg);
        if (until(msg)) return msg;
      }
    } finally { clearTimeout(timer); }
  }
  async function rpc(method, params) {
    const requestId = ++id;
    send({ id:requestId, method, params });
    const msg = await receive(m => m.id === requestId && !m.method, method);
    if (msg.error) throw Error(method + ' failed: ' + JSON.stringify(msg.error));
    return msg.result;
  }
  try {
    await rpc('initialize', { clientInfo: { name: 'tsp-native-memory-live', version: '1' }, capabilities: { experimentalApi: true } });
    send({ method: 'initialized' });
    const inventory = await rpc('mcpServerStatus/list', { detail: 'full' });
    assert.ok(inventory.data.find(server => server.name === 'tsp_memory')?.tools.search_memory);
    const dynamicTools = options.dynamic ? [['project_memory','读取当前项目的讨论和决定及其来源。'],['personal_memory','读取本人适用于当前项目的风格与偏好。']]
      .map(([name,description])=>({type:'function',name,description,inputSchema:{type:'object',properties:{},additionalProperties:false},deferLoading:false})) : undefined;
    const { thread } = await rpc('thread/start', { dynamicTools,ephemeral: false, cwd: member.cwd, approvalPolicy: 'never', sandbox: 'read-only',
      baseInstructions: options.baseInstructions ?? '你是项目助手。普通陈述仅回复收到。被问到已知的项目背景时用 search_memory 检索，输入 query 和 scope。不要通过 shell 或文件查找记忆。' });
    threadId = thread.id;
    const toolSpec = inventory.data.find(server => server.name === 'tsp_memory').tools.search_memory;
    const call = async (name, args) => {
      const reply = await rpc('mcpServer/tool/call', { threadId: thread.id, server: 'tsp_memory', tool: name, arguments: args });
      assert.ok(!reply.isError, 'Codex MCP reported an error');
      return JSON.parse(reply.content[0].text);
    };
    const turn = async text => {
      const { turn: started } = await rpc('turn/start', { threadId: thread.id, input: [{ type: 'text', text, text_elements: [] }] });
      const completed = msg => msg.method === 'turn/completed' && msg.params?.turn?.id === started.id;
      const event = notifications.find(completed) || await receive(completed, 'turn/completed');
      const result = event.params.turn;
      assert.equal(result.status, 'completed', 'Model turn: ' + JSON.stringify(result.error));
      return notifications.filter(msg => msg.method === 'item/completed' && msg.params?.turnId === started.id).map(msg => msg.params.item);
    };
    const readResource = uri => rpc('mcpServer/resource/read', {threadId:thread.id, server:'tsp_memory',uri});
    await work({ sessionId: thread.id, search: query => call('search_memory', { query }), call, toolSpec, turn, readResource });
  } finally {
    host.stdin.end();
    const timer = setTimeout(() => host.kill(), 2500);
    try { await done; } finally { clearTimeout(timer); }
  }
}

async function ollamaMember(host, expectedSource) {
  const { name, description, inputSchema } = host.toolSpec;
  const messages = [{ role: 'system', content: '你是项目成员助手。从项目记忆查实当前方案，再根据工具结果向用户回答。' },
    { role: 'user', content: '我准备处理退款，帮我查团队已有的讨论。用关键词“退款”，说明方案和确认状态。' }];
  const chat = async tools => {
    const response = await fetch('http://127.0.0.1:11434/api/chat', { method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(60000),
      body: JSON.stringify({ model: process.env.TSP_MEMORY_MODEL || 'hub-qwen2.5:latest', messages,
        tools, stream: false, options: { temperature: 0, seed: 73 } }) });
    assert.ok(response.ok, 'Ollama chat failed: ' + response.status);
    return (await response.json()).message;
  };
  const first = await chat([{ type: 'function', function: { name, description, parameters: inputSchema } }]);
  const selected = first.tool_calls?.[0]?.function;
  assert.equal(selected?.name, name, 'Ollama did not select the advertised MCP tool');
  const rows = await host.call(selected.name, selected.arguments);
  assert.ok(rows.some(row => row.source === expectedSource && row.state === 'discussed'));
  messages.push(first, { role: 'tool', tool_name: selected.name, content: JSON.stringify(rows) });
  const answer = (await chat([])).content;
  assert.match(answer, /人工/u);
  assert.doesNotMatch(answer, /Git|提交说明/u);
  return { host: 'Ollama chat with MCP tool schema', selected: selected.name, query: selected.arguments.query,
    retrievedSource: expectedSource, mentionsManualReview: true, mentionsDiscussion: /讨论|建议|尚未|待确认/u.test(answer) };
}

async function verify(f) {
  const { ok, http, alice, bob, root, foreign, topicCode, requirementCode } = f;
  const memory = root + '/memory';
  const objects = new URLSearchParams({ topicCode, requirementCode });
  const inspect = member => ok('GET', memory + '/binding?' + objects, member);
  const lookup = (member, query) => ok('GET', memory + '?' + new URLSearchParams({ query }), member);
  const topic = () => ok('GET', '/requirement-topics/' + topicCode, alice);
  const requirement = () => ok('GET', '/requirements/' + requirementCode, alice);
  let sessionId = randomUUID();
  const initial = await inspect(alice);
  const before = await requirement();
  assert.equal(initial.expectedRevision, before.current_revision);
  assert.equal(initial.expectedHead, null);
  assert.equal((await http('GET', memory + '?query=test', null)).status, 401);
  assert.equal((await http('GET', memory + '?query=test', null, undefined, { 'x-principal-code': alice.code })).status, 401);

  const sourceText = '我建议退款超过七天进入人工审核。这个项目我习惯用中文写 Git 提交说明。';
  let transcript;
  const bind = () => invoke(alice, ['memory', 'bind', '--session', sessionId, '--topic', topicCode, '--requirement', requirementCode, '--transcript', transcript]);
  async function captureAlice(text, inspectPrivate = false) {
    await withCodex(alice, async host => {
      sessionId = host.sessionId;
      await host.turn('请回复收到。');
      const folder = path.join(alice.codexHome, 'sessions');
      const relative = (await readdir(folder, { recursive: true })).find(file => file.endsWith(sessionId + '.jsonl'));
      assert.ok(relative, 'No native Codex rollout after warm-up');
      transcript = path.join(folder, relative);
      await bind();
      await host.turn(text);
      // Some app-server builds buffer rollout writes beyond turn/completed.
      let appended = 0;
      for (let attempt = 0; !appended && attempt < 5; attempt++) {
        if (attempt) await pause(350);
        appended = (await invoke(alice, ['memory', 'sync', '--session', sessionId])).data.appended;
      }
      if (!appended) {
        const entries = (await readFile(transcript, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
        throw Error('No operator event consumed; observed host records: ' + JSON.stringify([...new Set(entries.map(row =>
          [row.type, row.payload?.type, row.payload?.role, row.payload?.item?.type, ...(row.payload?.item ? Object.keys(row.payload.item) : [])]
            .filter(Boolean).join('/')))]));
      }
      assert.equal(appended, 1);
      if (inspectPrivate) assert.ok((await host.search('Git')).some(row => row.scope === 'personal'));
    });
  }
  if (process.env.TSP_PROBE_CODEX) {
    await captureAlice(sourceText, true);
    evidence.capture = 'real Codex user turn and rollout, native CLI sync, loopback Ollama extraction';
  } else {
    const folder = path.join(alice.codexHome, 'sessions');
    await mkdir(folder, { recursive: true });
    transcript = path.join(folder, 'rollout-' + sessionId + '.jsonl');
    const line = record => JSON.stringify({ timestamp: new Date().toISOString(), ...record }) + '\n';
    await writeFile(transcript, line({ type: 'session_meta', payload: { id: sessionId, cwd: alice.cwd } }));
    await bind();
    await appendFile(transcript, line({ type: 'event_msg', payload: { type: 'user_message', message: sourceText } }));
    evidence.capture = 'sample Codex Stop replay over native CLI with loopback Ollama extraction';
  }
  const hook = JSON.stringify({ hook_event_name: 'Stop', session_id: sessionId, transcript_path: transcript, cwd: alice.cwd });
  await invoke(alice, ['memory', 'hook'], hook);
  const pending = await topic();
  assert.equal(pending.entries.length, 1, 'One public proposal must result from the mixed utterance');
  assert.match(pending.entries[0].content, /退款.*人工审核/u);
  assert.doesNotMatch(JSON.stringify(pending), /Git|提交说明|习惯/u);
  assert.equal(pending.entries[0].author_code, alice.code);
  assert.deepEqual(await requirement(), before, 'Discussion alone must preserve the formal requirement');
  await invoke(alice, ['memory', 'hook'], hook);
  assert.equal((await topic()).entries.length, 1);

  const publicRows = await lookup(bob, '退款');
  const privateRows = await lookup(alice, 'Git');
  assert.ok(publicRows.some(row => row.scope === 'project' && row.state === 'discussed' && row.source === pending.entries[0].entry_code));
  assert.doesNotMatch(JSON.stringify(publicRows), /Git|提交说明|习惯/u);
  assert.ok(privateRows.some(row => row.scope === 'personal' && /Git/u.test(row.text)));
  assert.deepEqual(await lookup(bob, 'Git'), []);
  assert.deepEqual(await ok('GET', '/projects/' + foreign.code + '/memory?query=Git', alice), [],
    'A habit qualified by this project must stay scoped to it');
  assert.equal((await http('GET', '/projects/' + foreign.code + '/memory?query=Git', bob)).status, 403);
  const wrongObjects = await http('GET', '/projects/' + foreign.code + '/memory/binding?' + objects, alice);
  assert.ok([400, 403, 404, 409].includes(wrongObjects.status) && !wrongObjects.ok);
  assert.deepEqual((await invoke(bob, ['memory', 'search', '退款'])).data, publicRows);
  if (process.env.TSP_PROBE_CODEX) {
    await withCodex(bob, async host => {
      const items = await host.turn('项目对退款有什么讨论？请查项目记忆，搜索词用“退款”，告诉我原方案和确认状态。');
      const agentCalls = items.filter(item => item.type === 'mcpToolCall' && item.tool === 'search_memory' && item.status === 'completed');
      evidence.codex = { successfulModelInitiatedSearches: agentCalls.length, explicitHostSearches: 3,
        modelItems: items.map(item => ({ type: item.type, ...(item.tool ? { tool: item.tool, status: item.status } : {}) })) };
      if (agentCalls.length === 0) {
        const folder = path.join(bob.codexHome, 'sessions');
        const relative = (await readdir(folder, { recursive: true })).find(file => file.endsWith(host.sessionId + '.jsonl'));
        const events = (await readFile(path.join(folder, relative), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
        evidence.codex.attemptedToolNames = events.filter(row => row.type === 'response_item' && row.payload.type === 'function_call').map(row => row.payload.name);
      }
      const output = items.filter(item => item.type === 'agentMessage').map(item => item.text).join('\n');
      assert.doesNotMatch(output, /Git|提交说明|习惯/u);
      if (agentCalls.length > 0) evidence.codex.answerMentionsReview = /人工/u.test(output);
      assert.deepEqual(await host.search('退款'), publicRows);
      assert.deepEqual(await host.search('Git'), []);
      evidence.ollamaMember = await ollamaMember(host, pending.entries[0].entry_code);
    });
  }

  await ok('POST', '/requirement-topics/' + topicCode + '/entries', bob, { entry_type: 'comment', content: '我核对了现有退款流程，这个方案可行。' });
  const comments = (await topic()).entries.filter(row => row.author_code === bob.code);
  assert.equal(comments.length, 1);
  assert.equal(comments[0].entry_type, 'comment');
  assert.deepEqual(await requirement(), before);
  const current = await inspect(alice);
  const adopt = { topicCode, requirementCode, sessionId, eventId: randomUUID(), expectedRevision: current.expectedRevision,
    expectedHead: current.expectedHead, sourceText: '确认采纳：退款超过七天进入人工审核。' };
  const noReferent = await http('POST', memory + '/captures', alice, { ...adopt, eventId: randomUUID(), sourceText: '就按这个方案做。' });
  assert.equal(noReferent.status, 422, 'A bare approval with no conversational referent must wait for clarification');
  assert.deepEqual(await requirement(), before);
  const denied = await http('POST', memory + '/captures', bob, adopt);
  assert.equal(denied.status, 403, 'An ordinary member must not adopt a project decision: ' + JSON.stringify(denied.error));
  assert.deepEqual(await requirement(), before, 'An unauthorized adoption must have zero revision side effects');
  if (process.env.TSP_PROBE_CODEX) {
    await captureAlice(adopt.sourceText);
    const { rows } = await f.db.$client.query('SELECT event_key FROM memory_capture_receipts WHERE session_key=$1', [sessionId]);
    assert.equal(rows.length, 1);
    adopt.sessionId = sessionId;
    adopt.eventId = rows[0].event_key;
    evidence.adoptionSource = 'a second real Alice Codex transcript, bound after Bob commented and synchronized with CLI';
  }
  const contenders = [adopt, { ...adopt, eventId: randomUUID() }];
  const attempts = await Promise.all(contenders.map(body => http('POST', memory + '/captures', alice, body)));
  assert.deepEqual(attempts.map(row => row.status).sort(), [200, 409], 'Concurrent adoption: ' + JSON.stringify(attempts.map(row => row.error)));
  const winner = attempts.findIndex(row => row.ok);
  const confirmation = attempts[winner].data;
  assert.equal(confirmation.replayed, Boolean(process.env.TSP_PROBE_CODEX));
  const replay = await ok('POST', memory + '/captures', alice, contenders[winner]);
  assert.equal(replay.replayed, true);
  assert.equal(replay.receiptCode, confirmation.receiptCode);
  assert.deepEqual(replay.items, confirmation.items);
  const after = await requirement();
  assert.equal(after.current_revision, before.current_revision + 1);
  assert.equal(after.revisions.length, before.revisions.length + 1);
  assert.equal(after.acceptance_criteria.length, before.acceptance_criteria.length + 1);
  assert.ok(after.acceptance_criteria.some(criterion => criterion.text === pending.entries[0].content.replace(/^我建议\s*/u, '')));
  assert.equal(after.state, before.state);
  assert.deepEqual(after.tasks, before.tasks);
  const decisions = (await topic()).entries.filter(row => row.entry_type === 'decision');
  assert.equal(decisions.length, 1);
  const confirmed = await lookup(bob, '退款');
  assert.ok(confirmed.some(row => row.state === 'confirmed' && row.source === decisions[0].entry_code));
  assert.ok(confirmed.every(row => row.state !== 'implemented'));
  assert.doesNotMatch(JSON.stringify([after, decisions, confirmed]), /Git|提交说明|习惯/u);
  evidence.decision = { fromRevision: before.current_revision, toRevision: after.current_revision, decisions: decisions.length,
    implementationState: after.state, linkedTasks: after.tasks.length, concurrentStatuses: attempts.map(row => row.status).sort(), replayed: replay.replayed };
  const changedPayload = await http('POST', memory + '/captures', alice, { ...contenders[winner], sourceText: '完全不同的原话。' });
  assert.equal(changedPayload.status, 409);
  if (process.env.TSP_VERIFY_MEMORY_ENGINES === '1') {
    const { verifyProjections } = await import('./native-memory-engines.mjs');
    evidence.engines = await verifyProjections(f.db, { projectCode: f.projectCode, aliceCode: alice.code, bobCode: bob.code,
      aliceToken: alice.token, bobToken: bob.token });
  }
  const accountPreference = '在所有项目中我习惯先读变更摘要。';
  await ok('POST', memory + '/captures', alice, { ...(await inspect(alice)), sessionId, eventId: randomUUID(), sourceText: accountPreference });
  const accountRows = await ok('GET', '/projects/' + foreign.code + '/memory?' + new URLSearchParams({ query: '变更摘要' }), alice);
  assert.ok(accountRows.some(row => row.scope === 'personal' && row.text === accountPreference));
  assert.deepEqual(await lookup(bob, '变更摘要'), []);
  evidence.privateScope = 'project-qualified Git preference stays local; explicit account habit follows Alice into her other project';
  await ok('DELETE', root + '/members/' + bob.code, alice);
  assert.equal((await http('GET', memory + '?query=' + encodeURIComponent('退款'), bob)).status, 403);
  assert.equal((await http('POST', memory + '/captures', bob, adopt)).status, 403);
  evidence.access = 'no anonymous or forged legacy reads; unrelated project, unauthorized decision and revoked membership denied';
}

export async function withNativeMemoryProject(subject, work) {
  const temp = await realpath(tmpdir());
  const dir = await mkdtemp(path.join(temp, 'tsp-native-memory-'));
  try {
    return await withDatabase(async db => {
      const app = await buildServer({ db, logger: false, memoryEnginesFile: '' });
      try {
        const api = await app.listen({ host: '127.0.0.1', port: 0 });
        const f = await fixture(db, api, dir, subject);
        return await work(f, {dir, api});
      } finally { await app.close(); }
    });
  } finally {
    const target = await realpath(dir);
    assert.equal(path.dirname(target), temp);
    assert.match(path.basename(target), /^tsp-native-memory-[a-zA-Z0-9]+$/);
    await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
  }
}

async function run() {
  if (process.env.TSP_PROBE_CODEX) {
    evidence.codexVersion = execFileSync(process.env.TSP_PROBE_CODEX, ['--version'], { windowsHide: true, timeout: 4000,
      encoding: 'utf8', env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } }).trim();
  }
  await withNativeMemoryProject({}, async (f, {dir}) => {
    if (process.argv.includes('--opencode-holdout')) {
      const { evaluateOpenCodeHoldout } = await import('./native-memory-opencode.mjs');
      evidence.openCodeHoldout = await evaluateOpenCodeHoldout(f, { dir });
    } else if (process.argv.includes('--active-retrieval')) {
      const { evaluateRetrieval } = await import('./native-memory-retrieval.mjs');
      evidence.activeRetrieval = await evaluateRetrieval(f, { dir, withCodex, version:evidence.codexVersion });
    } else if (!process.argv.includes('--prepare-only')) await verify(f);
    else if (process.env.TSP_PROBE_CODEX) {
      await withCodex(f.alice, async host => {
        await host.turn('请回复收到。');
        await host.turn('谢谢。');
        const folder = path.join(f.alice.codexHome, 'sessions');
        const relative = (await readdir(folder, { recursive: true })).find(file => file.endsWith(host.sessionId + '.jsonl'));
        const events = (await readFile(path.join(folder, relative), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
        evidence.hostRecords = events.slice(-22).map(row => {
          const { type, role, item } = row.payload ?? {};
          const part = item?.content?.[0];
          return [row.type, type, role, item?.type, part?.type, ...(part ? Object.keys(part) : [])].filter(Boolean).join('/');
        });
      });
      evidence.codex = 'Codex reached loopback Ollama and completed a warm-up turn';
    }
  });
  if (evidence.activeRetrieval && process.argv.includes('--record-retrieval')) {
    const runner = process.env.TSP_RETRIEVAL_HOST || 'codex';
    const suffix = runner==='codex' ? '' : '-'+runner;
    const arms = Object.keys(evidence.activeRetrieval.variants);
    const stage = process.env.TSP_EVAL_FAMILY === 'deepseek-v4.1-flash' ? '-deepseek-flash' :
      arms.some(v=>['catalog','dynamic'].includes(v)) ? '-compat' : arms.includes('native') || process.argv.includes('--v2') ? '-v2' : '';
    const output = path.join(repo,'docs/experiments/memory-harness-pilot/active-retrieval'+suffix+stage+'-result.json');
    await writeFile(output,JSON.stringify({...evidence.activeRetrieval,isolatedDatabaseRemoved:true},null,2)+'\n');
  }
  if (evidence.openCodeHoldout && process.env.TSP_EVAL_FAMILY === 'deepseek-v4.1-flash') {
    const output = path.join(repo,'docs/experiments/memory-harness-pilot/active-retrieval-opencode-deepseek-flash-holdout.json');
    await writeFile(output,JSON.stringify({...evidence.openCodeHoldout,isolatedDatabaseRemoved:true},null,2)+'\n');
  }
  console.log(JSON.stringify(evidence, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.env.ACP_ALLOW_LEGACY_IDENTITY = '0';
  process.env.TSP_MEMORY_ENABLED = '1';
  await run();
}
