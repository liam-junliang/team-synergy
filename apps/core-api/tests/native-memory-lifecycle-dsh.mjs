// Persistent official DSH SDK session: each prompt keeps the same in-process Agent history.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {createDshEvalPatch} from './native-memory-dsh.mjs';

export async function withPersistentDsh({member,mcpArgs,dir,system,maxTokens=1400,turnTimeoutMs=120000},work) {
  const installed=process.env.TSP_PROBE_DSH_BIN || path.join(process.env.APPDATA||'','npm/node_modules/@deepseek-ai/dsh/lib/bin.js');
  assert.ok(path.isAbsolute(installed));
  const manifest=JSON.parse(await readFile(path.resolve(path.dirname(installed),'../package.json'),'utf8'));
  assert.equal(manifest.name,'@deepseek-ai/dsh');
  assert.equal(manifest.version,'0.2.1-rc.2');
  const gateway=new URL(process.env.TSP_EVAL_GATEWAY_URL||'about:blank');
  assert.ok(gateway.protocol==='http:' && gateway.hostname==='127.0.0.1' && gateway.port && /^\/v1\/?$/.test(gateway.pathname));
  const model=process.env.TSP_EVAL_MODEL;
  assert.equal(model,'workbuddy/deepseek-v4.1-flash');
  assert.ok(process.env.TSP_EVAL_GATEWAY_TOKEN);
  const home=await mkdtemp(path.join(dir,'session-'));
  const overlay=path.join(home,'runtime.json');
  let proc,done;
  let timer;
  let completed=false;
  try {
    await writeFile(overlay,createDshEvalPatch(member,mcpArgs,gateway,model,system,false,maxTokens),{mode:0o600});
    const env={DSH_HOME:home,HOME:home,USERPROFILE:home,APPDATA:home,LOCALAPPDATA:home,TEMP:home,TMP:home,
      DSH_TELEMETRY_DISABLED:'1',DO_NOT_TRACK:'1',DSH_PRIMARY_RUNTIME:'',DSH_SYSTEM_PROMPT:system,
      DEEPSEEK_BASE_URL:gateway.origin,DEEPSEEK_API_KEY:process.env.TSP_EVAL_GATEWAY_TOKEN,NO_PROXY:'127.0.0.1,localhost'};
    for(const key of ['SystemRoot','WINDIR','PATH','PATHEXT']) if(process.env[key]) env[key]=process.env[key];
    proc=spawn(process.execPath,[installed,'--profile','sdk-minimal','--patch',overlay],{cwd:member.cwd,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
    done=once(proc,'close');
    proc.stderr.resume();
    const lines=createInterface({input:proc.stdout})[Symbol.asyncIterator]();
    let requestId=0;
    const send=(method,params)=>proc.stdin.write(JSON.stringify({jsonrpc:'2.0',id:++requestId,method,params})+'\n');
    async function next() {
      for(;;) {
        const line=await lines.next();
        if(line.done) throw Error('Persistent DSH exited before turn completion');
        if(/^Client\.list(?:Resources|ResourceTemplates)\(\) called but server does not advertise resources capability - returning empty list$/.test(line.value)) continue;
        const frame=JSON.parse(line.value);
        if(frame.error) throw Error('DSH RPC rejected '+frame.id+' ('+frame.error.code+')');
        return frame;
      }
    }
    timer=setTimeout(()=>proc.kill(),turnTimeoutMs);
    send('initialize',{cwd:member.cwd,provider:'deepseek-official',model,maxTokens});
    for(;;) {const msg=await next();if(msg.id===1){assert.equal(msg.result?.serverInfo?.name,'deepseek-harness-sdk-runtime');break;}}
    clearTimeout(timer);
    const sessionId='memory-'+randomUUID();
    let turns=0;
    const turn=async prompt=>{
      const calls=[];
      let answer='';
      timer=setTimeout(()=>proc.kill(),turnTimeoutMs);
      send('session/prompt',{sessionId,contentBlocks:[{type:'text',text:prompt}]});
      try {
        for(;;) {
          const msg=await next();
          if(msg.method!=='session.event' || msg.params.sessionId!==sessionId) continue;
          const {type,data}=msg.params.event;
          if(type==='tool/call') {calls.push(data.name);assert.ok(calls.length<=12,'Persistent turn exceeded tool budget');}
          else if(type==='assistant/message') answer=(data.message?.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
          else if(type==='turn/end') {
            assert.equal(data.reason?.kind,'completed','DSH turn did not complete: '+JSON.stringify(data.reason));
            turns++;
            return {turn:turns,answer,calls};
          }
        }
      } finally {clearTimeout(timer);}
    };
    const value=await work({sessionId,turn,version:manifest.version+' sdk-minimal persistent'});
    assert.ok(turns>1,'Lifecycle probe must retain a real multi-turn session');
    completed=true;
    return value;
  } finally {
    clearTimeout(timer);
    let code;
    if(proc && done) {
      if(proc.exitCode===null && proc.signalCode===null && !proc.stdin.destroyed) proc.stdin.end(JSON.stringify({jsonrpc:'2.0',id:9999,method:'shutdown',params:{}})+'\n');
      const reap=setTimeout(()=>proc.kill(),4000);
      try{[code]=await done;}finally{clearTimeout(reap);}
    }
    assert.equal(path.dirname(home),path.resolve(dir));
    assert.match(path.basename(home),/^session-[a-zA-Z0-9]+$/);
    await rm(home,{recursive:true,force:true,maxRetries:3,retryDelay:250});
    if(completed) assert.equal(code,0,'Persistent DSH failed shutdown');
  }
}
