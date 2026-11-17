import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { withIntegrityFixture } from '../../../scripts/orphan-fixture.mjs';
import { reconcileProjectMaterialIndexes } from '@team-synergy/application';
import { projectNextMemory } from '../dist/memory-engines.js';

const baseUrl = process.env.TSP_TEST_DATABASE_URL;

async function withEngines(t, project, work) {
  const raw = new Map(), pages = new Map(), messages = new Map();
  const calls = { rawWrites: 0, pageWrites: 0, coreAdds: 0 };
  const hooks = {};
  const app = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    let data;
    switch (request.url) {
      case '/wiki/get':
        data = { wiki_id: 'test-wiki', team_id: 'test-team', name: 'tsp-memory-' + project, status: hooks.wikiState ?? 'ready' }; break;
      case '/wiki/raw/ls':
        data = { items: [...raw.keys()].map(filename => ({ filename, status: 'ingested' })) }; break;
      case '/wiki/raw/read':
        data = { items: body.filenames.map(filename => raw.has(filename) ? { filename, content: raw.get(filename) } : { filename, not_found: true }) }; break;
      case '/wiki/page/read':
        data = { items: body.refs.map(ref => pages.has(ref) ? { ref, content: pages.get(ref) } : { ref, not_found: true }) }; break;
      case '/wiki/raw/write':
        for (const file of body.files) { assert.equal(file.encoding, 'utf8'); raw.set(file.filename, file.content); }
        calls.rawWrites++;
        if (hooks.afterRawWrite) await hooks.afterRawWrite();
        data = {}; break;
      case '/wiki/page/write':
        for (const page of body.pages) pages.set(page.ref, page.content);
        calls.pageWrites++; if (hooks.afterPageWrite) await hooks.afterPageWrite(); data = {}; break;
      case '/wiki/page/rm':
        for (const ref of body.refs) pages.delete(ref); data = {}; break;
      case '/wiki/page/ls':
        data = { items: [...pages.keys()].map(path => ({ path })) }; break;
      case '/wiki/raw/rm':
        for (const filename of body.filenames) raw.delete(filename); data = {}; break;
      case '/conversation/delete':
        for (const [key, rows] of messages) messages.set(key, rows.filter(row => !body.message_ids.includes(row.id)));
        data = {}; break;
      case '/wiki/search':
        data = { results: [...pages].filter(([, content]) => content.includes(body.query)).map(([path]) => ({ path })) }; break;
      case '/conversation/query': {
        const rows = messages.get(body.session_id) ?? [];
        data = { messages: rows, total: rows.length }; break;
      }
      case '/conversation/add':
        assert.equal(body.messages.length, 1);
        messages.set(body.session_id, body.messages.map((row, n) => ({ ...row, id: 'message-' + n }))); calls.coreAdds++;
        data = { accepted_ids: ['accepted-' + calls.coreAdds] }; break;
      default:
        response.writeHead(404).end(); return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ code: 0, data }));
  });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(() => new Promise(resolve => app.close(resolve)));
  const url = 'http://127.0.0.1:' + app.address().port;
  const config = { tencent: { baseUrl: url, coreBaseUrl: url, token: 'test', serviceId: 'test' },
    openviking: { baseUrl: url }, accounts: {},
    projects: { [project]: { teamId: 'test-team', userId: 'test-writer', wikiId: 'test-wiki', semanticAgentId: 'test-agent' } } };
  return work({ config, raw, pages, messages, calls, hooks });
}

async function seedDocument(db, text, revision = 1) {
  const q = (sql, values = []) => db.$client.query(sql, values).then(result => result.rows[0]);
  const project = await q("select id,code from projects where name='Fixture A'");
  const author = await q("select id,code from users where account='integrity.fixture'");
  const doc = await q(`insert into project_documents
    (project_id,title,content,revision,status,created_by,created_at,updated_by,updated_at)
    values ($1,'中文部署说明',$2,$3,'active',$4,'t0',$4,'t0') returning id,code`, [project.id, text, revision, author.id]);
  const version = await addRevision(db, doc.id, author.id, revision, text);
  await reconcileProjectMaterialIndexes(db, project.id);
  return { project, author, doc, version, q };
}

async function addRevision(db, document, author, revision, text) {
  const { rows } = await db.$client.query(`insert into project_document_revisions
    (document_id,revision,title,content,change_summary,created_by,created_at)
    values ($1,$2,'中文部署说明',$3,'测试修订',$4,'t0') returning id,code`, [document, revision, text, author]);
  return rows[0];
}

test('native material indexing writes only a bounded directory card and safely reconciles a leased replay', { skip: !baseUrl }, async t =>
  withIntegrityFixture(baseUrl, 'documentindex', async db => {
    const text = '# 中文部署说明\n' + '必须检查中文与上下游。\n'.repeat(300) + 'BODY_ONLY_CANARY';
    const { project, version } = await seedDocument(db, text);
    await withEngines(t, project.code, async fx => {
      fx.hooks.wikiState = 'draft'; // Fresh metadata-only Wikis never need raw ingestion.
      const first = await projectNextMemory(db, fx.config);
      assert.equal(first.status, 'synced'); assert.equal(first.sourceKind, 'project_material'); assert.equal(first.source, version.code);
      assert.equal(fx.raw.size, 0); assert.equal(fx.calls.coreAdds, 1);
      const page = [...fx.pages.values()][0];
      assert.ok(page.length < 2500); assert.match(page, /tsp-project-material-index\/v1/); assert.doesNotMatch(page, /BODY_ONLY_CANARY/);
      assert.match([...fx.messages.values()][0][0].content, /tsp-material-index/);
      await db.$client.query("update memory_projection_jobs set status='processing',lease_until=now()-interval '1 second'");
      assert.equal((await projectNextMemory(db, fx.config)).status, 'synced');
      assert.deepEqual(fx.calls, { rawWrites: 0, pageWrites: 1, coreAdds: 1 });
      assert.equal(await projectNextMemory(db, fx.config), null);
    });
  }));

test('a large document remains intact in PG while Wiki and Core contain the same bounded abstract', { skip: !baseUrl }, async t =>
  withIntegrityFixture(baseUrl, 'documentindexlarge', async db => {
    const text = '实现方案与验证边界。\n'.repeat(1000) + 'TAIL_NOT_INDEXED';
    const { project, version } = await seedDocument(db, text);
    await withEngines(t, project.code, async fx => {
      assert.equal((await projectNextMemory(db, fx.config)).status, 'synced');
      assert.equal(fx.raw.size, 0); assert.equal(fx.calls.coreAdds, 1);
      assert.doesNotMatch([...fx.pages.values()][0], /TAIL_NOT_INDEXED/);
      assert.doesNotMatch([...fx.messages.values()][0][0].content, /TAIL_NOT_INDEXED/);
      assert.equal((await db.$client.query('select content from project_document_revisions where id=$1', [version.id])).rows[0].content, text);
    });
  }));

test('Unicode title bounds never change the authoritative native revision', { skip: !baseUrl }, async t =>
  withIntegrityFixture(baseUrl, 'documentindextitle', async db => {
    const { project, doc, version } = await seedDocument(db, 'Title evidence');
    const title = '前' + '😀'.repeat(1000);
    await db.$client.query('update project_documents set title=$1 where id=$2', [title, doc.id]);
    await db.$client.query('update project_document_revisions set title=$1 where id=$2', [title, version.id]);
    await reconcileProjectMaterialIndexes(db, project.id);
    await withEngines(t, project.code, async fx => {
      // The retired, never-delivered initial metadata job is cleaned before the current one.
      let current; for (let n = 0; n < 3; n++) { const item = await projectNextMemory(db, fx.config); if (!item) break; if (item.operation === 'upsert' && item.status === 'synced') current = item; }
      assert.ok(current);
      const page = [...fx.pages.values()][0]; assert.ok(page.length < 3000); assert.ok(!/[\uD800-\uDBFF]$/.test(page));
      assert.equal((await db.$client.query('select title from project_document_revisions where id=$1', [version.id])).rows[0].title, title);
    });
  }));

test('a replaced index lease cannot acknowledge a newer attempt or duplicate verified copies', { skip: !baseUrl }, async t =>
  withIntegrityFixture(baseUrl, 'documentindexlease', async db => {
    const { project } = await seedDocument(db, '租约变更保留原文。');
    await withEngines(t, project.code, async fx => {
      fx.hooks.afterPageWrite = () => db.$client.query("update memory_projection_jobs set attempts=attempts+1,lease_until=now()+interval '2 minutes' where operation='upsert'");
      assert.equal((await projectNextMemory(db, fx.config)).status, 'lease_changed');
      const state = (await db.$client.query('select status,attempts,external_ref from memory_projection_jobs')).rows[0];
      assert.deepEqual(state, { status: 'processing', attempts: 2, external_ref: null });
      await db.$client.query("update memory_projection_jobs set lease_until=now()-interval '1 second'");
      assert.equal((await projectNextMemory(db, fx.config)).status, 'synced');
      assert.deepEqual(fx.calls, { rawWrites: 0, pageWrites: 1, coreAdds: 1 });
    });
  }));

test('remote card mutation fails reconciliation without overwriting unknown content', { skip: !baseUrl }, async t =>
  withIntegrityFixture(baseUrl, 'documentindexmutated', async db => {
    const { project } = await seedDocument(db, '需要核验的目录来源。');
    await withEngines(t, project.code, async fx => {
      assert.equal((await projectNextMemory(db, fx.config)).status, 'synced');
      const key = [...fx.pages.keys()][0]; fx.pages.set(key, 'remote changed');
      await db.$client.query("update memory_projection_jobs set status='pending'");
      const result = await projectNextMemory(db, fx.config);
      assert.equal(result.status, 'needs_reconcile'); assert.equal(result.code, 'remote_content_changed'); assert.equal(fx.pages.get(key), 'remote changed');
    });
  }));

test('legacy pending full-body upserts are never executed by the new worker', { skip: !baseUrl }, async t =>
  withIntegrityFixture(baseUrl, 'documentindexlegacy', async db => {
    const { project, version } = await seedDocument(db, '旧全文任务不得再被投递。');
    await db.$client.query("delete from memory_projection_jobs where material_index_id is not null");
    await db.$client.query("insert into memory_projection_jobs(project_document_revision_id,engine) values($1,'tencent')", [version.id]);
    await withEngines(t, project.code, async fx => {
      assert.equal(await projectNextMemory(db, fx.config), null);
      assert.deepEqual(fx.calls, { rawWrites: 0, pageWrites: 0, coreAdds: 0 });
    });
  }));

test('legacy mixed-source bodies remain visible as cleanup pending and are never silently removed by cascade', { skip: !baseUrl }, async t =>
  withIntegrityFixture(baseUrl, 'documentindexmixed', async db => {
    const text = '既有全文副本与其他来源混合的派生页。';
    const { project, version } = await seedDocument(db, text);
    await db.$client.query('delete from memory_projection_jobs');
    await db.$client.query("insert into memory_projection_jobs(project_document_revision_id,engine,operation,attempts) values($1,'tencent','delete',1)", [version.id]);
    await withEngines(t, project.code, async fx => {
      const filename = 'tsp-' + version.code + '-' + createHash('sha256').update(text).digest('hex') + '.md';
      fx.raw.set(filename, text);
      fx.pages.set('wiki/mixed.md', `---\nsources:\n  - ${filename}\n  - unrelated.md\n---\n\nMixed retained source`);
      const first = await projectNextMemory(db, fx.config);
      assert.equal(first.status, 'needs_reconcile'); assert.equal(first.code, 'legacy_cleanup_pending');
      assert.equal(fx.raw.get(filename), text); assert.equal(fx.pages.has('wiki/mixed.md'), true);
      assert.equal(fx.calls.rawWrites, 0);
      // A reviewed rebuild removes the mixed page; the same source-specific cleanup can then finish.
      fx.pages.delete('wiki/mixed.md');
      await db.$client.query("update memory_projection_jobs set lease_until=now()-interval '1 second'");
      assert.equal((await projectNextMemory(db, fx.config)).status, 'synced');
      assert.equal(fx.raw.has(filename), false);
    });
  }));
