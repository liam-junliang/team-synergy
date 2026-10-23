import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, copyFile, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { openDb, closeDb } from '@team-synergy/persistence';

test('0041 and 0042 preserve historical payloads and receipts while allowing isolated material-only bindings', async () => {
  const base = new URL(process.env.TSP_TEST_DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/team_synergy_test');
  assert.equal(base.pathname, '/team_synergy_test', 'migration verification must start from the isolated test configuration');
  base.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: base.toString() }); await admin.connect();
  const databaseName = `tsp_intake_migration_${randomUUID().replaceAll('-', '')}`;
  const migrations = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../persistence/drizzle');
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'tsp-intake-migrations-'));
  let db;
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    const databaseUrl = new URL(base); databaseUrl.pathname = `/${databaseName}`;
    await mkdir(path.join(scratch, 'meta'));
    const journal = JSON.parse(await readFile(path.join(migrations, 'meta', '_journal.json'), 'utf8'));
    journal.entries = journal.entries.filter(entry => entry.tag < '0041_intake_quality_gate');
    await writeFile(path.join(scratch, 'meta', '_journal.json'), JSON.stringify(journal));
    for (const file of await readdir(migrations)) if (file.endsWith('.sql') && file < '0041_intake_quality_gate.sql') await copyFile(path.join(migrations, file), path.join(scratch, file));
    db = await openDb({ databaseUrl: databaseUrl.toString(), migrationsFolder: scratch });
    const original = (await db.$client.query(`INSERT INTO intake_batches(project_id,repository_id,namespace,created_by,source_json,payload_hash,submit_key,submit_hash,status,revision,plan_hash,created_at,updated_at)
      VALUES(1,2,'legacy',3,'{"complete":false}','old-payload','old-submit','old-submit-hash','applying',4,'old-plan','t0','t1') RETURNING *`)).rows[0];
    const receipt = (await db.$client.query(`INSERT INTO intake_items(batch_id,item_key,kind,item_json,decision_json,status,target_code)
      VALUES($1,'document','requirement_document','{"title":"Original"}','{"key":"document","action":"create"}','applied','00000000000000000001') RETURNING *`, [original.id])).rows[0];
    const attempt = (await db.$client.query(`INSERT INTO intake_attempts(batch_id,idempotency_key,plan_hash,principal_id,status,results_json,created_at)
      VALUES($1,'resume-key','old-plan',3,'running','[{"key":"document","status":"applied"}]','t1') RETURNING *`, [original.id])).rows[0];
    const binding = (await db.$client.query(`INSERT INTO intake_bindings(project_id,repository_id,namespace,kind,source_key,target_code,target_fingerprint,batch_id,created_at)
      VALUES(1,2,'legacy','requirement_document','document','00000000000000000001','original-fingerprint',$1,'t1') RETURNING *`, [original.id])).rows[0];
    await closeDb(db); db = await openDb({ databaseUrl: databaseUrl.toString(), migrationsFolder: migrations });
    const migrated = (await db.$client.query('SELECT * FROM intake_batches WHERE id=$1', [original.id])).rows[0];
    for (const field of ['profile', 'quality_rule_version', 'quality_report_json', 'frozen_quality_json']) assert.equal(migrated[field], null);
    const { profile: _profile, quality_rule_version: _rule, quality_report_json: _report, frozen_quality_json: _frozen, ...preserved } = migrated;
    assert.deepEqual(preserved, original);
    assert.deepEqual((await db.$client.query('SELECT * FROM intake_items')).rows, [receipt]);
    assert.deepEqual((await db.$client.query('SELECT * FROM intake_attempts')).rows, [attempt]);
    assert.deepEqual((await db.$client.query('SELECT * FROM intake_bindings')).rows, [binding]);
    await closeDb(db); db = await openDb({ databaseUrl: databaseUrl.toString(), migrationsFolder: migrations });
    assert.deepEqual((await db.$client.query('SELECT * FROM intake_batches')).rows, [migrated], 'migration rerun cannot backfill guesses or alter receipts');
    const materialBatch = (await db.$client.query(`INSERT INTO intake_batches(project_id,repository_id,namespace,created_by,source_json,payload_hash,submit_key,submit_hash,status,created_at,updated_at)
      VALUES(1,NULL,'legacy',3,'{"mode":"materials"}','material-payload','material-submit','material-submit-hash','draft','t2','t2') RETURNING *`)).rows[0];
    const insertMaterial = `INSERT INTO intake_bindings(project_id,repository_id,namespace,kind,source_key,target_code,target_fingerprint,batch_id,created_at)
      VALUES($1,NULL,$2,'requirement_document','document','00000000000000000002','material-fingerprint',$3,'t2') RETURNING *`;
    const materialBinding = (await db.$client.query(insertMaterial, [1, 'legacy', materialBatch.id])).rows[0];
    assert.equal(materialBinding.repository_id, null, 'material and repository identities may share stable keys');
    await assert.rejects(db.$client.query(insertMaterial, [1, 'legacy', materialBatch.id]), error => error.code === '23505' && error.constraint === 'uq_intake_bindings_material_source');
    await db.$client.query(insertMaterial, [1, 'other-materials', materialBatch.id]);
    await db.$client.query(insertMaterial, [2, 'legacy', materialBatch.id]);
    const indexes = (await db.$client.query(`SELECT indexname FROM pg_indexes WHERE tablename='intake_bindings'`)).rows.map(row => row.indexname);
    assert(indexes.includes('uq_intake_bindings_source')); assert(indexes.includes('uq_intake_bindings_material_source'));
  } finally {
    if (db) await closeDb(db);
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`); await admin.end();
    const resolved = path.resolve(scratch);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir())); assert.ok(path.basename(resolved).startsWith('tsp-intake-migrations-'));
    await rm(resolved, { recursive: true, force: true });
  }
});
