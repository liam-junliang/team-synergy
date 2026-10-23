import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { planTenantMapping, TENANT_INVENTORY_CATALOG, checkDatabaseIntegrity, openDb, closeDb } from '../dist/index.js';
import { withIntegrityFixture } from '../../../scripts/orphan-fixture.mjs';
import { getTableConfig } from 'drizzle-orm/pg-core';
import * as schema from '../dist/schema.js';
const baseUrl = process.env.TSP_TEST_DATABASE_URL;
const time = '2026-10-23T00:00:00.000Z';
const secret = 'TENANT_INVENTORY_PRIVATE_SENTINEL';

test('customer inventory catalog reviews every schema table exactly once', () => {
  const names = TENANT_INVENTORY_CATALOG.flatMap(group => group.tables.split(' '));
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(names.sort(), Object.values(schema).map(table => getTableConfig(table).name).sort());
  assert.equal(names.length, 75);
});

test('inventory is pending, complete as a metadata read and never exposes private bodies or invents customer acceptance', {skip:!baseUrl}, async () => {
  await withIntegrityFixture(baseUrl,'tenant',async (db,url) => {
    const q=(sql,params=[])=>db.$client.query(sql,params).then(r=>r.rows[0]);
    const original = await q('select * from projects order by id limit 1');
    const other = await q('select * from projects order by id desc limit 1');
    const user = await q('select * from users limit 1');
    await q('insert into team_members(team_id,principal_id,role,display_name,created_at) values ($1,$2,$3,$4,$5)',[original.team_id,user.id,'admin',secret,time]);
    const external = await q('insert into users(account,display_name,created_at) values ($1,$1,$2) returning id',[secret,time]);
    await q('insert into members(principal_id,project_id,role,display_name,created_at) values ($1,$2,$3,$4,$5)',[external.id,original.id,'viewer',secret,time]);
    const targetTeam = await q('insert into teams(name,created_at) values ($1,$2) returning id,code',[secret,time]);
    await q('update projects set team_id=$1 where id=$2',[targetTeam.id,other.id]);
    const skill = await q("insert into skills(scope_type,scope_id,owner_principal_id,current_revision,created_at,updated_at) values ('team',$1,$2,2,$3,$3) returning id,code",[original.team_id,user.id,time]);
    await q('insert into skill_revisions(skill_id,revision,package_json,change_summary,created_by,created_at,published_at) values ($1,1,$2,$2,$3,$4,$4),($1,2,$2,$2,$3,$4,null)',[skill.id,secret,user.id,time]);
    const sourceTeam = await q('select code from teams where id=$1',[original.team_id]);
    for(const target of [original.team_id,targetTeam.id]) await q("insert into skill_shares(skill_id,target_type,target_id,revisions_json,created_by,created_at,revoked_at) values ($1,'team',$2,'[1]',$3,$4,$4)",[skill.id,target,user.id,time]);
    await q("insert into skill_shares(skill_id,target_type,target_id,revisions_json,created_by,created_at) values ($1,'team',$2,$3,$4,$5)",[skill.id,targetTeam.id,secret,user.id,time]);
    await q("insert into skill_shares(skill_id,target_type,target_id,revisions_json,created_by,created_at) values ($1,'team',$2,'[2]',$3,$4)",[skill.id,targetTeam.id,user.id,time]);
    await q('insert into project_skill_installations(project_id,skill_id,revision,alias,enabled,updated_by,updated_at) values ($1,$2,1,$3,false,$4,$5)',[other.id,skill.id,secret,user.id,time]);
    const run = await q('select id from runs limit 1');
    await q('insert into run_skill_manifests(run_id,manifest_json,created_at) values ($1,$2,$3)',[run.id,secret,time]);
    await q('insert into command_receipts(principal_id,operation,key,request_hash,result,created_at) values ($1,$2,$2,$2,$2,$3)',[user.id,secret,time]);
    await q("insert into audit_events(timestamp,principal_id,action,entity_type,entity_id,payload,base_snapshot) values ($1,$2,'skill.installation_updated','skill',$3,$4,0),($1,$2,$4,$4,null,$4,0)",[time,user.id,skill.id,secret]);
    const before = await q('select (select count(*) from audit_events)::int as audits,(select count(*) from command_receipts)::int as receipts');
    const report = await planTenantMapping(db);
    assert.equal(report.status,'pending'); assert.equal(report.read_complete,true); assert.equal(report.ready_for_backfill,false); assert.equal(report.ownership_complete,false); assert.equal(report.tenant_id,null);
    assert.equal(report.inventory.length,75);
    assert.equal(report.teams.length,3); // Historical migration also retains its empty default team.
    assert.equal(report.projects.length,2);
    assert.equal(report.projects.find(p=>p.project_code===original.code).external_members,1);
    assert.equal(report.shares.length,4); assert.ok(report.shares.every(s=>s.recipient_acceptance==='not_recorded_in_legacy_model'));
    assert.equal(report.shares.filter(s=>s.team_relation==='same_team').length,1);
    assert.equal(report.shares.filter(s=>s.team_relation==='different_teams_customer_unknown').length,3);
    assert.equal(report.shares.filter(s=>s.revoked).length,2); assert.equal(report.issues.invalid_or_unpublished_share_versions,2);
    assert.equal(report.installations[0].enabled,false); assert.equal(report.installations[0].revision_exists,true);
    assert.equal(report.installations[0].source_team_code,sourceTeam.code); assert.equal(report.installations[0].target_team_code,targetTeam.code);
    assert.equal(report.audit.find(a=>a.family==='skill_installation_bridge_review').rows,1);
    assert.equal(report.issues.unknown_audit_rows,1); assert.equal(report.issues.unknown_receipt_rows,1);
    assert.equal(report.deferred.find(d=>d.area==='historical_manifests').content_inspected,false);
    assert.equal(report.deferred.find(d=>d.area==='historical_manifests').rows,1);
    assert.ok(!JSON.stringify(report).includes(secret));
    assert.ok(!JSON.stringify(report).includes(user.code));
    assert.deepEqual(await q('select (select count(*) from audit_events)::int as audits,(select count(*) from command_receipts)::int as receipts'),before);
    assert.equal((await planTenantMapping(db)).fact_digest,report.fact_digest);
    await q('update project_skill_installations set revision=99');
    assert.equal((await planTenantMapping(db)).issues.missing_installation_revisions,1);
    await q('update skill_shares set revisions_json=repeat($1,10000) where revisions_json=$1',[secret]);
    const oversized=await planTenantMapping(db);
    assert.equal(oversized.issues.invalid_or_unpublished_share_versions,2);
    assert.ok(!JSON.stringify(oversized).includes(secret));
    const child=spawn(process.execPath,[fileURLToPath(new URL('../../../apps/cli/dist/index.js',import.meta.url)),'db:plan-tenants'],{env:{...process.env,TSP_DATABASE_URL:url,NODE_USE_ENV_PROXY:'0'},windowsHide:true,stdio:['ignore','pipe','pipe']});
    let out='',err='';child.stdout.on('data',v=>out+=v);child.stderr.on('data',v=>err+=v);
    assert.equal(await new Promise((resolve,reject)=>{child.once('close',resolve);child.once('error',reject);}),0);
    const cli=JSON.parse(out);assert.equal(cli.ok,true);assert.equal(cli.data.ready_for_backfill,false);assert.ok(!(out+err).includes(secret));
  });
});

test('inventory refuses unreviewed schema, migration drift, RLS and silently truncated relations', {skip:!baseUrl}, async()=>{
  await withIntegrityFixture(baseUrl,'coverage',async db=>{
    await db.$client.query('create table unreviewed_table(id int)');
    await assert.rejects(planTenantMapping(db),/table coverage/);await db.$client.query('drop table unreviewed_table');
    await db.$client.query('alter table teams add column unreviewed_column text');
    await assert.rejects(planTenantMapping(db),/columns or visibility/);await db.$client.query('alter table teams drop column unreviewed_column');
    await db.$client.query('alter table teams enable row level security');
    await assert.rejects(planTenantMapping(db),/columns or visibility/);await db.$client.query('alter table teams disable row level security');
    await db.$client.query("update drizzle.__drizzle_migrations set hash='changed' where created_at=(select max(created_at) from drizzle.__drizzle_migrations)");
    await assert.rejects(planTenantMapping(db),/migration head/);
    // This fixture intentionally stops here: migration drift is not repaired or ignored by the command.
  });
  await withIntegrityFixture(baseUrl,'overflow',async db=>{
    await db.$client.query("insert into teams(name,created_at) select 'Overflow','2026-10-23T00:00:00Z' from generate_series(1,5001)");
    await assert.rejects(planTenantMapping(db),/limit exceeded/);
  });
});

test('inventory requires every table SELECT privilege and honors the DDL lock deadline', {skip:!baseUrl}, async()=>{
  await withIntegrityFixture(baseUrl,'privileges',async(db,url)=>{
    const role=`c041_reader_${process.pid}`;
    await db.$client.query(`create role ${role} nologin`);
    let limited;
    try {
      await db.$client.query(`grant usage on schema public,drizzle to ${role}; grant select on all tables in schema public,drizzle to ${role}; revoke select on teams from ${role}`);
      limited=await openDb({databaseUrl:url,migrate:false});
      const connect=limited.$client.connect.bind(limited.$client);
      const restricted={$client:{connect:async()=>{const c=await connect();await c.query(`set role ${role}`);return c;}}};
      await assert.rejects(planTenantMapping(restricted),/columns or visibility/);
    } finally {
      if(limited) await closeDb(limited);
      await db.$client.query(`drop owned by ${role}; drop role ${role}`);
    }
    const blocker=await db.$client.connect();
    try {
      await blocker.query('begin');await blocker.query('lock table teams in access exclusive mode');
      await assert.rejects(planTenantMapping(db),{code:'55P03'});
    }finally{await blocker.query('rollback');blocker.release();}
    assert.equal((await planTenantMapping(db)).read_complete,true);
  });
});

test('inventory always reads public facts even with ordinary and temporary schema shadows', {skip:!baseUrl},async()=>{
  await withIntegrityFixture(baseUrl,'shadow',async db=>{
    await db.$client.query('create schema inventory_shadow');
    for(const table of TENANT_INVENTORY_CATALOG.flatMap(group=>group.tables.split(' '))) {
      assert.match(table,/^[a-z_]+$/);
      await db.$client.query(`create view inventory_shadow.${table} as select * from public.${table} where false`);
    }
    const expected=await planTenantMapping(db);
    const connect=db.$client.connect.bind(db.$client);
    const shadowed={$client:{connect:async()=>{
      const client=await connect();
      await client.query('set search_path=inventory_shadow,public');
      await client.query('create or replace temp view teams as select * from public.teams where false');
      return client;
    }}};
    const actual=await planTenantMapping(shadowed);
    assert.equal(actual.read_complete,true); assert.equal(actual.projects.length,2); assert.equal(actual.teams.length,2);
    assert.deepEqual(actual.inventory,expected.inventory); assert.equal(actual.fact_digest,expected.fact_digest);
    await db.$client.query('update public.features set module_id=9223372036854775807');
    const integrity=await checkDatabaseIntegrity(shadowed);
    assert.equal(integrity.relations.find(r=>r.name==='features.module_id').count,1);
  });
});

test('different missing source skills cannot match each other through a null revision key', {skip:!baseUrl},async()=>{
  await withIntegrityFixture(baseUrl,'missing',async db=>{
    const user=(await db.$client.query('select id from public.users limit 1')).rows[0];
    const project=(await db.$client.query('select id,team_id from public.projects limit 1')).rows[0];
    await db.$client.query("insert into skill_revisions(skill_id,revision,package_json,change_summary,created_by,created_at,published_at) values (900001,1,$1,$1,$2,$3,$3)",[secret,user.id,time]);
    await db.$client.query('insert into project_skill_installations(project_id,skill_id,revision,alias,enabled,updated_by,updated_at) values ($1,900002,1,$2,false,$3,$4)',[project.id,secret,user.id,time]);
    await db.$client.query("insert into skill_shares(skill_id,target_type,target_id,revisions_json,created_by,created_at) values (900003,'team',$1,'[1]',$2,$3)",[project.team_id,user.id,time]);
    const report=await planTenantMapping(db);
    assert.equal(report.installations[0].skill_code,null);assert.equal(report.installations[0].revision_exists,false);
    assert.equal(report.shares[0].skill_code,null);assert.equal(report.shares[0].versions_valid_and_published,false);
    assert.equal(report.issues.orphaned_skill_revisions,1);assert.equal(report.issues.missing_installation_revisions,1);
    assert.equal(report.issues.invalid_or_unpublished_share_versions,1);assert.equal(report.ready_for_backfill,false);
    assert.ok(!JSON.stringify(report).includes(secret));
  });
});
