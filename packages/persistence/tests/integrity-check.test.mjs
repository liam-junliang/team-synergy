import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getTableConfig } from 'drizzle-orm/pg-core';
import * as schema from '../dist/schema.js';
import { INTEGRITY_RELATIONS, checkDatabaseIntegrity } from '../dist/integrity-check.js';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

test('audit catalog covers actual application and API writer literals, including intake helper calls',()=>{
 const types=new Set(['team','project','user','test_case','test_asset']); // Typed ownership/testing helper discriminators.
 const visit=dir=>{
  for(const entry of readdirSync(dir,{withFileTypes:true})) {
   const file=path.join(dir,entry.name);if(entry.isDirectory()){visit(file);continue;}if(!file.endsWith('.ts'))continue;
   const source=readFileSync(file,'utf8');
   const expressions=[/\bentity_type\s*:\s*'([^']+)'/g,/\bintakeAudit\([^,]+,[^,]+,\s*'([^']+)'/g];
   if(['testing-use-cases.ts','ownership-use-cases.ts'].includes(entry.name))expressions.push(/\baudit\(tx,\s*'([^']+)'/g);
   for(const expression of expressions)for(const match of source.matchAll(expression))types.add(match[1]);
  }
 };
 visit(fileURLToPath(new URL('../../application/src',import.meta.url)));visit(fileURLToPath(new URL('../../../apps/core-api/src',import.meta.url)));
 for(const type of types)assert.ok(INTEGRITY_RELATIONS.some(rule=>rule.name===`audit_events.entity_id.${type}`),`Missing actual audit writer type: ${type}`);
});

test('every bigint entity reference has an explicit catalog rule, including polymorphic columns',()=>{
 const covered=new Set(INTEGRITY_RELATIONS.flatMap(rule=>rule.references));
 const actual=[];
 for(const table of Object.values(schema)) {
  try{const meta=getTableConfig(table);for(const column of meta.columns)if(column.dataType==='bigint'&&column.name!=='id')actual.push(`${meta.name}.${column.name}`);}catch{}
 }
 assert.deepEqual(actual.filter(name=>!covered.has(name)),[]);
 assert.equal(new Set(INTEGRITY_RELATIONS.map(rule=>rule.name)).size,INTEGRITY_RELATIONS.length);
 for(const key of ['tasks.feature_id','members.project_id','features.project_id','runs.task_id','device_sessions.device_id'])assert.ok(covered.has(key));
});

test('checker transaction is readonly, snapshot-consistent and deadline-bounded; output contains counts only',async()=>{
 const calls=[];
 const client={async query(sql){calls.push(sql);if(sql.includes('UNION ALL'))return{rows:[{name:'test.reference',count:'2'}]};return{rows:[]};},release(){calls.push('release');}};
 const result=await checkDatabaseIntegrity({$client:{connect:async()=>client}});
 assert.ok(calls[0].includes('REPEATABLE READ READ ONLY'));
 assert.ok(calls.some(sql=>sql.includes('statement_timeout')));
 assert.ok(calls.some(sql=>sql.includes('lock_timeout')));
 assert.ok(calls.includes('COMMIT'));
 assert.deepEqual(result.relations,[{name:'test.reference',count:2}]);
 assert.equal(result.total_orphans,2);
 assert.ok(result.duration_ms<10000);
 assert.equal(calls.at(-1),'release');
});

test('total deadline destroys a stalled transport once and skips rollback on the destroyed client',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const calls=[];let rejectTransport;
 const client={query:async sql=>{
  calls.push(sql);if(sql.includes('UNION ALL'))return new Promise((_resolve,reject)=>{rejectTransport=reject;});return{rows:[]};
 },release:destroy=>{calls.push(destroy?'destroy':'release');rejectTransport?.(new Error('Transport closed'));}};
 const pending=checkDatabaseIntegrity({$client:{connect:async()=>client}});
 await new Promise(resolve=>setImmediate(resolve));
 assert.ok(rejectTransport,'query reached stalled transport');
 const rejected=assert.rejects(pending,/Integrity query deadline exceeded/);
 t.mock.timers.tick(9000);await rejected;await new Promise(resolve=>setImmediate(resolve));
 assert.equal(calls.filter(call=>call==='destroy').length,1);assert.ok(!calls.includes('release'));assert.ok(!calls.includes('ROLLBACK'));
});

import { withIntegrityFixture } from '../../../scripts/orphan-fixture.mjs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const baseUrl=process.env.TSP_INTEGRITY_TEST_DATABASE_URL??process.env.TSP_TEST_DATABASE_URL;

test('real snapshot detects nullable orphans, cross-project/team mismatches and explicit audit types; CLI gate is readonly', {skip:!baseUrl}, async()=>{
 await withIntegrityFixture(baseUrl,'test',async(db,url)=>{
  const original=db.$client.connect.bind(db.$client);
  let checkedMode=false;
  const result=await checkDatabaseIntegrity({$client:{connect:async()=>{
   const client=await original();
   const query=client.query.bind(client);
   return {query:async sql=>{
    if(sql.includes('UNION ALL')){
     assert.equal((await query('SHOW transaction_read_only')).rows[0].transaction_read_only,'on');
     assert.equal((await query('SHOW transaction_isolation')).rows[0].transaction_isolation,'repeatable read');checkedMode=true;
    }
    return query(sql);
   },release:()=>client.release()};
  }}});
  assert.ok(checkedMode);assert.equal(result.total_orphans,0);assert.ok(result.relations.length>200);assert.ok(result.duration_ms<10000);
  const intake=(await db.$client.query('SELECT id FROM intake_batches LIMIT 1')).rows[0];
  await db.$client.query("UPDATE audit_events SET entity_id=9223372036854775807 WHERE entity_type='intake_batch'");
  const missingIntake=await checkDatabaseIntegrity(db);
  assert.equal(missingIntake.relations.find(row=>row.name==='audit_events.entity_id.intake_batch').count,1);
  assert.equal(missingIntake.relations.find(row=>row.name==='audit_events.entity_id.unknown_type').count,0);
  await db.$client.query("UPDATE audit_events SET entity_id=$1 WHERE entity_type='intake_batch'",[intake.id]);
  const feature=(await db.$client.query('SELECT id FROM features LIMIT 1')).rows[0];
  await db.$client.query("INSERT INTO tasks(feature_id,title,profile,acceptance,base_snapshot,created_at) SELECT $1,'Scale fixture '||n,'builder','[]',0,'2026-10-23T00:00:00.000Z' FROM generate_series(1,5000) n",[feature.id]);
  const scale=await checkDatabaseIntegrity(db);assert.equal(scale.total_orphans,0);assert.ok(scale.duration_ms<10000);
  const blocker=await db.$client.connect();
  try {
   await blocker.query('BEGIN');await blocker.query('LOCK TABLE features IN ACCESS EXCLUSIVE MODE');
   await assert.rejects(checkDatabaseIntegrity(db),{code:'55P03'});
  }finally{await blocker.query('ROLLBACK');blocker.release();}
  console.log(`Integrity scale: ${scale.relations.length} checks / 5001 tasks in ${scale.duration_ms}ms; DDL lock deadline passed`);
  await db.$client.query('UPDATE features SET module_id=NULL WHERE id=$1',[feature.id]);
  assert.equal((await checkDatabaseIntegrity(db)).total_orphans,0);
  const other=(await db.$client.query('SELECT id FROM projects ORDER BY id DESC LIMIT 1')).rows[0];
  const otherTeam=(await db.$client.query("INSERT INTO teams(name,created_at) VALUES ('Other scope','2026-10-23T00:00:00.000Z') RETURNING id")).rows[0];
  await db.$client.query('UPDATE projects SET team_id=$1 WHERE id=$2',[otherTeam.id,other.id]);
  const module=(await db.$client.query("INSERT INTO project_modules(project_id,name,created_at,updated_at) VALUES ($1,'Other module','2026-10-23T00:00:00.000Z','2026-10-23T00:00:00.000Z') RETURNING id",[other.id])).rows[0];
  await db.$client.query('UPDATE features SET module_id=$1 WHERE id=$2',[module.id,feature.id]);
  const mismatch=await checkDatabaseIntegrity(db);
  assert.equal(mismatch.relations.find(row=>row.name==='features.module_id.project_scope').count,1);
  await db.$client.query('UPDATE features SET module_id=9223372036854775807 WHERE id=$1',[feature.id]);
  const orphan=await checkDatabaseIntegrity(db);
  assert.equal(orphan.relations.find(row=>row.name==='features.module_id').count,1);
  const user=(await db.$client.query('SELECT id FROM users LIMIT 1')).rows[0];
  await db.$client.query("INSERT INTO audit_events(timestamp,principal_id,action,entity_type,entity_id,base_snapshot) VALUES ('2026-10-23T00:00:00.000Z',$1,'fixture','unknown-sensitive-label',99,0),('2026-10-23T00:00:00.000Z',$1,'fixture','unknown-sensitive-label',NULL,0)",[user.id]);
  const polymorphic=await checkDatabaseIntegrity(db);
  assert.equal(polymorphic.relations.find(row=>row.name==='audit_events.entity_id.unknown_type').count,1);
  assert.ok(!JSON.stringify(polymorphic).includes('unknown-sensitive-label'));
  const child=spawn(process.execPath,[fileURLToPath(new URL('../../../apps/cli/dist/index.js',import.meta.url)),'db:check-orphans'],{env:{...process.env,TSP_DATABASE_URL:url,NODE_USE_ENV_PROXY:'0'},stdio:['ignore','pipe','pipe'],windowsHide:true});
  let out='';child.stdout.on('data',data=>out+=data);child.stderr.resume();
  const code=await new Promise((resolve,reject)=>{child.once('close',resolve);child.once('error',reject);});
  assert.equal(code,1);const output=JSON.parse(out);assert.equal(output.ok,false);assert.equal(output.data.total_orphans,2);
  assert.equal((await db.$client.query('SELECT count(*) FROM audit_events')).rows[0].count,'4');
  console.log(`Integrity fixture: ${result.relations.length} checks, ${result.duration_ms}ms, positive CLI gate rejected ${output.data.total_orphans} violations`);
 });
});
