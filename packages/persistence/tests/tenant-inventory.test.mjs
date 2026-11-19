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
  assert.equal(names.length, 92);
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
    assert.equal(report.inventory.length,92);
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
    // CREATEROLE is deliberately not superuser; PostgreSQL 16 requires an
    // explicit SET membership for this temporary read-only privilege probe.
    await db.$client.query(`grant ${role} to tsp_test_runner with set true`);
    let limited;
    try {
      await db.$client.query(`grant usage on schema public,drizzle to ${role}; grant select on all tables in schema public,drizzle to ${role}; revoke select on teams from ${role}`);
      limited=await openDb({databaseUrl:url,migrate:false});
      const connect=limited.$client.connect.bind(limited.$client);
      const restricted={$client:{connect:async()=>{const c=await connect();try{await c.query(`set role ${role}`);return c;}catch(error){c.release();throw error;}}}};
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

test('platform releases carry their own provenance in the inventory of project installations', {skip:!baseUrl}, async () => {
  await withIntegrityFixture(baseUrl,'platform',async db => {
    const query = (sql, params = []) => db.$client.query(sql, params).then(result => result.rows[0]);
    const project = await query('SELECT id FROM projects LIMIT 1');
    const user = await query('SELECT id FROM users LIMIT 1');
    const skill = await query("INSERT INTO skills(scope_type,current_revision,created_at,updated_at) VALUES ('platform',1,$1,$1) RETURNING id,code",[time]);
    await query("INSERT INTO skill_revisions(skill_id,revision,release_version,package_json,change_summary,created_at,published_at) VALUES ($1,1,'1.1.0',$2,$2,$3,$3)",[skill.id,secret,time]);
    await query("INSERT INTO project_skill_installations(project_id,skill_id,revision,alias,enabled,updated_by,updated_at) VALUES ($1,$2,1,'builtin',true,$3,$4)",[project.id,skill.id,user.id,time]);
    const report = await planTenantMapping(db);
    assert.equal(report.skills.find(item => item.skill_code === skill.code).source_scope_type, 'platform');
    assert.equal(report.installations.find(item => item.skill_code === skill.code).team_relation, 'platform_release');
    assert.equal(report.issues.unresolved_skill_scopes,0);
    assert.equal(report.issues.unresolved_installation_scopes,0);
    assert.ok(!JSON.stringify(report).includes(secret));
  });
});


test('Connector inventory counts private grants and OAuth state without exporting credentials or metadata', {skip:!baseUrl}, async () => {
  await withIntegrityFixture(baseUrl, 'connector', async db => {
    const query = (sql, params = []) => db.$client.query(sql, params).then(result => result.rows[0]);
    const project = await query('SELECT id FROM projects LIMIT 1');
    const owner = await query('SELECT id FROM users LIMIT 1');
    const privateFields = {
      clientId: 'CONNECTOR_CLIENT_SENTINEL',
      clientName: 'CONNECTOR_NAME_SENTINEL',
      clientSecretHash: '1'.repeat(64),
      callback: 'https://private-connector.example/callback',
      state: 'CONNECTOR_STATE_SENTINEL',
      challenge: 'CONNECTOR_CHALLENGE_SENTINEL',
      browserSessionCode: 'CONNECTOR_BROWSER_SESSION_SENTINEL',
      codeHash: '2'.repeat(64),
      bearerHash: '3'.repeat(64),
      refreshHash: '4'.repeat(64),
      accountBearerHash: '5'.repeat(64),
    };
    const remoteResource = 'https://private-platform.example/api/mcp';
    await query("INSERT INTO remote_mcp_oauth_clients(id,name,secret_hash,token_auth_method,redirect_uris,allow_refresh,created_at) VALUES ($1,$2,$3,'client_secret_post',to_jsonb(ARRAY[$4::text]),true,now())",
      [privateFields.clientId, privateFields.clientName, privateFields.clientSecretHash, privateFields.callback]);
    const grant = await query("INSERT INTO remote_mcp_grants(principal_id,project_id,name,token_hash,oauth_client_id,resource_uri,access_expires_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6,now()+interval '1 hour',now()+interval '7 days') RETURNING id, code",
      [owner.id, project.id, privateFields.clientName, privateFields.bearerHash, privateFields.clientId, remoteResource]);
    const accountGrant = await query("INSERT INTO remote_mcp_grants(principal_id,name,token_hash,expires_at) VALUES ($1,$2,$3,now()+interval '7 days') RETURNING code",
      [owner.id, privateFields.clientName, privateFields.accountBearerHash]);
    await query('INSERT INTO remote_mcp_oauth_requests(id,client_id,resource_uri,redirect_uri,state,challenge,browser_session_code,principal_id,project_id,requested_task_write,requested_personal_memory,code_hash,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,false,false,$10,now())',
      [secret, privateFields.clientId, remoteResource, privateFields.callback, privateFields.state, privateFields.challenge, privateFields.browserSessionCode, owner.id, project.id, privateFields.codeHash]);
    await query('INSERT INTO remote_mcp_oauth_refresh_tokens(token_hash,grant_id) VALUES ($1,$2)', [privateFields.refreshHash, grant.id]);
    await query("INSERT INTO audit_events(timestamp,principal_id,action,entity_type,entity_id,payload,base_snapshot) VALUES ($1,$2,'remote_mcp.connection_created','remote_mcp_connection',$3,$4,0)",
      [time, owner.id, grant.id, secret]);

    const report = await planTenantMapping(db);
    assert.deepEqual(report.inventory.filter(row => row.table.startsWith('remote_mcp')).map(({ table, category, rows }) => ({ table, category, rows })), [
      { table: 'remote_mcp_grants', category: 'connector_authorization', rows: 2 },
      { table: 'remote_mcp_oauth_clients', category: 'global_identity_control', rows: 1 },
      { table: 'remote_mcp_oauth_refresh_tokens', category: 'connector_ephemeral', rows: 1 },
      { table: 'remote_mcp_oauth_requests', category: 'connector_ephemeral', rows: 1 },
    ]);
    assert.equal(report.audit.find(row => row.family === 'connector_authorization_review').rows, 1);
    assert.equal(report.issues.unknown_audit_rows, 0);
    const serialized = JSON.stringify(report);
    for (const value of [...Object.values(privateFields), secret, remoteResource, grant.code, accountGrant.code]) {
      assert.equal(serialized.includes(value), false);
    }

    assert.equal((await checkDatabaseIntegrity(db)).total_orphans, 0);
    const other = await query("INSERT INTO users(account,display_name,created_at) VALUES ('connector-integrity-fixture','Other user',$1) RETURNING id", [time]);
    await query("UPDATE audit_events SET principal_id=$1 WHERE entity_type='remote_mcp_connection'", [other.id]);
    const mismatched = await checkDatabaseIntegrity(db);
    assert.equal(mismatched.relations.find(row => row.name === 'audit_events.entity_id.remote_mcp_connection.principal').count, 1);
    await query('DELETE FROM remote_mcp_grants WHERE id=$1', [grant.id]);
    assert.equal((await query('SELECT count(*)::int AS rows FROM remote_mcp_oauth_refresh_tokens')).rows, 0);
  });
});
