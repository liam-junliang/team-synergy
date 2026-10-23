import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { schema } from '@team-synergy/persistence';
import { toAuditEvent } from '@team-synergy/domain';
import { insertAudit } from '../../../packages/application/dist/task-service.js';
import { buildServer } from '../dist/server.js';
import { openTestDb, closeTestDb, insertUser } from './test-db.mjs';

test('audit export enforces current bearer admin, bounded exact-since paging, and redacts persisted/legacy payloads', async () => {
 const db=await openTestDb(); const app=await buildServer({db,logger:false});
 try {
  const users=[];
  for(const admin of [true,false]) {
   const user=await insertUser(db,{account:'audit.'+admin,display_name:'Audit',is_system_admin:admin,created_at:'2026-10-23T00:00:00.000Z'});
   const token='audit-fixture-'+admin;
   await db.insert(schema.devices).values({principal_id:user.id,device_name:'fixture',credential_hash:createHash('sha256').update(token).digest('hex'),created_at:'2026-10-23T00:00:00.000Z'});
   users.push({...user,headers:{authorization:'Bearer '+token}});
  }
  for(let i=0;i<4;i++) await insertAudit(db,toAuditEvent({entity_type:'user',entity_id:users[0].id,principal_id:users[0].id,base_snapshot:0,action:'user.login_failed',payload:{password:'audit-fixture-sensitive',nested:{device_token:'fixture-token'},safe:'visible'}},String(200+i).padStart(20,'0'),i===1?'2026-10-23T00:00:01Z':i===3?'2026-10-23T08:00:03+08:00':`2026-10-23T00:00:0${i}.000Z`));
  const stored=await db.select().from(schema.auditEvents);assert.ok(!JSON.stringify(stored,(_,v)=>typeof v==='bigint'?String(v):v).includes('audit-fixture-sensitive'));
  await db.insert(schema.auditEvents).values({code:'00000000000000000204',timestamp:'2026-10-23T00:00:04.000Z',principal_id:users[0].id,action:'legacy',entity_type:'user',entity_id:users[0].id,base_snapshot:0,payload:JSON.stringify({private_key:'-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----',note:'Bearer legacy-fixture-secret', 'api-key':'fixture-api-secret','private-key':'fixture-key-secret',embedded:JSON.stringify({password:'fixture-embedded-secret'}),prose:'password: fixture-prose-secret'})});
  assert.equal((await app.inject('/audit/export?since=2026-10-23')).statusCode,401);
  assert.equal((await app.inject({url:'/audit/export?since=2026-10-23',headers:users[1].headers})).statusCode,403);
  assert.equal((await app.inject({url:'/audit/export?since=2026-10-23',headers:{'x-principal-code':users[0].code}})).statusCode,401);
  const base='/audit/export?since=2026-10-23T00%3A00%3A01.000Z&limit=2';
  const first=await app.inject({url:base,headers:users[0].headers});assert.equal(first.statusCode,200,first.body);
  const p=first.json().data;assert.equal(p.items.length,2);assert.ok(p.next_cursor);
  const second=await app.inject({url:base+'&cursor='+p.next_cursor+'&snapshot='+p.snapshot,headers:users[0].headers});
  const rows=[...p.items,...second.json().data.items];assert.equal(rows.length,4);assert.equal(second.json().data.next_cursor,null);assert.equal(new Set(rows.map(r=>r.code)).size,4);
  assert.ok(rows.some(r=>r.action==='user.login_failed'));assert.ok(JSON.stringify(rows).includes('visible'));assert.ok(!JSON.stringify(rows).includes('legacy-fixture-secret'));assert.ok(!JSON.stringify(rows).includes('BEGIN PRIVATE'));
  for(const secret of ['fixture-api-secret','fixture-key-secret','fixture-embedded-secret','fixture-prose-secret']) assert.ok(!JSON.stringify(rows).includes(secret));
  const precise=await app.inject({url:'/audit/export?since=2026-10-23T00%3A00%3A01.500Z',headers:users[0].headers});assert.equal(precise.json().data.items.length,3);
  const micro=await app.inject({url:'/audit/export?since=2026-10-23T00%3A00%3A01.000001Z',headers:users[0].headers});assert.equal(micro.json().data.items.length,3);
  for(const query of ['since=bad','since=2026-02-31','since=2026-10-23&limit=0','since=2026-10-23&cursor=wat','since=2026-10-23&snapshot=9999999999999999999999999']) assert.equal((await app.inject({url:'/audit/export?'+query,headers:users[0].headers})).statusCode,400);
 }finally{await app.close();await closeTestDb(db);}
});
