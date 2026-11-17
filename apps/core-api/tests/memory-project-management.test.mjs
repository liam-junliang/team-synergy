import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { withIntegrityFixture } from '../../../scripts/orphan-fixture.mjs';
import { buildServer } from '../dist/server.js';
import { reconcileProjectMaterialIndexes } from '@team-synergy/application';
import { projectNextMemory } from '../dist/memory-engines.js';

const baseUrl = process.env.TSP_TEST_DATABASE_URL;

async function seed(db) {
  const q = (text, values = []) => db.$client.query(text, values).then(result => result.rows);
  const [project] = await q("select id,code from projects where name='Fixture A'");
  const [owner] = await q("select id,code from users where account='integrity.fixture'");
  const headers = {};
  for (const role of ['owner', 'member', 'viewer', 'outsider']) {
    const token = 'memory-management-' + role;
    const digest = createHash('sha256').update(token).digest('hex');
    if (role === 'owner') await q('update devices set credential_hash=$1 where principal_id=$2', [digest, owner.id]);
    else {
      const [user] = await q("insert into users(account,display_name,created_at) values($1,$1,'t0') returning id", ['management.' + role]);
      await q("insert into devices(principal_id,device_name,credential_hash,created_at) values($1,$2,$3,'t0')", [user.id, role, digest]);
      if (role !== 'outsider') await q("insert into members(project_id,principal_id,role,display_name,created_at) values($1,$2,$3,$3,'t0')", [project.id, user.id, role]);
    }
    headers[role] = { authorization: 'Bearer ' + token };
  }
  async function document(text, revision = 1, previous) {
    const doc = previous ?? (await q(`insert into project_documents(project_id,title,content,revision,status,created_by,created_at,updated_by,updated_at)
      values($1,'项目部署背景',$2,$3,'active',$4,'t0',$4,'t0') returning id,code`, [project.id, text, revision, owner.id]))[0];
    if (previous) await q('update project_documents set revision=$1,content=$2 where id=$3', [revision, text, doc.id]);
    const [version] = await q(`insert into project_document_revisions(document_id,revision,title,content,change_summary,created_by,created_at)
      values($1,$2,'项目部署背景',$3,'真实测试修订',$4,'t0') returning id,code`, [doc.id, revision, text, owner.id]);
    await reconcileProjectMaterialIndexes(db, project.id);
    return { doc, version };
  }
  return { q, project, owner, headers, document, root: `/projects/${project.code}/memory/management` };
}

async function withTencent(work) {
  const wikis = new Map(), raw = new Map(), pages = new Map(), messages = new Map(), requests = [], errors = [];
  const hooks = {};
  let creates = 0;
  const writer = { teamId: 'management-team', userId: 'management-writer', semanticAgentId: 'management-agent' };
  function addWiki(projectCode, wikiId = 'management-wiki-' + (++creates)) {
    const wiki = { wiki_id: wikiId, team_id: writer.teamId, owner_user_id: writer.userId, name: 'tsp-memory-' + projectCode, status: 'ready' };
    wikis.set(wikiId, wiki);
    return wiki;
  }
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push({ path: request.url, body });
      assert.equal(request.headers.authorization, 'Bearer management-service-token');
      assert.equal(request.headers['x-tdai-service-id'], 'management-service');
      const key = value => body.wiki_id + '/' + value;
      let data;
      switch (request.url) {
        case '/wiki/create': {
          assert.equal(body.team_id, writer.teamId);
          assert.equal(body.user_id, writer.userId);
          const existing = [...wikis.values()].find(wiki => wiki.name === body.name);
          data = existing ?? addWiki(body.name.slice('tsp-memory-'.length));
          break;
        }
        case '/wiki/get':
          if (hooks.wikiGetStatus) { response.writeHead(hooks.wikiGetStatus).end(); return; }
          if (!wikis.has(body.wiki_id)) { response.writeHead(404).end(); return; }
          if (hooks.beforeWikiGet) await hooks.beforeWikiGet();
          data = hooks.wikiIdentityMismatch ? { ...wikis.get(body.wiki_id), team_id: 'foreign-team' } : wikis.get(body.wiki_id); break;
        case '/wiki/raw/ls':
          data = { items: [...raw.keys()].filter(name => name.startsWith(body.wiki_id + '/')).map(name => ({ filename: name.slice(body.wiki_id.length + 1), status: 'ingested' })) }; break;
        case '/wiki/raw/read':
          data = { items: body.filenames.map(filename => raw.has(key(filename)) ? { filename, content: raw.get(key(filename)) } : { filename, not_found: true }) }; break;
        case '/wiki/page/read':
          data = { items: body.refs.map(ref => pages.has(key(ref)) ? { ref, content: pages.get(key(ref)) } : { ref, not_found: true }) }; break;
        case '/wiki/raw/write':
          for (const file of body.files) { assert.equal(file.encoding, 'utf8'); raw.set(key(file.filename), file.content); }
          if (hooks.afterRawWrite) await hooks.afterRawWrite();
          data = {}; break;
        case '/wiki/page/write':
          for (const page of body.pages) pages.set(key(page.ref), page.content);
          if (hooks.afterPageWrite) await hooks.afterPageWrite();
          data = {}; break;
        case '/wiki/search':
          data = { results: [...pages].filter(([name, content]) => name.startsWith(body.wiki_id + '/') && content.includes(body.query)).map(([name]) => ({ path: name.slice(body.wiki_id.length + 1) })) }; break;
        case '/wiki/page/rm':
          for (const ref of body.refs) pages.delete(key(ref)); data = {}; break;
        case '/conversation/query':
          data = { messages: messages.get(body.session_id) ?? [], total: (messages.get(body.session_id) ?? []).length }; break;
        case '/conversation/add':
          messages.set(body.session_id, body.messages.map((row, n) => ({ ...row, id: body.session_id + '-' + n }))); data = { accepted_ids: ['accepted'] }; break;
        case '/conversation/delete':
          for (const [session, rows] of messages) messages.set(session, rows.filter(row => !body.message_ids.includes(row.id)));
          data = {}; break;
        default: throw new Error('Unexpected Tencent request: ' + request.url);
      }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ code: 0, data }));
    } catch (error) { errors.push(error); response.writeHead(500).end(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = 'http://127.0.0.1:' + server.address().port;
  const config = { tencent: { baseUrl: url, coreBaseUrl: url, token: 'management-service-token', serviceId: 'management-service' },
    openviking: { baseUrl: url }, projects: {}, accounts: {}, projectProvisioning: writer };
  try {
    await work({ config, requests, hooks, wikis, raw, pages, messages, addWiki, creates: () => creates });
    assert.deepEqual(errors, []);
  } finally { await new Promise(resolve => server.close(resolve)); }
}

async function withApp(db, config, work) {
  const previousEnabled = process.env.TSP_MEMORY_ENABLED, previousFile = process.env.TSP_MEMORY_ENGINES_FILE;
  let folder, file, app;
  try {
    if (config) {
      folder = await mkdtemp(path.join(tmpdir(), 'tsp-memory-management-'));
      file = path.join(folder, 'engines.json');
      await writeFile(file, JSON.stringify(config));
    }
    process.env.TSP_MEMORY_ENABLED = '1';
    delete process.env.TSP_MEMORY_ENGINES_FILE;
    app = await buildServer({ db, logger: false, ...(file ? { memoryEnginesFile: file } : {}) });
    await work(app);
  } finally {
    if (previousEnabled === undefined) delete process.env.TSP_MEMORY_ENABLED; else process.env.TSP_MEMORY_ENABLED = previousEnabled;
    if (previousFile === undefined) delete process.env.TSP_MEMORY_ENGINES_FILE; else process.env.TSP_MEMORY_ENGINES_FILE = previousFile;
    if (app) await app.close();
    if (file) await unlink(file);
    if (folder) await rmdir(folder);
  }
}

async function request(app, fixture, method = 'GET', action = '', role = 'owner', payload = {}) {
  return app.inject({ method, url: fixture.root + (action ? '/' + action : ''), ...(role ? { headers: fixture.headers[role] } : {}), ...(method === 'POST' ? { payload } : {}) });
}
function ok(response) { assert.equal(response.statusCode, 200, response.body); assert.equal(response.headers['cache-control'], 'no-store'); return response.json().data; }

test('HTTP enable provisions an unmapped project once, pause stops claims, and resume reuses the resource', { skip: !baseUrl }, async () =>
  withIntegrityFixture(baseUrl, 'memoryhttpenable', async db => {
    const f = await seed(db), text = '# 部署背景\r\n\r\n发布前必须检查上下游兼容。\r\n';
    const first = await f.document(text);
    await withTencent(async fx => withApp(db, fx.config, async app => {
      const initial = ok(await request(app, f));
      assert.equal(initial.bindingState, 'not_enabled');
      assert.equal(initial.enabled, false);
      assert.equal(initial.counts.pending, 1);
      for (const response of await Promise.all([request(app, f, 'POST', 'enable'), request(app, f, 'POST', 'enable')])) {
        assert.ok(['ready', 'provisioning'].includes(ok(response).bindingState));
      }
      const enabled = ok(await request(app, f));
      assert.equal(enabled.bindingState, 'ready');
      assert.equal(enabled.retrievalEnabled, true);
      assert.equal(enabled.counts.pending, 1);
      assert.equal(enabled.documents[0].source, first.version.code);
      for (const response of await Promise.all([request(app, f, 'POST', 'enable'), request(app, f, 'POST', 'enable')])) assert.equal(ok(response).bindingState, 'ready');
      assert.equal(fx.requests.filter(item => item.path === '/wiki/create').length, 1);
      assert.deepEqual(fx.config.projects, {});
      const [binding] = await f.q('select wiki_id,engine_user_id from project_memory_bindings');
      assert.equal(binding.wiki_id, 'management-wiki-1');
      assert.equal(binding.engine_user_id, fx.config.projectProvisioning.userId);
      assert.doesNotMatch(JSON.stringify(enabled), /management-wiki|management-writer|management-service-token|发布前必须/);
      assert.equal((await projectNextMemory(db, fx.config)).status, 'synced');
      assert.equal(fx.raw.size, 0, 'native document bodies are not ingested');
      assert.equal(ok(await request(app, f)).counts.synced, 1);
      assert.equal(ok(await request(app, f, 'POST', 'pause')).retrievalEnabled, false);
      const next = await f.document('当前版本：发布后还要执行回滚演练。', 2, first.doc);
      await f.q("insert into memory_projection_jobs(project_document_revision_id,engine) values($1,'tencent')", [next.version.id]);
      const outbound = fx.requests.length;
      assert.equal(await projectNextMemory(db, fx.config), null);
      assert.equal(fx.requests.length, outbound);
      assert.deepEqual((await f.q('select status,attempts from memory_projection_jobs where material_index_id in (select v.id from project_material_index_versions v join project_document_revisions r on r.code=v.revision_code where r.id=$1)', [next.version.id]))[0], { status: 'pending', attempts: 0 });
      assert.equal(ok(await request(app, f, 'POST', 'enable')).retrievalEnabled, true);
      assert.equal(fx.requests.filter(item => item.path === '/wiki/create').length, 1);
      let projected;
      for (let n = 0; n < 5; n++) {
        projected = await projectNextMemory(db, fx.config);
        if (projected?.operation !== 'delete') break;
      }
      assert.equal(projected.status, 'synced');
      assert.equal(projected.source, next.version.code);
      const current = ok(await request(app, f));
      assert.equal(current.documents[0].currentRevision, 2);
      assert.equal(current.counts.synced, 1);
    }));
  }));

test('a persisted HTTP pause overrides a legacy static mapping and resume adopts the same Wiki', { skip: !baseUrl }, async () =>
  withIntegrityFixture(baseUrl, 'memoryhttplegacy', async db => {
    const f = await seed(db), { version } = await f.document('旧版配置的项目背景。');
    await f.q("insert into memory_projection_jobs(project_document_revision_id,engine) values($1,'tencent')", [version.id]);
    await withTencent(async fx => {
      const wiki = fx.addWiki(f.project.code, 'legacy-project-wiki');
      fx.config.projects[f.project.code] = { ...fx.config.projectProvisioning, wikiId: wiki.wiki_id };
      await withApp(db, fx.config, async app => {
        assert.equal(ok(await request(app, f)).retrievalEnabled, true);
        const paused = ok(await request(app, f, 'POST', 'pause'));
        assert.equal(paused.enabled, false);
        assert.equal(paused.retrievalEnabled, false);
        assert.equal(await projectNextMemory(db, fx.config), null);
        assert.equal(fx.requests.length, 0);
        assert.equal((await f.q('select attempts from memory_projection_jobs'))[0].attempts, 0);
        assert.equal(ok(await request(app, f, 'POST', 'enable')).retrievalEnabled, true);
        assert.equal(fx.requests.filter(item => item.path === '/wiki/create').length, 0);
        assert.equal((await f.q('select wiki_id from project_memory_bindings'))[0].wiki_id, 'legacy-project-wiki');
        assert.equal((await projectNextMemory(db, fx.config)).status, 'synced');
      });
    });
  }));

test('retry replaces a missing legacy Wiki with a persisted binding without changing static configuration', { skip: !baseUrl }, async () =>
  withIntegrityFixture(baseUrl, 'memoryhttplegacyrepair', async db => {
    const f = await seed(db), text = '静态 Wiki 丢失后也应从同一份不可变文档恢复。';
    const { version } = await f.document(text);
    await withTencent(async fx => {
      const legacy = fx.addWiki(f.project.code, 'legacy-missing-wiki');
      fx.config.projects[f.project.code] = { ...fx.config.projectProvisioning, wikiId: legacy.wiki_id };
      delete fx.config.projectProvisioning;
      const originalMapping = JSON.stringify(fx.config.projects);
      await withApp(db, fx.config, async app => {
        await f.q("insert into memory_projection_jobs(project_document_revision_id,engine) values($1,'tencent')", [version.id]);
        assert.equal((await projectNextMemory(db, fx.config)).status, 'synced');
        assert.equal((await f.q('select count(*)::int as count from project_memory_bindings'))[0].count, 0);
        fx.wikis.delete(legacy.wiki_id);
        const repaired = ok(await request(app, f, 'POST', 'retry'));
        assert.equal(repaired.bindingState, 'ready');
        assert.equal(repaired.retrievalEnabled, true);
        assert.equal(repaired.counts.pending, 1);
        assert.equal(repaired.documents[0].source, version.code);
        const [after] = await f.q('select wiki_id,engine_team_id,engine_user_id,semantic_agent_id,generation from project_memory_bindings');
        assert.notEqual(after.wiki_id, legacy.wiki_id);
        assert.ok(after.generation > 0);
        assert.equal(after.engine_team_id, fx.config.projects[f.project.code].teamId);
        assert.equal(after.engine_user_id, fx.config.projects[f.project.code].userId);
        assert.equal(after.semantic_agent_id, fx.config.projects[f.project.code].semanticAgentId);
        assert.equal(JSON.stringify(fx.config.projects), originalMapping);
        assert.equal(fx.requests.filter(item => item.path === '/wiki/create').length, 1);
        const replay = await projectNextMemory(db, fx.config);
        assert.equal(replay.status, 'synced');
        assert.equal(replay.source, version.code);
        assert.equal(fx.raw.size, 0, 'new indexing never copies raw source bodies');
        assert.ok([...fx.pages].some(([key, card]) => key.startsWith(after.wiki_id + '/') && card.includes('tsp-project-material-index/v1')));
        assert.equal((await f.q('select content from project_document_revisions where id=$1', [version.id]))[0].content, text);
        const [job] = await f.q('select external_ref from memory_projection_jobs where material_index_id in (select v.id from project_material_index_versions v join project_document_revisions r on r.code=v.revision_code where r.id=$1)', [version.id]);
        assert.ok(job.external_ref.startsWith('wiki:' + after.wiki_id + '/'));
        assert.equal(ok(await request(app, f)).counts.synced, 1);
        assert.equal(JSON.stringify(fx.config.projects), originalMapping);
      });
    });
  }));

test('bound resource service failures and identity mismatches preserve legacy and dynamic bindings without creating a replacement', { skip: !baseUrl }, async () =>
  withIntegrityFixture(baseUrl, 'memoryhttplegacyfailure', async db => {
    const f = await seed(db);
    await withTencent(async fx => {
      const legacy = fx.addWiki(f.project.code, 'legacy-protected-wiki');
      fx.config.projects[f.project.code] = { ...fx.config.projectProvisioning, wikiId: legacy.wiki_id };
      const verifyFailures = async app => {
        const [before] = await f.q('select enabled,state,wiki_id,generation from project_memory_bindings');
        const creates = fx.requests.filter(item => item.path === '/wiki/create').length;
        for (const mode of ['unavailable', 'identity_mismatch']) {
          fx.hooks.wikiGetStatus = mode === 'unavailable' ? 503 : undefined;
          fx.hooks.wikiIdentityMismatch = mode === 'identity_mismatch';
          const failure = await request(app, f, 'POST', 'retry');
          assert.equal(failure.statusCode, 503, failure.body);
          assert.equal(failure.json().error.code, 'memory_service_unavailable');
          assert.equal(fx.requests.filter(item => item.path === '/wiki/create').length, creates);
          assert.deepEqual((await f.q('select enabled,state,wiki_id,generation from project_memory_bindings'))[0], before);
          const current = ok(await request(app, f));
          assert.equal(current.bindingState, 'ready');
          assert.equal(current.enabled, true);
          fx.hooks.wikiGetStatus = undefined;
          fx.hooks.wikiIdentityMismatch = false;
          assert.equal(ok(await request(app, f, 'POST', 'retry')).bindingState, 'ready');
        }
      };
      await withApp(db, fx.config, async app => {
        ok(await request(app, f, 'POST', 'enable'));
        await verifyFailures(app);
        assert.equal(fx.config.projects[f.project.code].wikiId, legacy.wiki_id);
      });
      delete fx.config.projects[f.project.code];
      await withApp(db, fx.config, async app => {
        assert.deepEqual(fx.config.projects, {});
        assert.equal(ok(await request(app, f)).bindingState, 'ready');
        await verifyFailures(app);
        assert.deepEqual(fx.config.projects, {});
      });
    });
  }));

test('management status remains readable without engine configuration while ACLs and request bodies block writes', { skip: !baseUrl }, async () =>
  withIntegrityFixture(baseUrl, 'memoryhttpaccess', async db => {
    const f = await seed(db);
    await f.document('不能从管理摘要泄露文档原文。');
    await withApp(db, undefined, async app => {
      const state = ok(await request(app, f));
      assert.equal(state.serviceConfigured, false);
      assert.equal(state.canManage, true);
      assert.equal(state.retrievalEnabled, false);
      const unavailable = await request(app, f, 'POST', 'enable');
      assert.equal(unavailable.statusCode, 503, unavailable.body);
      assert.equal(unavailable.json().error.code, 'memory_service_unavailable');
      for (const role of ['member', 'viewer']) {
        assert.equal(ok(await request(app, f, 'GET', '', role)).canManage, false);
        for (const action of ['enable', 'pause', 'retry']) assert.equal((await request(app, f, 'POST', action, role)).statusCode, 403);
      }
      for (const [role, expected] of [['outsider', 403], [null, 401]]) {
        assert.equal((await request(app, f, 'GET', '', role)).statusCode, expected);
        for (const action of ['enable', 'pause', 'retry']) assert.equal((await request(app, f, 'POST', action, role)).statusCode, expected);
      }
      assert.equal((await f.q('select count(*)::int as count from project_memory_bindings'))[0].count, 0);
    });
    await withTencent(async fx => withApp(db, fx.config, async app => {
      for (const action of ['enable', 'pause', 'retry']) {
        const bad = await request(app, f, 'POST', action, 'owner', { wikiId: 'foreign-wiki', teamId: 'foreign-team', userId: 'foreign-user', principalCode: f.owner.code });
        assert.equal(bad.statusCode, 422, bad.body);
        assert.equal(bad.json().error.code, 'invalid_request');
      }
      assert.equal(fx.requests.length, 0);
      assert.equal((await f.q('select count(*)::int as count from project_memory_bindings'))[0].count, 0);
    }));
  }));

test('HTTP pause during an outbound document write prevents acknowledgement and subsequent claims', { skip: !baseUrl }, async () =>
  withIntegrityFixture(baseUrl, 'memoryhttprace', async db => {
    const f = await seed(db), { version } = await f.document('暂停发生在原文写入途中也不能报告已同步。');
    await withTencent(async fx => withApp(db, fx.config, async app => {
      ok(await request(app, f, 'POST', 'enable'));
      fx.hooks.afterPageWrite = async () => { assert.equal(ok(await request(app, f, 'POST', 'pause')).enabled, false); };
      const result = await projectNextMemory(db, fx.config);
      assert.equal(result.status, 'lease_changed');
      const [job] = await f.q(`select j.status,j.external_ref,v.code as index_code,b.wiki_id
        from memory_projection_jobs j join project_material_index_versions v on v.id=j.material_index_id
        join project_document_revisions r on r.code=v.revision_code join project_memory_bindings b on b.project_id=v.project_id
        where r.id=$1`, [version.id]);
      assert.notEqual(job.status, 'synced');
      const page = 'wiki/sources/tsp-material-' + createHash('sha256').update(f.project.code + '/' + job.index_code).digest('hex') + '.md';
      assert.equal(job.external_ref, 'wiki:' + job.wiki_id + '/' + page);
      assert.equal(ok(await request(app, f)).retrievalEnabled, false);
      assert.equal(await projectNextMemory(db, fx.config), null);
    }));
  }));

test('retry repairs a lost project Wiki and reprojects the same immutable native revision', { skip: !baseUrl }, async () =>
  withIntegrityFixture(baseUrl, 'memoryhttprepair', async db => {
    const f = await seed(db), text = 'Wiki 丢失后仍由原生项目文档恢复完整原文。';
    const { version } = await f.document(text);
    await withTencent(async fx => withApp(db, fx.config, async app => {
      ok(await request(app, f, 'POST', 'enable'));
      assert.equal((await projectNextMemory(db, fx.config)).status, 'synced');
      const [before] = await f.q('select wiki_id,generation from project_memory_bindings');
      fx.wikis.delete(before.wiki_id);
      const repaired = ok(await request(app, f, 'POST', 'retry'));
      assert.equal(repaired.bindingState, 'ready');
      assert.equal(repaired.retrievalEnabled, true);
      assert.equal(repaired.counts.pending, 1);
      const [after] = await f.q('select wiki_id,generation from project_memory_bindings');
      assert.notEqual(after.wiki_id, before.wiki_id);
      assert.ok(after.generation > before.generation);
      assert.equal(fx.requests.filter(item => item.path === '/wiki/create').length, 2);
      const replay = await projectNextMemory(db, fx.config);
      assert.equal(replay.status, 'synced');
      assert.equal(replay.source, version.code);
      assert.equal(fx.raw.size, 0, 'new indexing never copies raw source bodies');
        assert.ok([...fx.pages].some(([key, card]) => key.startsWith(after.wiki_id + '/') && card.includes('tsp-project-material-index/v1')));
      assert.equal((await f.q('select content from project_document_revisions where id=$1', [version.id]))[0].content, text);
      assert.equal(ok(await request(app, f)).counts.synced, 1);
    }));
  }));

test('a pause after outbound verification but before the final acknowledgement transaction cannot be overwritten', { skip: !baseUrl }, async () =>
  withIntegrityFixture(baseUrl, 'memoryhttpackfence', async db => {
    const f = await seed(db), { version } = await f.document('最后检查与确认同步之间发生暂停也必须保留暂停策略。');
    await withTencent(async fx => withApp(db, fx.config, async app => {
      ok(await request(app, f, 'POST', 'enable'));
      const originalTransaction = db.transaction;
      let pauseAtAcknowledgement = false, pauses = 0;
      // The next database transaction after external verification is the worker's
      // final acknowledgement. Pause before it acquires the shared project fence.
      fx.hooks.afterPageWrite = async () => { pauseAtAcknowledgement = true; };
      db.transaction = async function (...args) {
        if (pauseAtAcknowledgement) {
          pauseAtAcknowledgement = false;
          pauses++;
          assert.equal(ok(await request(app, f, 'POST', 'pause')).enabled, false);
        }
        return originalTransaction.apply(this, args);
      };
      let result;
      try { result = await projectNextMemory(db, fx.config); }
      finally { db.transaction = originalTransaction; }
      assert.equal(pauses, 1, 'Did not exercise the acknowledgement race');
      assert.equal(result.status, 'lease_changed');
      const [job] = await f.q(`select j.status,j.external_ref,v.code as index_code,b.wiki_id
        from memory_projection_jobs j join project_material_index_versions v on v.id=j.material_index_id
        join project_document_revisions r on r.code=v.revision_code join project_memory_bindings b on b.project_id=v.project_id
        where r.id=$1`, [version.id]);
      assert.notEqual(job.status, 'synced');
      const page = 'wiki/sources/tsp-material-' + createHash('sha256').update(f.project.code + '/' + job.index_code).digest('hex') + '.md';
      assert.equal(job.external_ref, 'wiki:' + job.wiki_id + '/' + page);
      assert.equal(ok(await request(app, f)).enabled, false);
      assert.equal(await projectNextMemory(db, fx.config), null);
    }));
  }));

test('an in-flight retry cannot reactivate a project paused while verifying the remote Wiki', { skip: !baseUrl, timeout: 15000 }, async () =>
  withIntegrityFixture(baseUrl, 'memoryhttpretrypause', async db => {
    const f = await seed(db);
    await f.document('远端校验途中暂停的项目必须继续保持暂停。');
    await withTencent(async fx => withApp(db, fx.config, async app => {
      ok(await request(app, f, 'POST', 'enable'));
      assert.equal((await projectNextMemory(db, fx.config)).status, 'synced');
      let reached, release;
      const checking = new Promise(resolve => { reached = resolve; });
      const proceed = new Promise(resolve => { release = resolve; });
      fx.hooks.beforeWikiGet = async () => { reached(); await proceed; };
      const createCount = fx.requests.filter(item => item.path === '/wiki/create').length;
      const retry = request(app, f, 'POST', 'retry');
      let retryResponse;
      try {
        await Promise.race([checking, new Promise((_, reject) => {
          const timeout = setTimeout(() => reject(new Error('Retry never reached remote verification')), 5000);
          timeout.unref();
        })]);
        const paused = ok(await request(app, f, 'POST', 'pause'));
        assert.equal(paused.enabled, false);
      } finally { release(); retryResponse = await retry; }
      assert.ok([200, 409].includes(retryResponse.statusCode), retryResponse.body);
      if (retryResponse.statusCode === 200) assert.equal(retryResponse.json().data.enabled, false);
      const final = ok(await request(app, f));
      assert.equal(final.enabled, false);
      assert.equal(final.retrievalEnabled, false);
      assert.equal(fx.requests.filter(item => item.path === '/wiki/create').length, createCount);
      assert.equal(await projectNextMemory(db, fx.config), null);
    }));
  }));
