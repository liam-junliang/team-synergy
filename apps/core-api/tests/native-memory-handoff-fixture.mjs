import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { createMemorySliceUseCases } from '@team-synergy/application';
import * as engines from '../dist/memory-engines.js';
import { buildServer } from '../dist/server.js';
import { invoke, withNativeMemoryProject } from './native-memory-live.mjs';
import { withScratchMemoryEngines } from './native-memory-engines.mjs';

const digest = text => createHash('sha256').update(text).digest('hex');
const originalName = entry => 'tsp-'+entry.fragmentCode+'-'+entry.sha256+'.md';

async function seedSources(f, corpus) {
  const memory = createMemorySliceUseCases(f.db);
  const sources = [...corpus.sources, {
    id:'alice-private-control', title:'Private isolation control', scope:'personal', owner:'alice',
    text:'仅我的私有隔离校验记号是榆树铜牌。此条是实验控制材料。',
  }];
  assert.ok(new Set(sources.map(row=>row.id)).size === sources.length);
  const result = [];
  for (const entry of sources) {
    const owner = entry.owner ?? (entry.scope === 'personal' ? 'bob' : 'alice');
    assert.ok(['personal','project'].includes(entry.scope) && ['alice','bob'].includes(owner));
    const actor = {projectCode:f.projectCode, principalCode:f[owner].code,
      topicCode:f.topicCode, requirementCode:f.requirementCode};
    const binding = await memory.inspect(actor);
    const receipt = await memory.capture({...actor,...binding,sessionId:'historical-evidence-import',
      eventId:entry.id,sourceText:entry.text,parts:[{kind:entry.scope === 'personal' ? 'preference' : 'discussion',text:entry.text}]});
    assert.equal(receipt.items.length,1);
    const item = receipt.items[0];
    assert.ok(item.text===entry.text && item.scope===entry.scope);
    const stored = await f.db.$client.query(`select f.code from memory_fragments f join memory_capture_receipts r on r.id=f.receipt_id
      where r.code=$1`,[receipt.receiptCode]);
    assert.equal(stored.rowCount,1);
    result.push({...entry,owner,source:item.source,fragmentCode:stored.rows[0].code,sha256:digest(entry.text)});
  }
  return result;
}

async function nativeSearch(url, f, query, scope) {
  const response = await fetch(url+f.root+'/memory/search',{method:'POST',redirect:'error',
    headers:{authorization:'Bearer '+f.bob.token,'content-type':'application/json'},
    body:JSON.stringify({query,scope}),signal:AbortSignal.timeout(30000)});
  assert.equal(response.status,200);
  const envelope = await response.json();
  assert.equal(envelope.ok,true);
  return {sources:envelope.data.map(row=>row.source),header:response.headers.get('x-tsp-memory-retrieval')};
}

async function createMember(f, base, dir, workDir) {
  const root = await realpath(dir);
  const location = path.resolve(workDir);
  const rel = path.relative(root,location);
  assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel),'Member workspace must be inside the isolated fixture');
  await mkdir(location,{recursive:true,mode:0o700});
  assert.equal(await realpath(location),location);
  const member = {code:f.bob.code,home:path.join(location,'device'),cwd:path.join(location,'work'),codexHome:path.join(location,'session')};
  for (const folder of [member.home,member.cwd,member.codexHome]) await mkdir(folder,{mode:0o700});
  const login = JSON.parse(await readFile(path.join(f.bob.home,'auth.json'),'utf8'));
  assert.equal(login.device_token,f.bob.token);
  await writeFile(path.join(member.home,'auth.json'),JSON.stringify({...login,api_url:base}),{mode:0o600,flag:'wx'});
  assert.equal((await invoke(member,['project','bind',f.projectCode])).ok,true);
  return member;
}

function privateDocument(cfg, account, entry) {
  const uri = 'viking://user/'+account.userId+'/memories/preferences/team-synergy/'+entry.fragmentCode+'.json';
  const base = cfg.openviking.baseUrl.replace(/\/$/,'')+'/api/v1/';
  const call = (operation,who=account,method='GET') => fetch(base+operation+encodeURIComponent(uri),{
    headers:{'x-api-key':who.apiKey},method,redirect:'error',signal:AbortSignal.timeout(15_000)});
  const read = who => call('content/read?uri=',who);
  const verify = async () => {
    const response = await read();
    if (response.status === 404) return false;
    assert.equal(response.status,200);
    const file = JSON.parse((await response.json()).result);
    assert.ok(file.source===entry.fragmentCode && file.text===entry.text,'Private source identity changed');
    return true;
  };
  return {read,verify,async cleanup() {
    if (!await verify()) return;
    const deleted = await call('fs?recursive=false&wait=true&uri=',account,'DELETE');
    assert.ok(deleted.ok);
    assert.equal((await read()).status,404);
  }};
}

function coreDocument(cfg, project, entry) {
  const ids = {team_id:project.teamId,user_id:project.userId,agent_id:project.semanticAgentId,
    task_id:'tsp-wiki-'+project.wikiId,session_id:'tsp-'+project.wikiId+'-'+entry.fragmentCode};
  const expected = entry.text+'\n\n[tsp-evidence '+project.wikiId+' '+entry.fragmentCode+']';
  const call = async (op,body) => {
    const response = await fetch(cfg.tencent.coreBaseUrl.replace(/\/$/,'')+'/conversation/'+op,{
      method:'POST',headers:{authorization:'Bearer '+cfg.tencent.token,'x-tdai-service-id':cfg.tencent.serviceId,
        'x-tdai-session-id':ids.session_id,'content-type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(15_000)});
    assert.equal(response.status,200);
    const envelope = await response.json();
    assert.equal(envelope.code,0);
    return envelope.data;
  };
  const verified = async () => {
    const data = await call('query',{...ids,limit:100});
    assert.equal(data.total,data.messages.length,'Truncated scratch session');
    for (const row of data.messages) {
      assert.ok(Object.entries(ids).every(([key,val])=>row[key]===val),'Core record outside scratch session');
      assert.ok(typeof row.id==='string' && row.content===expected && row.role==='assistant','Core source identity changed');
    }
    return data.messages;
  };
  return {verified,async cleanup() {
    const records = await verified();
    if (!records.length) return;
    const removed = await call('delete',{...ids,message_ids:records.map(row=>row.id)});
    assert.equal(removed.deleted_count,records.length);
    assert.equal((await verified()).length,0);
    return records.map(row=>row.id);
  }};
}

async function projectSources(db,cfg,sources) {
  const deadline = Date.now()+Math.max(300_000,120_000*sources.length);
  let synced = 0;
  while (synced<sources.length && Date.now()<deadline) {
    const job = await engines.projectNextMemory(db,cfg);
    if (!job || ['wiki_ingesting','wiki_index_pending'].includes(job.code)) {
      await delay(1000);
      continue;
    }
    assert.equal(job.status,'synced','Source projection failed: '+JSON.stringify(job));
    synced++;
  }
  assert.equal(synced,sources.length,'Source projection deadline exceeded');
  const stored = await db.$client.query(`select j.external_ref,f.code from memory_projection_jobs j
    join memory_fragments f on f.id=j.fragment_id where j.status='synced'`);
  assert.equal(stored.rowCount,sources.length);
  return new Map(stored.rows.map(row=>[row.external_ref,sources.find(entry=>entry.fragmentCode===row.code).source]));
}

function openVectorStore(runtime) {
  const vectorFile = path.join(runtime,'tencent/data/core/vectors.db');
  const module = createRequire(path.join(runtime,'tencent/source/MemoryCore/package.json'))('sqlite-vec');
  const store = new DatabaseSync(vectorFile,{readOnly:true,allowExtension:true});
  try {store.loadExtension(module.getLoadablePath());} catch (error) {store.close(); throw error;}
  return store;
}

async function verifyVectorStorage(runtime, cfg, project, expected) {
  const healthResponse = await fetch(new URL('/health',cfg.tencent.coreBaseUrl),{redirect:'error',signal:AbortSignal.timeout(5000)});
  assert.equal(healthResponse.status,200);
  const health = await healthResponse.json();
  assert.equal(health.stores?.embeddingService,true);
  const store = openVectorStore(runtime);
  try {
    // Validate this tenant's exact rows; retrieval itself always goes through the native API.
    const check = store.prepare(`select l.session_id,length(v.embedding) as bytes from l0_conversations l
      inner join l0_vec v on v.record_id=l.record_id where l.team_id=? and l.user_id=? and l.agent_id=?
      and l.task_id=? and l.role='assistant'`);
    for (let i=0;i<25;i++) {
      const rows=check.all(project.teamId,project.userId,project.semanticAgentId,'tsp-wiki-'+project.wikiId);
      if (rows.length===expected.length) {
        assert.deepEqual(rows.map(row=>row.session_id).sort(),expected.map(entry=>'tsp-'+project.wikiId+'-'+entry.fragmentCode).sort());
        const dimensions=[...new Set(rows.map(r=>r.bytes/4))];
        assert.equal(dimensions.length,1);
        assert.ok(Number.isInteger(dimensions[0]) && dimensions[0]>0);
        return {rows:rows.length,dimensions:dimensions[0],embeddingService:true};
      }
      await delay(400);
    }
    throw Error('Pending or missing native Tencent vector rows');
  } finally {store.close();}
}

// The same database and device serve both conditions. Tokens and engine keys stay outside the agent-visible memory corpus.
export async function withHandoffFixture(corpus, work) {
  process.env.ACP_ALLOW_LEGACY_IDENTITY = '0';
  process.env.TSP_MEMORY_ENABLED = '1';
  assert.ok(corpus.sources.some(r=>r.scope==='project') && corpus.sources.some(r=>r.scope==='personal'));
  const subject = {project:'TeamSynergy 缺陷交接验证',feature:'TeamSynergy', topic:corpus.title ?? '开发缺陷交接资料',
    requirement:'交接的历史来源',body:'归档来源保留其原始提交与文件定位。',criterion:'每条事实可指向其原始来源。'};
  return withNativeMemoryProject(subject,async (f,{dir,api:off})=>{
    const sources = await seedSources(f,corpus);
    return withScratchMemoryEngines(f.db,{projectCode:f.projectCode,aliceCode:f.alice.code,bobCode:f.bob.code},
      async ({cfg,wiki,wikiId,checkWiki,alice,bob,mapping,profiles,runtime})=>{
        cfg.tencent.coreBaseUrl=profiles.tencent.coreBaseUrl;
        const project = cfg.projects[f.projectCode];
        assert.equal(mapping.memberAgents.alice.userId,project.userId);
        project.semanticAgentId=mapping.memberAgents.alice.agentId;
        const privateDocs = new Map();
        const coreDocs = new Map();
        const owned = [];
        try {
          for (const entry of sources) {
            if (entry.scope==='personal') {
              const doc = privateDocument(cfg,entry.owner==='bob'?bob:alice,entry);
              assert.equal((await doc.read()).status,404,'Refusing to overwrite an existing private file');
              privateDocs.set(entry.source,doc);
              owned.push(doc);
            } else {
              const doc = coreDocument(cfg,project,entry);
              assert.equal((await doc.verified()).length,0,'Refusing to reuse an existing core session');
              coreDocs.set(entry.source,doc);
              owned.push(doc);
            }
          }
          // Stage the immutable originals into this empty, dedicated Wiki so its
          // first production projection can ingest the corpus in one generation.
          // Workers still reconcile every byte, write each indexed page/Core row,
          // and acknowledge every PG outbox job through the normal entry point.
          const shared = sources.filter(entry=>entry.scope==='project');
          await checkWiki();
          assert.deepEqual((await wiki('raw/ls',{wiki_id:wikiId})).data.items,[]);
          const files = shared.map(entry=>({filename:originalName(entry),content:entry.text,encoding:'utf8'}));
          for (let start=0;start<files.length;start+=10) {
            await wiki('raw/write',{wiki_id:wikiId,team_id:project.teamId,user_id:project.userId,files:files.slice(start,start+10)});
          }
          const refs = await projectSources(f.db,cfg,sources);
          for (const entry of sources.filter(row=>row.scope==='personal')) {
            const doc = privateDocs.get(entry.source);
            assert.equal(await doc.verify(),true);
            assert.equal((await doc.read(entry.owner==='alice'?bob:alice)).status,403);
          }
          for (const doc of coreDocs.values()) assert.equal((await doc.verified()).length,1,'Core vector source missing');
          const tencentVectors = await verifyVectorStorage(runtime,cfg,project,shared);
          const raw = (await wiki('raw/ls',{wiki_id:wikiId})).data.items;
          assert.equal(raw.length,shared.length);
          for (const entry of shared) {
            const filename = originalName(entry);
            const text = (await wiki('raw/read',{wiki_id:wikiId,filenames:[filename]})).data.items[0]?.content;
            assert.ok(typeof text==='string' && digest(text)===entry.sha256,'Wiki source hash mismatch');
          }
          const configFile=path.join(dir,'engines.json');
          await writeFile(configFile,JSON.stringify(cfg),{flag:'wx',mode:0o600});
          const app = await buildServer({db:f.db,logger:false,memoryEnginesFile:configFile});
          try {
            const on = await app.listen({host:'127.0.0.1',port:0});
            const control = sources.find(row=>row.id==='alice-private-control');
            for (const origin of [off,on]) {
              const unseen=await nativeSearch(origin,f,'榆树铜牌','personal');
              assert.ok(!unseen.sources.includes(control.source));
            }
            const traceSearch = async ({query,scope}) => {
              const lexical = await nativeSearch(off,f,query,scope);
              const merged = await nativeSearch(on,f,query,scope);
              assert.equal(lexical.header,'platform');
              if (!scope) return {engine:null,engineSources:[],lexicalSources:lexical.sources,mergedSources:merged.sources,
                lexicalHeader:lexical.header,mergedHeader:merged.header,channelSources:{}};
              assert.ok(scope==='project' || scope==='personal');
              const actor={projectCode:f.projectCode,principalCode:f.bob.code};
              const hits = await engines.searchMemoryEngineDetailed(cfg,actor,query,scope);
              const channelSources = {};
              for (const name of ['wiki','core','viking']) {
                channelSources[name] = [...new Set(hits[name].map(ref=>refs.get(ref)).filter(source=>source && merged.sources.includes(source)))];
              }
              return {engine:scope==='project'?'tencent':'openviking',engineSources:[...new Set(Object.values(channelSources).flat())],
                channelSources,degraded:hits.degraded,lexicalSources:lexical.sources,mergedSources:merged.sources,lexicalHeader:lexical.header,mergedHeader:merged.header};
            };
            const withdrawTestProposal = async id => {
              const entry = sources.find(row=>row.id===id);
              assert.ok(id==='retired-pilot' && entry?.scope==='project' && entry.owner==='alice');
              const before = await nativeSearch(on,f,entry.text.slice(0,256),'project');
              assert.ok(before.sources.includes(entry.source),'Control must be visible before withdrawal');
              await f.ok('POST','/requirement-topic-entries/'+entry.source+'/withdraw',f.alice,{reason:'隔离实验：该临时提案已撤回。'});
              const raw = await engines.searchMemoryEngineDetailed(cfg,{projectCode:f.projectCode,principalCode:f.bob.code},entry.text,'project');
              const remote = Object.fromEntries(['wiki','core'].map(channel=>[channel,raw[channel].some(ref=>refs.get(ref)===entry.source)]));
              assert.ok(remote.wiki || remote.core,'Expected a stale native index candidate to exercise visibility');
              for (const base of [off,on]) {
                assert.ok(!(await nativeSearch(base,f,entry.text.slice(0,256),'project')).sources.includes(entry.source),'Withdrawn evidence reached Bob');
              }
              return {id,visibleBefore:true,nativeStillMatchedAfter:remote,hiddenInBothArms:true};
            };
            return await work({dir,off,on,sources,native:f,withdrawTestProposal,makeMember:(enabled,location)=>createMember(f,enabled?on:off,dir,location),
              traceSearch,projectionSummary:{wikiOriginalHashesVerified:shared.length,coreOriginalsVerified:coreDocs.size,tencentVectors,
                ownerPrivateDocuments:privateDocs.size,crossAccountDirectReadsDenied:privateDocs.size,foreignPrivateSearchHiddenBoth:true}});
          } finally {await app.close();}
        } finally {
          await checkWiki();
          const errors=[];
          const deletedCoreIds=[];
          for (const doc of owned) {
            try {const ids=await doc.cleanup(); if(ids) deletedCoreIds.push(...ids);} catch(error){errors.push(error);}
          }
          if (deletedCoreIds.length) {
            const store=openVectorStore(runtime);
            try {
              const vector=store.prepare('select record_id from l0_vec where record_id=?');
              for (const id of deletedCoreIds) assert.equal(vector.get(id),undefined,'Deleted source still has a vector');
            } finally {store.close();}
          }
          if (errors.length) throw new AggregateError(errors,'Unable to verify cleanup of all owned source documents');
        }
      });
  });
}
