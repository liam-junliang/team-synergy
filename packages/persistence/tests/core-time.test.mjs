import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { openDb, closeDb } from '../dist/index.js';

const migrations = fileURLToPath(new URL('../drizzle/', import.meta.url));
const journal = JSON.parse(await readFile(path.join(migrations, 'meta/_journal.json'), 'utf8'));
const template = new URL(process.env.TSP_TEST_DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/team_synergy_test');
async function fixture(max = 49) {
  const name = `tsp_time_${randomBytes(8).toString('hex')}`;
  const adminUrl = new URL(template); adminUrl.pathname = '/postgres';
  const admin = new Pool({ connectionString: adminUrl.href });
  await admin.query(`CREATE DATABASE "${name}"`);
  const url = new URL(template); url.pathname = `/${name}`;
  const folder = await mkdtemp(path.join(tmpdir(), 'team-synergy-time-'));
  await mkdir(path.join(folder, 'meta'));
  const entries = journal.entries.filter(e => Number(e.tag.slice(0, 4)) <= max);
  await writeFile(path.join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
  for (const entry of entries) await copyFile(path.join(migrations, `${entry.tag}.sql`), path.join(folder, `${entry.tag}.sql`));
  const db = await openDb({ databaseUrl: url.href, migrationsFolder: folder });
  return { db, async close() {
    await closeDb(db);
    await admin.query(`DROP DATABASE "${name}"`); await admin.end();
    assert.equal(path.dirname(path.resolve(folder)), path.resolve(tmpdir()));
    assert.ok(path.basename(folder).startsWith('team-synergy-time-'));
    await rm(folder, { recursive: true, force: true });
  } };
}
async function expand(db) {
  const client = await db.$client.connect();
  try {
    await client.query('BEGIN');
    await client.query(await readFile(path.join(migrations, '0050_core_time_expand.sql'), 'utf8'));
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
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
