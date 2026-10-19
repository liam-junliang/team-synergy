import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, copyFile, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { openDb, closeDb } from '@team-synergy/persistence';
import { createAuthUseCases } from '../dist/index.js';

test('0037 preserves old device identity and execution secret while migrating the existing bearer into a session exactly once', async()=>{
 const base=new URL(process.env.ACP_TEST_DATABASE_URL??'postgres://postgres:postgres@127.0.0.1:5432/acp_test');base.pathname='/postgres';
 const admin=new pg.Client({connectionString:base.toString()});await admin.connect();
 const databaseName=`acp_device_migration_${randomUUID().replaceAll('-','')}`;
 const migrations=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../persistence/drizzle');
 const scratch=await mkdtemp(path.join(os.tmpdir(),'tsp-device-migrations-'));
 let db;
 try {
  await admin.query(`CREATE DATABASE "${databaseName}"`);const testUrl=new URL(base);testUrl.pathname=`/${databaseName}`;
  await mkdir(path.join(scratch,'meta'));
  const journal=JSON.parse(await readFile(path.join(migrations,'meta','_journal.json'),'utf8'));
  journal.entries=journal.entries.filter(entry=>entry.tag<'0037_device_sessions');
  await writeFile(path.join(scratch,'meta','_journal.json'),JSON.stringify(journal));
  for(const file of await readdir(migrations)) if(file.endsWith('.sql')&&file<'0037_device_sessions.sql')await copyFile(path.join(migrations,file),path.join(scratch,file));
  db=await openDb({databaseUrl:testUrl.toString(),migrationsFolder:scratch});
  const created='2026-10-01T01:02:03.000Z';const token='existing-deployed-token';const secret=createHash('sha256').update(token).digest('hex');
  const user=(await db.$client.query('INSERT INTO users(account,display_name,created_at) VALUES ($1,$2,$3) RETURNING id,code',['existing','Existing',created])).rows[0];
  const old=(await db.$client.query('INSERT INTO devices(principal_id,device_name,credential_hash,created_at) VALUES ($1,$2,$3,$4) RETURNING id,code',[user.id,'Prior CLI',secret,created])).rows[0];
  await closeDb(db);db=await openDb({databaseUrl:testUrl.toString(),migrationsFolder:migrations});
  const devices=(await db.$client.query('SELECT * FROM devices')).rows;assert.equal(devices.length,1);assert.equal(devices[0].id,old.id);assert.equal(devices[0].code,old.code);assert.equal(devices[0].credential_hash,secret);assert.equal(devices[0].last_login_at,created);
  const sessions=(await db.$client.query('SELECT * FROM device_sessions')).rows;assert.equal(sessions.length,1);assert.equal(sessions[0].device_id,old.id);assert.equal(sessions[0].token_hash,secret);
  const auth=createAuthUseCases(db);assert.equal((await auth.resolveToken(token)).ok,true);assert.equal((await auth.logout(token)).ok,true);assert.equal((await auth.resolveToken(token)).ok,false);
  await closeDb(db);db=await openDb({databaseUrl:testUrl.toString(),migrationsFolder:migrations});assert.equal((await createAuthUseCases(db).resolveToken(token)).ok,false,'migration rerun cannot revive logged-out bearer');
  assert.equal((await db.$client.query('SELECT count(*)::int AS count FROM device_sessions')).rows[0].count,1);
 } finally {
  if(db)await closeDb(db);
  await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);await admin.end();
  const resolved=path.resolve(scratch);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert.ok(path.basename(resolved).startsWith('tsp-device-migrations-'));
  await rm(resolved,{recursive:true,force:true});
 }
});
