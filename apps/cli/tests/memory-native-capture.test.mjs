import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createNativeCaptureBridge, nativeCaptureEventId } from '../dist/memory-native-capture.js';

const cliPath = fileURLToPath(new URL('../dist/index.js',import.meta.url));
function outboxFile(config) {
  const key=createHash('sha256').update(JSON.stringify([config.owner,config.harness,config.hostSessionId,config.memorySession])).digest('hex');
  const directory=path.join(config.memberHome,'memory-native-outbox');mkdirSync(directory,{recursive:true});
  return path.join(directory,key+'.sqlite');
}

async function nativeEnqueueProcess(t,f,event,onBusy=()=>{}) {
  // Observe real SQLite errors without replacing any database operation or timer.
  const program=`import {DatabaseSync} from 'node:sqlite';
    import {enqueueNativeCapture} from ${JSON.stringify(new URL('../dist/memory-native-capture.js',import.meta.url).href)};
    const exec=DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec=function(sql){try{return exec.call(this,sql);}catch(error){
      process.send({kind:'sqlite-error',code:error.code,errcode:error.errcode});throw error;}};
    process.once('message',async({config,event})=>{try{process.send({kind:'result',ok:true,data:await enqueueNativeCapture(config,event)});}
      catch(error){process.send({kind:'result',ok:false,code:error.code,errcode:error.errcode});}finally{process.disconnect();}});
    process.send({kind:'ready'});`;
  const child=spawn(process.execPath,['--input-type=module','-e',program],{cwd:f.config.cwd,
    env:{...process.env,AGENTCTL_HOME:f.config.memberHome},windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});
  t.after(()=>{if(child.exitCode===null)child.kill();});
  const done=once(child,'close'),ready=once(child,'message');
  const sqliteErrors=[];let result,notified=false;
  child.on('message',message=>{
    if(message.kind==='sqlite-error'){
      sqliteErrors.push(message);
      if((message.errcode&255)===5&&!notified){notified=true;onBusy();}
    }else if(message.kind==='result')result=message;
  });
  await ready;child.send({config:f.config,event});
  assert.equal((await done)[0],0);assert.ok(result);
  return {...result,sqliteErrors};
}
async function fixture(t,harness='dsh') {
  const directory = mkdtempSync(path.join(tmpdir(),'tsp-native-outbox-'));
  const cwd = path.join(directory,'repo'),memberHome=path.join(directory,'member');
  mkdirSync(path.join(cwd,'.agent'),{recursive:true}); mkdirSync(memberHome);
  const posts=[],jobs=new Map(); let loseAck=false;
  const server=createServer(async(req,res)=>{
    assert.equal(req.headers.authorization,'Bearer fixture-native-device');
    let result;
    if(req.url==='/auth/whoami') result={user_code:'member-A'};
    else if(req.url==='/projects/P/memory/binding') result={};
    else if(req.url==='/projects/P/memory/capture-events') {
      let raw='';for await(const b of req)raw+=b;const body=JSON.parse(raw);posts.push(body);
      assert.deepEqual(Object.keys(body).sort(),['eventId','sessionId','sourceText']);
      const prior=jobs.get(body.eventId);if(prior)assert.deepEqual(prior.body,body);
      const captureCode=prior?.captureCode??String(jobs.size+1).padStart(20,'0');jobs.set(body.eventId,{body,captureCode});
      if(loseAck){loseAck=false;res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({ok:false,error:{code:'fixture_ack_lost',message:'retry'}}));return;}
      res.statusCode=202;result={captureCode,status:'pending',replayed:Boolean(prior)};
    }else{res.writeHead(404).end();return;}
    res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,data:result}));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const api=`http://127.0.0.1:${server.address().port}`,authFile=path.join(memberHome,'auth.json');
  writeFileSync(authFile,JSON.stringify({api_url:api,user_code:'member-A',device_token:'fixture-native-device',device_name:'native fixture'}));
  const binding=path.join(cwd,'.agent','bound-project.yaml');
  writeFileSync(binding,`project_code: P\napi_url: ${api}\nbound_at: now\n`);
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));assert.equal(path.dirname(directory),path.resolve(tmpdir()));rmSync(directory,{recursive:true,force:true});});
  const child=spawn(process.execPath,[cliPath,'memory','native','config','--harness',harness,'--host-session','native-host'],{
    cwd,env:{...process.env,AGENTCTL_HOME:memberHome},windowsHide:true,stdio:['ignore','pipe','ignore']});
  const finished=once(child,'close');let output='';child.stdout.setEncoding('utf8').on('data',b=>output+=b);
  assert.equal((await finished)[0],0);const parsed=JSON.parse(output);assert.equal(parsed.ok,true);
  const config=parsed.data,bridge=createNativeCaptureBridge(config);
  const event=(message='message-1',text='在所有项目中我习惯先列出验证结果。')=>({
    eventId:nativeCaptureEventId(harness,config.hostSessionId,message),nativeMessageId:message,nativeSeq:1,sourceText:text});
  return {config,bridge,event,posts,jobs,authFile,binding,loseAck:()=>{loseAck=true;},directory};
}

test('OpenCode candidate remains local until exact native persisted text is confirmed',async t=>{
  const f=await fixture(t,'opencode'),event=f.event();
  const ack=await f.bridge.enqueue(event,false);assert.equal(ack.durable,true);assert.equal(ack.state,'staged');
  assert.equal((await f.bridge.pending()).length,1);assert.equal((await f.bridge.drain()).accepted,0);assert.equal(f.posts.length,0);
  await assert.rejects(f.bridge.confirm({eventId:event.eventId,sourceText:'不同原文'}),{code:'memory_source_changed'});
  const restarted=createNativeCaptureBridge(f.config);assert.deepEqual(await restarted.pending(),[{...event,cursor:1}]);
  await restarted.confirm(event);assert.equal((await restarted.drain()).accepted,1);assert.equal(f.jobs.size,1);
  assert.deepEqual(f.posts[0],{sessionId:f.config.memorySession,eventId:event.eventId,sourceText:event.sourceText});
  assert.equal((await restarted.status()).events[0].state,'accepted');
});

test('post-commit DSH event replay is idempotent and changed native text is rejected',async t=>{
  const f=await fixture(t),event=f.event();
  await f.bridge.enqueue(event);await f.bridge.drain();
  assert.equal((await f.bridge.enqueue(event)).state,'accepted');assert.equal((await f.bridge.drain()).accepted,0);
  assert.equal(f.posts.length,1);
  await assert.rejects(f.bridge.enqueue({...event,sourceText:'同一消息发生变化'}),{code:'memory_event_changed'});
  await assert.rejects(f.bridge.enqueue({...event,eventId:'native.dsh.wrong-session'}),{code:'memory_native_invalid'});
});

test('a lost remote ACK keeps the local source and retries the same server event',async t=>{
  const f=await fixture(t);await f.bridge.enqueue(f.event());f.loseAck();
  const failed=await f.bridge.drain();assert.equal(failed.accepted,0);assert.equal(failed.pending,true);
  assert.equal((await f.bridge.status()).events[0].state,'ready');
  const restarted=createNativeCaptureBridge(f.config);assert.equal((await restarted.drain()).accepted,1);
  assert.equal(f.posts.length,2);assert.deepEqual(f.posts[0],f.posts[1]);assert.equal(f.jobs.size,1);
});

test('switching accounts or projects fails before exposing or delivering an old spool',async t=>{
  const f=await fixture(t);await f.bridge.enqueue(f.event(),false);
  const auth=JSON.parse(readFileSync(f.authFile,'utf8'));writeFileSync(f.authFile,JSON.stringify({...auth,user_code:'member-B',device_token:'different-device'}));
  await assert.rejects(f.bridge.pending(),{code:'memory_binding_changed'});assert.equal(f.posts.length,0);
  writeFileSync(f.authFile,JSON.stringify(auth));writeFileSync(f.binding,readFileSync(f.binding,'utf8').replace('project_code: P','project_code: OTHER'));
  await assert.rejects(f.bridge.drain(),{code:'memory_binding_changed'});assert.equal(f.posts.length,0);
});

test('parallel native notifications and drains preserve one durable event',async t=>{
  const f=await fixture(t),event=f.event();
  await Promise.all([f.bridge.enqueue(event),f.bridge.enqueue(event)]);
  await Promise.all([f.bridge.drain(),f.bridge.drain()]);
  assert.equal(f.jobs.size,1);assert.equal(f.posts.length,1);assert.equal((await f.bridge.status()).events.length,1);
});

test('cold native initialization recovers real WAL lock errors across processes before durable ACK',async t=>{
  const f=await fixture(t),event=f.event(),file=outboxFile(f.config),holder=new DatabaseSync(file);
  holder.exec('BEGIN IMMEDIATE');let released=false,busy=0;
  const release=()=>{if(!released){holder.exec('ROLLBACK');holder.close();released=true;}};t.after(release);
  // A RESERVED rollback-journal lock makes WAL conversion return SQLITE_BUSY
  // immediately even with busy_timeout set. Release after both processes see it.
  const results=await Promise.all([0,1].map(()=>nativeEnqueueProcess(t,f,event,()=>{if(++busy===2)release();})));
  assert.equal(busy,2);
  for(const result of results){
    assert.equal(result.sqliteErrors[0].errcode&255,5);
    assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.data.durable,true);
  }
  const db=new DatabaseSync(file);
  try{assert.deepEqual(db.prepare('SELECT event_id,source_text FROM events').all().map(row=>({...row})),
    [{event_id:event.eventId,source_text:event.sourceText}]);}finally{db.close();}
  await Promise.all([f.bridge.drain(),f.bridge.drain()]);
  assert.equal(f.posts.length,1);assert.equal(f.jobs.size,1);
  assert.deepEqual(f.posts[0],{sessionId:f.config.memorySession,eventId:event.eventId,sourceText:event.sourceText});
  await assert.rejects(f.bridge.enqueue({...event,sourceText:'同一消息被改写'}),{code:'memory_event_changed'});
});

test('native initialization retries are bounded and never turn an unreleased lock into durable ACK',async t=>{
  const f=await fixture(t),holder=new DatabaseSync(outboxFile(f.config));holder.exec('BEGIN IMMEDIATE');
  const started=Date.now();let result;
  try{result=await nativeEnqueueProcess(t,f,f.event());}finally{holder.exec('ROLLBACK');holder.close();}
  assert.equal(result.ok,false);assert.equal(result.errcode&255,5);
  assert.ok(result.sqliteErrors.length>1,'a transient lock must be retried');
  assert.ok(Date.now()-started<10000,'retry budget must finish before the bridge deadline');
  assert.equal(f.posts.length,0);
});

test('native initialization does not retry corrupt storage and rechecks identity after contention',async t=>{
  const corrupt=await fixture(t),file=outboxFile(corrupt.config);writeFileSync(file,'not a sqlite database');
  const rejected=await nativeEnqueueProcess(t,corrupt,corrupt.event());
  assert.equal(rejected.ok,false);assert.equal(rejected.errcode,26);assert.equal(rejected.sqliteErrors.length,1);
  assert.equal(readFileSync(file,'utf8'),'not a sqlite database');
  const changed=await fixture(t),holder=new DatabaseSync(outboxFile(changed.config));holder.exec('BEGIN IMMEDIATE');let released=false;
  const release=()=>{if(!released){holder.exec('ROLLBACK');holder.close();released=true;}};t.after(release);
  const result=await nativeEnqueueProcess(t,changed,changed.event(),()=>{
    const auth=JSON.parse(readFileSync(changed.authFile,'utf8'));
    writeFileSync(changed.authFile,JSON.stringify({...auth,user_code:'member-B',device_token:'different-device'}));release();
  });
  assert.equal(result.ok,false);assert.equal(result.code,'memory_binding_changed');
  assert.equal(changed.posts.length,0);assert.equal(corrupt.posts.length,0);
});

test('a detached native pump retries a transient ACK failure without another user turn',async t=>{
  const f=await fixture(t);await f.bridge.enqueue(f.event());f.loseAck();f.bridge.kick();
  const deadline=Date.now()+12000;let current;
  do{current=await f.bridge.status();if(current.events[0].state==='accepted')break;await new Promise(resolve=>setTimeout(resolve,150));}while(Date.now()<deadline);
  assert.equal(current.events[0].state,'accepted');assert.equal(f.posts.length,2);assert.deepEqual(f.posts[0],f.posts[1]);assert.equal(f.jobs.size,1);
});

test('generated native profiles include capture, lifecycle and read-only MCP without credentials or overwrites',async t=>{
  const f=await fixture(t);
  async function setup(harness,directory){
    const child=spawn(process.execPath,[cliPath,'memory','native','setup','--harness',harness,'--host-session','native-host','--output',directory],{
      cwd:f.config.cwd,env:{...process.env,AGENTCTL_HOME:f.config.memberHome},windowsHide:true,stdio:['ignore','pipe','ignore']});
    const done=once(child,'close');let raw='';child.stdout.setEncoding('utf8').on('data',b=>raw+=b);
    const [code]=await done;return {code,...JSON.parse(raw)};
  }
  for(const harness of ['dsh','opencode']){
    const directory=path.join(f.directory,harness+'-profile'),result=await setup(harness,directory);
    assert.equal(result.code,0);assert.equal(result.data.globalConfigurationChanged,false);
    const profile=JSON.parse(readFileSync(result.data.profileFile,'utf8'));
    const capture=readFileSync(result.data.configFile,'utf8');
    assert.ok(!capture.includes('fixture-native-device'));
    if(harness==='dsh'){
      assert.deepEqual(profile.plugins.insert.map(row=>row.id),['tsp-memory-dsh-capture','tsp-memory-dsh-lifecycle','tsp-memory']);
      assert.equal(profile.plugins.insert[2].config.command,process.execPath);
    }else{
      assert.equal(profile.plugin.length,1);assert.deepEqual(profile.mcp.tsp_memory.command,[process.execPath,cliPath,'memory','mcp']);
    }
    const rejected=await setup(harness,directory);assert.equal(rejected.code,1);assert.equal(rejected.error.code,'memory_profile_exists');
    assert.equal(readFileSync(result.data.configFile,'utf8'),capture);
  }
  assert.equal(f.posts.length,0);
});

test('older unconfirmed messages cannot hide the 101st valid native message',async t=>{
  const f=await fixture(t,'opencode');
  const source=fileURLToPath(new URL('../dist/memory-native-capture.js',import.meta.url));
  const program=`import{readFileSync}from'node:fs';const config=JSON.parse(readFileSync(0,'utf8'));
    const m=await import(${JSON.stringify(new URL('../dist/memory-native-capture.js',import.meta.url).href)});
    const text='我偏好保留验证证据。';let last;
    for(let index=0;index<101;index++){const nativeMessageId='candidate-'+index;
      last={nativeMessageId,eventId:m.nativeCaptureEventId(config.harness,config.hostSessionId,nativeMessageId),sourceText:text};
      await m.enqueueNativeCapture(config,last,false);}
    const first=await m.pendingNativeCapture(config),next=await m.pendingNativeCapture(config,{after:first.at(-1).cursor});
    const exact=await m.pendingNativeCapture(config,{nativeMessageId:last.nativeMessageId});
    await m.confirmNativeCapture(config,last);const result=await m.drainNativeCapture(config);
    console.log(JSON.stringify({first:first.length,next:next.length,nextCursor:next[0].cursor,exact:exact.length,exactId:exact[0].nativeMessageId,accepted:result.accepted}));`;
  assert.ok(path.isAbsolute(source));
  const child=spawn(process.execPath,['--input-type=module','-e',program],{cwd:f.config.cwd,
    env:{...process.env,AGENTCTL_HOME:f.config.memberHome},windowsHide:true,stdio:['pipe','pipe','ignore']});
  const done=once(child,'close');let raw='';child.stdout.setEncoding('utf8').on('data',b=>raw+=b);child.stdin.end(JSON.stringify(f.config));
  assert.equal((await done)[0],0);
  assert.deepEqual(JSON.parse(raw),{first:100,next:1,nextCursor:101,exact:1,exactId:'candidate-100',accepted:1});
  assert.equal(f.posts.length,1);
});
