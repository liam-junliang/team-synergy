import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { openDb, closeDb, schema } from '../dist/index.js';
import { isoTimestamp } from '../dist/iso-timestamp.js';
import { pgTable } from 'drizzle-orm/pg-core';
import { createTestFixture, requireTestContext, testAdminUrl } from '../../../scripts/test-database-guard.mjs';

const migrations = fileURLToPath(new URL('../drizzle/', import.meta.url));
const journal = JSON.parse(await readFile(path.join(migrations, 'meta/_journal.json'), 'utf8'));
requireTestContext();
async function fixture(max = 49, { legacyDatabaseDefaults = false } = {}) {
  const owned = await createTestFixture('time');
  const name = owned.databaseName;
  const admin = new Pool({ connectionString: testAdminUrl() });
  if (legacyDatabaseDefaults) {
    await admin.query(`ALTER DATABASE "${name}" SET DateStyle = 'SQL, DMY'`);
    await admin.query(`ALTER DATABASE "${name}" SET TimeZone = 'Pacific/Auckland'`);
  }
  const url = new URL(owned.databaseUrl);
  const folder = await mkdtemp(path.join(tmpdir(), 'team-synergy-time-'));
  await mkdir(path.join(folder, 'meta'));
  const entries = journal.entries.filter(e => Number(e.tag.slice(0, 4)) <= max);
  await writeFile(path.join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
  for (const entry of entries) await copyFile(path.join(migrations, `${entry.tag}.sql`), path.join(folder, `${entry.tag}.sql`));
  const db = await openDb({ databaseUrl: url.href, migrationsFolder: folder });
  return { db, async close() {
    await closeDb(db);
    await admin.end(); await owned.dispose();
    assert.equal(path.dirname(path.resolve(folder)), path.resolve(tmpdir()));
    assert.ok(path.basename(folder).startsWith('team-synergy-time-'));
    await rm(folder, { recursive: true, force: true });
  } };
}
async function expand(db) {
  const client = await db.$client.connect();
  try {
    await client.query('BEGIN');
    const source = await readFile(path.join(migrations, '0050_core_time_expand.sql'), 'utf8');
    await client.query(source);
    await client.query('insert into drizzle.__drizzle_migrations(hash,created_at) values ($1,$2)', [createHash('sha256').update(source).digest('hex'), 1792731600000]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
async function contract(db) {
  const client = await db.$client.connect();
  try {
    await client.query('BEGIN');
    await client.query(await readFile(path.join(migrations, '0051_core_time_contract.sql'), 'utf8'));
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
async function fingerprints(db, typed = false) {
  const result = [];
  for (const [table, column] of [['projects','created_at'], ['tasks','created_at'], ['audit_events','timestamp']]) {
    result.push((await db.$client.query(`select id::text, md5((to_jsonb(t)-'${column}'-'${column}_ts')::text) as facts,
      extract(epoch from ${typed ? column : `tsp_parse_iso8601(${column})`})::text as instant from ${table} t order by id`)).rows);
  }
  return result;
}

test('string timestamp adapter normalizes offsets without losing microseconds', () => {
  const table = pgTable('time_probe', { value: isoTimestamp('value') });
  for (const [input, expected] of [
    ['2026-10-23 12:34:56.123456+08', '2026-10-23T04:34:56.123456Z'],
    ['2026-10-23T00:00:00.000001-03:30', '2026-10-23T03:30:00.000001Z'],
    ['2026-10-23 00:00:00+00', '2026-10-23T00:00:00.000Z'],
    ['2026-10-23', '2026-10-23T00:00:00.000Z'],
  ]) assert.equal(table.value.mapFromDriverValue(input), expected);
});

test('fresh initialization and ORM timestamps are independent of database DateStyle and zone', async () => {
  const f = await fixture(51, { legacyDatabaseDefaults: true });
  try {
    await seed(f.db);
    const settings = (await f.db.$client.query("select current_setting('DateStyle') as style,current_setting('TimeZone') as zone")).rows[0];
    assert.equal(settings.style, 'ISO, MDY'); assert.equal(settings.zone, 'UTC');
    assert.equal((await f.db.select({ time: schema.projects.created_at }).from(schema.projects))[0].time, '2026-10-23T04:34:56.123456Z');
  } finally { await f.close(); }
});

test('contract preserves every business fact and instant, ORM microseconds, defaults and natural range indexes', async () => {
  const f = await fixture();
  try {
    const { project, feature } = await seed(f.db);
    const { rows: [user] } = await f.db.$client.query("insert into users(account,display_name,created_at) values ('contract.user','Contract user','2026-10-23T00:00:00Z') returning id");
    await f.db.$client.query("insert into audit_events(timestamp,principal_id,action,entity_type,entity_id,base_snapshot) values ('2026-10-23T12:34:56.123456+08:00',$1,'project.test','project',$2,0)", [user.id,project.id]);
    await f.db.$client.query("insert into tasks(feature_id,title,profile,acceptance,base_snapshot,created_at) values ($1,'Microseconds','builder','[]',0,'2026-10-23T12:34:56.123456+08:00')", [feature.id]);
    await expand(f.db);
    const before = await fingerprints(f.db);
    await contract(f.db);
    assert.deepEqual(await fingerprints(f.db, true), before);
    const columns = (await f.db.$client.query("select table_name,column_name,data_type,is_nullable,column_default from information_schema.columns where (table_name,column_name) in (('projects','created_at'),('tasks','created_at'),('audit_events','timestamp')) order by table_name")).rows;
    assert.equal(columns.length, 3);
    for (const column of columns) {
      assert.equal(column.data_type, 'timestamp with time zone'); assert.equal(column.is_nullable, 'NO'); assert.equal(column.column_default, 'now()');
    }
    assert.equal((await f.db.$client.query("select count(*)::int as count from information_schema.columns where table_name in ('projects','tasks','audit_events') and column_name in ('created_at_ts','timestamp_ts')")).rows[0].count, 0);
    assert.equal((await f.db.select({ time: schema.projects.created_at }).from(schema.projects))[0].time, '2026-10-23T04:34:56.123456Z');
    assert.equal((await f.db.select({ time: schema.tasks.created_at }).from(schema.tasks))[0].time, '2026-10-23T04:34:56.123456Z');
    assert.equal((await f.db.select({ time: schema.auditEvents.timestamp }).from(schema.auditEvents))[0].time, '2026-10-23T04:34:56.123456Z');
    for (const invalid of ['infinity','-infinity','0001-01-01T00:00:00+01:00','10000-01-01T00:00:00Z']) {
      await assert.rejects(f.db.$client.query('update projects set created_at=$1 where id=$2', [invalid,project.id]), e => e.code === '23514');
    }
    await f.db.$client.query("insert into projects(team_id,name) select team_id,'Default time' from projects where id=$1", [project.id]);
    assert.equal((await f.db.$client.query("select abs(extract(epoch from now()-created_at))<10 as recent from projects where name='Default time'")).rows[0].recent, true);
    await f.db.$client.query("insert into projects(team_id,name,created_at) select team_id,'Historical','2000-01-01Z' from projects cross join generate_series(1,12000) where id=$1", [project.id]);
    await f.db.$client.query("insert into tasks(feature_id,title,profile,acceptance,base_snapshot,created_at) select $1,'Historical','builder','[]',0,'2000-01-01Z' from generate_series(1,12000)", [feature.id]);
    await f.db.$client.query("insert into audit_events(timestamp,principal_id,action,entity_type,entity_id,base_snapshot) select '2000-01-01Z',$1,'project.test','project',$2,0 from generate_series(1,12000)", [user.id,project.id]);
    for (const [table,column,index] of [['projects','created_at','idx_projects_created_at'],['tasks','created_at','idx_tasks_created_id'],['audit_events','timestamp','idx_audit_timestamp_id']]) {
      await f.db.$client.query(`analyze ${table}`);
      const plan = await f.db.$client.query(`explain select * from ${table} where ${column}>now()-interval '7 days'`);
      assert.match(JSON.stringify(plan.rows), new RegExp(index));
    }
  } finally { await f.close(); }
});

test('contract refuses mismatched mirrors atomically and preserves original text', async () => {
  const f = await fixture();
  try {
    const { project } = await seed(f.db);
    await expand(f.db);
    await f.db.$client.query("alter table projects disable trigger mirror_project_created_time; alter table projects drop constraint ck_projects_created_at_iso8601; update projects set created_at_ts='2000-01-01Z'");
    await assert.rejects(contract(f.db), e => e.code === '23514' && /invalid mirrors/.test(e.message));
    assert.equal((await f.db.$client.query('select created_at from projects where id=$1',[project.id])).rows[0].created_at, '2026-10-23T12:34:56.123456+08:00');
  } finally { await f.close(); }
});

test('nonempty database cannot skip the separately committed expand release', async () => {
  const f = await fixture();
  try {
    await seed(f.db);
    const client = await f.db.$client.connect();
    try {
      await client.query('BEGIN');
      await client.query(await readFile(path.join(migrations,'0050_core_time_expand.sql'),'utf8'));
      await client.query("insert into drizzle.__drizzle_migrations(hash,created_at) values ('same-transaction',1792731600000)");
      await assert.rejects(client.query(await readFile(path.join(migrations,'0051_core_time_contract.sql'),'utf8')), e => e.code==='23514' && /committed 0050/.test(e.message));
      await client.query('ROLLBACK');
    } finally { client.release(); }
    assert.equal((await f.db.$client.query("select count(*)::int as count from information_schema.columns where table_name='projects' and column_name='created_at_ts'")).rows[0].count,0);
    assert.equal((await f.db.$client.query('select created_at from projects')).rows[0].created_at,'2026-10-23T12:34:56.123456+08:00');
  } finally { await f.close(); }
});
async function seed(db, time = '2026-10-23T12:34:56.123456+08:00') {
  const { rows: [team] } = await db.$client.query("insert into teams(name,created_at) values ('Time team',$1) returning id", [time]);
  const { rows: [project] } = await db.$client.query("insert into projects(team_id,name,created_at) values ($1,'Time project',$2) returning id", [team.id, time]);
  const { rows: [feature] } = await db.$client.query("insert into features(project_id,title) values ($1,'Time feature') returning id", [project.id]);
  return { project, feature };
}

test('time expand preserves original strings and continuously mirrors validated instants', async () => {
  const f = await fixture();
  try {
    const { project, feature } = await seed(f.db);
    const { rows: [user] } = await f.db.$client.query("insert into users(account,display_name,created_at) values ('time.user','Time user','2026-10-23T00:00:00Z') returning id");
    await f.db.$client.query("insert into audit_events(timestamp,principal_id,action,entity_type,entity_id,base_snapshot) values ('2026-10-23T12:34:56.123456+08:00',$1,'project.test','project',$2,0)", [user.id, project.id]);
    await expand(f.db);
    const first = await f.db.$client.query('select created_at, created_at_ts::text as typed, created_at_ts=tsp_parse_iso8601(created_at) as matches from projects where id=$1', [project.id]);
    assert.equal(first.rows[0].created_at, '2026-10-23T12:34:56.123456+08:00');
    assert.match(first.rows[0].typed, /123456/); assert.equal(first.rows[0].matches, true);
    assert.equal((await f.db.$client.query('select count(*)::int as count from audit_events where timestamp_ts is distinct from tsp_parse_iso8601(timestamp)')).rows[0].count, 0);
    await f.db.$client.query("update projects set created_at='2026-10-24T00:00:00Z' where id=$1", [project.id]);
    await f.db.$client.query("update projects set created_at_ts='2000-01-01T00:00:00Z' where id=$1", [project.id]);
    assert.equal((await f.db.$client.query('select created_at_ts=tsp_parse_iso8601(created_at) as matches from projects where id=$1', [project.id])).rows[0].matches, true);
    await f.db.$client.query(`insert into tasks(feature_id,title,profile,acceptance,base_snapshot,created_at)
      select $1,'Temporal task','builder','[]',0,'2026-10-23T12:34:56.123456Z' from generate_series(1,1000)`, [feature.id]);
    assert.equal((await f.db.$client.query('select count(*)::int as count from tasks where created_at_ts is distinct from tsp_parse_iso8601(created_at)')).rows[0].count, 0);
    assert.equal((await f.db.$client.query("select tsp_parse_iso8601('2026-10-23')='2026-10-23T00:00:00Z'::timestamptz as matches")).rows[0].matches, true);
    for (const invalid of ['yesterday', '2026-02-30T00:00:00Z', '2026-10-23T24:00:00Z', '2026-10-23T00:00:00', '2026-10-23T00:00:00+16:00', '2026-10-23T00:00:00+23:00', 'infinity', '0000-01-01']) {
      await assert.rejects(f.db.$client.query('update projects set created_at=$1 where id=$2', [invalid, project.id]), e => e.code === '23514');
    }
    const plan = await f.db.$client.query("begin; set local enable_seqscan=off; explain select * from tasks where created_at_ts > now()-interval '7 days'; rollback");
    assert.match(JSON.stringify(plan), /idx_tasks_created_time_id/);
  } finally { await f.close(); }
});

test('invalid legacy dates halt the time migration atomically without deleting historical data', async () => {
  const f = await fixture();
  try {
    const { project } = await seed(f.db, 'not-an-instant');
    await assert.rejects(expand(f.db), e => e.code === '23514');
    assert.equal((await f.db.$client.query('select created_at from projects where id=$1', [project.id])).rows[0].created_at, 'not-an-instant');
    assert.equal((await f.db.$client.query("select count(*)::int as count from information_schema.columns where table_name='projects' and column_name='created_at_ts'")).rows[0].count, 0);
    await f.db.$client.query("update projects set created_at='2026-10-23T00:00:00Z' where id=$1", [project.id]);
    await expand(f.db);
    assert.equal((await f.db.$client.query('select count(*)::int as count from projects')).rows[0].count, 1);
  } finally { await f.close(); }
});
