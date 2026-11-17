// Isolated native DSH compaction/resume adapter. No model-facing control tools.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createDshEvalPatch} from './native-memory-dsh.mjs';

// This plugin is loaded only by the isolated test profile. It calls the shipped
// compaction service and observes its durable events. The shipped lifecycle
// adapter separately performs synchronous CLI resets before the next request.
const controllerPlugin=String.raw`
import {createServer} from 'node:http';
import {writeFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
export const name='tsp-memory-native-context-controller';
export const inject=['agents','compaction','sessions'];
export async function apply(ctx,config) {
  const audit=entry=>appendFileSync(config.audit,JSON.stringify(entry)+'\n',{mode:0o600});
  ctx.on('agent/created',({agent,source})=>{
    if(String(agent.session.id)!==config.sessionId)return;
    audit({kind:'agent-created',source});
  });
  ctx.on('session/event',(session,event)=>{
    if(String(session.id)!==config.sessionId)return;
    const data=event.data;
    if(event.type==='compaction/summary') {
      audit({kind:'native-compaction-summary',shadowedCount:data.shadowedSeqs.length,shadowedSeqs:data.shadowedSeqs,
        provider:data.provider,model:data.model,summaryChars:JSON.stringify(data.summary).length,llmStreamCall:data.llmStreamCall===true});
    }
    if(event.type==='compaction/end') {
      audit({kind:'native-compaction-end',ok:!data.error});
    }
  });
  function snapshot(agent,probes=[]) {
    if(!Array.isArray(probes)||probes.length>8||probes.some(p=>typeof p!=='string'||p.length>4000))throw Error('invalid_probe');
    const json=JSON.stringify(agent.session.deriveMessages());
    return {surfaceNodes:agent.session.surface.nodes.length,replaceGeneration:agent.session.surface.replaceGeneration,
      messageChars:json.length,sha256:createHash('sha256').update(json).digest('hex'),probes:probes.map(p=>json.includes(p))};
  }
  const server=createServer(async(req,res)=>{
    if(req.method!=='POST'||req.headers.authorization!=='Bearer '+config.token){res.writeHead(403);res.end('{}');return;}
    try {
      let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>40000)throw Error('input_too_large');}
      const body=JSON.parse(raw);
      if(body.sessionId!==config.sessionId)throw Error('session_mismatch');
      const agent=ctx.agents.get(body.sessionId);
      if(!agent)throw Error('agent_unavailable');
      let result;
      if(req.url==='/inspect') result=snapshot(agent,body.probes);
      else if(req.url==='/compact') {
        const before=snapshot(agent,body.probes);
        const compacted=await ctx.compaction.compactNow(agent,AbortSignal.timeout(120000));
        result={before,after:snapshot(agent,body.probes),compacted:!!compacted,
          shadowedCount:compacted?.shadowedSeqs.length??0,shadowedSeqs:compacted?.shadowedSeqs??[],
          summaryChars:compacted?JSON.stringify(compacted.summary).length:0};
      } else throw Error('unknown_control');
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true,data:result}));
    } catch(error) {
      // Keep only stable error classes; provider error objects may embed a request.
      const causes=[];
      for(let current=error;current&&causes.length<4;current=current.cause) {
        const message=String(current.message??'');
        const classification=/summary is not smaller/iu.test(message)?'not_smaller':
          /no text summary/iu.test(message)?'no_text':/max.?tokens|token limit|output limit|length/iu.test(message)?'output_limit':
          /timeout|timed out/iu.test(message)?'timeout':'other';
        const safe=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,80}$/u.test(value)?value:undefined;
        causes.push({name:safe(current.name),code:safe(current.code),classification});
      }
      res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({ok:false,error:error.code??error.name??'control_failed',causes}));
    }
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  writeFileSync(config.controlFile,JSON.stringify({url:'http://127.0.0.1:'+server.address().port,token:config.token}),{mode:0o600});
  ctx.on('dispose',()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
}
`;

/** Same native session before/after compaction, then a real persisted resume. */
export async function withRecoveryDsh({member,mcpArgs,dir,system,memorySession,autoReset=true,maxTokens=1600,turnTimeoutMs=150000},work) {
  if(autoReset)assert.match(memorySession??'',/^[a-zA-Z0-9._:-]{1,160}$/);
  const installed=process.env.TSP_PROBE_DSH_BIN||path.join(process.env.APPDATA||'','npm/node_modules/@deepseek-ai/dsh/lib/bin.js');
  assert.ok(path.isAbsolute(installed));
  const manifest=JSON.parse(await readFile(path.resolve(path.dirname(installed),'../package.json'),'utf8'));
  assert.equal(manifest.name,'@deepseek-ai/dsh');assert.equal(manifest.version,'0.2.1-rc.2');
  const gateway=new URL(process.env.TSP_EVAL_GATEWAY_URL||'about:blank');
  assert.ok(gateway.protocol==='http:'&&gateway.hostname==='127.0.0.1'&&gateway.port&&/^\/v1\/?$/.test(gateway.pathname));
  const model=process.env.TSP_EVAL_MODEL;assert.equal(model,'workbuddy/deepseek-v4.1-flash');
  assert.ok(process.env.TSP_EVAL_GATEWAY_TOKEN);
  const home=await mkdtemp(path.join(dir,'session-'));
  const sessionId='memory-'+randomUUID();
  const plugin=path.join(home,'controller.mjs');
  const auditFile=path.join(home,'controller.audit.jsonl');
  const overlay=path.join(home,'runtime.json');
  const cli=fileURLToPath(new URL('../../cli/dist/index.js',import.meta.url));
  const lifecycleAdapter=fileURLToPath(new URL('../../cli/dist/memory-dsh-lifecycle.js',import.meta.url));
  const events=[];
  let runtime,generation=0,turns=0;
  await writeFile(plugin,controllerPlugin,{mode:0o600});
  const controllerAudit=async()=>{
    try{return (await readFile(auditFile,'utf8')).trim().split('\n').filter(Boolean).map(row=>JSON.parse(row));}
    catch(error){if(error.code==='ENOENT')return [];throw error;}
  };
  async function start(resume) {
    generation++;
    const controlFile=path.join(home,'control-'+generation+'.json');
    const patch=JSON.parse(createDshEvalPatch(member,mcpArgs,gateway,model,system,false,maxTokens));
    const compact=patch.find(item=>item.id==='compaction-basic');
    compact.disabled=false;compact.config={auto:false,headroomTokens:0,retainTokens:0,maxTokens:4096};
    const memory=patch.flatMap(item=>item.insert??[]).find(item=>item.id==='tsp-memory');
    if(memorySession)memory.config.env.TSP_MEMORY_SESSION=memorySession;
    patch.push({insert:[{id:'tsp-memory-context-controller',name:pathToFileURL(plugin).href,
      config:{controlFile,audit:auditFile,token:randomBytes(24).toString('hex'),sessionId}},
      {id:'session-checkpoints',name:'@deepseek-ai/dsh-session-checkpoint-policy'}]});
    if(autoReset)patch.push({insert:[{id:'tsp-memory-dsh-lifecycle',name:pathToFileURL(lifecycleAdapter).href,
      config:{hostSessionId:sessionId,memorySession,cwd:member.cwd,memberHome:member.home,cliPath:cli,auditFile}}]});
    await writeFile(overlay,JSON.stringify(patch),{mode:0o600});
    const env={DSH_HOME:home,HOME:home,USERPROFILE:home,APPDATA:home,LOCALAPPDATA:home,TEMP:home,TMP:home,
      DSH_TELEMETRY_DISABLED:'1',DO_NOT_TRACK:'1',DSH_PRIMARY_RUNTIME:'',DSH_SYSTEM_PROMPT:system,
      DEEPSEEK_BASE_URL:gateway.origin,DEEPSEEK_API_KEY:process.env.TSP_EVAL_GATEWAY_TOKEN,NO_PROXY:'127.0.0.1,localhost'};
    for(const key of ['SystemRoot','WINDIR','PATH','PATHEXT'])if(process.env[key])env[key]=process.env[key];
    const proc=spawn(process.execPath,[installed,'--profile','sdk-minimal','--patch',overlay],{cwd:member.cwd,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
    const done=once(proc,'close');proc.stderr.resume();
    const pending=new Map();let requestId=0,activeTurn;
    const fail=error=>{for(const {reject,timer}of pending.values()){clearTimeout(timer);reject(error);}pending.clear();activeTurn?.reject(error);};
    const reader=(async()=>{
      try {
        for await(const line of createInterface({input:proc.stdout})) {
          if(/^Client\.list(?:Resources|ResourceTemplates)\(\) called but server does not advertise resources capability - returning empty list$/.test(line))continue;
          const frame=JSON.parse(line);
          if(frame.id!==undefined&&pending.has(frame.id)) {
            const task=pending.get(frame.id);pending.delete(frame.id);clearTimeout(task.timer);
            if(frame.error)task.reject(Error('DSH RPC rejected '+frame.id+' ('+frame.error.code+')'));else task.resolve(frame.result);
          }
          if(frame.method!=='session.event'||frame.params.sessionId!==sessionId)continue;
          const {type,data,seq}=frame.params.event;
          if(type.startsWith('compaction/'))events.push({generation,type,seq,shadowedCount:data.shadowedSeqs?.length,model:data.model,error:!!data.error});
          if(!activeTurn)continue;
          if(type==='tool/call'){activeTurn.calls.push(data.name);assert.ok(activeTurn.calls.length<=14,'Recovery turn exceeded tool budget');}
          else if(type==='assistant/message')activeTurn.answer=(data.message?.content??[]).filter(b=>b.type==='text').map(b=>b.text).join('');
          else if(type==='turn/end') {
            const task=activeTurn;activeTurn=undefined;
            if(data.reason?.kind!=='completed')task.reject(Error('DSH recovery turn did not complete: '+data.reason?.kind));
            else task.resolve({turn:++turns,answer:task.answer,calls:task.calls,generation});
          }
        }
        fail(Error('DSH recovery runtime closed'));
      }catch(error){fail(error);proc.kill();}
    })();
    function rpc(method,params) {
      const id=++requestId;
      return new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{pending.delete(id);reject(Error('DSH recovery RPC timeout'));proc.kill();},turnTimeoutMs);
        pending.set(id,{resolve,reject,timer});proc.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
      });
    }
    const stop=async()=>{
      if(proc.exitCode===null&&proc.signalCode===null) {
        try{await rpc('shutdown',{});}catch{proc.kill();}
      }
      const reap=setTimeout(()=>proc.kill(),5000);
      try {const [code]=await done;assert.equal(code,0,'DSH recovery shutdown failed');await reader;}
      finally {clearTimeout(reap);}
    };
    runtime={stop};
    const initialized=await rpc('initialize',{cwd:member.cwd,provider:'deepseek-official',model,maxTokens});
    assert.equal(initialized?.serverInfo?.name,'deepseek-harness-sdk-runtime');
    const control=JSON.parse(await readFile(controlFile,'utf8'));
    const controlCall=async(action,probes=[])=>{
      const response=await fetch(control.url+'/'+action,{method:'POST',headers:{authorization:'Bearer '+control.token,'content-type':'application/json'},
        body:JSON.stringify({sessionId,probes}),signal:AbortSignal.timeout(turnTimeoutMs)});
      const value=await response.json();assert.equal(value.ok,true,'Native DSH control '+action+' failed: '+value.error+' '+JSON.stringify(value.causes??[]));return value.data;
    };
    runtime={stop,controlCall,turn:async prompt=>{
      assert.equal(activeTurn,undefined,'Concurrent turns are not supported by this fixture');
      let timer;
      const completion=new Promise((resolve,reject)=>{
        timer=setTimeout(()=>{reject(Error('DSH recovery turn timeout'));proc.kill();},turnTimeoutMs);
        activeTurn={resolve,reject,answer:'',calls:[]};
      });
      completion.catch(()=>{});
      try {await rpc('session/prompt',{sessionId,contentBlocks:[{type:'text',text:prompt}]});return await completion;}
      finally {clearTimeout(timer);}
    }};
    if(resume)await rpc('session/resume',{sessionId});
    else await rpc('session/working-directory/get',{sessionId});
  }
  try {
    await start(false);
    const host={sessionId,version:manifest.version+' sdk-minimal native-compaction/resume',events,
      turn:prompt=>runtime.turn(prompt),inspect:({probes=[]}={})=>runtime.controlCall('inspect',probes),
      compact:({probes=[]}={})=>runtime.controlCall('compact',probes),
      restartResume:async()=>{await runtime.stop();runtime=undefined;await start(true);return {generation,sessionId,nativeResume:true};},
      controllerAudit};
    return await work(host);
  }finally {
    try{await runtime?.stop();}finally {
      assert.equal(path.dirname(home),path.resolve(dir));assert.match(path.basename(home),/^session-[a-zA-Z0-9]+$/);
      await rm(home,{recursive:true,force:true,maxRetries:3,retryDelay:250});
    }
  }
}
