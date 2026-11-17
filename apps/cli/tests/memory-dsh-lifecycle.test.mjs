import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {apply,createMemoryDshLifecycle,dshLifecyclePluginEntry} from '../dist/memory-dsh-lifecycle.js';

const config=()=>({hostSessionId:'dsh-session',memorySession:'member-memory',cwd:process.cwd(),memberHome:tmpdir(),cliPath:path.join(process.cwd(),'apps/cli/dist/index.js')});
const own={id:'dsh-session'};
const event=(type,data={compactionId:'native-one'},seq=1)=>({type,data,seq});

test('native summary and end reset once, while failed/no-summary attempts and other sessions do not',()=>{
  const calls=[];
  const lifecycle=createMemoryDshLifecycle(config(),reason=>calls.push(reason));
  lifecycle.event(own,event('compaction/start'));
  lifecycle.event(own,event('compaction/end',{compactionId:'missing-summary',error:'summary rejected'}));
  lifecycle.event({id:'another-session'},event('compaction/summary'));
  lifecycle.event({id:'another-session'},event('compaction/end'));
  assert.deepEqual(calls,[]);
  lifecycle.event(own,event('compaction/summary'));
  lifecycle.event(own,event('compaction/end'));
  lifecycle.event(own,event('compaction/end'));
  assert.deepEqual(calls,['compaction']);
});

test('a landed summary followed by an error and model-free pruning also invalidate old receipts',()=>{
  const calls=[];
  const lifecycle=createMemoryDshLifecycle(config(),reason=>calls.push(reason));
  lifecycle.event(own,event('compaction/summary'));
  lifecycle.event(own,event('compaction/end',{compactionId:'native-one',error:'persistence failed'}));
  lifecycle.event(own,event('compaction/prune',{},30));
  lifecycle.event(own,event('compaction/prune',{},30));
  assert.deepEqual(calls,['compaction','compaction']);
});

test('a real resume source resets before the resumed session can take a step',()=>{
  const calls=[];
  const original=config();
  const lifecycle=createMemoryDshLifecycle(original,reason=>calls.push(reason));
  original.hostSessionId='changed-by-caller';
  lifecycle.created({agent:{session:own},source:'startup'});
  lifecycle.created({agent:{session:{id:'another-session'}},source:'resume'});
  assert.deepEqual(calls,[]);
  lifecycle.created({agent:{session:own},source:'resume'});
  lifecycle.beforeStep(own);
  assert.deepEqual(calls,['resume']);
});

test('reset failure blocks only the affected native session and never calls the next step',()=>{
  const listeners=new Map();
  const ctx={on:(name,handler)=>listeners.set(name,handler)};
  const base=config();
  // A missing executable script makes production reset fail before any model step.
  apply(ctx,{...base,cliPath:path.join(tmpdir(),'missing-tsp-cli-'+process.pid+'.mjs')});
  assert.throws(()=>listeners.get('agent/created')({agent:{session:own},source:'resume'}),{code:'memory_lifecycle_unavailable'});
  let next=0;
  assert.throws(()=>listeners.get('agent/pre-step')({agent:{session:own}},()=>next++),{code:'memory_lifecycle_unavailable'});
  assert.equal(next,0);
  listeners.get('agent/pre-step')({agent:{session:{id:'another-session'}}},()=>next++);
  assert.equal(next,1);
});

test('production bridge invokes a fixed node argv with explicit member home and no model credential',()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'tsp-dsh-lifecycle-'));
  const file=path.join(dir,'fixed-cli.mjs'),log=path.join(dir,'calls.json');
  const previous=process.env.DEEPSEEK_API_KEY;
  try {
    process.env.DEEPSEEK_API_KEY='synthetic-key-must-not-propagate';
    writeFileSync(file,"import fs from 'node:fs';fs.writeFileSync("+JSON.stringify(log)+",JSON.stringify({args:process.argv.slice(2),home:process.env.AGENTCTL_HOME,keyPresent:!!process.env.DEEPSEEK_API_KEY}));console.log(JSON.stringify({ok:true,data:{epoch:2}}));");
    const lifecycle=createMemoryDshLifecycle({...config(),cliPath:file,memberHome:dir});
    lifecycle.created({agent:{session:own},source:'resume'});
    assert.deepEqual(JSON.parse(readFileSync(log,'utf8')),{args:['memory','context','reset','--session','member-memory','--reason','resume'],home:dir,keyPresent:false});
  }finally {
    if(previous===undefined)delete process.env.DEEPSEEK_API_KEY;else process.env.DEEPSEEK_API_KEY=previous;
    assert.equal(path.dirname(dir),path.resolve(tmpdir()));
    assert.match(path.basename(dir),/^tsp-dsh-lifecycle-[a-zA-Z0-9]+$/);
    rmSync(dir,{recursive:true,force:true});
  }
});

test('invalid session names, relative scripts and unknown configuration fields are rejected',()=>{
  for(const change of [{hostSessionId:'bad session'},{memorySession:'../other'},{cliPath:'relative.mjs'},{nodePath:'node'},{nodePath:''},{memberHome:''},{extra:'not accepted'}]) {
    assert.throws(()=>createMemoryDshLifecycle({...config(),...change}),{code:'memory_lifecycle_invalid'});
  }
});

test('exports the native lifecycle Cordis row and preserves an explicit Node executable',()=>{
  const entry=dshLifecyclePluginEntry({...config(),nodePath:process.execPath});
  assert.equal(entry.id,'tsp-memory-dsh-lifecycle');assert.match(entry.name,/^file:/u);
  assert.equal(entry.config.nodePath,process.execPath);
  assert.notEqual(entry.config,config());
});
