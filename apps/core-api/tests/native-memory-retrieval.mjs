import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createMemorySliceUseCases } from '@team-synergy/application';

const self = fileURLToPath(import.meta.url);
const cli = fileURLToPath(new URL('../../cli/dist/index.js', import.meta.url));
const legacyDescription = '查找背景时区分设想、确认和落实。公共业务或背景选 project 查询共享 Wiki；个人风格选 personal 查询账号经验。含私人信息的问题勿发往 project。省略范围使用平台授权检索。偏好不能授予执行权限。需要确认方案时可单独询问“是否采纳《方案原文》？”，或请操作者说“确认采纳：方案原文”。';
const instructions = '你是团队项目助手。请用中文简洁回答。项目规则和个人习惯若有依据，请一并给出记录编码；无法核实时请说明。';
const arms = ['tools','resources','guided','native','catalog','dynamic'];
const agentModel = () => process.env.TSP_EVAL_MODEL || process.env.TSP_MEMORY_MODEL || 'hub-qwen2.5:latest';
const questions = {
  discussion: '我们正在讨论的超期退款要怎么处理，已经定下来了吗？',
  confirmed: '现在订单超过退款时限，要按什么约定处理？做到哪一步了？',
  personal: '按我在这个项目的习惯，代码改完时变更说明应该怎么写？',
  control: '17 加 25 等于多少？',
};

function decodedRows(result) {
  const blocks = result?.contents ?? result?.content ?? [];
  return blocks.flatMap(block => {
    try {
      const rows = JSON.parse(block.text);
      if (!Array.isArray(rows)) return [];
      return rows.filter(row => row && typeof row.source === 'string').map(row => ({ source:row.source,scope:row.scope,state:row.state }));
    } catch { return []; }
  });
}

// Freeze only the MCP surface that existed before resource discovery. Both arms
// use the installed CLI and its actual authenticated API; no result is simulated.
async function proxy(variant, audit) {
  assert.ok(arms.includes(variant));
  const env = Object.fromEntries(['PATH','SystemRoot','AGENTCTL_HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP','HOME'].filter(k => process.env[k]).map(k => [k,process.env[k]]));
  const child = spawn(process.execPath,[cli,'memory','mcp'],{stdio:['pipe','pipe','inherit'],windowsHide:true,env});
  const sent = new Map();
  const send = value => process.stdout.write(JSON.stringify(value)+'\n');
  const record = row => appendFileSync(audit,JSON.stringify(row)+'\n',{mode:0o600});
  child.on('error',()=>{process.exitCode=1;});
  const up = createInterface({input:process.stdin});
  up.on('line',line=>{
    const req = JSON.parse(line);
    if (variant === 'tools' && req.method?.startsWith('resources/')) {
      if (req.id !== undefined) send({jsonrpc:'2.0',id:req.id,error:{code:-32601,message:'Method not found'}});
      return;
    }
    if (['tools','resources'].includes(variant) && req.method==='tools/call' && req.params?.name!=='search_memory') {
      send({jsonrpc:'2.0',id:req.id,error:{code:-32602,message:'Unknown tool'}});
      return;
    }
    if (req.id !== undefined) sent.set(req.id,req);
    child.stdin.write(line+'\n');
  });
  up.on('close',()=>child.stdin.end());
  const down = createInterface({input:child.stdout});
  for await (const line of down) {
    const msg = JSON.parse(line);
    const req = sent.get(msg.id);
    sent.delete(msg.id);
    if (variant === 'tools' && req?.method === 'initialize' && msg.result) {
      msg.result = {protocolVersion:msg.result.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'tsp-memory',version:'0.1.0'}};
    }
    if (['tools','resources'].includes(variant) && req?.method === 'tools/list' && msg.result) {
      msg.result.tools = msg.result.tools.filter(tool=>tool.name==='search_memory').map(tool=>({...tool,description:legacyDescription}));
    }
    if (['tools/call','resources/read'].includes(req?.method)) {
      record({ method:req.method, name:req.params?.name, rows:decodedRows(msg.result), error:Boolean(msg.error || msg.result?.isError) });
    }
    send(msg);
  }
}

async function rollout(member,threadId) {
  const folder = path.join(member.codexHome,'sessions');
  for (let n=0;n<5;n++) {
    const file = (await readdir(folder,{recursive:true}).catch(()=>[])).find(name=>name.endsWith(threadId+'.jsonl'));
    if (file) {
      const rows = (await readFile(path.join(folder,file),'utf8')).split('\n').filter(Boolean).map(line=>{try{return JSON.parse(line);}catch{return {};}});
      if (rows.some(r=>r.payload?.role==='assistant' || r.payload?.type==='task_complete')) return rows;
      if (n===4) return rows;
    }
    await pause(200);
  }
  return [];
}

function factualAnswer(id,text) {
  const normalized = text.replace(/[\s*_]/gu,'');
  const asserted = normalized.replace(/(?:尚未|仍未|并未|还没(?:有)?|没有|未经|未|待)(?:正式|最终|被|得到)?(?:确认|采纳|决定|确定|定下来|定案|落实|实施|上线)/gu,'');
  const pending = /讨论|提议|尚未(?:确定|确认|决定|定)|还没定|待确认|建议/u.test(normalized);
  const adopted = /(?:已(?:经)?|正式|最终|现已|明确)(?:被)?(?:确认|采纳|决定|确定|通过|定下来|定案)|确认采纳|确认的?(?:记录|决定|结论|约定)|已达成|已定|定下来了|确定了|已形成|状态.{0,8}confirmed/iu.test(asserted);
  const progress = /实施|执行|落实|上线|部署|实现|交付|落地|完成|进度|进展|做到了?哪一步|达到这一步骤/u;
  const clauses = normalized.split(/[。，；;：:！？!?,\n]|但是|不过|所以|因此/u);
  const uncertainty = clause => /无法(?:据此)?(?:确认|确定|判断|证明)|不能(?:据此)?(?:确认|确定|判断|证明|推断)|未能确认|尚不(?:清楚|明确)|未知|不得而知|不明确|待核实|无从判断/u.test(clause)
    || /(?:未(?:看到|见到|查到|见|提供|说明|记录|有)|尚无|暂无|没有|缺少|缺乏|不足|无相关|无实际|无).{0,30}(?:证据|记录|信息|情况|步骤|说明|具体做到了?哪一步)/u.test(clause)
    || /(?:尚未|暂未|没有).{0,10}(?:看到|查到|说明|提供).{0,28}(?:进度|证据|记录|情况|步骤|做到了?哪一步)/u.test(clause)
    || /(?:证据|记录|信息|情况).{0,15}(?:不足|缺失|未说明|不详|不明确|暂缺)/u.test(clause);
  const unknownProgress = clauses.some(clause => progress.test(clause) && uncertainty(clause));
  const assertedProgress = clauses.some(clause => !uncertainty(clause) && /(?:已经?|现已|尚未|暂无|还没有|还没|并未|仍未|暂未|未|没有)(?:正式|实际|完成|开始)?(?:上线|落实|实施|部署|实现|开发|交付|落地|达到这一步骤)|(?:实施|落实|上线|部署)(?:了|完毕|完成)/u.test(clause));
  if(id==='control') return /(?:^|[^\d])42(?:$|[^\d])/u.test(text);
  if(id==='personal') return /中文|汉语/u.test(text) && !/不(?:用|使用|要用)中文/u.test(text);
  const rule = /[七7]\s*(?:天|日)/u.test(text) && /人工.{0,5}审/u.test(text);
  if(id==='discussion') return rule && pending && !adopted;
  return rule && adopted && unknownProgress && !assertedProgress;
}

// Counterexamples from independent review; keep separate from the production memory extractor.
assert.equal(factualAnswer('discussion','处理方式已定下来：建议退款超过七天进入人工审核。确认采纳这个提议。'),false);
assert.equal(factualAnswer('discussion','讨论中建议退款超过七天进入人工审核，目前尚未正式采纳。'),true);
assert.equal(factualAnswer('confirmed','根据项目背景确认的记录，退款超过七天将进入人工审核流程。目前尚未在记录中看到具体执行步骤或实施情况。'),true);
assert.equal(factualAnswer('confirmed','已采纳退款超过七天进入人工审核。尚未标明作者，现已上线。'),false);
assert.equal(factualAnswer('confirmed','已确认退款超过七天进入人工审核。尚未实施。'),false);
assert.equal(factualAnswer('confirmed','已确认退款超过七天进入人工审核。目前尚未达到这一步骤。'),false);
assert.equal(factualAnswer('confirmed','已确认退款超过七天进入人工审核。缺少实施记录，但已经上线。'),false);
assert.equal(factualAnswer('confirmed','已确认退款超过七天进入人工审核。缺少实施记录，所以尚未上线。'),false);
assert.equal(factualAnswer('confirmed','已确认退款超过七天进入人工审核。尚无执行证据，无法确认是否已上线。'),true);
assert.equal(factualAnswer('confirmed','根据团队的确认约定，退款超过七天进入人工审核。目前尚未说明具体做到了哪一步。'),true);

function redactedExcerpt(answer) {
  return answer.replace(/[0-9A-HJKMNP-TV-Z]{20}/gu,'[来源]')
    .replace(/(?:[a-z]:[\\/]|\/Users\/|\/home\/|https?:\/\/)[^\s`"'<>]+/giu,'[位置]')
    .replace(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/giu,'[会话]').slice(0,600);
}

async function observedCodex(options, turn) {
  const segment = '/' + randomUUID() + '/v1';
  const wire = { requests:0, nativeSearchFlat:false, nativeBriefFlat:false, namespacedMemory:false, flatClientAliases:false };
  const remoteEval = !!process.env.TSP_EVAL_MODEL;
  if (remoteEval) assert.ok(process.env.TSP_EVAL_GATEWAY_URL && process.env.TSP_EVAL_GATEWAY_TOKEN, 'Isolated model gateway required');
  const base = new URL(remoteEval ? process.env.TSP_EVAL_GATEWAY_URL : 'http://127.0.0.1:11434/v1');
  assert.ok(base.protocol === 'http:' && base.hostname === '127.0.0.1' && base.port && !base.username && !base.password && !base.search && !base.hash && /^\/v1\/?$/.test(base.pathname));
  // Forward request bytes unchanged. The isolated harness and all its tools
  // receive no gateway token; only this relay can authorize a model request.
  const server = createServer(async (req,res) => {
    try {
      if (req.method !== 'POST' || req.url !== segment + '/responses') { res.writeHead(404).end(); return; }
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 2_000_000) throw Error('Oversize fixture request');
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      const input = JSON.parse(body);
      if(input.model !== agentModel()) throw Error('Wrong model requested');
      const promptInput = JSON.stringify([input.instructions,input.input]);
      wire.hostInstructionVisible ||= promptInput.includes(instructions);
      if(options.baseInstructions !== instructions) wire.guidanceVisible ||= promptInput.includes('算术和通识直接回答');
      const offered = Array.isArray(input.tools) ? input.tools : [];
      wire.requests++;
      wire.nativeSearchFlat ||= offered.some(t => t.type === 'function' && t.name?.includes('search_memory'));
      wire.nativeBriefFlat ||= offered.some(t => t.type === 'function' && t.name?.includes('read_memory_brief'));
      wire.namespacedMemory ||= offered.some(t => t.type === 'namespace' && t.tools?.some(f => f.name === 'read_memory_brief' || f.name === 'search_memory'));
      wire.flatClientAliases ||= offered.some(t => t.type === 'function' && ['project_memory','personal_memory'].includes(t.name));
      const upstream = await fetch(base.origin+'/v1/responses',{method:'POST',body,redirect:'error',
        headers:{'content-type':'application/json',...(remoteEval ? {authorization:'Bearer '+process.env.TSP_EVAL_GATEWAY_TOKEN} : {})},
        signal:AbortSignal.timeout(100000)});
      wire.lastStatus = upstream.status;
      res.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type') || 'text/event-stream'});
      if (upstream.body) Readable.fromWeb(upstream.body).pipe(res); else res.end();
    } catch { if (!res.headersSent) res.writeHead(502); res.end(); }
  });
  await new Promise((resolve,reject) => { server.once('error',reject);server.listen(0,'127.0.0.1',resolve); });
  try {
    await turn({...options,modelUrl:'http://127.0.0.1:'+server.address().port+segment});
    assert.ok(wire.requests>0,'No observed requests reached the loopback model');
    return wire;
  } finally {
    await new Promise(resolve => {server.close(resolve);server.closeAllConnections();});
  }
}

async function evaluateCase(member, {id, variant, expected, forbidden, dir, withCodex, external, guidance}) {
  const audit = path.join(dir,variant+'-'+id+'.jsonl');
  const profile = path.join(dir,variant+'-'+id+'-codex');
  await mkdir(profile,{mode:0o700});
  const current = {...member,codexHome:profile};
  const mcpArgs = [self,'--mcp',variant,audit];
  const system = guidance ? instructions+'\n'+guidance : instructions;
  let answer, calls, hostVersion, wire, autonomousAuditEnd, calibrated = false;
  const readAudit = async () => (await readFile(audit,'utf8').catch(err=>{if(err.code==='ENOENT')return '';throw err;}))
    .split('\n').filter(Boolean).map(line=>JSON.parse(line));
  if (external) {
    const result = await external.runCase({member:current,prompt:questions[id],system,mcpArgs,dir:profile});
    ({answer,calls,version:hostVersion} = result);
    assert.ok(typeof answer==='string' && Array.isArray(calls) && calls.every(s=>typeof s==='string'));
  } else wire = await observedCodex({mcpArgs,baseInstructions:system,catalog:variant==='catalog',dynamic:variant==='dynamic'}, opts => withCodex(current,async host=>{
    const items = await host.turn(questions[id]);
    const history = await rollout(current,host.sessionId);
    calls = history.filter(r=>r.type==='response_item' && r.payload?.type==='function_call').map(r=>r.payload.name);
    const lastTool = history.findLastIndex(r=>r.type==='response_item' && ['function_call_output','custom_tool_call_output'].includes(r.payload?.type));
    const finalMessages = history.slice(lastTool+1).filter(r=>r.type==='response_item' && r.payload?.role==='assistant');
    const finalMessage = finalMessages.findLast(r=>r.payload.phase==='final_answer') ?? finalMessages.at(-1);
    answer = (finalMessage?.payload.content ?? []).filter(p=>p.type==='output_text').map(p=>p.text).join('\n')
      || items.filter(i=>i.type==='agentMessage').at(-1)?.text || '';
    if (expected) {
      autonomousAuditEnd = (await readAudit()).length;
      const uri = expected.scope==='personal' ? 'tsp-memory://personal/preferences' : 'tsp-memory://project/brief';
      const rows = variant==='tools' ? await host.search(expected.scope==='personal'?'Git':'退款') : decodedRows(await host.readResource(uri));
      calibrated = rows.some(row => row.source===expected.source && row.state===expected.state);
      assert.ok(calibrated,'The real Codex host could not read the expected record after its independent answer');
    }
  },opts));
  const effective = (await readAudit()).slice(0, autonomousAuditEnd);
  const rows = effective.flatMap(call => call.rows);
  const hit = Boolean(expected) && rows.some(r => r.source === expected.source && r.state === expected.state && r.scope === expected.scope);
  const cited = Boolean(expected) && answer.includes(expected.source);
  const foreign = forbidden.some(r => rows.some(item => item.source === r.source) || answer.includes(r.source));
  assert.equal(foreign, false, 'Out-of-scope memory reached ' + id);
  const correct = factualAnswer(id, answer);
  const row = {
    case: id,
    discoveryCalls: calls.filter(name => /list_mcp_resources|list_mcp_resource_templates|resources\/list|resources\/templates\/list/.test(name)).length,
    toolSearches: effective.filter(call => call.name === 'search_memory').length,
    briefToolReads: effective.filter(call => call.name === 'read_memory_brief').length,
    resourceReads: effective.filter(call => call.method === 'resources/read').length,
    errors: effective.filter(call => call.error).length,
    expectedSourceRead: hit,
    citedExpectedSource: cited,
    answerPresent: Boolean(answer.trim()),
    correctContent: correct,
    groundedCorrect: correct && (id === 'control' ? !calls.length && !effective.length : hit && cited),
    modelFunctionCalls: calls.length,
    ...(calibrated ? {explicitHostPositiveControl: true} : {}),
    ...(hostVersion ? {hostVersion} : {}),
    ...(wire ? {wire} : {}),
    ...(id !== 'control' && (hit || correct) ? {answerExcerpt: redactedExcerpt(answer)} : {}),
  };
  process.stderr.write(variant + '/' + id + ' ' + JSON.stringify(row) + '\n');
  if (process.env.TSP_EVAL_TRACE === '1') process.stderr.write(JSON.stringify({calls, answer: answer.slice(0,1000)}) + '\n');
  return row;
}

export async function evaluateRetrieval(f,{dir,withCodex,version}) {
  const runner = process.env.TSP_RETRIEVAL_HOST || 'codex';
  assert.ok(['codex','opencode','dsh'].includes(runner));
  let external;
  if (runner==='codex') assert.ok(version && process.env.TSP_PROBE_CODEX,'Choose a real Codex app-server binary');
  else external = await import('./native-memory-'+runner+'.mjs');
  const variants = (process.env.TSP_RETRIEVAL_VARIANTS || 'tools,resources').split(',');
  assert.ok(variants.every(v=>arms.includes(v)) && new Set(variants).size===variants.length);
  const {alice,bob,ok,root,topicCode,requirementCode} = f;
  const capture = async (sourceText, parts) => {
    const binding = await ok('GET',root+'/memory/binding?'+new URLSearchParams({topicCode,requirementCode}),alice);
    const event = {...binding,sessionId:'active-retrieval',eventId:randomUUID(),sourceText};
    if (process.env.TSP_EVAL_MODEL) {
      return createMemorySliceUseCases(f.db).capture({...event,parts,principalCode:alice.code,projectCode:f.projectCode});
    }
    return ok('POST',root+'/memory/captures',alice,event);
  };
  const parts = [{kind:'discussion',text:'我建议退款超过七天进入人工审核。'},{kind:'preference',text:'这个项目我习惯用中文写 Git 提交说明。'}];
  const proposal = await capture(parts.map(part=>part.text).join(''),parts);
  const project = proposal.items.find(row=>row.state==='discussed');
  const preference = proposal.items.find(row=>row.state==='preference');
  assert.ok(project && preference);
  const byVariant = Object.fromEntries(variants.map(v=>[v,[]]));
  const guidance = Object.fromEntries(variants.map(variant=>{
    if (['tools','resources'].includes(variant)) return [variant,''];
    const args = [cli,'memory','guidance',...(variant==='native' && runner!=='codex' ? ['--harness',runner] : [])];
    const hint = execFileSync(process.execPath,args,{encoding:'utf8',timeout:5000,windowsHide:true,
      env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot}}).trim();
    assert.ok(hint && !hint.startsWith('{'),'CLI guidance unavailable');
    return [variant,variant==='dynamic' ? hint+'\n该客户端还提供平铺的 project_memory 和 personal_memory，只读且无需参数。涉及项目约定调用前者，个人习惯调用后者。' : hint];
  }));
  const run = async (id,member,expected,forbidden) => {
    for (const variant of variants) {
      byVariant[variant].push(await evaluateCase(member,{id,variant,expected,forbidden,dir,withCodex,external,guidance:guidance[variant]}));
    }
  };
  await run('discussion',bob,project,[preference]);
  if(process.argv.includes('--wire-smoke')) {
    assert.ok(!process.argv.includes('--record-retrieval'),'A single-case diagnostic must not overwrite a complete report');
    return {host:version,variants:byVariant};
  }
  const decision = '确认采纳：退款超过七天进入人工审核。';
  const approval = await capture(decision,[{kind:'adopt',text:decision}]);
  const confirmed = approval.items.find(row=>row.state==='confirmed');
  assert.ok(confirmed);
  await run('confirmed',bob,confirmed,[preference]);
  await run('personal',alice,preference,[]);
  await run('control',bob,null,[preference]);
  return {host:version ?? byVariant[variants[0]][0].hostVersion,model:agentModel(),
    seed:process.env.TSP_EVAL_MODEL ? 'preclassified synthetic parts via native transactional use case' : 'local extraction',
    questions,variants:byVariant};
}

if (process.argv[2]==='--mcp') await proxy(process.argv[3],process.argv[4]);
