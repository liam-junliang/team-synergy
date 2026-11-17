// Opt-in native project-document -> Tencent outbox -> fresh member OpenCode handoff.
// All writes use an isolated database and a newly created, identity-checked Wiki.
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHash,randomBytes} from 'node:crypto';
import {appendFileSync} from 'node:fs';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {buildServer} from '../dist/server.js';
import {projectNextMemory,searchMemoryEngineDetailed} from '../dist/memory-engines.js';
import {invoke,withNativeMemoryProject} from './native-memory-live.mjs';
import {withScratchMemoryEngines} from './native-memory-engines.mjs';
import {runCase} from './native-memory-opencode.mjs';

const cli=fileURLToPath(new URL('../../cli/dist/index.js',import.meta.url));
const output=fileURLToPath(new URL('../../../docs/experiments/memory-project-documents/',import.meta.url));
const hash=value=>createHash('sha256').update(value).digest('hex');
const opaque=()=>randomBytes(16).toString('hex');
const parseAnswer=text=>{try{return JSON.parse(text.trim().replace(/^```(?:json)?\s*/u,'').replace(/\s*```$/u,''));}catch{return null;}};
const save=(name,value)=>writeFile(path.join(output,name),JSON.stringify(value,null,2)+'\n');
const audit=(file,value)=>appendFileSync(file,JSON.stringify(value)+'\n',{mode:0o600});
const readAudit=async file=>{try{return (await readFile(file,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));}catch(error){if(error.code==='ENOENT')return [];throw error;}};

function rowsOf(value) {
  const rows=Array.isArray(value)?value:value&&typeof value==='object'&&typeof value.source==='string'?[value]:[];
  return rows.filter(row=>typeof row?.source==='string').map(row=>({source:row.source,state:row.state,scope:row.scope,
    sourceRevision:row.sourceRevision,text:row.text,excerpt:row.excerpt,range:row.range}));
}

function observeFetch(file) {
  const original=globalThis.fetch;
  globalThis.fetch=async(input,init)=>{
    const route=new URL(input instanceof Request?input.url:input).pathname;
    if(route.endsWith('/memory/search')) {
      const headers=new Headers(init?.headers);headers.set('X-TSP-Memory-Explain','1');init={...init,headers};
    }
    const response=await original(input,init);
    if(/\/memory\/(?:search|brief|sources|documents\/read)$/u.test(route)) {
      const result=await response.clone().json();
      const request=JSON.parse(init?.body??'{}');
      const matches=response.headers.get('X-TSP-Memory-Matches');
      audit(file,{kind:'http',route:route.slice(route.indexOf('/memory/')),status:response.status,request,
        retrieval:response.headers.get('X-TSP-Memory-Retrieval'),engines:response.headers.get('X-TSP-Memory-Engines'),
        matches:matches?JSON.parse(matches):null,error:result.error?.code??null,rows:rowsOf(result.data)});
    }
    return response;
  };
}

async function relay(file) {
  const env=Object.fromEntries(['PATH','SystemRoot','WINDIR','AGENTCTL_HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP','HOME']
    .filter(key=>process.env[key]).map(key=>[key,process.env[key]]));
  const child=spawn(process.execPath,['--import',import.meta.url,cli,'memory','mcp'],{
    env:{...env,TSP_DOCUMENT_HANDOFF_AUDIT:file},windowsHide:true,stdio:['pipe','pipe','ignore'],
  });
  const done=once(child,'close'),pending=new Map();
  const input=createInterface({input:process.stdin});
  input.on('line',line=>{const request=JSON.parse(line);if(request.id!==undefined)pending.set(request.id,request);child.stdin.write(line+'\n');});
  input.on('close',()=>child.stdin.end());
  try {
    for await(const line of createInterface({input:child.stdout})) {
      const frame=JSON.parse(line),request=pending.get(frame.id);pending.delete(frame.id);
      if(request?.method==='tools/call') {
        const blocks=frame.result?.content??[];
        const values=blocks.map(block=>{try{return JSON.parse(block.text);}catch{return null;}});
        audit(file,{kind:'mcp',tool:request.params.name,args:request.params.arguments,error:!!(frame.error||frame.result?.isError),
          bodyChars:blocks.reduce((n,block)=>n+(block.text?.length??0),0),rows:values.flatMap(rowsOf)});
      }
      process.stdout.write(line+'\n');
    }
    const [code]=await done;assert.equal(code,0,'Member memory MCP failed');
  }finally {input.close();if(child.exitCode===null&&child.signalCode===null)child.kill();}
}

async function memberFor(f,base,dir) {
  const location=path.join(dir,opaque());await mkdir(location,{mode:0o700});
  const member={code:f.bob.code,home:path.join(location,'device'),cwd:path.join(location,'work'),codexHome:path.join(location,'session')};
  for(const directory of [member.home,member.cwd,member.codexHome])await mkdir(directory,{mode:0o700});
  const auth=JSON.parse(await readFile(path.join(f.bob.home,'auth.json'),'utf8'));
  assert.equal(auth.device_token,f.bob.token);
  await writeFile(path.join(member.home,'auth.json'),JSON.stringify({...auth,api_url:base}),{mode:0o600,flag:'wx'});
  assert.equal((await invoke(member,['project','bind',f.projectCode])).ok,true);
  return member;
}

async function main() {
  process.env.ACP_ALLOW_LEGACY_IDENTITY='0';process.env.TSP_MEMORY_ENABLED='1';
  assert.equal(process.env.TSP_EVAL_MODEL,'workbuddy/deepseek-v4.1-flash','Run through the Magpie documents wrapper');
  const program=process.env.TSP_PROBE_OPENCODE||path.join(process.env.APPDATA,'npm/node_modules/opencode-ai/node_modules/opencode-windows-x64/bin/opencode.exe');
  assert.equal(execFileSync(program,['--version'],{encoding:'utf8',timeout:15000,windowsHide:true}).trim(),'1.14.21');
  const attempt=Number(process.env.TSP_DOCUMENT_HANDOFF_ATTEMPT??1);
  assert.ok(Number.isSafeInteger(attempt)&&attempt>=1&&attempt<=99);
  await mkdir(output,{recursive:true});
  const baselineProtocol=attempt>1?JSON.parse(await readFile(path.join(output,'handoff-protocol.attempt1.json'),'utf8')):undefined;
  const baselineResult=attempt>1?JSON.parse(await readFile(path.join(output,'handoff-result.attempt1.json'),'utf8')):undefined;
  if(baselineResult)assert.equal(baselineResult.accepted,true,'Only an accepted frozen scenario can be rerun');
  const marker=baselineResult?.cases.find(item=>item.id==='current').parsed.acceptanceMarker??'青栎-'+randomBytes(6).toString('hex');
  const initialText='# 工作台超时处理契约\n\n适用范围：TeamSynergy工作台的项目筛选查询，不包含上传与登录。\n'+
    '当前文档规则：请求超过5秒按超时处理；前端取消旧请求，并按当前请求序列号丢弃晚到响应。\n'+
    '原因：切换项目时旧请求可能晚到，覆盖当前项目的内容。\n'+
    '验收：项目A查询慢，切换B先返回，A再返回不得覆盖B；模拟5秒超时显示可重试状态；撤权后重试不能读取原项目。\n'+
    '状态声明：这是隔离演练中的文档记录，不是确认采纳，不证明实现、测试或上线已经完成。';
  const currentText='# 工作台超时处理契约\n\n适用范围：TeamSynergy工作台项目筛选查询，不包含上传和登录。\n'+
    '当前文档规则改为：请求超过8秒按超时处理，继续取消旧请求并按请求序列号丢弃晚到响应。\n'+
    '原因：切换项目时旧请求可能晚到，覆盖当前项目内容；这次为弱网保留更长等待窗口。\n'+
    '验收：项目A晚于项目B返回时不得覆盖B；8秒超时显示人工重试入口；撤权后重试不得读取原项目。\n'+
    '文末还有必须核对的写请求重试约束与验收标记，当前摘录不能替代完整原文。\n'+
    Array.from({length:95},(_,index)=>`\n验证条目${index+1}：检查当前项目编码、页面筛选条件、请求序列号、服务器处理状态和响应返回顺序；保存可追溯记录，区分观察、文档约定与已经实际实施的结果。`).join('')+
    '\n\n文末强制约束：非幂等写请求禁止自动重试，必须先查询服务端处理结果。验收先模拟服务端已处理但客户端超时，再断网重连，确认没有重复写入。\n'+
    '验收标记：'+marker+'。\n状态声明：这是隔离演练文档，不证明方案已采纳、代码已修改、测试已通过或服务已上线。';
  assert.ok(initialText.length<1600&&currentText.length>4000&&!currentText.slice(0,1600).includes(marker));
  const protocol={version:1,attempt,frozenBeforeModelTurns:true,model:process.env.TSP_EVAL_MODEL,harness:'OpenCode 1.14.21 fresh run sessions',
    flow:'Native authenticated document HTTP writes -> same transaction projection outbox -> real Tencent Wiki/Core -> production memory API/MCP -> fresh Bob agent',
    corpus:{initialSha256:hash(initialText),currentSha256:hash(currentText),currentChars:currentText.length},
    system:'你是软件开发项目的成员助手。项目自己的规则、原因和验证方法必须主动读取项目记忆并引用source；先选一种合适入口，必要时补查。documented只说明文档记载，不能据此断言方案已采纳、已实施、已测试或已上线。项目文档结果是摘录，缺少要求的信息时用read_memory_document分页或按query定位当前原文。只能使用当前有权访问的来源。',
    prompts:{initial:'请查当前工作台超时处理契约，说明超时秒数、为什么要这样做、怎么验证，以及能否认定已经实施。只输出JSON：{"timeoutSeconds":数字,"reason":字符串,"checks":[字符串],"implementationStatus":"unknown或implemented","sources":[来源ID]}。',
      current:'请查当前工作台超时处理契约，说明最新超时秒数、变更原因、怎么验证，并核对文末的写请求重试约束和验收标记。只输出JSON：{"timeoutSeconds":数字,"reason":字符串,"checks":[字符串],"tailRule":字符串,"acceptanceMarker":字符串,"implementationStatus":"unknown或implemented","sources":[来源ID]}。'},
    criteria:['Both answers cite their current native document revision, documented is not implemented',
      'Second fresh session uses current 8-second revision and excludes old revision even though stale remote candidate still exists',
      'Second model actually invokes read_memory_document and receives the tail marker beyond the preview'],
    limitations:['Synthetic project document bodies, not an actual delivered production feature','Two fresh sessions, no native OpenCode compaction/resume claim',
      'No personal-memory question; this probe proves Tencent document path, not use of OpenViking in the answer','No causal engine-on/off performance comparison']};
  if(baselineProtocol)assert.deepEqual({...protocol,attempt:1},baselineProtocol,'Reruns must preserve the frozen prompts, bodies and marker');
  else await save('handoff-protocol.attempt1.json',protocol);
  const protocolFile='handoff-protocol.attempt1.json';
  const report={attempt,startedAt:new Date().toISOString(),protocolSha256:hash(await readFile(path.join(output,protocolFile))),
    model:process.env.TSP_EVAL_MODEL,protocol:protocolFile,...(baselineProtocol?{reusedProtocolFromAttempt:1}:{}),
    cases:[],documents:[],deliveries:[],realGitActions:0,runtimeHashes:{}};
  for(const relative of ['apps/cli/dist/memory-mcp.js','apps/core-api/dist/memory-engines.js','packages/application/dist/memory-document-sources.js',
    'packages/application/dist/project-document-use-cases.js','apps/core-api/tests/native-memory-document-handoff.mjs','apps/core-api/tests/native-memory-opencode.mjs',
    'apps/cli/dist/memory.js','apps/core-api/dist/routes/memory.js','apps/core-api/dist/routes/project-documents.js',
    'packages/application/dist/memory-slice-use-cases.js','packages/application/dist/project-document-memory.js',
    'packages/persistence/dist/schema.js','packages/contracts/dist/memory.js']) {
    report.runtimeHashes[relative]=hash(await readFile(new URL('../../../'+relative,import.meta.url)));
  }
  try {
    await withNativeMemoryProject({project:'TeamSynergy document handoff'},async(f,{dir})=>withScratchMemoryEngines(f.db,
      {projectCode:f.projectCode,aliceCode:f.alice.code,bobCode:f.bob.code},async({cfg,wiki,wikiId,profiles,mapping})=>{
        cfg.tencent.coreBaseUrl=profiles.tencent.coreBaseUrl;
        const project=cfg.projects[f.projectCode];project.semanticAgentId=mapping.memberAgents.alice.agentId;
        assert.ok(cfg.tencent.coreBaseUrl&&project.semanticAgentId);
        const owned=[];
        async function core(op,document) {
          const ids={team_id:project.teamId,user_id:project.userId,agent_id:project.semanticAgentId,task_id:'tsp-wiki-'+wikiId,
            session_id:'tsp-'+wikiId+'-'+document.source};
          const response=await fetch(cfg.tencent.coreBaseUrl.replace(/\/$/u,'')+'/conversation/'+op,{method:'POST',
            headers:{authorization:'Bearer '+cfg.tencent.token,'content-type':'application/json','x-tdai-service-id':cfg.tencent.serviceId,'x-tdai-session-id':ids.session_id},
            body:JSON.stringify({...ids,...(op==='query'?{limit:100}:{message_ids:document.recordIds})}),redirect:'error',signal:AbortSignal.timeout(15000)});
          assert.equal(response.status,200);const result=await response.json();assert.equal(result.code,0);
          if(op==='query')for(const row of result.data.messages){assert.ok(Object.entries(ids).every(([key,value])=>row[key]===value));assert.equal(row.content,document.text+'\n\n[tsp-evidence '+wikiId+' '+document.source+']');}
          return result.data;
        }
        async function stored(documentCode,revision) {
          const row=(await f.db.$client.query(`select v.id,v.code,v.content from project_document_revisions v join project_documents d on d.id=v.document_id
            where d.code=$1 and v.revision=$2`,[documentCode,revision])).rows[0];assert.ok(row);
          assert.deepEqual((await f.db.$client.query('select engine,status from memory_projection_jobs where project_document_revision_id=$1',[row.id])).rows,[{engine:'tencent',status:'pending'}]);
          const document={source:row.code,document:documentCode,revision,text:row.content};assert.equal((await core('query',document)).total,0);
          owned.push(document);report.documents.push({source:document.source,document:document.document,revision,chars:document.text.length,sha256:hash(document.text),transactionQueued:true});
          return document;
        }
        async function deliverDocument(document) {
          const deadline=Date.now()+360000;let delivered=false;
          while(Date.now()<deadline) {
            const result=await projectNextMemory(f.db,cfg);
            if(result)report.deliveries.push(result);
            if(result?.status==='synced'){assert.equal(result.source,document.source);delivered=true;break;}
            if(result&&!['wiki_ingesting','wiki_index_pending'].includes(result.code))throw Error('Document projection '+JSON.stringify(result));
            await delay(1000);
          }
          assert.ok(delivered,'Document projection did not complete');
          const filename='tsp-'+document.source+'-'+hash(document.text)+'.md';
          const raw=(await wiki('raw/read',{wiki_id:wikiId,filenames:[filename]})).data.items[0].content;assert.equal(hash(raw),hash(document.text));
          const entry=report.documents.find(row=>row.source===document.source);entry.fullWikiHashVerified=true;
          entry.coreRecords=(await core('query',document)).messages.length;assert.equal(entry.coreRecords,document.text.length<=4000?1:0);
        }
        const configFile=path.join(dir,opaque()+'.json');await writeFile(configFile,JSON.stringify(cfg),{mode:0o600,flag:'wx'});
        const app=await buildServer({db:f.db,logger:false,memoryEnginesFile:configFile});
        try {
          const base=await app.listen({host:'127.0.0.1',port:0});
          const currentApi=async(route,body)=>{
            const response=await fetch(base+f.root+'/memory/'+route,{method:'POST',headers:{authorization:'Bearer '+f.bob.token,'content-type':'application/json'},body:JSON.stringify(body)});
            return {status:response.status,...await response.json()};
          };
          const created=await f.ok('POST',f.root+'/handoff/documents',f.alice,{title:'工作台超时处理契约',kind:'doc',content:initialText});
          const first=await stored(created.document_code,1);await deliverDocument(first);
          for(const [id,document]of [['initial',first],['current',null]]) {
            let current=document;
            if(id==='current') {
              await f.ok('PATCH','/handoff-documents/'+created.document_code,f.alice,{title:'工作台超时处理契约',content:currentText,
                base_revision:1,change_summary:'弱网等待窗口与非幂等请求验收约束'});
              current=await stored(created.document_code,2);await deliverDocument(current);
              const oldJob=(await f.db.$client.query('select external_ref from memory_projection_jobs j join project_document_revisions v on v.id=j.project_document_revision_id where v.code=$1',[first.source])).rows[0];
              const raw=await searchMemoryEngineDetailed(cfg,{projectCode:f.projectCode,principalCode:f.bob.code},'tspfragment'+first.source.toLowerCase(),'project');
              assert.ok(raw.wiki.includes(oldJob.external_ref)||raw.core.includes(oldJob.external_ref),'Old indexed source must still exist');
              const filtered=await currentApi('search',{query:'tspfragment'+first.source.toLowerCase(),scope:'project'});
              assert.equal(filtered.ok,true);assert.ok(filtered.data.every(row=>row.source!==first.source));
              const oldRead=await currentApi('documents/read',{source:first.source});assert.equal(oldRead.ok,false);assert.equal(oldRead.error.code,'memory_source_unavailable');
              report.staleIndex={oldNativeStillMatched:true,oldSourceFiltered:true,oldDocumentReadRejected:true};
            }
            const member=await memberFor(f,base,dir),auditFile=path.join(dir,opaque()+'.jsonl');
            const result=await runCase({member,prompt:protocol.prompts[id],system:protocol.system,mcpArgs:[fileURLToPath(import.meta.url),'--mcp',auditFile],dir});
            const observed=await readAudit(auditFile),parsed=parseAnswer(result.answer);
            const checks={realMemoryRead:observed.some(row=>row.kind==='mcp'&&!row.error),
              timeoutCorrect:parsed?.timeoutSeconds===(id==='initial'?5:8),implementationUnknown:parsed?.implementationStatus==='unknown',
              currentSourceCited:parsed?.sources?.includes(current.source)??false,onlyCurrentSourceCited:!!parsed?.sources?.length&&parsed.sources.every(source=>source===current.source),
              reasonPresent:typeof parsed?.reason==='string'&&/晚到|覆盖|乱序/u.test(parsed.reason),verificationPresent:Array.isArray(parsed?.checks)&&parsed.checks.length>=1};
            if(id==='current')Object.assign(checks,{actualDocumentExpand:observed.some(row=>row.kind==='mcp'&&row.tool==='read_memory_document'&&!row.error),
              receivedTail:observed.some(row=>row.kind==='mcp'&&row.tool==='read_memory_document'&&row.rows.some(r=>r.source===current.source&&r.text.includes(marker))),
              markerCorrect:parsed?.acceptanceMarker===marker,tailConstraintCorrect:typeof parsed?.tailRule==='string'&&/非幂等/u.test(parsed.tailRule)&&/重试/u.test(parsed.tailRule),
              oldSourceNotReturned:observed.filter(row=>row.kind==='mcp').every(row=>row.rows.every(r=>r.source!==first.source))});
            const entry={id,...result,parsed,checks,audit:observed,memoryChars:observed.filter(row=>row.kind==='mcp').reduce((n,row)=>n+row.bodyChars,0)};
            report.cases.push(entry);await save(`handoff-model-${id}.attempt${attempt}.json`,entry);await save(`handoff-partial.attempt${attempt}.json`,report);
            assert.ok(Object.values(checks).every(Boolean),'Fresh member failed document handoff checks: '+JSON.stringify(checks));
            process.stdout.write(JSON.stringify({case:id,calls:result.calls.length,memoryChars:entry.memoryChars,checks})+'\n');
          }
        }finally {
          await app.close();
          for(const document of owned){const records=(await core('query',document)).messages;if(!records.length)continue;document.recordIds=records.map(row=>row.id);assert.equal((await core('delete',document)).deleted_count,records.length);assert.equal((await core('query',document)).total,0);}
        }
      }));
    report.isolatedDatabaseAndEngineResourcesRemoved=true;report.accepted=true;
  }catch(error){report.accepted=false;report.failure={name:error.name,message:error.message.slice(0,1500)};process.exitCode=1;}
  report.endedAt=new Date().toISOString();await save(`handoff-result.attempt${attempt}.json`,report);
  if(report.accepted)await save('handoff-result.json',report);
  process.stdout.write(JSON.stringify({accepted:report.accepted,cases:report.cases.length,attempt,failure:report.failure})+'\n');
}

if(process.env.TSP_DOCUMENT_HANDOFF_AUDIT)observeFetch(process.env.TSP_DOCUMENT_HANDOFF_AUDIT);
else if(process.argv[2]==='--mcp')await relay(process.argv[3]);
else await main();
