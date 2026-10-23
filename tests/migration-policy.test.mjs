import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectMigration, checkMigrations } from '../scripts/check-migrations.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

test('migration gates reject combined expansion/contract and concurrent transaction DDL',()=>{
 assert.ok(inspectMigration('ALTER TABLE tasks ADD COLUMN new_name text NOT NULL; ALTER TABLE tasks DROP COLUMN old_name;').length);
 assert.ok(inspectMigration('ALTER TABLE t ADD foo text NOT NULL, DROP old;').length);
 assert.ok(inspectMigration('DO $$ BEGIN ALTER TABLE t ADD x text NOT NULL; ALTER TABLE t DROP y; END $$;').length);
 assert.ok(inspectMigration('CREATE INDEX CONCURRENTLY idx ON tasks(id);').length);
 assert.deepEqual(inspectMigration('ALTER TABLE tasks ADD COLUMN new_name text;'),[]);
 assert.deepEqual(inspectMigration('ALTER TABLE tasks DROP COLUMN old_name;'),[]);
});
test('policy inventory detects new violations, changed history and missing registration',()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'tsp-migration-policy-'));
 try {
  const migrations=path.join(root,'packages/persistence/drizzle');
  mkdirSync(path.join(migrations,'meta'),{recursive:true});mkdirSync(path.join(root,'scripts'));
  const old='SELECT 1;';
  writeFileSync(path.join(migrations,'0000_old.sql'),old);
  writeFileSync(path.join(root,'scripts/migration-policy-baseline.json'),JSON.stringify({'0000_old.sql':createHash('sha256').update(old).digest('hex')}));
  writeFileSync(path.join(migrations,'meta/_journal.json'),JSON.stringify({entries:[{tag:'0000_old',when:1},{tag:'0001_new',when:2}]}));
  writeFileSync(path.join(migrations,'0001_new.sql'),'ALTER TABLE t ADD x text NOT NULL; ALTER TABLE t DROP COLUMN y;');
  assert.ok(checkMigrations(root).issues.some(i=>i.includes('expand/contract')));
  writeFileSync(path.join(migrations,'0001_new.sql'),'ALTER TABLE t ADD x text;');assert.equal(checkMigrations(root).issues.length,0);
  writeFileSync(path.join(migrations,'0000_old.sql'),'SELECT 2;');assert.ok(checkMigrations(root).issues.some(i=>i.includes('historical migration changed')));
  writeFileSync(path.join(migrations,'0002_unregistered.sql'),'SELECT 1;');assert.ok(checkMigrations(root).issues.some(i=>i.includes('not registered')));
 }finally{
  assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('tsp-migration-policy-'));
  rmSync(root,{recursive:true,force:true});
 }
});
test('comments, quoted contents and dollar function bodies never act as DDL',()=>{
 assert.deepEqual(inspectMigration("-- DROP COLUMN old;\nALTER TABLE t ADD COLUMN name text NOT NULL DEFAULT 'DROP TABLE t';"),[]);
 assert.deepEqual(inspectMigration('/* outer /* CREATE INDEX CONCURRENTLY */ end */ SELECT 1;'),[]);
 assert.deepEqual(inspectMigration('CREATE FUNCTION f() RETURNS text AS $body$ BEGIN RETURN \'CONCURRENTLY DROP COLUMN\'; END $body$ LANGUAGE plpgsql;'),[]);
 assert.deepEqual(inspectMigration('CREATE INDEX "CONCURRENTLY" ON t(id);'),[]);
});
