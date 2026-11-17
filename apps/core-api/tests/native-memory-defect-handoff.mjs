// Opt-in paired handoff of a historical TeamSynergy defect using a real member and real engines.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCase } from './native-memory-dsh.mjs';
import { withHandoffFixture } from './native-memory-handoff-fixture.mjs';

const repo = fileURLToPath(new URL('../../../',import.meta.url));
const evidenceDir = path.join(repo,'docs/experiments/memory-harness-pilot/defect-handoff');
const cli = path.join(repo,'apps/cli/dist/index.js');
const observer = fileURLToPath(new URL('native-memory-handoff-observer.mjs',import.meta.url));
const sha = s => createHash('sha256').update(s).digest('hex');
const unique = values => [...new Set(values)];
const pubCode = /\b[0-9A-HJKMNP-TV-Z]{20}\b/gu;
const budget = {maxTokens:4096,turnTimeoutMs:180000,maxToolCalls:24};

function sourceText(text, byCode) {
  // Synthetic platform source IDs differ when reproducing with a fresh DB.
  return text.replace(pubCode, raw => byCode.has(raw) ? '['+byCode.get(raw).id+']' : '[platform-reference]');
}

function enrichAnswer(answer, f, rubric, events) {
  const byCode = new Map(f.sources.map(source=>[source.source,source]));
  for (const event of events.filter(event=>event.kind==='mcp' && !event.error)) {
    for (const row of event.rows) {
      const frozen=byCode.get(row.source);
      assert.ok(frozen && frozen.scope===row.scope && row.textHash===sha(frozen.text),'Returned row does not match its attributed source and scope');
    }
  }
  const visible = new Set(events.filter(event=>event.kind==='mcp' && !event.error).flatMap(event=>event.rows.map(row=>row.source)));
  const exposedAlice = f.sources.some(source=>source.scope==='personal' && source.owner==='alice' &&
    (visible.has(source.source) || answer.includes(source.source) || (source.text && answer.includes(source.text))));
  assert.equal(exposedAlice,false,'An Alice-only source was visible to Bob');
  const cited = f.sources.filter(source=>answer.includes(source.source));
  const supported = cited.filter(source=>visible.has(source.source)).map(source=>source.id);
  const direct = f.sources.filter(source=>visible.has(source.source) && source.locator && answer.includes(source.locator)).map(source=>source.id);
  const record = sourceText(answer,byCode);
  return {
    answer:record,
    seenSourceIds:unique([...visible].map(raw=>byCode.get(raw)?.id).filter(Boolean)),
    citedAndRead:supported, citedButNotRead:cited.filter(source=>!visible.has(source.source)).map(source=>source.id),
    citedLiterallyByLocator:direct,
    // This measures source coverage only. Check the adjacent claim against the cited text before grading meaning.
    evidenceCoverage:rubric.map(fact=>({
      criterion:fact.id,dimension:fact.dimension,
      seen:(fact.sourceIds??[]).filter(id=>[...visible].some(raw=>byCode.get(raw)?.id===id)),
      cited:(fact.sourceIds??[]).filter(id=>supported.includes(id) || direct.includes(id)),
    })),
  };
}

async function annotate(events, f, replayCache) {
  const byCode = new Map(f.sources.map(source=>[source.source,source.id]));
  const ids = codes => unique((codes??[]).map(raw=>{
    assert.ok(byCode.has(raw),'A memory row lacked an attributable case source'); return byCode.get(raw);
  }));
  // Correlate HTTP and MCP so an extra replay never counts as a model request.
  let http;
  const calls = [];
  for (const entry of events) {
    if (entry.kind==='http') {
      assert.ok(!http,'Observed two source fetches before one model tool completed');
      http=entry;
      continue;
    }
    if (!http) {
      assert.ok(entry.error || !entry.rows.length,'A tool returned evidence without a platform fetch');
      calls.push({name:entry.name,error:entry.error,returned:[]});
      continue;
    }
    const returned=ids(entry.rows.map(row=>row.source));
    if (!entry.error) assert.deepEqual(entry.rows,http.rows,'CLI response did not match the observed authenticated HTTP result');
    const call = {name:entry.name,operation:http.operation,scope:http.scope??null,query:http.query??null,
      status:http.status,actualRetrieval:http.retrieval??'platform-brief',returned,error:entry.error};
    if (http.operation==='search') {
      call.enginesAttempted=http.engines;
      call.actualSourceChannels=http.matches && Object.fromEntries(Object.entries(http.matches).map(([raw,channels])=>{
        const id=ids([raw])[0];
        assert.ok(returned.includes(id) && Array.isArray(channels),'Attribution header included an unavailable row');
        return [id,channels];
      }));
      const key=JSON.stringify([http.scope,http.query]);
      if (!replayCache.has(key)) replayCache.set(key,await f.traceSearch({scope:http.scope,query:http.query}));
      const traced=replayCache.get(key);
      const lexical=ids(traced.lexicalSources);
      const engine=ids(traced.engineSources);
      const actualAdded=call.actualRetrieval==='engine-and-platform' ? returned.filter(id=>!lexical.includes(id)) : [];
      call.counterfactualReplay={engine:traced.engine??null,lexical,authorizedEngine:engine,merged:ids(traced.mergedSources),
        channels:Object.fromEntries(Object.entries(traced.channelSources??{}).map(([name,codes])=>[name,ids(codes)]))};
      call.addedBeyondLiteral=actualAdded;
      call.confirmedEngineOnly=actualAdded.filter(id=>engine.includes(id) && call.actualSourceChannels?.[id]?.some(ch=>['core','wiki','viking'].includes(ch)));
      call.replayMatchesActual=JSON.stringify(returned)===JSON.stringify(call.actualRetrieval==='engine-and-platform'?ids(traced.mergedSources):lexical);
    }
    calls.push(call);
    http=null;
  }
  assert.ok(!http,'CLI exited during a source fetch');
  return calls;
}

export async function collectHandoffTurn(f,{pair,enabled,prompt,system}) {
  const arm=enabled?'dual':'platform';
  // DSH embeds its cwd in the model-visible conversation. Do not reveal case,
  // arm, scoring goal or ordering in any directory that the member can see.
  const dir=path.join(f.dir,'work-'+randomBytes(16).toString('hex'));
  const member=await f.makeMember(enabled,dir);
  const auditFile=path.join(dir,'audit.jsonl');
  const started=Date.now();
  process.stderr.write('Running fresh member handoff '+pair+' '+arm+'\n');
  const output=await runCase({member,dir,system,prompt,mcpArgs:[observer,'--mcp',auditFile],...budget});
  assert.equal(typeof output.answer,'string');
  const stream=await readFile(auditFile,'utf8').catch(err=>{if(err.code==='ENOENT')return '';throw err;});
  const events=stream.split('\n').filter(Boolean).map(line=>JSON.parse(line));
  process.stderr.write('Completed handoff '+pair+' '+arm+'; visible actions='+output.calls.length+'\n');
  return {pair,arm,events,output,seconds:(Date.now()-started)/1000};
}

export async function analyzeHandoffTurn(f,raw,rubric,replayCache=new Map()) {
  const {pair,arm,events,output,seconds}=raw;
  const answer=enrichAnswer(output.answer,f,rubric,events);
  const calls=await annotate(events,f,replayCache);
  const added=unique(calls.flatMap(call=>call.confirmedEngineOnly??[]));
  return {pair,arm,seconds,host:output.version,modelSelectedTools:output.calls,calls,
    confirmedEngineOnlyDelivered:added,confirmedEngineOnlyCited:added.filter(id=>answer.citedAndRead.includes(id)),...answer};
}

async function evaluate(f,corpus,pairs,system) {
  const rawRuns=[];
  for (let pair=0;pair<pairs;pair++) {
    for (const enabled of (pair % 2 === 0 ? [false,true] : [true,false])) {
      rawRuns.push(await collectHandoffTurn(f,{pair:pair+1,enabled,prompt:corpus.prompt,system}));
    }
  }
  const result=[];
  // Replay for attribution only once all member conversations have ended.
  const replayCache=new Map();
  for (const raw of rawRuns) {
    result.push(await analyzeHandoffTurn(f,raw,corpus.rubric,replayCache));
  }
  const calibration=[];
  const byCode=new Map(f.sources.map(row=>[row.source,row.id]));
  for (const item of [
    {scope:'project',expected:'review',query:'最初为什么让常规接口也接收这么大的请求正文，登录处理曾经付出什么代价？'},
    {scope:'personal',expected:'replay-note',query:'我上次是怎么对照父提交、修复模块和当前工作树复跑测试，并区分本地验证与发布证据的？'},
  ]) {
    const trace=await f.traceSearch({scope:item.scope,query:item.query});
    const map=codes=>codes.map(code=>{assert.ok(byCode.has(code));return byCode.get(code);});
    calibration.push({...item,lexical:map(trace.lexicalSources),authorizedMerged:map(trace.mergedSources),
      channels:Object.fromEntries(Object.entries(trace.channelSources).map(([key,ids])=>[key,map(ids)])),
      offMode:trace.lexicalHeader,onMode:trace.mergedHeader});
  }
  return {projection:f.projectionSummary,sourceMap:f.sources.filter(s=>s.owner!=='alice'||s.scope!=='personal')
    .map(s=>({id:s.id,source:s.source,sha256:s.sha256,scope:s.scope,locator:s.locator??null})),runs:result,
    operatorCalibrationAfterAllModelTurns:calibration};
}

export function retrievalCosts(run, corpus) {
  const sources=new Map(corpus.sources.map(s=>[s.id,s]));
  const seen=new Set();
  const firstThroughEngine=new Set();
  let sourceDeliveries=0,partialChars=0,distractorDeliveries=0;
  for (const call of run.calls) {
    for (const id of call.returned) {
      const source=sources.get(id);
      assert.ok(source,'Cannot attribute returned evidence text');
      if (!seen.has(id) && call.confirmedEngineOnly?.includes(id)) firstThroughEngine.add(id);
      seen.add(id);
      sourceDeliveries++;
      partialChars+=[...source.text].length;
      if (source.distractor) distractorDeliveries++;
    }
  }
  return {modelToolCalls:run.modelSelectedTools.length,memoryRequests:run.calls.length,sourceDeliveries,
    distinctSources:seen.size,duplicateDeliveries:sourceDeliveries-seen.size,sourceTextCharactersDelivered:partialChars,
    distractorDeliveries,firstDeliveredThroughEngine:[...firstThroughEngine],
    firstDeliveredThroughEngineAndCited:[...firstThroughEngine].filter(id=>run.citedAndRead.includes(id))};
}

async function summarizeFile(label) {
  assert.match(label,/^[a-z][a-z0-9-]{0,35}$/);
  const file=path.join(evidenceDir,'results-'+label+'.json');
  const corpus=JSON.parse(await readFile(path.join(evidenceDir,'case.json'),'utf8'));
  const report=JSON.parse(await readFile(file,'utf8'));
  assert.equal(report.corpusSha256,sha(await readFile(path.join(evidenceDir,'case.json'))));
  for (const sample of report.runs) sample.retrievalCosts=retrievalCosts(sample,corpus);
  await writeFile(file,JSON.stringify(report,null,2)+'\n');
}

async function blindPacket(label) {
  assert.match(label,/^[a-z][a-z0-9-]{0,35}$/);
  const report=JSON.parse(await readFile(path.join(evidenceDir,'results-'+label+'.json'),'utf8'));
  console.log(JSON.stringify(await writeBlindHandoffPacket({question:report.prompt,runs:report.runs})));
}

export async function writeBlindHandoffPacket({question,runs,file}) {
  const serial=randomBytes(6).toString('hex');
  const answers=runs.map((sample,i)=>({id:'H-'+sha(serial+'-'+i).slice(0,8),question:sample.prompt,questionId:sample.caseId,
    answer:sample.answer,readAndCited:sample.citedAndRead,seen:sample.seenSourceIds,literalLocators:sample.citedLiterallyByLocator,
    ...(sample.negativeChecks ? {memoryProtocolCalls:sample.calls.length,...sample.negativeChecks} : {})}));
  const key=answers.map((sample,i)=>({id:sample.id,arm:runs[i].arm,pair:runs[i].pair,caseId:runs[i].caseId}));
  const packet=file??path.join(repo,'tmp','handoff-blind-'+serial+'.json');
  await writeFile(packet,JSON.stringify({question,answers:answers.sort((a,b)=>a.id.localeCompare(b.id))},null,2)+'\n',{flag:'wx',mode:0o600});
  return {packet,key};
}

async function run() {
  assert.equal(process.env.TSP_EVAL_MODEL,'workbuddy/deepseek-v4.1-flash','Run through the model-attesting local Magpie wrapper');
  assert.equal(process.env.TSP_EVAL_FAMILY,'deepseek-v4.1-flash');
  assert.ok(process.env.TSP_EVAL_GATEWAY_TOKEN);
  assert.equal(process.env.TSP_PROBE_DSH_PROFILE,'headless','Use actual headless DSH');
  assert.ok(!process.env.TSP_PROBE_DSH_GUIDANCE,'Use the same explicit handoff instructions for both arms');
  const label=process.env.TSP_HANDOFF_LABEL||'initial';
  assert.match(label,/^[a-z][a-z0-9-]{0,35}$/);
  const pairs=Number(process.env.TSP_HANDOFF_PAIRS||2);
  assert.ok(Number.isInteger(pairs) && pairs>=1 && pairs<=3);
  const bytes=await readFile(path.join(evidenceDir,'case.json'));
  const corpus=JSON.parse(bytes);
  assert.ok(corpus.prompt && corpus.sources.length && Array.isArray(corpus.rubric) && corpus.rubric.length);
  const guidance=execFileSync(process.execPath,[cli,'memory','guidance','--harness','dsh'],{encoding:'utf8',windowsHide:true}).trim();
  const instructions='你正在接手前一位成员留下的软件问题。结合可查到的项目资料和适用的本人工作经验，用中文答复，逐项说明原因、影响范围和可执行的验证办法。每项重要判断紧邻引用你实际读到的来源编码；有代码或测试定位也请给出。没有依据的部分明确说明。';
  const system=guidance+'\n'+instructions;
  const builds={};
  for (const relative of ['apps/cli/dist/memory.js','apps/cli/dist/memory-mcp.js','apps/core-api/dist/routes/memory.js','apps/core-api/dist/memory-engines.js','packages/application/dist/memory-slice-use-cases.js']) {
    builds[relative]=sha(await readFile(path.join(repo,relative)));
  }
  const startedAt=new Date().toISOString();
  const result=await withHandoffFixture(corpus,f=>evaluate(f,corpus,pairs,system));
  const report={caseId:corpus.id,corpusSha256:sha(bytes),prompt:corpus.prompt,system,systemSha256:sha(system),
    builds,label,budget,startedAt,endedAt:new Date().toISOString(),model:process.env.TSP_EVAL_MODEL,
    design:'Same Bob, immutable evidence, tools and prompt. Fresh bound workspace and DSH session per arm. Alternating pair order. Only the core API engine config changes within a pair.',
    modelPairs:pairs,fixtureCleaned:true,...result};
  await writeFile(path.join(evidenceDir,'results-'+label+'.json'),JSON.stringify(report,null,2)+'\n');
  await summarizeFile(label);
  console.log(JSON.stringify({label,pairs,runs:result.runs.map(r=>({arm:r.arm,pair:r.pair,citations:r.citedAndRead,engineOnly:r.confirmedEngineOnlyCited}))}));
}

if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if (process.argv[2]==='--summarize') await summarizeFile(process.argv[3]);
  else if (process.argv[2]==='--blind') await blindPacket(process.argv[3]);
  else await run();
}
