import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const variant = process.argv[2];
if (!['baseline', 'substring', 'control', 'live', 'live-decisions', 'live-project'].includes(variant)) throw Error('Unknown probe variant');
const live = ['live', 'live-decisions', 'live-project'].includes(variant);
const withDecisions = ['live-decisions', 'live-project'].includes(variant);
const projectOnly = variant === 'live-project';
const model = 'hub-qwen2.5:latest';
const server = fileURLToPath(new URL('../transport/probe.mjs', import.meta.url));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsp-agent-use-')));
const session = 'agent-use-synthetic';
const env = { ...process.env, TSP_PROBE_DIR: root, TSP_PROBE_ACTOR: 'alice', TSP_PROBE_PROJECT: 'refund' };
const questions = {
  project: '我们之前讨论过：退款超过七天该怎么处理？目前定下来了吗？',
  personal: '给这个项目写 Git commit 时，我习惯用哪种语言写提交说明？',
  unrelated: '17 加 25 等于多少？',
};
const controls = {
  project: '请用记忆工具查询，关键词只填「退款」。根据结果，七天以上人工审核是讨论中的提议，还是已经确认或落实？',
  personal: '请用记忆工具查「提交说明」这个关键词。我习惯用什么语言写提交说明？资料里有没有允许自动推送？',
};
const liveQuestions = {
  contract: '本项目已确认的架构图片契约如何限制编码后的大小？是否按完整 data URL 计算，是否做完整解码？最终用 JSON 回答 maxEncodedBytes（整数）、includePrefix（布尔值）、fullDecode（布尔值）。缺少项目依据时对应字段填 null。',
  experience: '我以前怎样验证 Base64 规范化和图片编码长度边界？最终用 JSON 回答 source（实际采用的本人经验来源 ID，未知填 null）。',
  unrelated: questions.unrelated,
};
const instructions = '你是刚进入项目的协作助手。根据用户当前的问题，自行决定是否调用可用工具。简洁回答，保留资料中表达的确定程度。';
const searchHint = '用户问本项目历史、决定、个人惯例时可从此工具取得依据。试验存储按连续子串查找，query 只填一个短名词或术语。无匹配时可以换短词，空结果仅表示本次未匹配。';

function seed() {
  writeFileSync(join(root, 'synthetic-fixture.json'), JSON.stringify({
    members: { refund: ['alice'] }, sessions: [{ actor: 'alice', project: 'refund', id: session, cwd: '.', transcript: 'turn.jsonl' }],
  }));
  const transcript = join(root, 'turn.jsonl');
  writeFileSync(transcript, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user',
    content: [{ type: 'input_text', text: '退款超过七天也许需要人工审核。我在这个项目习惯写中文提交说明。' }] } }) + '\n');
  const run = spawnSync(process.execPath, [server, 'hook'], { env, encoding: 'utf8', windowsHide: true, timeout: 10000,
    input: JSON.stringify({ hook_event_name: 'Stop', session_id: session, transcript_path: transcript, cwd: root }) });
  if (run.status !== 0 || JSON.parse(run.stdout).appended !== 1) throw Error('Synthetic capture failed');
}

async function startMcp() {
  const args = live ? [fileURLToPath(new URL('live-server.mjs', import.meta.url)), projectOnly ? 'project' : withDecisions ? 'decisions' : 'search-only'] : [server, 'mcp'];
  const child = spawn(process.execPath, args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const send = msg => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  let next = 0;
  async function request(method, params) {
    const id = ++next;
    send({ id, method, params });
    const reply = await lines.next();
    if (reply.done) throw Error('Unexpected MCP transport EOF');
    const value = JSON.parse(reply.value);
    if (value.id !== id || value.error) throw Error(`MCP ${method} failed`);
    return value.result;
  }
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agent-use', version: '1.0' } });
  send({ method: 'notifications/initialized' });
  const { tools } = await request('tools/list', {});
  return { request, tools, close: async () => { const exited = once(child, 'exit'); child.stdin.end(); await exited; } };
}

function liveFacts(id, content, rows) {
  if (id === 'unrelated') return { arithmeticCorrect: /\b42\b/.test(content) };
  // The model may surround its final, flat JSON object with ordinary prose.
  // Select exactly one checkable object without ever serializing that prose.
  const candidates = [];
  for (const segment of content.matchAll(/\{[^{}]{1,1600}\}/g)) {
    try { candidates.push(JSON.parse(segment[0])); } catch { /* Ignore malformed fragments. */ }
  }
  const required = id === 'experience' ? ['source'] : ['maxEncodedBytes', 'includePrefix', 'fullDecode'];
  const matched = candidates.filter(obj => required.every(key => Object.hasOwn(obj, key)));
  const formalFacts = id === 'contract' && withDecisions ? {
    publicSourcesDelivered: rows.filter(r => r.scope === 'project').length,
    answerMentionsSixMiB: /6\s*MiB/i.test(content), exactByteValueMentioned: /\b6291456\b/.test(content.replace(/[,，_]/g, '')),
    binaryExpressionMentioned: /6\s*[*×]\s*1024\s*[*×]\s*1024/i.test(content),
    includePrefixField: content.match(/["']?includePrefix["']?\s*[:：=]\s*(true|false|null)/i)?.[1]?.toLowerCase() ?? 'absent',
    fullDecodeField: content.match(/["']?fullDecode["']?\s*[:：=]\s*(true|false|null)/i)?.[1]?.toLowerCase() ?? 'absent',
  } : {};
  if (matched.length !== 1) return { parseable: false, jsonObjects: candidates.length, matchingShapes: matched.length,
    citesReturnedPersonalSource: rows.some(r => r.scope === 'personal' && content.includes(r.source)), ...formalFacts };
  const [fields] = matched;
  if (id === 'experience') return { parseable: true, citesReturnedPersonalSource: rows.some(r => r.scope === 'personal' && fields.source === r.source),
    citesImageStudyExperience: fields.source === 'experience_e03f85c4-3013-4a4e-bfac-47b017c332fd' && rows.some(r => r.scope === 'personal' && r.source === fields.source) };
  const envelope = (key, expected) => fields[key] === null ? 'unknown' : fields[key] === expected ? 'matches_known_contract' : 'unexpected_or_absent';
  return { parseable: true, publicSourcesDelivered: rows.filter(r => r.scope === 'project').length,
    ...(withDecisions ? { ...formalFacts,
      numericAnswer: [6, 6144, 6000000, 6291456, null].includes(fields.maxEncodedBytes) ? fields.maxEncodedBytes : 'other' } : {}),
    limit: envelope('maxEncodedBytes', 6 * 1024 * 1024), prefix: envelope('includePrefix', true), fullDecode: envelope('fullDecode', false) };
}

async function ask(mcp, userText, id) {
  const calls = [];
  const received = [];
  const tools = mcp.tools.map(t => ({ type: 'function', function: { name: t.name,
    description: t.description + (variant === 'substring' ? searchHint : ''), parameters: t.inputSchema } }));
  const messages = [{ role: 'system', content: instructions }, { role: 'user', content: userText }];
  for (let round = 0; round < 4; round++) {
    const response = await fetch('http://127.0.0.1:11434/api/chat', { method: 'POST', redirect: 'error',
      signal: AbortSignal.timeout(120000), headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, stream: false, messages, tools, options: { temperature: 0, seed: 42, num_ctx: 4096, num_predict: 240 } }) });
    if (!response.ok) throw Error(`Local model HTTP ${response.status}`);
    const { message } = await response.json();
    if (!message.tool_calls?.length) return live ? { calls, facts: liveFacts(id, message.content, received) } : { calls, answer: message.content };
    messages.push(message);
    for (const call of message.tool_calls) {
      if (calls.length >= 3) return { calls, answer: null, stop: 'tool budget exhausted' };
      const { name, arguments: args } = call.function;
      if (!mcp.tools.some(t => t.name === name)) throw Error('Model selected unknown tool');
      const result = await mcp.request('tools/call', { name, arguments: args });
      const content = result.content[0].text;
      const parsed = JSON.parse(content);
      const rows = live ? parsed.rows : parsed;
      received.push(...rows);
      const diagnostics = parsed.mode === 'formal_read' ? { mode: 'formal_read', records: rows.length, omitted: parsed.omitted }
        : live ? { projectMode: parsed.projectMode, accountMode: parsed.accountMode, hits: rows.length } : { args, hits: rows.length };
      if (projectOnly) Object.assign(diagnostics, { listedTaskScopedRecords: rows.filter(row => row.applicability === 'listed_tasks').length,
        versionedSources: rows.filter(row => row.source && row.hash && row.version).length });
      calls.push({ name, ...diagnostics, states: rows.map(row => row.state), scopes: rows.map(row => row.scope) });
      messages.push({ role: 'tool', tool_name: name, content });
    }
  }
  return { calls, answer: null, stop: 'round budget exhausted' };
}

let mcp;
try {
  if (!live) seed();
  mcp = await startMcp();
  const report = { variant, model, taskClaimed: false, fixture: projectOnly ? 'Bob project: teamsynergy' : live ? 'Bob context: teamsynergy/image-preflight' : 'one synthetic mixed turn via Stop', toolNames: mcp.tools.map(t => t.name),
    toolsContractSuffix: variant === 'substring' ? searchHint : '', runs: [] };
  report.explicitLookupControl = variant === 'control';
  if (live) Object.assign(report, { taskScopeRequired: !projectOnly, projectOnlyColdStartVerified: false });
  for (const [id, question] of Object.entries(variant === 'control' ? controls : live ? liveQuestions : questions)) {
    const result = await ask(mcp, question, id);
    report.runs.push({ id, question, ...result });
    console.error(id, result.calls.length, 'calls,', result.calls.reduce((n, c) => n + (c.hits ?? 0), 0), 'search hits');
  }
  if (projectOnly) report.projectOnlyColdStartVerified = report.runs.some(run => run.calls.some(call => call.versionedSources > 0));
  writeFileSync(new URL(`observed-${variant}.json`, import.meta.url), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally {
  if (mcp) await mcp.close();
  if (dirname(root) === realpathSync(tmpdir()) && basename(root).startsWith('tsp-agent-use-')) rmSync(root, { recursive: true });
}
