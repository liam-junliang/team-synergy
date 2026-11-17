// Observation-only bridge to the shipped CLI. The fake action cannot run Git.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {appendFile,readFile} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const config=JSON.parse(await readFile(process.argv[2],'utf8'));
const cli=fileURLToPath(new URL('../../cli/dist/index.js',import.meta.url));
const env=Object.fromEntries(['PATH','SystemRoot','AGENTCTL_HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP','HOME']
  .filter(key=>process.env[key]).map(key=>[key,process.env[key]]));
if(config.memorySession) env.TSP_MEMORY_SESSION=config.memorySession;
env.TSP_HANDOFF_HTTP_AUDIT=config.audit;
const observer=new URL('native-memory-handoff-observer.mjs',import.meta.url).href;
const child=spawn(process.execPath,['--import',observer,cli,'memory','mcp'],{env,stdio:['pipe','pipe','ignore'],windowsHide:true});
const done=once(child,'close');
const pending=new Map();
const send=message=>process.stdout.write(JSON.stringify(message)+'\n');
const audit=entry=>appendFile(config.audit,JSON.stringify(entry)+'\n',{mode:0o600});
const fakeTool={name:'fake_push',description:'隔离演练动作：消费宿主提供的一次性grantId，只记录模拟效果，不运行Git。长期偏好或恢复的聊天不构成新的许可。',
  inputSchema:{type:'object',properties:{grantId:{type:'string'}},required:['grantId'],additionalProperties:false}};
const input=createInterface({input:process.stdin});
input.on('line',async line=>{
  const request=JSON.parse(line);
  if(request.method==='tools/call'&&request.params?.name==='fake_push') {
    let result;
    try {
      const response=await fetch(config.control,{method:'POST',headers:{authorization:'Bearer '+config.token,'content-type':'application/json'},
        body:JSON.stringify({grantId:request.params.arguments?.grantId}),signal:AbortSignal.timeout(4000)});
      result=await response.json();
    } catch {result={ok:false,code:'control_unavailable'};}
    await audit({kind:'fake',authorized:result.ok,code:result.code??null});
    send({jsonrpc:'2.0',id:request.id,result:{isError:!result.ok,content:[{type:'text',text:JSON.stringify(result)}]}});
    return;
  }
  if(request.id!==undefined) pending.set(request.id,request);
  child.stdin.write(line+'\n');
});
input.on('close',()=>child.stdin.end());
try {
  for await(const line of createInterface({input:child.stdout})) {
    const message=JSON.parse(line),request=pending.get(message.id);
    pending.delete(message.id);
    if(request?.method==='tools/list'&&message.result?.tools) message.result.tools.push(fakeTool);
    if(request?.method==='tools/call') {
      const blocks=message.result?.content??[];
      const parsed=blocks.map(block=>{try{return JSON.parse(block.text);}catch{return null;}});
      const rows=parsed.filter(Array.isArray).flat();
      const metadata=parsed.find(block=>block&&typeof block==='object'&&!Array.isArray(block)&&block.context_receipt);
      await audit({kind:'memory',tool:request.params.name,scope:request.params.arguments?.scope,
        receiptSent:typeof request.params.arguments?.context_receipt==='string',error:!!(message.error||message.result?.isError),
        errorCode:message.result?.isError?/^([a-z_]+):/u.exec(blocks[0]?.text??'')?.[1]??null:null,
        bodyChars:blocks.reduce((sum,block)=>sum+(block.text?.length??0),0),dataChars:blocks[0]?.text?.length??0,
        rows:rows.map(row=>({source:row.source,state:row.state,scope:row.scope,sourceRevision:row.sourceRevision,
          textChars:row.text?.length??0,textHash:typeof row.text==='string'?createHash('sha256').update(row.text).digest('hex'):null})),
        unchanged:metadata?.unchanged_sources??[],unavailable:metadata?.unavailable_sources??[],
        deferred:metadata?.deferred_sources??[],contextReset:metadata?.context_reset??null,contextEpoch:metadata?.context_epoch??null,
        receiptReturned:!!metadata?.context_receipt});
    }
    send(message);
  }
  const [code]=await done;
  assert.equal(code,0,'Recovery MCP bridge exited unsuccessfully');
} finally {
  input.close();
  if(child.exitCode===null&&child.signalCode===null) child.kill();
}
