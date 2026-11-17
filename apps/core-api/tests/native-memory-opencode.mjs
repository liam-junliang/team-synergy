import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createMemorySliceUseCases } from '@team-synergy/application';

const execute = promisify(execFile);
const localAgent = 'member';

export function evaluationProvider() {
  const gateway = process.env.TSP_EVAL_GATEWAY_URL;
  const model = process.env.TSP_EVAL_MODEL;
  if (!gateway && !model && !process.env.TSP_EVAL_FAMILY && !process.env.TSP_EVAL_GATEWAY_TOKEN) {
    const local = process.env.TSP_MEMORY_MODEL || 'hub-qwen2.5:latest';
    return {model:local,alias:local,name:'Local diagnostics',baseURL:'http://127.0.0.1:11434/v1',gateway:false};
  }
  assert.equal(process.env.TSP_EVAL_FAMILY,'deepseek-v4.1-flash','Choose the requested Flash family');
  assert.ok(typeof model==='string' && /^(?:[a-z0-9._-]+\/)?deepseek-(?:v4\.1-)?flash(?:-1017)?$/iu.test(model),
    'The gateway evaluation requires a Flash route');
  assert.ok(gateway,'The Flash evaluation requires its isolated loopback gateway');
  const url = new URL(gateway);
  assert.ok(url.protocol === 'http:' && ['127.0.0.1','[::1]'].includes(url.hostname) && Number(url.port)>=1024
    && !url.username && !url.password && !url.search && !url.hash && ['/','/v1','/v1/'].includes(url.pathname),
    'Expected the local test gateway origin or its /v1 base path');
  assert.ok(process.env.TSP_EVAL_GATEWAY_TOKEN,'Missing the temporary test gateway token');
  return {model,alias:'deepseek-flash',name:'DeepSeek-V4.1-Flash gateway',baseURL:url.origin+'/v1',gateway:true};
}

export async function runCase({ member, prompt, system, mcpArgs, dir }) {
  const provider = evaluationProvider();
  const {model,alias,baseURL,name} = provider;
  // The npm Windows package contains the actual executable. Avoid the user's shell/profile.
  const program = process.env.TSP_PROBE_OPENCODE || path.join(process.env.APPDATA,
    'npm/node_modules/opencode-ai/node_modules/opencode-windows-x64/bin/opencode.exe');
  const parent = await realpath(dir);
  const profile = await mkdtemp(path.join(parent, 'opencode-case-'));
  const env = {
    SystemRoot: process.env.SystemRoot, PATH: process.env.PATH,
    HOME: profile, USERPROFILE: profile, APPDATA: profile, LOCALAPPDATA: profile,
    PROGRAMDATA: profile, TEMP: profile, TMP: profile, OPENCODE_TEST_HOME: profile,
    XDG_CONFIG_HOME: path.join(profile,'config'), XDG_CACHE_HOME: path.join(profile,'cache'),
    XDG_DATA_HOME: path.join(profile,'data'), XDG_STATE_HOME: path.join(profile,'state'),
    NO_PROXY: '127.0.0.1,localhost', HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_DISABLE_LSP_DOWNLOAD: '1', OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: '1', GIT_CONFIG_NOSYSTEM: '1',
    ...(provider.gateway ? {TSP_EVAL_GATEWAY_TOKEN:process.env.TSP_EVAL_GATEWAY_TOKEN} : {}),
  };
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    model: 'local/' + alias, small_model: 'local/' + alias, enabled_providers: ['local'],
    autoupdate: false, share: 'disabled', snapshot: false, lsp: false, formatter: false,
    permission: { '*': 'deny', 'tsp_memory_*': 'allow' },
    agent: { [localAgent]: { mode:'primary', prompt:system, temperature:0, steps:5 } },
    provider: { local: { npm:'@ai-sdk/openai-compatible', name,
      ...(provider.gateway ? {env:['TSP_EVAL_GATEWAY_TOKEN']} : {}),
      options:{baseURL, ...(provider.gateway ? {} : {apiKey:'local-test'}), timeout:90000},
      models:{[alias]:{id:model,name:model,tool_call:true,limit:{context:16384,output:provider.gateway ? 2048 : 768}}},
    } },
    mcp: { tsp_memory: {type:'local',command:[process.execPath,...mcpArgs],
      environment:{AGENTCTL_HOME:member.home,TSP_EVAL_GATEWAY_TOKEN:'',OPENCODE_CONFIG_CONTENT:''},timeout:15000} },
  });
  const options = {cwd:member.cwd,env,timeout:180000,maxBuffer:1024*1024,windowsHide:true,encoding:'utf8'};
  try {
    for (const folder of [env.XDG_CONFIG_HOME,env.XDG_CACHE_HOME,env.XDG_DATA_HOME,env.XDG_STATE_HOME]) await mkdir(folder);
    const version = (await execute(program,['--version'],options)).stdout.trim();
    const status = await execute(program,['mcp','list'],options);
    const description = (status.stdout + status.stderr).replace(/\x1b\[[0-9;]*m/gu,'');
    assert.match(description,/\btsp_memory\s+connected\b/u,'OpenCode did not connect to the fixture MCP');
    const turn = execute(program,['run','--format','json','--agent',localAgent,'--model','local/'+alias,prompt],options);
    turn.child.stdin.end();
    const {stdout} = await turn;
    const events = stdout.split(/\r?\n/u).filter(line=>line.trim()).map(line=>JSON.parse(line));
    const failure = events.find(event=>event.type==='error');
    if (failure) throw new Error('OpenCode turn failed: '+String(failure.error?.name ?? 'unknown error'));
    const lastCall = events.findLastIndex(event=>event.type==='tool_use');
    const isText = event=>event.type==='text' && typeof event.part?.text==='string';
    const parts = events.slice(lastCall + 1).filter(isText);
    const calls = events.filter(event=>event.type==='tool_use').map(event=>String(event.part?.tool));
    const preToolTextSeen = lastCall >= 0 && events.slice(0,lastCall).some(isText);
    return {answer:parts.map(event=>event.part.text).join('\n'),preToolTextSeen,calls,version};
  } catch (error) {
    // execFile errors can include provider logs. Keep the public report independent of child output.
    if (provider.gateway && error && ('stderr' in error || 'stdout' in error)) {
      throw new Error('OpenCode gateway run failed: '+(error.killed ? 'timeout' : 'child_exit_'+String(error.code)));
    }
    throw error;
  } finally {
    const target = await realpath(profile);
    assert.equal(path.dirname(target),parent);
    assert.match(path.basename(target),/^opencode-case-[a-zA-Z0-9]+$/u);
    await rm(target,{recursive:true,force:true,maxRetries:4,retryDelay:200});
  }
}

// A new business decision and unseen question distinguish retrieval from memorising
// the earlier seven-day example. Each arm gets a fresh OpenCode home and session.
export async function evaluateOpenCodeHoldout(f, { dir }) {
  const {model,gateway} = evaluationProvider();
  const criterion = '退款金额超过八百元时由主管复核。';
  for (const sourceText of ['我建议' + criterion, '确认采纳：' + criterion]) {
    const params = new URLSearchParams({ topicCode: f.topicCode, requirementCode: f.requirementCode });
    const binding = await f.ok('GET', f.root + '/memory/binding?' + params, f.alice);
    const command = { ...binding, sessionId: 'holdout', eventId: randomUUID(), sourceText };
    // Freeze the synthetic fixture via the real transactional domain; the evaluation concerns reading.
    const receipt = gateway ? await createMemorySliceUseCases(f.db).capture({...command,
      principalCode:f.alice.code,projectCode:f.projectCode,
      parts:[{kind:sourceText.startsWith('确认采纳')?'adopt':'discussion',text:sourceText}],
    }) : await f.ok('POST', f.root + '/memory/captures', f.alice, command);
    assert.equal(receipt.items[0].state, sourceText.startsWith('确认采纳') ? 'confirmed' : 'discussed');
  }
  const rows = await f.ok('POST', f.root + '/memory/brief', f.bob, { scope: 'project' });
  const expected = rows.find(row => row.state === 'confirmed' && row.text === criterion);
  assert.ok(expected);
  const prompt = '我刚来接售后这个项目。大额退款的分界线在哪里，过线之后由谁复核？我可以告诉客服这个流程已经上线了吗？';
  const cli = fileURLToPath(new URL('../../cli/dist/index.js', import.meta.url));
  const proxy = fileURLToPath(new URL('./native-memory-retrieval.mjs', import.meta.url));
  const general = execFileSync(process.execPath, [cli, 'memory', 'guidance'], { encoding: 'utf8', windowsHide: true }).trim();
  const short = name => '项目背景用 '+name+' 查询 scope=project，个人偏好用 scope=personal。按原记录的 state、text 和 source 回答。已采纳不等于已经上线。通识直接回答。';
  const arms = { general, short: short('read_memory_brief'), nativeName: short('tsp_memory_read_memory_brief') };
  const results = {};
  for (const [name, guide] of Object.entries(arms)) {
    const audit = path.join(dir, name+'.jsonl');
    const result = await runCase({ member: f.bob, prompt, dir, mcpArgs: [proxy, '--mcp', 'guided', audit],
      system: '你是团队项目助手。请用中文简洁回答。项目规则和个人习惯若有依据，请一并给出记录编码；无法核实时请说明。\n'+guide });
    const log = await readFile(audit,'utf8').catch(error=>{ if(error.code==='ENOENT') return ''; throw error; });
    const calls = log.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
    results[name] = {
      hostVersion: result.version, calls:result.calls, preToolTextSeen:result.preToolTextSeen,
      expectedSourceRead:calls.some(call=>call.rows.some(row=>row.source===expected.source && row.state==='confirmed')),
      correctSourceCited:result.answer.includes(expected.source),
      // This is a synthetic scenario. Preserve the response for semantic review,
      // substituting its ephemeral source code after checking the exact citation.
      answer:result.answer.replaceAll(expected.source,'[source]').replace(/\b[0-9A-HJKMNP-TV-Z]{20}\b/gu,'[object]'),
    };
  }
  return {model,prompt,syntheticCriterion:criterion,fixture:gateway?'prelabelled_transactional_write':'native_capture',variants:results};
}
