// Write only to a newly created, unbound Wiki in the existing local study fixture.
// Run with --scratch-wiki. Keep the receipt until verified cleanup completes.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

if (process.argv[2] !== '--scratch-wiki') throw Error('Use --scratch-wiki to create and remove an isolated experimental Wiki.');
const hub = resolve(process.env.TSP_PILOT_HUB || 'F:/workspace/team-knowledge-hub');
const runtime = resolve(process.env.TSP_PILOT_RUNTIME || 'F:/workspace/team-knowledge-runtime');
const json = async p => JSON.parse((await readFile(p, 'utf8')).replace(/^\uFEFF/, ''));
const {attestTarget} = await import(pathToFileURL(resolve(hub, 'scripts/setup-teamsynergy-study.mjs')));
const tencent = await json(resolve(runtime, 'tencent/deployment.json'));
await attestTarget({runtime,profiles:{tencent}}, 'tencent');
const config = await json(resolve(hub, 'config/live.json'));
const study = await json(resolve(runtime,'hub/teamsynergy-study/deployment.json'));
const mapping = config.projects.teamsynergy;
assert.equal(study.mapping.tencentTeamId, mapping.tencentTeamId);
assert.equal(config.tencent.knowledgeBaseUrl, tencent.knowledgeBaseUrl);
const base = new URL(config.tencent.knowledgeBaseUrl);
assert.equal(base.origin, 'http://127.0.0.1:8424');
const refs = {team_id:mapping.tencentTeamId,user_id:mapping.tencentOwnerUserId};
const headers = {'content-type':'application/json',authorization:'Bearer '+config.tencent.token,'x-tdai-service-id':config.tencent.serviceId};
const call = async (action,body) => {
  const res = await fetch(base.href.replace(/\/$/,'')+'/wiki/'+action,{method:'POST',headers,body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(8000)});
  if(!res.ok)throw Error(action+' HTTP '+res.status);
  const env=await res.json();
  assert.equal(env.code,0,action+' rejected');
  return {status:res.status,data:env.data};
};
const hash = x => createHash('sha256').update(x).digest('hex');
const reportFile=new URL('result.json',import.meta.url);
const name='harness-scratch-'+randomUUID();
const report={name,started:new Date().toISOString(),created:false,cleaned:false};
const save=()=>writeFile(reportFile,JSON.stringify(report,null,2)+'\n');
await save();
const created=await call('create',{...refs,name});
assert.equal(created.status,201);
const id=created.data.wiki_id;
assert.ok(id && created.data.name===name && created.data.team_id===refs.team_id);
Object.assign(report,{created:true,id});
await save();
const check=async()=>{
  const {data:detail}=await call('get',{wiki_id:id});
  assert.ok(detail.wiki_id===id && detail.team_id===refs.team_id && detail.name===name);
  return detail.version;
};
const write=async(filename,text)=>call('raw/write',{...refs,wiki_id:id,files:[{filename,content:text,encoding:'utf8'}]});
const read=async(filename)=>(await call('raw/read',{wiki_id:id,filenames:[filename]})).data.items[0].content;
try{
  await check();
  const initial='# 试验规划\r\n退款议题还在讨论。\r\n';
  const current='退款人工审核方案已采纳，尚待实现。\n';
  const stale='从初始版本起草的并行修改。\n';
  const file='plan.md';
  await write(file,initial);
  const original=await read(file);
  report.firstReadHash=hash(original);
  report.exactChineseMarkdown=hash(original)===hash(initial);
  const baseVersion=await check();
  await write(file,current);
  assert.equal(await read(file),current);
  const secondVersion=await check();
  // Two editors read the initial text. The documented raw/write request has no
  // expected source revision, so the late writer submits through the same API.
  await write(file,stale);
  report.staleWriterWon=(await read(file))===stale;
  report.versions=[baseVersion,secondVersion,await check()];
  const savedName='r1-'+hash(initial).slice(0,16)+'.md';
  await write(savedName,initial);
  await write('r2-'+hash(current).slice(0,16)+'.md',current);
  report.versionedFilenameRetainsR1=(await read(savedName))===initial;
  await save();
}finally{
  await check();
  const {data}=await call('delete',{wiki_ids:[id]});
  assert.deepEqual(data.deleted_ids,[id]);
  report.cleaned=true;
  await save();
}
console.log(JSON.stringify(report));
