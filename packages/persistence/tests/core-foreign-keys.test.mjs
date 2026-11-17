import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { readFile, mkdtemp, mkdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, closeDb } from '../dist/index.js';
import { createTestFixture, requireTestContext } from '../../../scripts/test-database-guard.mjs';

const folder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../drizzle');
requireTestContext();
let owned, url;
const relations = [
 ['tasks', 'feature_id', 'features', 'fk_tasks_feature'],
 ['members', 'project_id', 'projects', 'fk_members_project'],
 ['features', 'project_id', 'projects', 'fk_features_project'],
 ['runs', 'task_id', 'tasks', 'fk_runs_task'],
 ['device_sessions', 'device_id', 'devices', 'fk_device_sessions_device'],
];
let client, oldMigrations, createdDatabase = false;
const expand = () => readFile(path.join(folder, '0048_core_foreign_keys_expand.sql'), 'utf8');
const validate = () => readFile(path.join(folder, '0049_core_foreign_keys_validate.sql'), 'utf8');
const missingParent = '9000000000000000000';

before(async () => {
 owned = await createTestFixture('foreignkeys'); url = owned.databaseUrl; createdDatabase = true;
 client = new Client({ connectionString: url }); await client.connect();
 oldMigrations = await mkdtemp(path.join(tmpdir(), 'tsp-core-fk-upgrade-'));
 const journal = JSON.parse(await readFile(path.join(folder, 'meta/_journal.json'), 'utf8'));
 for (const [destination, maxTag] of [[oldMigrations, 47], [path.join(oldMigrations, 'time-expand'), 50]]) {
  const entries = journal.entries.filter(entry => Number(entry.tag.slice(0, 4)) <= maxTag);
  await mkdir(path.join(destination, 'meta'), { recursive: true });
  for (const entry of entries) await copyFile(path.join(folder, `${entry.tag}.sql`), path.join(destination, `${entry.tag}.sql`));
  await (await import('node:fs/promises')).writeFile(path.join(destination, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
 }
});
after(async () => {
 await client?.end();
 if (oldMigrations) {
  const relative = path.relative(path.resolve(tmpdir()), path.resolve(oldMigrations));
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(oldMigrations).startsWith('tsp-core-fk-upgrade-'));
  await rm(oldMigrations, { recursive: true, force: true });
 }
 if (createdDatabase) {
  await owned.dispose();
 }
});
async function legacyFixture() {
 await owned.assertOwned(client);
 await client.query('drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public');
 const db = await openDb({ databaseUrl: url, migrationsFolder: oldMigrations }); await closeDb(db);
 const user = (await client.query("insert into users(account,display_name,created_at) values ('fk.user','FK user','2026-10-23T00:00:00Z') returning id")).rows[0];
 const team = (await client.query("insert into teams(name,created_at) values ('FK team','2026-10-23T00:00:00Z') returning id")).rows[0];
 const project = (await client.query("insert into projects(team_id,name,created_at) values ($1,'FK project','2026-10-23T00:00:00Z') returning id", [team.id])).rows[0];
 const feature = (await client.query("insert into features(project_id,title) values ($1,'FK feature') returning id", [project.id])).rows[0];
 const task = (await client.query("insert into tasks(feature_id,title,profile,acceptance,base_snapshot,created_at) values ($1,'FK task','builder','[]',0,'2026-10-23T00:00:00Z') returning id", [feature.id])).rows[0];
 const member = (await client.query("insert into members(principal_id,project_id,role,display_name,created_at) values ($1,$2,'member','FK user','2026-10-23T00:00:00Z') returning principal_id", [user.id,project.id])).rows[0];
 const device = (await client.query("insert into devices(principal_id,device_name,credential_hash,created_at) values ($1,'FK device',$2,'2026-10-23T00:00:00Z') returning id", [user.id,'b'.repeat(64)])).rows[0];
 const session = (await client.query("insert into device_sessions(device_id,token_hash,created_at) values ($1,$2,'2026-10-23T00:00:00Z') returning id", [device.id,'c'.repeat(64)])).rows[0];
 const workspace = (await client.query("insert into workspaces(run_id,path,git_base,created_at) values (-1,'test/fk/workspace','test','2026-10-23T00:00:00Z') returning id")).rows[0];
 const run = (await client.query("insert into runs(task_id,principal_id,profile,workspace_id,status,base_snapshot,started_at) values ($1,$2,'builder',$3,'active',0,'2026-10-23T00:00:00Z') returning id", [task.id,user.id,workspace.id])).rows[0];
 await client.query('update workspaces set run_id=$1 where id=$2',[run.id,workspace.id]);
 return { user,team,project,feature,task,member,device,session,run,workspace };
}
async function catalog() {
 return (await client.query(`select conname,convalidated,condeferrable,condeferred,confdeltype,confupdtype
   from pg_constraint where conname=any($1::text[]) order by conname`, [relations.map(row => row[3])])).rows;
}

test('legacy data upgrades without change; NOT VALID expand and VALIDATE are idempotent with five restrict constraints', async () => {
 const fixture = await legacyFixture();
 const before = (await client.query('select row_to_json(tasks) as row from tasks')).rows;
 await client.query(await expand()); await client.query(await expand());
 assert.equal((await catalog()).length, 5); assert.ok((await catalog()).every(row => row.convalidated === false));
 await client.query(await validate()); await client.query(await validate()); await client.query(await expand());
 const rows = await catalog();
 assert.equal(rows.length, 5);
 for (const row of rows) {
  assert.equal(row.convalidated, true); assert.equal(row.condeferrable, true); assert.equal(row.condeferred, false);
  assert.equal(row.confdeltype, 'r'); assert.equal(row.confupdtype, 'a');
 }
 assert.deepEqual((await client.query('select row_to_json(tasks) as row from tasks')).rows, before);
 const expanded = await openDb({ databaseUrl: url, migrationsFolder: path.join(oldMigrations, 'time-expand') }); await closeDb(expanded);
 assert.equal((await client.query(`select count(*)::int as count from drizzle.__drizzle_migrations
   where created_at=1792731600000 and xmin <> pg_current_xact_id()::text::xid`)).rows[0].count, 1, '0050 expand must commit before the separate contract migrator');
 const upgraded = await openDb({ databaseUrl: url, migrationsFolder: folder }); await closeDb(upgraded);
 assert.equal((await client.query('select id from tasks where id=$1',[fixture.task.id])).rows.length, 1);
 assert.deepEqual((await client.query('select row_to_json(content) as row from (select id,feature_id,title,profile,status,acceptance,base_snapshot from tasks) content')).rows,
   before.map(({ row }) => ({ row: Object.fromEntries(['id','feature_id','title','profile','status','acceptance','base_snapshot'].map(key => [key, row[key]])) })), 'cutover preserves the original task content and references');
 assert.equal((await client.query('select created_at from tasks where id=$1',[fixture.task.id])).rows[0].created_at.toISOString(), '2026-10-23T00:00:00.000Z');
 const inserts = [
  ["insert into tasks(feature_id,title,profile,acceptance,base_snapshot,created_at) values ($1,'Orphan task','builder','[]',0,'2026-10-23T00:00:00Z')", [missingParent]],
  ["insert into members(principal_id,project_id,role,display_name,created_at) values ($1,$2,'member','Orphan member','2026-10-23T00:00:00Z')", [fixture.user.id,missingParent]],
  ["insert into features(project_id,title) values ($1,'Orphan feature')", [missingParent]],
  ["insert into runs(task_id,principal_id,profile,workspace_id,base_snapshot,started_at) values ($1,$2,'builder',$3,0,'2026-10-23T00:00:00Z')", [missingParent,fixture.user.id,fixture.workspace.id]],
  ["insert into device_sessions(device_id,token_hash,created_at) values ($1,$2,'2026-10-23T00:00:00Z')", [missingParent,'d'.repeat(64)]],
 ];
 for (let i = 0; i < inserts.length; i++) {
  await assert.rejects(client.query(...inserts[i]), error => error.code === '23503' && error.constraint === relations[i][3]);
 }
 for (const [child,column,parent] of relations) {
  const childRow = child === 'members' ? fixture.member.principal_id : ({ tasks: fixture.task.id,features:fixture.feature.id,runs:fixture.run.id,device_sessions:fixture.session.id })[child];
  const pk = child === 'members' ? 'principal_id' : 'id';
  await assert.rejects(client.query(`update ${child} set ${column}=$1 where ${pk}=$2`, [missingParent,childRow]), error => error.code === '23503');
  const parentId = ({ features:fixture.feature.id,projects:fixture.project.id,tasks:fixture.task.id,devices:fixture.device.id })[parent];
  await assert.rejects(client.query(`delete from ${parent} where id=$1`, [parentId]), error => error.code === '23503');
 }
});

test('legacy orphans stop expansion without deleting data or manufacturing parent rows', async () => {
 const fixture = await legacyFixture();
 await client.query('update tasks set feature_id=$1 where id=$2',[missingParent,fixture.task.id]);
 await assert.rejects(client.query(await expand()), error => error.code === '23503' && error.message.includes('tasks.feature_id'));
 assert.equal((await catalog()).length, 0);
 assert.equal((await client.query('select feature_id from tasks where id=$1',[fixture.task.id])).rows[0].feature_id, missingParent);
 assert.equal((await client.query('select id from features where id=$1',[missingParent])).rows.length, 0);
});


test('NOT VALID still fences new orphans, and validation refuses preserved legacy orphans until explicitly corrected', async () => {
 const fixture = await legacyFixture();
 await client.query('update tasks set feature_id=$1 where id=$2',[missingParent,fixture.task.id]);
 // Emulate a previously installed NOT VALID fence over dirty historic rows.
 for (const [child,column,parent,name] of relations) await client.query(`alter table ${child} add constraint ${name} foreign key (${column}) references ${parent}(id) on delete restrict on update no action deferrable initially immediate not valid`);
 await assert.rejects(client.query("insert into features(project_id,title) values ($1,'New orphan')",[missingParent]), error => error.code === '23503');
 await assert.rejects(client.query(await validate()), error => error.code === '23503' && error.message.includes('tasks.feature_id'));
 assert.ok((await catalog()).every(row => row.convalidated === false));
 assert.equal((await client.query('select feature_id from tasks where id=$1',[fixture.task.id])).rows[0].feature_id, missingParent);
 // This fixture knows its actual original parent; the migration never performs this repair.
 await client.query('update tasks set feature_id=$1 where id=$2',[fixture.feature.id,fixture.task.id]);
 await client.query(await validate());
 assert.ok((await catalog()).every(row => row.convalidated === true));
});

test('explicit deferral permits a complete insert transaction but RESTRICT parent deletion remains immediate', async () => {
 const fixture = await legacyFixture(); await client.query(await expand()); await client.query(await validate());
 await client.query('begin');
 try {
  await client.query('set constraints fk_features_project deferred');
  await client.query("insert into features(project_id,title) values ($1,'Deferred feature')",[missingParent]);
  await client.query("insert into projects(id,team_id,name,created_at) values ($1,$2,'Deferred project','2026-10-23T00:00:00Z')",[missingParent,fixture.team.id]);
  await client.query('commit');
 } catch (error) { await client.query('rollback'); throw error; }
 await client.query('begin');
 try {
  await client.query('set constraints all deferred');
  await assert.rejects(client.query('delete from projects where id=$1',[missingParent]), error => error.code === '23503' && error.constraint === 'fk_features_project');
 } finally { await client.query('rollback'); }
});

test('reruns reject a same-name constraint with a different definition instead of silently trusting it', async () => {
 await legacyFixture();
 await client.query('alter table tasks add constraint fk_tasks_feature check (base_snapshot >= 0)');
 await assert.rejects(client.query(await expand()), error => error.code === '55000' && error.message.includes('unexpected definition'));
 assert.equal((await client.query("select count(*)::int as count from pg_constraint where contype='f' and connamespace='public'::regnamespace")).rows[0].count, 0);
});
