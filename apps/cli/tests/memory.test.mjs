import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const line = (type, payload) => JSON.stringify({ type, payload }) + '\n';
const turn = message => line('event_msg', { type: 'user_message', message });

async function fixture(t, readBrief, readSources, readDocument) {
  const dir = mkdtempSync(path.join(tmpdir(), 'tsp-memory-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cwd = path.join(dir, 'repo');
  const account = path.join(dir, 'account');
  const codex = path.join(dir, 'codex');
  const boundFile = path.join(cwd, '.agent', 'bound-project.yaml');
  const transcript = path.join(codex, 'sessions', 'test.jsonl');
  for (const folder of [path.dirname(boundFile), account, path.dirname(transcript)]) mkdirSync(folder, { recursive: true });
  const session = 'isolated-host-session';
  writeFileSync(transcript, line('session_meta', { id: session, cwd }) + turn('before binding'));
  const posts = [];
  const queries = [];
  const briefs = [];
  const sourceReads = [];
  const receipts = new Map();
  const queuePosts = [], jobs = new Map(), jobReads = [];
  let bindingReads = 0;
  let head = null;
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer test-device');
    const url = new URL(request.url, 'http://fixture.local');
    let result;
    if (url.pathname === '/auth/whoami') result = { user_code: 'member-A' };
    else if (url.pathname === '/projects/P/memory/binding') {
      bindingReads++;
      result = url.search ? { topicCode: 'topic', requirementCode: 'req', expectedRevision: 1, expectedHead: head } : {};
    } else if (url.pathname === '/projects/P/memory/capture-events') {
      let raw = ''; for await (const part of request) raw += part;
      const body = JSON.parse(raw); queuePosts.push(body);
      assert.ok(!['topicCode', 'requirementCode', 'expectedRevision', 'expectedHead'].some(key => key in body));
      const prior = [...jobs.values()].find(job => job.eventId === body.eventId);
      const job = prior ?? { captureCode: String(jobs.size + 1).padStart(20, '0'), status: 'pending', attempts: 0, eventId: body.eventId };
      jobs.set(job.captureCode, job); response.statusCode = 202;
      result = { captureCode: job.captureCode, status: job.status, replayed: Boolean(prior) };
    } else if (url.pathname.startsWith('/projects/P/memory/captures/')) {
      const code = url.pathname.split('/')[5];
      const job = jobs.get(code); assert.ok(job);
      if (url.pathname.endsWith('/retry')) {
        assert.equal(request.method, 'POST');
        if (job.status !== 'failed') { response.end(JSON.stringify({ ok: false, error: { code: 'memory_capture_not_retryable', message: '只可重试failed' } })); return; }
        job.status = 'pending'; job.attempts++;
      } else { assert.equal(request.method, 'GET'); jobReads.push(code); }
      result = job;
    } else if (url.pathname === '/projects/P/memory/captures') {
      let raw = '';
      for await (const part of request) raw += part;
      const body = JSON.parse(raw);
      posts.push(body);
      if (receipts.has(body.eventId)) result = { ...receipts.get(body.eventId), replayed: true };
      else if (body.sourceText === '就按这个方案做' && body.referenceText !== '是否采纳《退款进入人工审核》？') {
        response.end(JSON.stringify({ ok: false, error: { code: 'memory_ambiguous', message: '请明确方案原文' } })); return;
      }
      else if (body.sourceText === 'ignore' || body.sourceText === 'ambiguous' || body.expectedHead !== head) {
        const code = body.sourceText === 'ignore' ? 'memory_no_material' : body.sourceText === 'ambiguous' ? 'memory_needs_clarification' : 'memory_source_changed';
        response.end(JSON.stringify({ ok: false, error: { code, message: code } })); return;
      } else {
        head = 'head-' + posts.length;
        const confirmed = body.sourceText.startsWith('确认采纳：') || body.sourceText === '就按这个方案做';
        result = { receiptCode: 'receipt', expectedRevision: 1, expectedHead: head, replayed: false, items: confirmed ? [{ state: 'confirmed' }] : [] };
        receipts.set(body.eventId, result);
      }
    } else if (url.pathname === '/projects/P/memory/brief') {
      assert.equal(request.method, 'POST');
      assert.equal(url.search, '');
      let raw = '';
      for await (const part of request) raw += part;
      const body = JSON.parse(raw);
      assert.deepEqual(Object.keys(body), ['scope']);
      briefs.push(body.scope);
      result = await readBrief(body.scope);
    } else if (url.pathname === '/projects/P/memory/sources') {
      assert.equal(request.method, 'POST');
      let raw = '';
      for await (const part of request) raw += part;
      const body = JSON.parse(raw);
      assert.deepEqual(Object.keys(body), ['sources']);
      sourceReads.push(body.sources);
      result = await readSources(body.sources);
    } else if (url.pathname === '/projects/P/memory/documents/read') {
      assert.equal(request.method, 'POST');
      let raw = ''; for await (const part of request) raw += part;
      result = await readDocument(JSON.parse(raw));
    } else if (url.pathname === '/projects/P/memory/search') {
      assert.equal(request.method, 'POST');
      assert.equal(url.search, '');
      let raw = '';
      for await (const part of request) raw += part;
      queries.push(JSON.parse(raw));
      result = [{ state: 'discussion' }];
    } else throw Error('Unexpected fixture route ' + url.pathname);
    response.end(JSON.stringify({ ok: true, data: result }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const api = 'http://127.0.0.1:' + server.address().port;
  const authFile = path.join(account, 'auth.json');
  const auth = { device_token: 'test-device', device_code: 'device-A', user_code: 'member-A', device_name: 'test', api_url: api };
  writeFileSync(authFile, JSON.stringify(auth));
  const bindProject = (apiUrl = api, code = 'P') => writeFileSync(boundFile, 'project_code: ' + code + '\napi_url: ' + apiUrl + '\nbound_at: today\n');
  bindProject();
  async function run(args, input = '') {
    const child = spawn(process.execPath, [cli, 'memory', ...args], {
      cwd, env: { ...process.env, ACP_API_URL: api, AGENTCTL_HOME: account, CODEX_HOME: codex }, windowsHide: true,
    });
    const exit = once(child, 'close');
    let out = '', err = '';
    child.stdout.setEncoding('utf8').on('data', s => { out += s; });
    child.stderr.setEncoding('utf8').on('data', s => { err += s; });
    child.stdin.end(input);
    const [code] = await exit;
    return { code, out, err, json: () => JSON.parse(out) };
  }
  const bind = (...args) => run(['bind', '--topic', 'topic', '--requirement', 'req', '--session', session, ...args]);
  const capture = (id, msg) => run(['capture', '--session', session, '--event', id], msg);
  const sync = () => run(['sync', '--session', session]);
  const hook = (overrides = {}) => run(['hook'], JSON.stringify({ hook_event_name: 'Stop', session_id: session, cwd, transcript_path: transcript, ...overrides }));
  const startMcp = (env = {}) => spawn(process.execPath, [cli, 'memory', 'mcp'], {
    cwd, env: { ...process.env, ACP_API_URL: api, AGENTCTL_HOME: account, CODEX_HOME: codex, ...env }, windowsHide: true,
  });
  return { session, run, startMcp, bind, capture, sync, hook, bindProject, transcript, posts, queuePosts, jobs, jobReads, queries, briefs, sourceReads, auth, authFile, bindingReads: () => bindingReads, changeHead: () => { head = 'other-member'; } };
}

test('Stop only captures new operator messages for the bound host and never resends discussion mirrors', async t => {
  const f = await fixture(t);
  assert.equal((await f.hook()).out, '');
  assert.equal((await f.bind('--transcript', f.authFile)).json().error.code, 'memory_source_invalid');
  assert.equal((await f.hook()).code, 0, 'failed bind must leave capture disabled');
  assert.equal((await f.bind('--transcript', f.transcript)).json().data.transcriptBound, true);
  const mirror = line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'injected context' }] });
  appendFileSync(f.transcript, mirror + line('event_msg', { type: 'agent_message', message: 'assistant' }) + turn('ignore') + turn('new operator').trimEnd());
  let result = (await f.sync()).json().data;
  assert.deepEqual([result.skipped, result.appended], [1, 0]);
  appendFileSync(f.transcript, '\n');
  assert.equal((await f.hook({ cwd: path.dirname(f.transcript) })).code, 1);
  const missing = await f.hook({ transcript_path: null });
  assert.equal(missing.out, '');
  assert.match(missing.err, /memory_transcript_unavailable/);
  assert.equal((await f.hook()).code, 0);
  assert.equal((await f.sync()).json().data.appended, 0);
  assert.deepEqual(f.posts.map(p => p.sourceText), ['ignore', 'new operator']);
  assert.deepEqual(Object.keys(f.posts[0]).sort(), ['eventId', 'expectedHead', 'expectedRevision', 'requirementCode', 'sessionId', 'sourceText', 'topicCode']);
  writeFileSync(f.transcript, readFileSync(f.transcript, 'utf8').replace('before binding', 'tamper binding'));
  assert.equal((await f.sync()).json().error.code, 'memory_source_changed');
  assert.equal(f.posts.length, 2);
});

test('Stop preserves successful turns, leaves ambiguity pending and never reloads its witness on conflict', async t => {
  const f = await fixture(t);
  await f.bind('--transcript', f.transcript);
  appendFileSync(f.transcript, turn('one') + turn('ambiguous') + turn('later'));
  assert.equal((await f.sync()).json().error.code, 'memory_needs_clarification');
  assert.equal((await f.sync()).json().error.code, 'memory_needs_clarification');
  assert.deepEqual(f.posts.map(p => p.sourceText), ['one', 'ambiguous', 'ambiguous']);
  assert.equal(f.posts[1].eventId, f.posts[2].eventId);
  assert.equal(f.bindingReads(), 1);
});

test('bare adoption uses only an immediately preceding displayed quote and lets the operator clarify in the next turn', async t => {
  const f = await fixture(t);
  await f.bind('--transcript', f.transcript);
  const bare = '就按这个方案做';
  const quote = '是否采纳《退款进入人工审核》？';
  const assistant = message => line('event_msg', { type: 'agent_message', message });
  const mirror = (role, text) => line('response_item', { type: 'message', role,
    content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] });
  const append = s => appendFileSync(f.transcript, s);
  append(assistant(quote) + mirror('assistant', quote) + line('event_msg', { type: 'task_complete' }));
  await f.sync();
  append(line('event_msg', { type: 'task_started' }) + mirror('user', bare) + turn(bare));
  assert.equal((await f.sync()).json().data.appended, 1);
  assert.equal(f.posts.at(-1).referenceText, quote);
  append(assistant(quote) + line('response_item', { type: 'function_call' }) + mirror('assistant', quote) + turn(bare));
  assert.match((await f.hook()).err, /确认采纳：方案原文/);
  assert.equal(f.posts.at(-1).referenceText, undefined);
  assert.ok((await f.sync()).json().data.clarification.eventId);
  append(turn('确认采纳：退款进入人工审核'));
  assert.equal((await f.sync()).json().data.clarification, undefined);
  assert.equal(f.posts.at(-1).referenceText, undefined);
  append(assistant('是否采纳《另外一个方案》？') + turn(bare));
  assert.ok((await f.sync()).json().data.clarification);
  assert.equal(f.posts.at(-1).referenceText, '是否采纳《另外一个方案》？');
  append(assistant(quote) + mirror('user', '切换到其他问题') + turn(bare));
  assert.ok((await f.sync()).json().data.clarification);
  assert.equal(f.posts.at(-1).referenceText, undefined);
  append(assistant(quote) + turn('普通讨论'));
  await f.sync();
  assert.equal(f.posts.at(-1).referenceText, undefined);
});

test('manual events keep their first witness across retries and rebind and cannot cross account/project boundaries', async t => {
  const f = await fixture(t);
  await f.bind();
  await f.capture('1', 'one');
  await f.capture('2', 'two');
  assert.equal((await f.capture('1', 'one')).json().data.replayed, true);
  assert.equal(f.posts.at(-1).expectedHead, null);
  assert.equal((await f.capture('1', 'changed')).json().error.code, 'memory_event_changed');
  f.changeHead();
  assert.equal((await f.capture('3', 'three')).json().error.code, 'memory_source_changed');
  await f.run(['unbind', '--session', f.session]);
  await f.bind();
  assert.equal((await f.capture('3', 'three')).json().error.code, 'memory_source_changed');
  assert.equal(f.posts.at(-1).expectedHead, f.posts.at(-2).expectedHead);
  writeFileSync(f.authFile, JSON.stringify({ ...f.auth, device_token: 'different-login' }));
  assert.equal((await f.capture('4', 'private')).json().error.code, 'memory_unbound');
  writeFileSync(f.authFile, JSON.stringify(f.auth));
  f.bindProject(f.auth.api_url, 'other-project');
  assert.equal((await f.capture('5', 'private')).json().error.code, 'memory_unbound');
  f.bindProject('http://127.0.0.1:1');
  assert.equal((await f.run(['search', 'sensitive'])).json().error.code, 'memory_api_mismatch');
});

test('unassigned sessions omit all business witnesses, expose durable job status and retry only the original failed job', async t => {
  const f = await fixture(t);
  for (const arg of ['--topic', '--requirement']) {
    const half = await f.run(['bind', '--session', f.session, arg, 'object']);
    assert.equal(half.json().error.code, 'memory_target_required');
  }
  assert.equal(f.bindingReads(), 0);
  const bound = (await f.run(['bind', '--session', f.session])).json().data;
  assert.equal(bound.expectedRevision, undefined);
  assert.equal(bound.topicCode, undefined);
  const first = (await f.capture('private-1', '我习惯用中文写提交说明')).json().data;
  assert.equal(first.status, 'pending');
  assert.equal(first.items, undefined, 'queued acknowledgement must not invent extracted memories');
  assert.equal((await f.capture('private-1', '我习惯用中文写提交说明')).json().data.replayed, true);
  assert.equal(f.jobs.size, 1);
  assert.deepEqual(Object.keys(f.queuePosts[0]).sort(), ['eventId', 'sessionId', 'sourceText']);
  assert.equal(f.jobReads.length, 0, 'capture does not poll');
  let result = (await f.sync()).json().data;
  assert.equal(result.jobs[0].status, 'pending');
  assert.equal(f.jobReads.length, 1, 'sync performs one status read, not a completion loop');
  const job = f.jobs.get(first.captureCode);
  job.status = 'failed'; job.error = { code: 'model_unavailable', message: '暂不可用' };
  result = (await f.sync()).json().data;
  assert.equal(result.updatedJobs[0].error.code, 'model_unavailable');
  assert.equal((await f.run(['retry', first.captureCode])).json().data.status, 'pending');
  assert.equal(f.jobs.size, 1);
  assert.equal(f.queuePosts.length, 2, 'retry cannot submit a changed source or witness');
  job.status = 'needs_clarification';
  assert.equal((await f.run(['retry', first.captureCode])).json().error.code, 'memory_capture_not_retryable');
  assert.equal((await f.run(['capture-status', first.captureCode])).json().data.status, 'needs_clarification');
});

test('unassigned Codex Stop enqueues each native user event once and never polls asynchronous extraction', async t => {
  const f = await fixture(t);
  await f.run(['bind', '--session', f.session, '--transcript', f.transcript]);
  appendFileSync(f.transcript, turn('退款流程先讨论一下') + turn('就按这个方案做'));
  assert.equal((await f.hook()).code, 0);
  assert.equal((await f.hook()).code, 0);
  assert.equal(f.queuePosts.length, 2);
  assert.equal(new Set(f.queuePosts.map(row => row.eventId)).size, 2);
  assert.equal(f.posts.length, 0, 'unassigned discussion must not use synchronous business mutations');
  assert.equal(f.jobReads.length, 0, 'Stop must return after durable enqueue');
  const sync = (await f.sync()).json().data;
  assert.equal(sync.appended, 0);
  assert.equal(sync.queued, 0);
  assert.equal(sync.jobs.length, 2);
  assert.equal(f.jobReads.length, 2);
});

test('rebind cannot reinterpret a previously witnessed business event as an unassigned event', async t => {
  const f = await fixture(t);
  await f.bind(); await f.capture('same-event', 'one');
  await f.run(['unbind', '--session', f.session]);
  await f.run(['bind', '--session', f.session]);
  assert.equal((await f.capture('same-event', 'one')).json().error.code, 'memory_target_mismatch');
  assert.equal(f.queuePosts.length, 0);
  assert.equal((await f.capture('new-event', '新讨论')).json().data.status, 'pending');
});

test('desktop Codex item_completed speaks for the operator and model-input mirrors cannot create a reference', async t => {
  const f = await fixture(t);
  await f.bind('--transcript', f.transcript);
  const completed = (type, kind, text) => line('event_msg', { type: 'item_completed',
    item: { type, id: 'test-item', content: [{ type: kind, text }] } });
  const mirror = (role, text) => line('response_item', { type: 'message', role,
    content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] });
  const question = '是否采纳《退款进入人工审核》？';
  const bare = '就按这个方案做';
  const user = completed('UserMessage', 'text', bare);
  const hostCwd = JSON.parse(readFileSync(f.transcript, 'utf8').split('\n')[0]).payload.cwd;
  appendFileSync(f.transcript, completed('AgentMessage', 'Text', question) + mirror('assistant', question)
    + line('token_usage_record', {}) + line('event_msg', { type: 'token_count' })
    + line('event_msg', { type: 'task_complete' }) + line('event_msg', { type: 'task_started' })
    + line('turn_context', { cwd: hostCwd }) + mirror('user', bare) + user);
  const sync = (await f.sync()).json().data;
  assert.equal(sync.appended, 1);
  assert.equal(f.posts[0].referenceText, question);
  assert.equal(f.posts[0].sourceText, bare);
  appendFileSync(f.transcript, mirror('assistant', question) + user);
  assert.ok((await f.sync()).json().data.clarification);
  assert.equal(f.posts[1].referenceText, undefined);
  appendFileSync(f.transcript, completed('UserMessage', 'image', 'not trustworthy'));
  assert.equal((await f.sync()).json().error.code, 'memory_source_unsupported');
  assert.equal(f.posts.length, 2);
});

test('MCP resolves callers from the device and keeps personal queries scoped', async t => {
  const f = await fixture(t);
  const msgs = [
    { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { method: 'notifications/initialized' },
    { id: 2, method: 'tools/list' },
    { id: 3, method: 'tools/call', params: { name: 'search_memory', arguments: { query: '中文', scope: 'personal' } } },
    { id: 4, method: 'tools/call', params: { name: 'search_memory', arguments: { query: '秘密', actor: 'other' } } },
  ];
  const r = await f.run(['mcp'], msgs.map(msg => JSON.stringify({ jsonrpc: '2.0', ...msg })).join('\n') + '\n');
  assert.equal(r.code, 0);
  const replies = r.out.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(replies.map(r => r.id), [1, 2, 3, 4]);
  assert.deepEqual(replies[1].result.tools.slice(0, 8).map(t => t.name), ['get_connection_context', 'list_projects', 'search_memory', 'read_memory_brief', 'read_memory_source', 'read_memory_document', 'list_personal_memories', 'read_personal_memory']);
  assert.deepEqual(JSON.parse(replies[2].result.content[0].text), [{ state: 'discussion' }]);
  assert.equal(replies[3].error.code, -32602);
  assert.deepEqual(f.queries, [{ query: '中文', scope: 'personal' }]);
  assert.equal((await f.run(['search', '背景', '--scope', 'project'])).json().ok, true);
  assert.deepEqual(f.queries.at(-1), { query: '背景', scope: 'project' });
});

test('MCP expands a document page with a fixed source and rejects forged ownership or conflicting ranges', async t => {
  const source = '0'.repeat(20), posted = [];
  let forged = false;
  const f = await fixture(t, () => [], () => [], async body => {
    posted.push(body);
    return { source, sourceKind: 'project_document', state: 'documented', scope: forged ? 'personal' : 'project',
      text: '原文中的文末约束', range: { offset: 2000, nextOffset: null, total: 2010, unit: 'utf16' } };
  });
  const args = { source, query: '文末约束', occurrence: 'last', limit: 500 };
  const messages = [
    { id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
    { id: 2, method: 'tools/call', params: { name: 'read_memory_document', arguments: args } },
    { id: 3, method: 'tools/call', params: { name: 'read_memory_document', arguments: { ...args, actor: 'someone' } } },
    { id: 4, method: 'tools/call', params: { name: 'read_memory_document', arguments: { ...args, offset: 0 } } },
  ];
  const run = await f.run(['mcp'], messages.map(msg => JSON.stringify({ jsonrpc: '2.0', ...msg })).join('\n') + '\n');
  assert.equal(run.code, 0);
  const replies = run.out.trim().split('\n').map(line => JSON.parse(line));
  assert.match(JSON.parse(replies[1].result.content[0].text)[0].text, /文末约束/u);
  assert.equal(replies[2].error.code, -32602);
  assert.equal(replies[3].error.code, -32602);
  assert.deepEqual(posted, [args]);
  forged = true;
  const bad = await f.run(['mcp'], messages.slice(0, 2).map(msg => JSON.stringify({ jsonrpc: '2.0', ...msg })).join('\n') + '\n');
  const rejection = JSON.parse(bad.out.trim().split('\n').at(-1));
  assert.equal(rejection.result.isError, true);
  assert.match(rejection.result.content[0].text, /memory_invalid_document/u);
});

async function resourceRequests(f, requests) {
  const input = [{ method: 'initialize', params: { protocolVersion: '2025-11-25' } }, ...requests]
    .map((msg, id) => JSON.stringify({ jsonrpc: '2.0', id, ...msg })).join('\n');
  const result = await f.run(['mcp'], input + '\n');
  assert.equal(result.code, 0);
  return result.out.trim().split('\n').map(row => JSON.parse(row));
}

async function withMcp(f, work, env) {
  const child = f.startMcp(env);
  const exited = once(child, 'close');
  const lines = createInterface({ input: child.stdout });
  const replies = lines[Symbol.asyncIterator]();
  let seq = 0;
  const rpc = async (method, params) => {
    const id = ++seq;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    const reply = await replies.next();
    assert.equal(reply.done, false, 'MCP exited before replying');
    const frame = JSON.parse(reply.value);
    assert.equal(frame.id, id);
    return frame;
  };
  try {
    await rpc('initialize', { protocolVersion: '2025-11-25' });
    await work(rpc);
  } finally {
    child.stdin.end();
    await exited;
    lines.close();
  }
}

const memoryRead = async (rpc, name, args) => {
  const response = await rpc('tools/call', { name, arguments: args });
  assert.equal(response.error, undefined);
  assert.equal(response.result.isError, undefined, response.result.content[0]?.text);
  return { rows: JSON.parse(response.result.content[0].text), metadata: JSON.parse(response.result.content[1].text) };
};

test('persistent MCP revalidates explicit receipt branches, returns changes and removes withdrawn sources', async t => {
  let row = { scope: 'project', source: 'entry-A', state: 'discussed', text: '待决定的退款方案', sourceRevision: 1 };
  let available = true;
  const f = await fixture(t, () => [{ ...row, evidenceStatus: '议题记录说明' }],
    sources => available && sources.includes(row.source) ? [row] : []);
  await withMcp(f, async rpc => {
    const first = await memoryRead(rpc, 'read_memory_brief', { scope: 'project' });
    assert.equal(first.rows[0].text, '待决定的退款方案');
    assert.deepEqual(f.sourceReads, []);
    const receipt = first.metadata.context_receipt;
    const repeat = await memoryRead(rpc, 'read_memory_brief', { scope: 'project', context_receipt: receipt });
    assert.deepEqual(repeat.rows, []);
    assert.equal(repeat.metadata.unchanged_sources[0].source, 'entry-A');
    assert.deepEqual(f.sourceReads, [['entry-A']]);
    // A fresh chat can use this same server without inheriting another chat's read state.
    assert.equal((await memoryRead(rpc, 'read_memory_brief', { scope: 'project' })).rows.length, 1);
    const forced = await memoryRead(rpc, 'read_memory_source', { source: 'entry-A', context_receipt: repeat.metadata.context_receipt });
    assert.equal(forced.rows[0].text, '待决定的退款方案');
    assert.deepEqual(forced.metadata.unchanged_sources, []);
    row = { ...row, state: 'confirmed', text: '已确认的退款方案', sourceRevision: 2 };
    const changed = await memoryRead(rpc, 'read_memory_brief', { scope: 'project', context_receipt: forced.metadata.context_receipt });
    assert.equal(changed.rows[0].text, '已确认的退款方案');
    assert.equal(changed.rows[0].state, 'confirmed');
    assert.doesNotMatch(JSON.stringify(changed), /待决定/);
    available = false;
    const withdrawn = await memoryRead(rpc, 'read_memory_brief', { scope: 'project', context_receipt: changed.metadata.context_receipt });
    assert.deepEqual(withdrawn.rows, []);
    assert.deepEqual(withdrawn.metadata.unavailable_sources, ['entry-A']);
    assert.doesNotMatch(JSON.stringify(withdrawn), /已确认的退款方案/);
    const denied = await rpc('tools/call', { name: 'read_memory_source', arguments: { source: 'entry-A', context_receipt: withdrawn.metadata.context_receipt } });
    assert.equal(denied.result.isError, true);
    assert.match(denied.result.content[0].text, /memory_source_unavailable/);
    assert.doesNotMatch(JSON.stringify(denied), /已确认的退款方案|待决定/);
  });
});

test('MCP uses latest authorized version after a read and rejects forged revalidation responses', async t => {
  const old = { scope: 'project', source: 'entry-A', state: 'discussed', text: '旧讨论' };
  let fresh = old;
  const f = await fixture(t, () => [old], () => [fresh]);
  await withMcp(f, async rpc => {
    const first = await memoryRead(rpc, 'read_memory_brief', { scope: 'project' });
    fresh = { ...old, state: 'confirmed', text: '校验阶段已确认的最新结论' };
    const updated = await memoryRead(rpc, 'read_memory_brief', { scope: 'project', context_receipt: first.metadata.context_receipt });
    assert.deepEqual(updated.rows, [fresh]);
    assert.doesNotMatch(JSON.stringify(updated), /旧讨论/);
    fresh = { ...old, source: 'other-source', text: '不可返回的外部内容' };
    const forged = await rpc('tools/call', { name: 'read_memory_brief', arguments: { scope: 'project', context_receipt: updated.metadata.context_receipt } });
    assert.equal(forged.result.isError, true);
    assert.match(forged.result.content[0].text, /memory_invalid_sources/);
    assert.doesNotMatch(JSON.stringify(forged), /不可返回的外部内容/);
  });
});

test('full baseline retains the receipt surface and a bound project change cannot reuse it', async t => {
  const row = { scope: 'project', source: 'entry-A', state: 'discussed', text: '公共背景' };
  const f = await fixture(t, () => [row], () => [row]);
  await withMcp(f, async rpc => {
    const first = await memoryRead(rpc, 'read_memory_brief', { scope: 'project' });
    const repeat = await memoryRead(rpc, 'read_memory_brief', { scope: 'project', context_receipt: first.metadata.context_receipt });
    assert.deepEqual(repeat.rows, [row]);
    assert.deepEqual(repeat.metadata.unchanged_sources, []);
    assert.ok(repeat.metadata.context_receipt);
    f.bindProject(f.auth.api_url, 'other-project');
    const switched = await rpc('tools/call', { name: 'read_memory_brief', arguments: { scope: 'project', context_receipt: repeat.metadata.context_receipt } });
    assert.equal(switched.result.isError, true);
    assert.match(switched.result.content[0].text, /memory_binding_changed/);
    assert.doesNotMatch(JSON.stringify(switched), /公共背景/);
  }, { TSP_MEMORY_CONTEXT_MODE: 'full' });
});

test('tracked MCP restores current authorized source bodies after compaction and process restart, never another chat', async t => {
  const a = '0'.repeat(19) + '1', b = '0'.repeat(19) + '2';
  let rows = [
    { source: a, scope: 'project', state: 'discussed', text: '历史执行观察', sourceRevision: 1, topicStatus: 'decided' },
    { source: b, scope: 'project', state: 'discussed', text: '随后撤回的观察', sourceRevision: 1 },
  ];
  let current = rows;
  const f = await fixture(t, () => rows, sources => current.filter(row => sources.includes(row.source)));
  const session = 'tracked-chat';
  let latest;
  await withMcp(f, async rpc => {
    const first = await memoryRead(rpc, 'read_memory_brief', { scope: 'project' });
    assert.equal(first.metadata.context_reset, 'new-session');
    const repeat = await memoryRead(rpc, 'read_memory_brief', { scope: 'project', context_receipt: first.metadata.context_receipt });
    assert.deepEqual(repeat.rows, []);
    const before = (await f.run(['context', 'inspect', '--session', session])).json().data;
    assert.equal(before.sourceCount, 2);
    rows = [];
    current = [{ ...current[0], text: '重新授权回读到的最新观察', sourceRevision: 2 }];
    const reset = (await f.run(['context', 'reset', '--session', session, '--reason', 'compaction'])).json().data;
    assert.notEqual(reset.epoch, repeat.metadata.context_epoch);
    assert.equal(reset.expiresAt, before.expiresAt);
    const recovered = await memoryRead(rpc, 'read_memory_brief', { scope: 'project', context_receipt: repeat.metadata.context_receipt });
    assert.deepEqual(recovered.rows, current);
    assert.equal(recovered.metadata.context_reset, 'compaction');
    assert.deepEqual(recovered.metadata.unavailable_sources, [b]);
    assert.deepEqual(recovered.metadata.restored_sources, [a]);
    assert.deepEqual(recovered.metadata.unchanged_sources, []);
    latest = recovered.metadata.context_receipt;
  }, { TSP_MEMORY_SESSION: session });
  await withMcp(f, async rpc => {
    const recovered = await memoryRead(rpc, 'read_memory_brief', { scope: 'project', context_receipt: latest });
    assert.deepEqual(recovered.rows, current);
    assert.equal(recovered.metadata.context_reset, 'process_restart');
    assert.deepEqual(recovered.metadata.unchanged_sources, []);
    await f.run(['context', 'reset', '--session', session, '--reason', 'new-chat']);
    assert.deepEqual((await memoryRead(rpc, 'read_memory_brief', { scope: 'project', context_receipt: recovered.metadata.context_receipt })).rows, []);
  }, { TSP_MEMORY_SESSION: session });
  await withMcp(f, async rpc => {
    const other = await memoryRead(rpc, 'read_memory_brief', { scope: 'project', context_receipt: latest });
    assert.deepEqual(other.rows, []);
    assert.equal(other.metadata.context_reset, 'new-session');
  }, { TSP_MEMORY_SESSION: 'different-chat' });
});

test('tracked MCP rejects an in-flight result when the host resets its epoch, then recovers on retry', async t => {
  const row = { source: '0'.repeat(20), scope: 'project', state: 'discussed', text: '当前已授权观察' };
  const session = 'racing-chat';
  let resetDuringRead = false;
  let f;
  f = await fixture(t, () => [row], async () => {
    if (resetDuringRead) {
      resetDuringRead = false;
      assert.equal((await f.run(['context', 'reset', '--session', session, '--reason', 'compaction'])).code, 0);
    }
    return [row];
  });
  await withMcp(f, async rpc => {
    const first = await memoryRead(rpc, 'read_memory_brief', { scope: 'project' });
    resetDuringRead = true;
    const rejected = await rpc('tools/call', { name: 'read_memory_brief', arguments: { scope: 'project', context_receipt: first.metadata.context_receipt } });
    assert.equal(rejected.result.isError, true);
    assert.match(rejected.result.content[0].text, /memory_context_changed/);
    assert.doesNotMatch(JSON.stringify(rejected), /当前已授权观察/);
    const retry = await memoryRead(rpc, 'read_memory_brief', { scope: 'project', context_receipt: first.metadata.context_receipt });
    assert.deepEqual(retry.rows, [row]);
    assert.equal(retry.metadata.context_reset, 'compaction');
  }, { TSP_MEMORY_SESSION: session });
});

const projectBrief = 'tsp-memory://project/brief';
const preferences = 'tsp-memory://personal/preferences';

test('all harness guidance distinguishes new information from retrieval and durable queue completion', async t => {
  const f = await fixture(t);
  for (const args of [[], ['--harness', 'dsh'], ['--harness', 'opencode']]) {
    const result = await f.run(['guidance', ...args]);
    assert.equal(result.code, 0);
    assert.match(result.out, /仅声明新的偏好或补充信息/u);
    assert.match(result.out, /不为登记新信息重复检索/u);
    assert.match(result.out, /未拿到保存回执不声称已保存/u);
    assert.match(result.out, /pending仅表示已入队/u);
    assert.match(result.out, /completed后仍须按回执实际内容/u);
  }
  assert.equal(f.posts.length + f.queuePosts.length + f.queries.length + f.briefs.length, 0);
});
const read = (uri, params = {}) => ({ method: 'resources/read', params: { uri, ...params } });

test('tool-only hosts and the CLI can read the same scoped evidence without a query or a task', async t => {
  const evidence = [{ scope: 'personal', source: 'self-only', state: 'preference', text: '本人记录' }];
  const f = await fixture(t, () => evidence);
  const tool = args => ({ method: 'tools/call', params: { name: 'read_memory_brief', arguments: args } });
  const [, valid, mixed, forged] = await resourceRequests(f, [
    tool({ scope: 'personal' }), tool({ scope: 'both' }), tool({ scope: 'personal', actor: 'B' }),
  ]);
  assert.deepEqual(JSON.parse(valid.result.content[0].text), evidence);
  assert.equal(mixed.error.code, -32602);
  assert.equal(forged.error.code, -32602);
  const viaCli = await f.run(['brief', '--scope', 'personal']);
  assert.deepEqual(JSON.parse(viaCli.out).data, evidence);
  assert.deepEqual(f.briefs, ['personal', 'personal']);
  const guide = await f.run(['guidance', '--harness', 'dsh']);
  assert.match(guide.out, /read_memory_brief/);
  assert.match(guide.out, /当前工具目录/);
  assert.doesNotMatch(guide.out, /self-only|本人记录/);
});

test('resource discovery contains only metadata and reading returns scoped records with their original evidence', async t => {
  const rows = {
    project: [{ scope: 'project', state: 'discussed', source: 'entry-A', text: '成员提出新方案' }],
    personal: [{ scope: 'personal', state: 'preference', source: 'fragment-A', text: '私有提交习惯' }],
  };
  const f = await fixture(t, scope => rows[scope]);
  const [init, list, templates, badCursor] = await resourceRequests(f, [
    { method: 'resources/list' }, { method: 'resources/templates/list' }, { method: 'resources/list', params: { cursor: 'forged' } },
  ]);
  assert.deepEqual(init.result.capabilities.resources, {});
  assert.deepEqual(list.result.resources.map(r => r.uri), [projectBrief, preferences]);
  assert.doesNotMatch(JSON.stringify(list), /成员提出新方案|私有提交习惯|entry-A|fragment-A|member-A|test-device/);
  assert.deepEqual(templates.result.resourceTemplates, []);
  assert.equal(badCursor.error.code, -32602);
  assert.deepEqual(f.briefs, []);

  const [, project, personal, badActor, otherProject, foreignHost] = await resourceRequests(f, [
    read(projectBrief), read(preferences), read(preferences, { actor: 'member-B' }),
    read(projectBrief + '?project=Q'), read('https://untrusted.example/resource'),
  ]);
  for (const [response, uri, expected] of [[project, projectBrief, rows.project], [personal, preferences, rows.personal]]) {
    const [content] = response.result.contents;
    assert.deepEqual([content.uri, content.mimeType], [uri, 'application/json']);
    assert.deepEqual(JSON.parse(content.text), expected);
  }
  assert.equal(badActor.error.code, -32602);
  assert.equal(otherProject.error.code, -32002);
  assert.equal(foreignHost.error.code, -32002);
  assert.deepEqual(f.briefs, ['project', 'personal']);
  assert.deepEqual(f.queries, []);
});

test('resource reads reject crossed scopes and a local device switch during a request', async t => {
  const outside = { scope: 'personal', state: 'preference', source: 'other-fragment', text: 'private-canary' };
  const f = await fixture(t, scope => {
    if (scope === 'personal') writeFileSync(f.authFile, JSON.stringify({ ...f.auth, device_token: 'new-device' }));
    return [outside];
  });
  const [, crossed, switched, later] = await resourceRequests(f, [read(projectBrief), read(preferences), read(preferences)]);
  assert.equal(crossed.error.message, 'memory_invalid_brief');
  assert.equal(switched.error.message, 'memory_binding_changed');
  assert.equal(later.error.message, 'memory_binding_changed');
  assert.doesNotMatch(JSON.stringify([crossed, switched, later]), /private-canary|other-fragment/);
  assert.deepEqual(f.briefs, ['project', 'personal']);
});
