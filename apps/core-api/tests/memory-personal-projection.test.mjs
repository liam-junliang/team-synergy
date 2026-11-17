import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { withIntegrityFixture } from '../../../scripts/orphan-fixture.mjs';
import { createMemorySliceUseCases, createPersonalMemoryUseCases } from '../../../packages/application/dist/index.js';
import { projectNextMemory } from '../dist/memory-engines.js';

const database = process.env.TSP_TEST_DATABASE_URL;
const trailer = '\n\n<!-- MEMORY_FIELDS\n{\n  "version": 1\n}\n-->';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(db) {
  const q = (text, values = []) => db.$client.query(text, values).then(result => result.rows);
  const [project] = await q("select id,code from projects where name='Fixture A'");
  const [user] = await q("select id,code from users where account='integrity.fixture'");
  const actor = { projectCode: project.code, principalCode: user.code };
  const memory = createMemorySliceUseCases(db), personal = createPersonalMemoryUseCases(db);
  const capture = (text, event = 'one', kind = 'preference') => memory.capture({ ...actor,
    sessionId: 'projection', eventId: event, sourceText: text, parts: [{ kind, text }] });
  return { q, project, user, actor, memory, personal, capture };
}

async function withEngine(f, work, { provision = false } = {}) {
  const files = new Map(), raw = new Map(), pages = new Map(), calls = [], hooks = {}, errors = [];
  const settings = { accountId: 'fixture-account', adminApiKey: 'fixture-admin', keySeed: 'fixture-provisioning-seed-'.repeat(2) };
  const userId = provision ? 'tsp_' + f.user.code.toLowerCase() : 'fixture-personal-user';
  const seed = createHmac('sha256', settings.keySeed).update(settings.accountId + '\0' + f.user.code).digest('hex');
  const secret = createHash('sha256').update(userId + '\0' + seed).digest('hex');
  const key = provision ? [settings.accountId,userId,secret].map(value => Buffer.from(value).toString('base64url')).join('.') : 'fixture-personal-key';
  const identities = new Map([[key,userId]]);
  let provisioned = false;
  const server = createServer(async (req, res) => {
    try {
      const parts = []; for await (const chunk of req) parts.push(chunk);
      const body = parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : null;
      const url = new URL(req.url, 'http://localhost'), path = url.pathname, uri = body?.uri ?? url.searchParams.get('uri');
      calls.push({ path, method: req.method, uri, key: req.headers['x-api-key'] });
      const ok = result => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ status: 'ok', result })); };
      const tencent = data => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ code: 0, data })); };
      if (path.startsWith('/api/v1/admin/')) {
        assert.equal(req.headers['x-api-key'], settings.adminApiKey);
        if (req.method === 'POST') { assert.equal(body.user_id, userId); assert.equal(body.seed, seed); provisioned = true; ok({ user_key: key }); return; }
        if (!provisioned) { res.writeHead(404).end(); return; }
        ok({ user_id: userId, role: 'user' }); return;
      }
      if (path === '/health') {
        assert.equal(req.headers['x-api-key'], key);
        res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ account_id: settings.accountId, user_id: userId })); return;
      }
      if (path.startsWith('/api/')) {
        const scopedUser = identities.get(req.headers['x-api-key']);
        assert.ok(scopedUser, 'Unknown member credential');
        assert.ok(uri?.startsWith('viking://user/' + scopedUser + '/memories/preferences/team-synergy/'));
      }
      if (path === '/api/v1/content/read') {
        if (!files.has(uri)) { res.writeHead(404).end(); return; }
        ok(files.get(uri)); return;
      }
      if (path === '/api/v1/content/write') {
        if (hooks.beforeWrite) await hooks.beforeWrite(body);
        files.set(uri, body.content + trailer);
        if (hooks.afterWrite) await hooks.afterWrite(body);
        ok({ uri }); return;
      }
      if (path === '/api/v1/fs') {
        assert.equal(req.method, 'DELETE'); assert.equal(url.searchParams.get('recursive'), 'false'); assert.equal(url.searchParams.get('wait'), 'true');
        if (hooks.deleteFailure) { res.writeHead(503).end(); return; }
        if (hooks.deleteNoop) { ok({}); return; }
        const existed = files.delete(uri);
        if (!existed) { res.writeHead(404).end(); return; }
        ok({}); return;
      }
      switch (path) {
        case '/wiki/get': tencent({ wiki_id: 'test-wiki', team_id: 'test-team', name: 'tsp-memory-' + f.project.code, status: 'ready' }); return;
        case '/wiki/raw/ls': tencent({ items: [...raw.keys()].map(filename => ({ filename, status: 'ingested' })) }); return;
        case '/wiki/raw/read': tencent({ items: body.filenames.map(filename => raw.has(filename) ? { filename, content: raw.get(filename) } : { filename, not_found: true }) }); return;
        case '/wiki/raw/write': for (const file of body.files) raw.set(file.filename, file.content); tencent({}); return;
        case '/wiki/page/read': tencent({ items: body.refs.map(ref => pages.has(ref) ? { ref, content: pages.get(ref) } : { ref, not_found: true }) }); return;
        case '/wiki/page/write': for (const page of body.pages) pages.set(page.ref, page.content); tencent({}); return;
        case '/wiki/search': tencent({ results: [...pages].filter(([, content]) => content.includes(body.query)).map(([path]) => ({ path })) }); return;
        default: throw Error('Unexpected path ' + path);
      }
    } catch (error) { errors.push(error); res.writeHead(500).end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  const config = { tencent: { baseUrl, token: 'fixture-token', serviceId: 'fixture-service' }, openviking: { baseUrl },
    projects: { [f.project.code]: { teamId: 'test-team', userId: 'test-writer', wikiId: 'test-wiki' } },
    accounts: provision ? {} : { [f.user.code]: { userId, apiKey: key } }, ...(provision ? { personalProvisioning: settings } : {}) };
  try { await work({ config, files, calls, hooks, baseUrl, key, userId,
    addIdentity: (principal, user, apiKey) => { identities.set(apiKey,user); config.accounts[principal] = { userId: user, apiKey }; } }); assert.deepEqual(errors, []); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

async function drain(db, config) {
  const results = [];
  for (let n = 0; n < 20; n++) { const result = await projectNextMemory(db, config); if (!result) return results; results.push(result); }
  throw Error('Projection queue did not drain');
}

test('personal revisions accept only the version trailer, delete old URI with readback and restore under the same owner', { skip: !database }, async () =>
  withIntegrityFixture(database, 'personalprojection', async db => {
    const f = await fixture(db), captured = await f.capture('我习惯中文说明。');
    const source = captured.items[0].source;
    await withEngine(f, async fx => {
      assert.equal((await projectNextMemory(db, fx.config)).status, 'synced');
      assert.equal(fx.files.size, 1);
      const originalUri = [...fx.files.keys()][0];
      const edited = await f.personal.edit({ principalCode: f.user.code, source, expectedRevision: 1, text: '我偏好先读摘要。' });
      assert.equal(edited.projection.cleanupPending, true);
      assert.ok((await drain(db, fx.config)).every(result => result.status === 'synced'));
      assert.equal(fx.files.has(originalUri), false); assert.equal(fx.files.size, 1);
      const current = await f.personal.read({ principalCode: f.user.code, source });
      assert.equal(current.projection.cleanupPending, false);
      await f.personal.withdraw({ principalCode: f.user.code, source, expectedRevision: 2 });
      assert.ok((await drain(db, fx.config)).every(result => result.status === 'synced'));
      assert.equal(fx.files.size, 0);
      assert.equal((await f.personal.read({ principalCode: f.user.code, source })).projection.cleanupPending, false);
      await f.personal.edit({ principalCode: f.user.code, source, expectedRevision: 3, text: '恢复先读摘要。' });
      assert.ok((await drain(db, fx.config)).every(result => result.status === 'synced'));
      assert.equal(fx.files.size, 1);
      assert.ok([...fx.files.values()][0].includes('恢复先读摘要。'));
      assert.ok(fx.calls.some(call => call.method === 'DELETE'));
      assert.equal(fx.calls.filter(call => call.path.startsWith('/wiki') || call.path.startsWith('/conversation')).length, 0);
    });
  }));

test('a late legacy upsert cannot acknowledge a completed delete and requeues verified cleanup', { skip: !database }, async () =>
  withIntegrityFixture(database, 'personallatewrite', async db => {
    const f = await fixture(db), captured = await f.capture('晚到写入不得复活旧偏好。'), source = captured.items[0].source;
    await withEngine(f, async fx => {
      const entered = deferred(), release = deferred();
      fx.hooks.beforeWrite = async () => { entered.resolve(); await release.promise; };
      const oldWrite = projectNextMemory(db, fx.config); await entered.promise;
      await f.personal.withdraw({ principalCode: f.user.code, source, expectedRevision: 1 });
      // Simulate a pre-fence/legacy deleter finishing first; the new compliant
      // workers are additionally serialized in the next regression.
      fx.files.clear();
      await f.q("update memory_projection_jobs set status='synced',lease_until=null where operation='delete'");
      release.resolve();
      assert.equal((await oldWrite).status, 'lease_changed');
      assert.equal(fx.files.size, 1, 'The old remote response actually arrived after deletion');
      const [cleanup] = await f.q("select status,operation from memory_projection_jobs order by id limit 1");
      assert.equal(cleanup.operation, 'delete'); assert.equal(cleanup.status, 'pending');
      assert.ok((await f.personal.read({ principalCode: f.user.code, source })).projection.cleanupPending);
      assert.equal((await projectNextMemory(db, fx.config)).status, 'synced');
      assert.equal(fx.files.size, 0);
    });
  }));

test('compliant workers serialize remote operations for one source without blocking domain withdrawal', { skip: !database }, async () =>
  withIntegrityFixture(database, 'personalserialized', async db => {
    const f = await fixture(db), captured = await f.capture('并发清理旧偏好。'), source = captured.items[0].source;
    await withEngine(f, async fx => {
      const entered = deferred(), release = deferred();
      fx.hooks.beforeWrite = async () => { entered.resolve(); await release.promise; };
      const oldWrite = projectNextMemory(db, fx.config); await entered.promise;
      await f.personal.withdraw({ principalCode: f.user.code, source, expectedRevision: 1 });
      const cleanup = projectNextMemory(db, fx.config);
      await delay(50);
      assert.equal(fx.calls.filter(call => call.method === 'DELETE').length, 0);
      release.resolve();
      assert.equal((await oldWrite).status, 'lease_changed');
      assert.equal((await cleanup).status, 'synced');
      await drain(db, fx.config);
      assert.equal(fx.files.size, 0);
    });
  }));

test('deletion failures remain visible and retry; mismatched metadata and cross-owner destinations fail closed', { skip: !database }, async () =>
  withIntegrityFixture(database, 'personalfailure', async db => {
    const f = await fixture(db), captured = await f.capture('私有偏好必须保留精确正文。'), source = captured.items[0].source;
    await withEngine(f, async fx => {
      assert.equal((await projectNextMemory(db, fx.config)).status, 'synced');
      await f.personal.withdraw({ principalCode: f.user.code, source, expectedRevision: 1 });
      fx.hooks.deleteFailure = true;
      assert.equal((await projectNextMemory(db, fx.config)).status, 'needs_reconcile');
      assert.equal((await f.personal.read({ principalCode: f.user.code, source })).projection.cleanupPending, true);
      fx.hooks.deleteFailure = false;
      fx.hooks.deleteNoop = true;
      await f.q("update memory_projection_jobs set lease_until=now()-interval '1 second' where status='needs_reconcile'");
      assert.equal((await projectNextMemory(db, fx.config)).code, 'readback_mismatch');
      assert.equal((await f.personal.read({ principalCode: f.user.code, source })).projection.cleanupPending, true);
      fx.hooks.deleteNoop = false;
      await f.q("update memory_projection_jobs set lease_until=now()-interval '1 second' where status='needs_reconcile'");
      await drain(db, fx.config); assert.equal(fx.files.size, 0);
      const restored = await f.personal.edit({ principalCode: f.user.code, source, expectedRevision: 2, text: '恢复私有偏好。' });
      const uri = 'viking://user/' + fx.userId + '/memories/preferences/team-synergy/' + restored.revisionSource + '.json';
      fx.files.set(uri, JSON.stringify({ source: restored.revisionSource, applicability: 'project', project: f.project.code, text: restored.text }) + '\n\n<!-- MEMORY_FIELDS\n{}\n-->');
      await drain(db, fx.config);
      const result = await f.q("select status,last_error from memory_projection_jobs where fragment_id=(select id from memory_fragments where code=$1)", [restored.revisionSource]);
      assert.equal(result[0].last_error, 'remote_content_changed');
      assert.equal(fx.calls.filter(call => call.path.startsWith('/wiki')).length, 0);
    });
  }));

test('unbound project discussion projects to Tencent while personal fragments never enter that engine', { skip: !database }, async () =>
  withIntegrityFixture(database, 'unboundprojection', async db => {
    const f = await fixture(db);
    await f.capture('先讨论退款边界，方案尚未确认。', 'discussion', 'discussion');
    await f.capture('我习惯中文说明。', 'private');
    await withEngine(f, async fx => {
      const results = await drain(db, fx.config);
      assert.deepEqual(results.map(result => [result.engine, result.status]), [['tencent', 'synced'], ['openviking', 'synced']]);
      assert.ok(fx.calls.some(call => call.path === '/wiki/page/write'));
      assert.ok([...fx.files.values()].every(content => !content.includes('退款边界')));
    });
  }));

test('an active unmapped member is claimed and provisioned without sharing another account identity', { skip: !database }, async () =>
  withIntegrityFixture(database, 'personalprovision', async db => {
    const f = await fixture(db);
    await f.capture('新成员偏好可以自动投影。');
    await withEngine(f, async fx => {
      assert.deepEqual(fx.config.accounts, {});
      assert.equal((await projectNextMemory(db, fx.config)).status, 'synced');
      assert.equal(fx.config.accounts[f.user.code].userId, fx.userId);
      assert.ok(fx.calls.some(call => call.path.startsWith('/api/v1/admin/') && call.method === 'POST'));
      assert.equal(fx.files.size, 1);
      assert.ok([...fx.files.keys()][0].startsWith('viking://user/' + fx.userId + '/'));
      assert.equal(fx.calls.filter(call => call.path.startsWith('/wiki')).length, 0);
      await f.capture('停用账号不得自动创建新映射。', 'disabled');
      await f.q("update users set status='disabled' where id=$1", [f.user.id]);
      delete fx.config.accounts[f.user.code];
      const before = fx.calls.length;
      assert.equal(await projectNextMemory(db, fx.config), null);
      assert.equal(fx.calls.length, before);
    }, { provision: true });
  }));

test('member destinations remain separate and a forged deletion receipt cannot delete another user URI', { skip: !database }, async () =>
  withIntegrityFixture(database, 'personaldestinations', async db => {
    const f = await fixture(db), first = await f.capture('甲的私有偏好。');
    const [other] = await f.q("insert into users(account,display_name,created_at) values('projection.other','Other',now()) returning id,code");
    await f.q("insert into members(project_id,principal_id,role,display_name,created_at) values($1,$2,'member','Other',now())", [f.project.id, other.id]);
    await f.memory.capture({ ...f.actor, principalCode: other.code, sessionId: 'projection', eventId: 'other', sourceText: '乙的私有偏好。', parts: [{ kind: 'preference', text: '乙的私有偏好。' }] });
    await withEngine(f, async fx => {
      fx.addIdentity(other.code, 'another-user', 'another-key');
      assert.ok((await drain(db, fx.config)).every(result => result.status === 'synced'));
      assert.equal(fx.files.size, 2);
      assert.equal(fx.calls.filter(call => call.path.startsWith('/wiki')).length, 0);
      const anotherUri = [...fx.files.keys()].find(uri => uri.includes('/another-user/'));
      await f.personal.withdraw({ principalCode: f.user.code, source: first.items[0].source, expectedRevision: 1 });
      await f.q("update memory_projection_jobs set external_ref=$1 where fragment_id=(select id from memory_fragments where code=$2)", [anotherUri,first.items[0].source]);
      const result = await projectNextMemory(db, fx.config);
      assert.equal(result.status, 'needs_reconcile'); assert.equal(result.code, 'identity_mismatch');
      assert.equal(fx.files.has(anotherUri), true);
      assert.equal(fx.calls.filter(call => call.method === 'DELETE').length, 0);
      await drain(db, fx.config);
      const misrouted = await f.capture('私有偏好即使错误排队也不能进入公共引擎。', 'misrouted');
      await f.q("update memory_projection_jobs set engine='tencent' where fragment_id=(select id from memory_fragments where code=$1)", [misrouted.items[0].source]);
      const before = fx.calls.length;
      assert.equal((await projectNextMemory(db, fx.config)).status, 'needs_reconcile');
      assert.equal(fx.calls.length, before, 'No private bytes may be sent to Tencent');
    });
  }));
