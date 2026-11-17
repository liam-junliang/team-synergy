import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { projectNextMemory, searchMemoryEngine } from '../dist/memory-engines.js';
import { createMemorySliceUseCases } from '@team-synergy/application';
import { buildServer } from '../dist/server.js';

const json = async file => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/,''));

export async function withScratchMemoryEngines(db, {projectCode,aliceCode,bobCode}, work) {
  const database = await db.$client.query('select current_database() as name');
  assert.match(database.rows[0].name, /^tsp_memory_live_[0-9a-f]{24}$/);
  const hub = resolve(process.env.TSP_PILOT_HUB || 'F:/workspace/team-knowledge-hub');
  const runtime = resolve(process.env.TSP_PILOT_RUNTIME || 'F:/workspace/team-knowledge-runtime');
  const source = await json(resolve(hub,'config/live.json'));
  const profiles = {
    tencent: await json(resolve(runtime,'tencent/deployment.json')),
    viking: await json(resolve(runtime,'openviking/deployment.json')),
  };
  const {attestTarget,checkOpenVikingOwnership} = await import(pathToFileURL(resolve(hub,'scripts/setup-teamsynergy-study.mjs')));
  await attestTarget({runtime,profiles},'tencent');
  await checkOpenVikingOwnership({runtime,profiles});
  assert.equal(source.tencent.knowledgeBaseUrl, profiles.tencent.knowledgeBaseUrl);
  assert.equal(source.openviking.baseUrl, profiles.viking.baseUrl);
  const study = await json(resolve(runtime,'hub/teamsynergy-study/deployment.json'));
  const mapping = source.projects.teamsynergy;
  assert.deepEqual(mapping, study.mapping);
  const account = name => {
    const entry = source.accounts[name];
    assert.equal(entry.openVikingUserId,profiles.viking.accounts[name].userId);
    return {userId:entry.openVikingUserId,apiKey:entry.openVikingApiKey};
  };
  const alice = account('alice'), bob = account('bob');
  assert.notEqual(alice.userId,bob.userId);
  const wiki = async (op, body) => {
    const response = await fetch(source.tencent.knowledgeBaseUrl.replace(/\/$/,'')+'/wiki/'+op,{
      method:'POST',headers:{'content-type':'application/json','authorization':'Bearer '+source.tencent.token,
        'x-tdai-service-id':source.tencent.serviceId},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(10000),
    });
    assert.ok(response.ok, op+' HTTP '+response.status);
    const env = await response.json();
    assert.equal(env.code,0, op+' rejected');
    return {data:env.data,status:response.status};
  };
  const wikiName = 'tsp-memory-'+projectCode;
  const refs = {team_id:mapping.tencentTeamId,user_id:mapping.tencentOwnerUserId};
  const created = await wiki('create',{...refs,name:wikiName});
  assert.equal(created.status,201);
  const wikiId = created.data.wiki_id;
  const checkWiki = async () => {
    const {data} = await wiki('get',{wiki_id:wikiId});
    assert.ok(data.wiki_id===wikiId && data.team_id===refs.team_id && data.name===wikiName);
  };
  assert.ok(wikiId && created.data.name===wikiName && created.data.team_id===refs.team_id);
  const cfg = {tencent:{token:source.tencent.token,serviceId:source.tencent.serviceId,baseUrl:source.tencent.knowledgeBaseUrl},openviking:{baseUrl:source.openviking.baseUrl},
    projects:{[projectCode]:{teamId:refs.team_id,userId:refs.user_id,wikiId}}, accounts:{[aliceCode]:alice,[bobCode]:bob}};
  try {
    await checkWiki();
    return await work({cfg, wiki, wikiId, refs, checkWiki, alice, bob, profiles, mapping, runtime});
  } finally {
    await checkWiki();
    assert.deepEqual((await wiki('delete',{wiki_ids:[wikiId]})).data.deleted_ids,[wikiId]);
  }
}

export async function verifyProjections(db, { projectCode, aliceCode, bobCode, aliceToken, bobToken }) {
  return withScratchMemoryEngines(db,{projectCode,aliceCode,bobCode},async ({cfg,wiki,wikiId,refs,checkWiki,alice,bob})=>{
    const actor = {projectCode,principalCode:bobCode};
    const base = cfg.openviking.baseUrl.replace(/\/$/,'')+'/api/v1/';
    const rows = (await db.$client.query(`select f.code,f.state,f.text,u.code as owner from memory_fragments f
      join memory_capture_receipts r on r.id=f.receipt_id join users u on u.id=r.principal_id
      join projects p on p.id=r.project_id where p.code=$1`,[projectCode])).rows;
    const privateRow = rows.find(r=>r.state==='preference');
    assert.ok(privateRow && privateRow.owner===aliceCode);
    const uri = 'viking://user/'+alice.userId+'/memories/preferences/team-synergy/'+privateRow.code+'.json';
    const ov = (who, path, method='GET') => fetch(base+path,{method,headers:{'x-api-key':who.apiKey},redirect:'error',signal:AbortSignal.timeout(12000)});
    const read = who => ov(who,'content/read?uri='+encodeURIComponent(uri));
    let ownsPersonal = false;
    try {
      await checkWiki();
      assert.equal((await read(alice)).status,404);
      ownsPersonal = true;
      const discussed = rows.find(row=>row.state==='discussed');
      const summaryPath = 'wiki/sources/tsp-'+discussed.code+'.md';
      const summary = '---\ntype: source\nlocked: true\n---\n\n# 既有摘要\n';
      await wiki('page/write',{...refs,wiki_id:wikiId,pages:[{ref:summaryPath,content:summary}]});
      const deadline = Date.now()+240_000;
      let synced = 0;
      while (synced < rows.length && Date.now() < deadline) {
        const delivery = await projectNextMemory(db,cfg);
        if (!delivery || delivery.code === 'wiki_ingesting' || delivery.code === 'wiki_index_pending') {
          await delay(1000);
          continue;
        }
        assert.equal(delivery?.status,'synced','Unverified projection '+JSON.stringify(delivery));
        synced++;
      }
      assert.equal(synced,rows.length,'Outbox did not drain within four minutes');
      assert.equal(await projectNextMemory(db,cfg),null);
      const {rows:jobs} = await db.$client.query('select id,engine,external_ref from memory_projection_jobs order by id');
      const shared = jobs.filter(j=>j.engine==='tencent');
      const personal = jobs.filter(j=>j.engine==='openviking');
      assert.equal(shared.length,2);
      assert.equal((await wiki('page/read',{wiki_id:wikiId,refs:[summaryPath]})).data.items[0].content,summary);
      assert.deepEqual(personal.map(j=>j.external_ref),[uri]);
      const raw = (await wiki('raw/ls',{wiki_id:wikiId})).data.items;
      assert.equal(raw.length,2);
      const texts = (await wiki('raw/read',{wiki_id:wikiId,filenames:raw.map(x=>x.filename)})).data.items.map(x=>x.content);
      assert.ok(texts.every(t=>t.includes('退款') && !/Git|提交说明|我习惯/u.test(t)));
      assert.equal(JSON.parse((await (await read(alice)).json()).result).text,privateRow.text);
      assert.equal((await read(bob)).status,403);
      const hits = await searchMemoryEngine(cfg,actor,'退款','project');
      assert.ok(hits.some(ref=>shared.some(job=>job.external_ref===ref)), 'Chinese native Wiki search missed both confirmed and discussed sources');
      const memory = createMemorySliceUseCases(db);
      const viaEngine = await memory.search({...actor,query:'nonliteral-probe',scope:'project',engineRefs:hits});
      assert.ok(viaEngine.length && viaEngine.every(row=>row.scope==='project'));
      assert.deepEqual(await memory.search({...actor,query:'nonliteral-probe',engineRefs:[uri]}),[]);
      const ovHits = await searchMemoryEngine(cfg,{projectCode,principalCode:aliceCode},privateRow.text,'personal');
      assert.ok(ovHits.includes(uri),'OpenViking native query missed the owner preference');
      assert.ok(aliceToken && bobToken);
      const dir = await mkdtemp(resolve(tmpdir(),'tsp-memory-engines-'));
      const file = resolve(dir,'engines.json');
      try {
        await writeFile(file,JSON.stringify(cfg),{mode:0o600,flag:'wx'});
        const app = await buildServer({db,logger:false,memoryEnginesFile:file});
        try {
          const url = await app.listen({host:'127.0.0.1',port:0});
          const find = async (token,query,scope) => {
            const result = await fetch(url+'/projects/'+projectCode+'/memory?'+new URLSearchParams({query,scope}),{headers:{authorization:'Bearer '+token}});
            assert.equal(result.status,200);
            assert.equal(result.headers.get('X-TSP-Memory-Retrieval'),'engine-and-platform');
            return (await result.json()).data;
          };
          const indirect = await find(bobToken,'超过七天时怎样处理退款申请','project');
          assert.ok(indirect.some(hit=>hit.state==='confirmed' && hit.scope==='project'));
          const accountHits = await find(aliceToken,'这个项目应该用什么语言写 Git 的提交说明','personal');
          assert.ok(accountHits.some(hit=>hit.source===privateRow.code));
          assert.deepEqual(await find(bobToken,'Git','personal'),[]);
        } finally { await app.close(); }
      } finally { await unlink(file).catch(e=>{if(e.code!=='ENOENT') throw e;}); await rmdir(dir); }
      // Simulate process death after external write and before PG acknowledgment.
      await db.$client.query("update memory_projection_jobs set status='processing',lease_until=now()-interval '1 second' where id=$1",[shared[0].id]);
      const version = (await wiki('get',{wiki_id:wikiId})).data.version;
      assert.equal((await projectNextMemory(db,cfg)).status,'synced');
      assert.equal((await wiki('get',{wiki_id:wikiId})).data.version,version);
      return {wikiRaw:raw.length,wikiChineseHits:hits.length,ownerPrivateRead:true,foreignPrivateRead:403,
        openVikingQueryHit:ovHits.includes(uri),httpScopedRecall:true,recoveredWithoutRewrite:true};
    } finally {
      if (ownsPersonal) {
        const response = await read(alice);
        if (response.ok) {
          const file = JSON.parse((await response.json()).result);
          assert.ok(file.source===privateRow.code && file.text===privateRow.text);
          const deleted = await ov(alice,'fs?uri='+encodeURIComponent(uri)+'&recursive=false&wait=true','DELETE');
          assert.ok(deleted.ok,'Deleting own scratch preference: '+deleted.status);
          assert.equal((await read(alice)).status,404);
        } else assert.equal(response.status,404);
      }
    }
  });
}
