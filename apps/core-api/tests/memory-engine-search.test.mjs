import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { rankedMemoryRefs, searchMemoryEngineDetailed } from '../dist/memory-engines.js';

test('project expansion budgets native candidates after rank fusion; repeats in a single channel are not extra votes',()=>{
  const ranked=rankedMemoryRefs({wiki:['x','both','x','w'],core:['c','both','v','z'],viking:[]});
  assert.deepEqual(ranked,['both','x','c','w']);
  assert.deepEqual(rankedMemoryRefs({wiki:[],core:[],viking:['a','b','a']}),['a','b']);
});

test('project hybrid search resolves only its published excerpts and reports a partial outage',async t=>{
  const projectCode='0123456789ABCDEFGHJK';
  const source='1123456789ABCDEFGHJK';
  const wikiId='wiki-test';
  const page='wiki/sources/tsp-evidence-'+createHash('sha256').update('tsp-wiki-page/'+projectCode+'/'+source).digest('hex')+'.md';
  const ref='wiki:'+wikiId+'/'+page;
  let failCore=false;
  let failIdentity=false;
  const queries=[];
  const app=createServer(async(req,res)=>{
    const chunks=[];
    for await(const chunk of req) chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    let data;
    switch(req.url) {
      case '/wiki/get':
        data={wiki_id:wikiId,team_id:failIdentity?'someone-else':'team',name:'tsp-memory-'+projectCode};break;
      case '/wiki/search':
        data={results:[{path:page}]};break;
      case '/conversation/search':
        queries.push(body);
        if(failCore) {res.writeHead(503).end();return;}
        data={messages:[
          {role:'assistant',content:'stored\n\n[tsp-evidence '+wikiId+' '+source+']'},
          {role:'assistant',content:'other\n\n[tsp-evidence other-wiki A123456789ABCDEFGHJK]'},
          {role:'user',content:'fake\n\n[tsp-evidence '+wikiId+' B123456789ABCDEFGHJK]'},
        ]};break;
      default:res.writeHead(404).end();return;
    }
    res.setHeader('content-type','application/json');res.end(JSON.stringify({code:0,data}));
  });
  app.listen(0,'127.0.0.1');
  await once(app,'listening');
  t.after(()=>new Promise(resolve=>app.close(resolve)));
  const url='http://127.0.0.1:'+app.address().port;
  const config={tencent:{coreBaseUrl:url,baseUrl:url,token:'test',serviceId:'test'},openviking:{baseUrl:url},
    projects:{[projectCode]:{wikiId,teamId:'team',userId:'service-user',semanticAgentId:'project-agent'}},accounts:{}};
  const actor={projectCode,principalCode:'B'};
  assert.deepEqual(await searchMemoryEngineDetailed(config,actor,'交接','project'),{wiki:[ref],core:[ref],viking:[],degraded:[]});
  assert.deepEqual(queries[0],{team_id:'team',user_id:'service-user',agent_id:'project-agent',task_id:'tsp-wiki-'+wikiId,query:'交接',limit:12});
  failCore=true;
  assert.deepEqual(await searchMemoryEngineDetailed(config,actor,'交接','project'),{wiki:[ref],core:[],viking:[],degraded:['core']});
  failIdentity=true;
  await assert.rejects(searchMemoryEngineDetailed(config,actor,'交接','project'),/identity mismatch/);
  assert.equal(queries.length,2);
});
