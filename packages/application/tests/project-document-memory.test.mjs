import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { sql } from 'drizzle-orm';
import { checkDatabaseIntegrity } from '@team-synergy/persistence';
import { createProjectDocumentUseCases, createProjectUseCasesProject, createSystemAgentUseCases } from '../dist/index.js';
import { enqueueProjectDocumentMemory } from '../dist/project-document-memory.js';
import { lockAggregate } from '../dist/aggregate-lock.js';
import { withIntegrityFixture } from '../../../scripts/orphan-fixture.mjs';

const baseUrl = process.env.TSP_TEST_DATABASE_URL;
const unwrap = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.data; };
async function setup(db) {
  const q = (text, values = []) => db.$client.query(text, values).then(result => result.rows);
  const [project] = await q("select * from projects where name='Fixture A'");
  const [user] = await q("select * from users where account='integrity.fixture'");
  return { q, project, user, docs: createProjectDocumentUseCases(db), actor: { projectCode: project.code, principalCode: user.code } };
}

test('native document create, concurrent revise, archive and restore enqueue exactly one immutable source per revision', { skip: !baseUrl }, async () =>
  withIntegrityFixture(baseUrl, 'docmemorywrites', async db => {
    const { q, docs, actor } = await setup(db);
    const created = unwrap(await docs.createDocument({ ...actor, kind: 'doc', title: 'Project context', content: '# Context\r\n\r\nOriginal source.' }));
    const command = { documentCode: created.document_code, principalCode: actor.principalCode, baseRevision: 1, title: 'Project context', changeSummary: 'Update context' };
    const edits = await Promise.all(['First', 'Second'].map(content => docs.reviseDocument({ ...command, content })));
    assert.equal(edits.filter(result => result.ok).length, 1);
    assert.equal(edits.find(result => !result.ok).error.code, 'project_document_revision_conflict');
    const current = unwrap(await docs.getDocument(created.document_code, actor.principalCode));
    await docs.reviseDocument({ ...command, baseRevision: 2, content: current.content, status: 'archived' }).then(unwrap);
    await docs.reviseDocument({ ...command, baseRevision: 3, content: current.content, status: 'active' }).then(unwrap);
    const rows = await q(`select r.id,r.code,r.revision,r.content,j.fragment_id,j.engine,j.status
      from project_document_revisions r join project_documents d on d.id=r.document_id
      left join project_material_index_versions v on v.revision_code=r.code left join memory_projection_jobs j on j.material_index_id=v.id
      where d.code=$1 order by r.revision`, [created.document_code]);
    assert.deepEqual(rows.map(row => row.revision), [1, 2, 3, 4]);
    assert.ok(rows.filter(row => row.revision !== 3).every(row => row.fragment_id === null && row.engine === 'tencent' && row.status === 'pending'));
    assert.equal(rows[2].engine, null, 'an archived revision does not create a live index');
    assert.equal(rows[0].content, '# Context\n\nOriginal source.');
    await enqueueProjectDocumentMemory(db, BigInt(rows[0].id));
    assert.equal((await q('select count(*)::int as count from memory_projection_jobs'))[0].count, 3);
    assert.equal((await q('select count(*)::int as count from memory_fragments'))[0].count, 0);
    const integrity = await checkDatabaseIntegrity(db);
    assert.equal(integrity.total_orphans, 0, JSON.stringify(integrity.relations.filter(row => row.count)));
    assert.ok(integrity.relations.some(row => row.name.includes('memory_projection_jobs.project_document_revision_id')));
  }));

test('a document and its audit, revision and outbox roll back together if enqueue fails', { skip: !baseUrl }, async () =>
  withIntegrityFixture(baseUrl, 'docmemoryatomic', async db => {
    const { q, docs, actor } = await setup(db);
    const install = () => q(`create or replace function fail_document_memory() returns trigger language plpgsql as $$
      begin if new.material_index_id is not null then raise exception 'fixture_outbox_failure'; end if; return new; end $$;
      create trigger fail_document_memory before insert on memory_projection_jobs for each row execute function fail_document_memory()`);
    const counts = async () => (await q(`select (select count(*)::int from project_documents) as documents,
      (select count(*)::int from project_document_revisions) as revisions,
      (select count(*)::int from memory_projection_jobs) as jobs,
      (select count(*)::int from audit_events) as audits`))[0];
    const create = { ...actor, kind: 'doc', title: 'Atomic source', content: 'Current project context.' };
    const before = await counts();
    await install();
    assert.equal((await docs.createDocument(create)).ok, false);
    assert.deepEqual(await counts(), before);
    await q('drop trigger fail_document_memory on memory_projection_jobs');
    const document = unwrap(await docs.createDocument(create));
    const persisted = await counts();
    await install();
    assert.equal((await docs.reviseDocument({ documentCode: document.document_code, principalCode: actor.principalCode,
      baseRevision: 1, title: 'Changed title', content: 'Changed source', changeSummary: 'Must roll back' })).ok, false);
    assert.deepEqual(await counts(), persisted);
    const current = unwrap(await docs.getDocument(document.document_code, actor.principalCode));
    assert.equal(current.content, create.content);
    assert.equal(current.current_revision, 1);
  }));

test('native create waits for the project fence and rechecks a concurrent archive before creating any source', { skip: !baseUrl }, async () =>
  withIntegrityFixture(baseUrl, 'docmemoryarchivefence', async db => {
    const { q, docs, actor, project } = await setup(db);
    let creation;
    try {
      await db.transaction(async tx => {
        await lockAggregate(tx, 'project', BigInt(project.id));
        const { pid } = (await tx.execute(sql`select pg_backend_pid() as pid`)).rows[0];
        await tx.execute(sql`update projects set status='archived' where code=${project.code}`);
        // The preliminary read still sees the committed active project. Creation
        // must wait and then authorize against the archive committed by this tx.
        creation = docs.createDocument({ ...actor, kind: 'doc', title: 'Concurrent source', content: 'Must not be created after archive.' });
        const deadline = Date.now() + 8000;
        for (;;) {
          const [{ count }] = await q(`select count(*)::int as count from pg_stat_activity
            where datname=current_database() and wait_event='advisory' and $1=any(pg_blocking_pids(pid))`, [pid]);
          if (count === 1) break;
          assert.ok(Date.now() < deadline, 'Create must reach the held project fence before the archive commits');
          await delay(15);
        }
      });
      const rejected = await creation;
      assert.equal(rejected.ok, false);
      assert.equal(rejected.error.code, 'project_archived');
      const [counts] = await q(`select (select count(*)::int from project_documents) as documents,
        (select count(*)::int from project_document_revisions) as revisions,
        (select count(*)::int from memory_projection_jobs) as jobs`);
      assert.deepEqual(counts, { documents: 0, revisions: 0, jobs: 0 });
    } finally {
      if (creation) await creation;
    }
  }));

test('legacy overview writes and exact system-agent adoption use the same derived material index outbox', { skip: !baseUrl }, async () =>
  withIntegrityFixture(baseUrl, 'docmemorywriters', async db => {
    const { q, docs, actor } = await setup(db);
    const legacy = createProjectUseCasesProject(db);
    const overview = unwrap(await legacy.saveProjectDocument({ ...actor, title: 'Overview', content: '# Overview\n\nOriginal source.' }));
    unwrap(await legacy.saveProjectDocument({ ...actor, title: 'Overview', content: '# Overview\n\nLatest source.' }));
    const uc = createSystemAgentUseCases(db);
    const job = unwrap(await uc.createJob({ ...actor, documentCode: overview.document_code, baseRevision: 2,
      instruction: 'Clarify the existing source.', quote: 'Latest source.', requestKey: 'source-adoption' }));
    const execution = unwrap(await uc.claimNextJob({ executorId: 'document-memory-test' }));
    assert.equal(execution.job_code, job.job_code);
    const drafted = unwrap(await uc.completeJob({ jobCode: execution.job_code, executorId: 'document-memory-test', executionToken: execution.execution_token,
      proposal: { title: 'Overview', summary: 'Revised source', content: '# Overview\n\nClarified source.', rationale: 'Clarify the existing source.', evidence: ['Native revision 2'], warnings: [] } }));
    const adopt = { jobCode: job.job_code, principalCode: actor.principalCode, proposalHash: drafted.proposal_hash, baseRevision: 2 };
    await Promise.all([uc.applyJob(adopt), uc.applyJob(adopt)]).then(results => results.forEach(unwrap));
    const current = unwrap(await docs.getDocument(overview.document_code, actor.principalCode));
    assert.equal(current.current_revision, 3);
    const rows = await q(`select r.revision,count(j.id)::int as jobs from project_document_revisions r
      join project_documents d on d.id=r.document_id left join project_material_index_versions v on v.revision_code=r.code left join memory_projection_jobs j on j.material_index_id=v.id
      where d.code=$1 group by r.revision order by r.revision`, [overview.document_code]);
    assert.deepEqual(rows, [{ revision: 1, jobs: 1 }, { revision: 2, jobs: 1 }, { revision: 3, jobs: 1 }]);
  }));

test('document backfill is bounded to existing active current revisions and enforces a single Tencent source', { skip: !baseUrl }, async () =>
  withIntegrityFixture(baseUrl, 'docmemorybackfill', async db => {
    const { q, docs, actor, project } = await setup(db);
    const active = unwrap(await docs.createDocument({ ...actor, kind: 'doc', title: 'Active source', content: 'First source' }));
    unwrap(await docs.reviseDocument({ documentCode: active.document_code, principalCode: actor.principalCode, title: 'Active source', content: 'Current source', changeSummary: 'New revision' }));
    const archived = unwrap(await docs.createDocument({ ...actor, kind: 'doc', title: 'Archived source', content: 'Archived source' }));
    unwrap(await docs.reviseDocument({ documentCode: archived.document_code, principalCode: actor.principalCode, title: 'Archived source', content: 'Archived source', changeSummary: 'Archive', status: 'archived' }));
    const [other] = await q("select * from projects where name='Fixture B'");
    const inactive = unwrap(await docs.createDocument({ ...actor, projectCode: other.code, kind: 'doc', title: 'Inactive project', content: 'Inactive project source' }));
    await q("update projects set status='archived' where id=$1", [other.id]);
    await q('delete from memory_projection_jobs');
    const migration = readFileSync(new URL('../../persistence/drizzle/0055_project_document_memory.sql', import.meta.url), 'utf8');
    const backfill = migration.split('--> statement-breakpoint').at(-1);
    await q(backfill); await q(backfill);
    const rows = await q(`select d.code,r.revision,j.engine,j.fragment_id from memory_projection_jobs j
      join project_document_revisions r on r.id=j.project_document_revision_id join project_documents d on d.id=r.document_id`);
    assert.deepEqual(rows, [{ code: active.document_code, revision: 2, engine: 'tencent', fragment_id: null }]);
    assert.notEqual(active.document_code, inactive.document_code);
    const [revision] = await q('select r.id from project_document_revisions r join project_documents d on d.id=r.document_id where d.project_id=$1 order by r.id limit 1', [project.id]);
    await assert.rejects(q("insert into memory_projection_jobs(project_document_revision_id,engine) values($1,'openviking')", [revision.id]), { code: '23514' });
    await assert.rejects(q("insert into memory_projection_jobs(engine) values('tencent')"), { code: '23514' });
    await assert.rejects(q("insert into memory_projection_jobs(fragment_id,project_document_revision_id,engine) values(-1,$1,'tencent')", [revision.id]), { code: '23514' });
    await assert.rejects(q("insert into memory_projection_jobs(project_document_revision_id,engine) values(-1,'tencent')"), { code: '23503' });
  }));
