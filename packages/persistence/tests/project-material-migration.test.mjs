import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { openDb, closeDb } from '../dist/index.js';
import { seedIntegrityFixture } from '../../../scripts/orphan-fixture.mjs';
import { createTestFixture } from '../../../scripts/test-database-guard.mjs';

test('0059 upgrades preserve native documents, legacy jobs and explicit pauses while allowing system-owned indexes', async () => {
  const owned = await createTestFixture('materialupgrade');
  const source = fileURLToPath(new URL('../drizzle/', import.meta.url));
  const folder = await mkdtemp(path.join(tmpdir(), 'tsp-material-upgrade-'));
  let db;
  try {
    const journal = JSON.parse(await readFile(path.join(source, 'meta/_journal.json'), 'utf8'));
    const entries = journal.entries.filter(row => Number(row.tag.slice(0, 4)) <= 59);
    await mkdir(path.join(folder, 'meta'));
    await writeFile(path.join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
    for (const row of entries) await copyFile(path.join(source, row.tag + '.sql'), path.join(folder, row.tag + '.sql'));
    db = await openDb({ databaseUrl: owned.databaseUrl, migrationsFolder: folder });
    await seedIntegrityFixture(db);
    const q = (sql, values = []) => db.$client.query(sql, values).then(result => result.rows);
    const [project] = await q("select id from projects where name='Fixture A'");
    const [other] = await q("select id from projects where name='Fixture B'");
    const [owner] = await q("select id from users where account='integrity.fixture'");
    const [document] = await q("insert into project_documents(project_id,title,content,created_by,updated_by,updated_at,created_at) values($1,'Original','Canonical body',$2,$2,now(),now()) returning id", [project.id, owner.id]);
    const [revision] = await q("insert into project_document_revisions(document_id,revision,title,content,change_summary,created_by,created_at) values($1,1,'Original','Canonical body','Initial',$2,now()) returning id,code", [document.id, owner.id]);
    await q("insert into memory_projection_jobs(project_document_revision_id,engine,status,attempts) values($1,'tencent','processing',2)", [revision.id]);
    await q("insert into project_memory_bindings(project_id,enabled,state,generation,updated_by) values($1,false,'provisioning',7,$2)", [project.id, owner.id]);
    await closeDb(db); db = await openDb({ databaseUrl: owned.databaseUrl, migrationsFolder: source });
    assert.deepEqual(await q('select title,content from project_documents where id=$1', [document.id]), [{ title: 'Original', content: 'Canonical body' }]);
    assert.deepEqual(await q('select enabled,generation,updated_source,updated_by from project_memory_bindings'),
      [{ enabled: false, generation: 7, updated_source: 'member', updated_by: owner.id }]);
    assert.deepEqual(await q('select status,attempts,material_index_id from memory_projection_jobs'), [{ status: 'processing', attempts: 2, material_index_id: null }]);
    await q("insert into project_memory_bindings(project_id,enabled,state,updated_source,updated_by) values($1,true,'provisioning','system',null)", [other.id]);
    await assert.rejects(q("update project_memory_bindings set updated_source='member' where project_id=$1", [other.id]), { code: '23514' });
    const [index] = await q(`insert into project_material_index_versions(project_id,source_kind,object_code,revision,revision_code,metadata_hash,source_citation,path,title,summary,summary_origin,text_searchable)
      select $1,'project',d.code,1,r.code,repeat('a',64),r.code,'project/'||d.code||'.md',d.title,'Short index only','authored',true
      from project_documents d join project_document_revisions r on r.document_id=d.id where r.id=$2 returning id`, [project.id, revision.id]);
    await q("insert into memory_projection_jobs(material_index_id,engine) values($1,'tencent')", [index.id]);
    await assert.rejects(q("insert into memory_projection_jobs(material_index_id,project_document_revision_id,engine) values($1,$2,'tencent')", [index.id, revision.id]), { code: '23514' });
    await assert.rejects(q("insert into memory_projection_jobs(material_index_id,engine) values($1,'openviking')", [index.id]), { code: '23514' });
  } finally {
    if (db) await closeDb(db);
    await owned.dispose();
    assert.equal(path.dirname(path.resolve(folder)), path.resolve(tmpdir()));
    assert.ok(path.basename(folder).startsWith('tsp-material-upgrade-'));
    await rm(folder, { recursive: true, force: true });
  }
});
