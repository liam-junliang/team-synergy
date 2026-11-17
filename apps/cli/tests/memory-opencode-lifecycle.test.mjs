import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import plugin,{createMemoryOpencodeLifecycle} from '../dist/memory-opencode-lifecycle.js';

const config=()=>({hostSessionId:'ses_native',memorySession:'member-memory',cwd:process.cwd(),memberHome:tmpdir(),cliPath:path.join(process.cwd(),'apps/cli/dist/index.js')});
const native=base=>({mcp:{tsp_memory:{type:'local',environment:{TSP_MEMORY_SESSION:base.memorySession,AGENTCTL_HOME:base.memberHome}}}});
const tool=(sessionID='ses_native',name='tsp_memory_read_memory_brief')=>({sessionID,tool:name,callID:'call-native'});
const compacted=(sessionID='ses_native')=>({event:{type:'session.compacted',properties:{sessionID}}});

test('trusted first session use resets once and model arguments cannot route another chat into the connection',()=>{
  const base=config(),calls=[],lifecycle=createMemoryOpencodeLifecycle(base,reason=>calls.push(reason));
  lifecycle.configure(native(base));
  base.hostSessionId='mutated-after-configuration';
  lifecycle.message({sessionID:'another-chat'});
  lifecycle.beforeTool(tool('another-chat','unrelated_tool'));
  assert.deepEqual(calls,[]);
  lifecycle.message({sessionID:'ses_native'});
  lifecycle.beforeTool(tool());
  assert.deepEqual(calls,['resume']);
  assert.throws(()=>lifecycle.beforeTool({...tool('another-chat'),args:{sessionID:'ses_native'}}),{code:'memory_session_mismatch'});
  assert.throws(()=>lifecycle.beforeTool(tool('another-chat','tsp_memory_read_memory_document')),{code:'memory_session_mismatch'});
  lifecycle.beforeTool(tool('ses_native','tsp_memory_read_memory_document'));
  assert.deepEqual(calls,['resume']);
});

test('compaction begin blocks memory until success, and awaited auto completion plus bus event resets once',()=>{
  const base=config(),calls=[],lifecycle=createMemoryOpencodeLifecycle(base,reason=>calls.push(reason));
  lifecycle.configure(native(base));
  lifecycle.message({sessionID:base.hostSessionId});
  lifecycle.compacting({sessionID:base.hostSessionId});
  assert.throws(()=>lifecycle.beforeTool(tool()),{code:'memory_lifecycle_unavailable'});
  assert.deepEqual(calls,['resume']);
  lifecycle.autoContinue({sessionID:base.hostSessionId});
  lifecycle.event(compacted());
  lifecycle.beforeTool(tool());
  assert.deepEqual(calls,['resume','compaction']);
  lifecycle.compacting({sessionID:base.hostSessionId});
  lifecycle.event(compacted());
  lifecycle.beforeTool(tool());
  assert.deepEqual(calls,['resume','compaction','compaction']);
});

test('other sessions and unrelated events cannot complete a pending compaction',()=>{
  const base=config(),calls=[],lifecycle=createMemoryOpencodeLifecycle(base,reason=>calls.push(reason));
  lifecycle.configure(native(base));
  lifecycle.compacting({sessionID:base.hostSessionId});
  lifecycle.autoContinue({sessionID:'another-chat'});
  lifecycle.event(compacted('another-chat'));
  lifecycle.event({event:{type:'session.error',properties:{sessionID:base.hostSessionId}}});
  assert.throws(()=>lifecycle.beforeTool(tool()),{code:'memory_lifecycle_unavailable'});
  assert.deepEqual(calls,['resume']);
});

test('unobserved bus reset failure remains fail closed without rejecting the fire-and-forget event',()=>{
  const base=config(),lifecycle=createMemoryOpencodeLifecycle(base,()=>{throw Error('synthetic failure');});
  lifecycle.configure(native(base));
  assert.doesNotThrow(()=>lifecycle.event(compacted()));
  assert.throws(()=>lifecycle.beforeTool(tool()),{code:'memory_lifecycle_unavailable'});
  assert.doesNotThrow(()=>lifecycle.beforeTool(tool('another-chat','unrelated_tool')));
});

test('missing or mismatched native MCP configuration cannot silently share a checkpoint',()=>{
  for(const value of [{},{mcp:{tsp_memory:{type:'remote'}}},native({...config(),memorySession:'other-memory'}),native({...config(),memberHome:process.cwd()})]) {
    const lifecycle=createMemoryOpencodeLifecycle(config(),()=>{});
    assert.throws(()=>lifecycle.configure(value),{code:'memory_session_mismatch'});
    assert.throws(()=>lifecycle.beforeTool(tool()),{code:'memory_lifecycle_unavailable'});
  }
  const lifecycle=createMemoryOpencodeLifecycle(config(),()=>{});
  assert.throws(()=>lifecycle.beforeTool(tool()),{code:'memory_lifecycle_unavailable'});
});

test('native plugin validates workspace and invokes fixed CLI argv without forwarding provider credentials',async()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'tsp-opencode-lifecycle-'));
  const cliPath=path.join(directory,'fixed-cli.mjs'),log=path.join(directory,'calls.json');
  const previous=process.env.TSP_EVAL_GATEWAY_TOKEN;
  const originalNodePath=process.execPath;
  try {
    process.env.TSP_EVAL_GATEWAY_TOKEN='synthetic-secret-not-for-cli';
    writeFileSync(cliPath,"import fs from 'node:fs';fs.writeFileSync("+JSON.stringify(log)+",JSON.stringify({args:process.argv.slice(2),home:process.env.AGENTCTL_HOME,key:process.env.TSP_EVAL_GATEWAY_TOKEN??null}));console.log(JSON.stringify({ok:true}));");
    const base={...config(),cliPath,memberHome:directory,nodePath:originalNodePath};
    const hooks=await plugin.server({directory:process.cwd()},base);
    await hooks.config(native(base));
    process.execPath=path.join(directory,'opencode-bun-host.exe');
    try { await hooks['chat.message']({sessionID:base.hostSessionId},{}); }
    finally { process.execPath=originalNodePath; }
    assert.deepEqual(JSON.parse(readFileSync(log,'utf8')),{args:['memory','context','reset','--session',base.memorySession,'--reason','resume'],home:directory,key:null});
    await assert.rejects(plugin.server({directory},base),{code:'memory_workspace_mismatch'});
    assert.equal(plugin.id,'team-synergy-memory-lifecycle');
    assert.equal('tool' in hooks,false);
  }finally {
    process.execPath=originalNodePath;
    if(previous===undefined)delete process.env.TSP_EVAL_GATEWAY_TOKEN;else process.env.TSP_EVAL_GATEWAY_TOKEN=previous;
    assert.equal(path.dirname(directory),path.resolve(tmpdir()));
    assert.match(path.basename(directory),/^tsp-opencode-lifecycle-[a-zA-Z0-9]+$/u);
    rmSync(directory,{recursive:true,force:true});
  }
});

test('invalid names, relative paths and unexpected config cannot become native routing inputs',()=>{
  for(const changes of [{hostSessionId:'bad session'},{memorySession:'../other'},{cwd:'relative'},{cliPath:''},{nodePath:''},{nodePath:'relative'},{extra:true}]) {
    assert.throws(()=>createMemoryOpencodeLifecycle({...config(),...changes}),{code:'memory_lifecycle_invalid'});
  }
});
