import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm, utimes, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { createSystemAgentRuntime } from '../dist/system-agent-runtime.js';

const input = { jobCode: 'JOB', document: { code: 'DOC', revision: 1, title: 'Title', content: '# Body' }, instruction: 'Clarify' };
async function fixture(behavior = 'success', keep = '0') {
  const directory = await mkdtemp(join(tmpdir(), 'team-synergy-d03-'));
  const install = join(directory, 'install'), root = join(directory, 'work');
  await mkdir(join(install, 'lib'), { recursive: true });
  await writeFile(join(install, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.1-rc.2' }));
  await writeFile(join(install, 'lib', 'bin.js'), `
    const fs = require('node:fs');
    fs.writeFileSync(require('node:path').join(process.env.HOME, 'session.json'), 'SENSITIVE-PROMPT '+process.env.DEEPSEEK_API_KEY);
    fs.writeFileSync(require('node:path').join(process.cwd(), 'started'), 'started');
    const send = frame => process.stdout.write(JSON.stringify(frame)+'\\n');
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      const r=JSON.parse(line); if(r.method==='shutdown') return;
      if(${JSON.stringify(behavior)}==='timeout') return;
      if(${JSON.stringify(behavior)}==='failure') { process.stdout.write('invalid\\n'); return; }
      if(r.method==='initialize') return send({jsonrpc:'2.0',id:r.id,result:{serverInfo:{name:'deepseek-harness-sdk-runtime'}}});
      const sessionId=r.params.sessionId;
      const event=(type,data)=>send({jsonrpc:'2.0',method:'session.event',params:{sessionId,event:{type,data}}});
      send({jsonrpc:'2.0',id:r.id,result:{messageId:'m'}});
      event('agent/inbox/spliced',{inserted:[{id:'m'}]});
      event('assistant/message',{message:{content:[{type:'text',text:JSON.stringify({title:'Draft',summary:'',content:'# Draft',rationale:'Clarified',evidence:[],warnings:[]})}]}});
      event('turn/end',{reason:{kind:'completed'}});
      send({jsonrpc:'2.0',method:'session.status',params:{sessionId,status:'idle'}});
    });
  `);
  const env = { TSP_SYSTEM_AGENT_ENABLED:'true', TSP_SYSTEM_AGENT_DSH_BIN:join(install,'lib','bin.js'),
    TSP_SYSTEM_AGENT_WORKSPACE_ROOT:root, TSP_SYSTEM_AGENT_API_KEY:'fixture-private-key',
    TSP_SYSTEM_AGENT_TIMEOUT_MS:'1000', TSP_SYSTEM_AGENT_RETAIN_FAILED_RUNS:keep };
  return { directory, root, env, runtime:createSystemAgentRuntime(env), async remove() {
    const path=relative(resolve(tmpdir()),resolve(directory)); assert.ok(path&&!path.startsWith('..')&&!isAbsolute(path));
    await rm(directory,{recursive:true,force:true});
  } };
}

test('generation removes engine home/workspace/tmp on success, failure, timeout and cancellation', async () => {
  for (const behavior of ['success','failure','timeout','cancel']) {
    const ctx=await fixture(behavior==='cancel'?'timeout':behavior);
    try {
      const controller=new AbortController();
      const pending=ctx.runtime.generate(input,{signal:controller.signal});
      if(behavior==='cancel') setTimeout(()=>controller.abort(),150);
      if(behavior==='success') assert.equal((await pending).title,'Draft');
      else await assert.rejects(pending, error=>error.code===({failure:'protocol_error',timeout:'timeout',cancel:'cancelled'}[behavior]));
      assert.deepEqual(await readdir(ctx.root),[],behavior);
    } finally { await ctx.remove(); }
  }
});

test('failure retention is bounded and contains only safe diagnostic summaries', async () => {
  const ctx=await fixture('failure','2');
  try {
    for(let i=0;i<3;i++) await assert.rejects(ctx.runtime.generate(input),{code:'protocol_error'});
    const dirs=await readdir(ctx.root); assert.equal(dirs.length,2);
    for(const dir of dirs) {
      assert.deepEqual(await readdir(join(ctx.root,dir)),['failure.json']);
      const content=await readFile(join(ctx.root,dir,'failure.json'),'utf8');
      assert.equal(JSON.parse(content).code,'protocol_error');
      for(const secret of ['fixture-private-key','SENSITIVE-PROMPT',input.instruction]) assert.ok(!content.includes(secret));
    }
    await createSystemAgentRuntime({...ctx.env,TSP_SYSTEM_AGENT_RETAIN_FAILED_RUNS:'0'}).cleanup();
    assert.deepEqual(await readdir(ctx.root),[]);
  } finally { await ctx.remove(); }
});

test('startup cleanup skips live runs, unrelated directories and symlinks; removes stale owned and legacy runs while disabled', async () => {
  const ctx=await fixture();
  try {
    await mkdir(ctx.root);
    const old=new Date(Date.now()-25*60*60*1000);
    async function owned(name,pid) {
      const path=join(ctx.root,name); await mkdir(path);
      await writeFile(join(path,'owner.json'),JSON.stringify({version:1,pid})); await utimes(path,old,old); return path;
    }
    await owned('draft-OLD001',2147483647);
    await owned('draft-LIVE01',process.pid);
    const activeChild=await owned('draft-CHILD1',2147483647);
    await writeFile(join(activeChild,'owner.json'),JSON.stringify({version:1,pid:2147483647,child_pid:process.pid}));
    await utimes(activeChild,old,old);
    const legacy=join(ctx.root,'draft-LEGACY'); await mkdir(legacy);
    for(const dir of ['home','workspace','tmp']) await mkdir(join(legacy,dir));
    for(const file of ['no-tools.mjs','document-draft.patch.yml']) await writeFile(join(legacy,file),'');
    await utimes(legacy,old,old);
    await mkdir(join(ctx.root,'draft-OTHER1')); await utimes(join(ctx.root,'draft-OTHER1'),old,old);
    await mkdir(join(ctx.directory,'outside'));
    await writeFile(join(ctx.directory,'outside','keep'),'safe');
    await symlink(join(ctx.directory,'outside'),join(ctx.root,'draft-LINK01'),'junction');
    await createSystemAgentRuntime({TSP_SYSTEM_AGENT_WORKSPACE_ROOT:ctx.root}).cleanup();
    assert.deepEqual((await readdir(ctx.root)).sort(),['draft-CHILD1','draft-LINK01','draft-LIVE01','draft-OTHER1']);
    assert.equal(await readFile(join(ctx.directory,'outside','keep'),'utf8'),'safe');
    const unsafe=join(ctx.directory,'unsafe-root'); await symlink(join(ctx.directory,'outside'),unsafe,'junction');
    await assert.rejects(createSystemAgentRuntime({TSP_SYSTEM_AGENT_WORKSPACE_ROOT:unsafe}).cleanup(),{code:'not_configured'});
  } finally { await ctx.remove(); }
});
