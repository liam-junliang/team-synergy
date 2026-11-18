import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { withIntegrityFixture } from '../../../scripts/orphan-fixture.mjs';
import { createMemorySliceUseCases, createPersonalMemoryUseCases, reconcileProjectMaterialIndexes } from '@team-synergy/application';
import { buildServer } from '../dist/server.js';
import { extractMemoryParts } from '../dist/memory-extraction.js';
import { memoryModelStatus } from '../dist/memory-observability.js';

const database = process.env.TSP_TEST_DATABASE_URL;
async function fixture(db) {
  const q = (text, values = []) => db.$client.query(text, values).then(result => result.rows);
  const [owner] = await q("select id,code from users where account='integrity.fixture'");
  const projects = await q('select id,code,name from projects order by id');
  await q("update projects set member_policy='private'");
  const [member] = await q("insert into users(account,display_name,created_at) values('center.member','Member','t0') returning id,code");
  const [outsider] = await q("insert into users(account,display_name,created_at) values('center.outsider','Outsider','t0') returning id,code");
  await q("insert into members(project_id,principal_id,role,display_name,created_at) values($1,$2,'viewer','Viewer','t0')", [projects[0].id, member.id]);
  const headers = new Map();
  for (const user of [owner, member, outsider]) {
    const token = 'center-fixture-' + user.code;
    await q("insert into devices(principal_id,device_name,credential_hash,created_at) values($1,'center-fixture',$2,'t0')", [user.id, createHash('sha256').update(token).digest('hex')]);
    headers.set(user.code, { authorization: 'Bearer ' + token });
  }
  async function document(project, title) {
    const [doc] = await q("insert into project_documents(project_id,title,content,revision,status,created_by,created_at,updated_by,updated_at) values($1,$2,'Native body',1,'active',$3,'t0',$3,'t0') returning id,code", [project.id, title, owner.id]);
    const [version] = await q("insert into project_document_revisions(document_id,revision,title,content,change_summary,created_by,created_at) values($1,1,$2,'Native body','fixture',$3,'t0') returning id,code", [doc.id, title, owner.id]);
    await reconcileProjectMaterialIndexes(db, project.id);
    return { doc, version };
  }
  const app = await buildServer({ db, logger: false });
  const get = (user, query = '') => app.inject({ method: 'GET', url: '/account/memory-center' + query, ...(user ? { headers: headers.get(user.code) } : {}) });
  return { q, owner, member, outsider, projects, document, app, get, headers };
}
function data(response) { assert.equal(response.statusCode, 200, response.body); assert.equal(response.headers['cache-control'], 'no-store'); return response.json().data; }

test('memory center enforces account/project visibility and exposes real private capture states without payloads', { skip: !database }, async () =>
  withIntegrityFixture(database, 'memorycenteracl', async db => {
    const f = await fixture(db);
    try {
      const [project, foreign] = f.projects;
      await f.document(project, 'Visible material'); await f.document(foreign, 'FOREIGN_PROJECT_SECRET');
      const states = ['pending', 'processing', 'completed', 'skipped', 'needs_clarification', 'failed'];
      for (const [index, status] of states.entries()) await f.q(`insert into memory_capture_jobs(project_id,principal_id,session_key,event_key,source_hash,payload_json,status,attempts,last_error_code,result_json)
        values($1,$2,'my-session',$3,'hash',$4,$5,1,$6,$7)`, [project.id, f.member.id, 'event-' + index,
        JSON.stringify({ sourceText: 'PRIVATE_INPUT_NEVER_RETURN' }), status, status === 'failed' ? 'SECRET_KEY_IN_ERROR' : null, '{"text":"PRIVATE_RESULT_NEVER_RETURN"}']);
      await f.q(`insert into memory_capture_jobs(project_id,principal_id,session_key,event_key,source_hash,payload_json,status)
        values($1,$2,'OWNER_SESSION_SECRET','OWNER_EVENT_SECRET','hash','{}','pending')`, [project.id, f.owner.id]);
      assert.equal((await f.get()).statusCode, 401);
      for (const query of ['?owner=' + f.owner.code, '?principalCode=' + f.owner.code, '?projectCode=invalid']) assert.equal((await f.get(f.member, query)).statusCode, 422);
      assert.equal((await f.get(f.member, '?projectCode=' + foreign.code)).statusCode, 403);
      const overview = data(await f.get(f.member));
      assert.equal(overview.ownerCode, f.member.code); assert.equal(overview.projects.length, 1);
      assert.equal(overview.projects[0].code, project.code); assert.equal(overview.projects[0].indexes, 1);
      assert.equal(overview.captures.total, 6); for (const state of states) assert.equal(overview.captures.counts[state], 1);
      assert.equal(overview.captures.installation, 'unknown'); assert.equal(overview.captures.localQueue, 'unknown');
      assert.ok(overview.captures.lastReceivedAt); assert.ok(overview.captures.lastProcessedAt);
      assert.equal(overview.model.observation, undefined);
      assert.equal(overview.captures.recent.find(row => row.status === 'failed').errorCode, 'memory_capture_failed');
      assert.doesNotMatch(JSON.stringify(overview), /PRIVATE_INPUT|PRIVATE_RESULT|OWNER_SESSION|OWNER_EVENT|FOREIGN_PROJECT|SECRET_KEY|payload_json|result_json/);
      const none = data(await f.get(f.outsider)); assert.deepEqual(none.projects, []); assert.equal(none.captures.total, 0);
      assert.equal((await f.get(f.outsider, '?projectCode=' + project.code)).statusCode, 403);
      const selected = data(await f.get(f.member, '?projectCode=' + project.code));
      assert.equal(selected.selectedProject.materials.documents[0].title, 'Visible material');
      await f.q('update users set is_system_admin=true where id=$1', [f.owner.id]);
      const admin = data(await f.get(f.owner));
      assert.equal(admin.captures.total, 1, 'Admin must still only see their own capture events');
      assert.equal(admin.model.observation.scope, 'service_process');
      await f.q('update users set is_system_admin=true where id=$1', [f.outsider.id]);
      const adminWithoutProject = data(await f.get(f.outsider));
      assert.deepEqual(adminWithoutProject.projects, []); assert.equal(adminWithoutProject.captures.total, 0);
      assert.equal((await f.get(f.outsider, '?projectCode=' + project.code)).statusCode, 403);
    } finally { await f.app.close(); }
  }));

test('center preserves personal edit/withdraw ownership and reads current material revisions independently of stale indexes', { skip: !database }, async () =>
  withIntegrityFixture(database, 'memorycentersources', async db => {
    const f = await fixture(db), project = f.projects[0];
    try {
      const memory = createMemorySliceUseCases(db), personal = createPersonalMemoryUseCases(db);
      const actor = { principalCode: f.owner.code, projectCode: project.code };
      const text = '我习惯先核对来源再开始讨论。';
      await memory.capture({ ...actor, sessionId: 'isolated-fixture', eventId: 'preference', sourceText: text, parts: [{ kind: 'preference', text }] });
      const discussion = '我建议先校验资料来源。';
      await memory.capture({ ...actor, sessionId: 'isolated-fixture', eventId: 'discussion', sourceText: discussion, parts: [{ kind: 'discussion', text: discussion }] });
      const { doc, version } = await f.document(project, 'First version');
      const [second] = await f.q("insert into project_document_revisions(document_id,revision,title,content,change_summary,created_by,created_at) values($1,2,'Current version','Updated native body','revision',$2,'t1') returning code", [doc.id, f.owner.id]);
      await f.q("update project_documents set revision=2,title='Current version',content='Updated native body' where id=$1", [doc.id]);
      let center = data(await f.get(f.owner, '?projectCode=' + project.code));
      assert.equal(center.personal.active, 1);
      assert.equal(center.selectedProject.materials.documents[0].source, second.code);
      assert.notEqual(center.selectedProject.materials.documents[0].source, version.code);
      assert.equal(center.selectedProject.materials.documents[0].projectionStatus, 'not_queued');
      assert.deepEqual(center.selectedProject.shared.map(row => row.text), [discussion]);
      const member = data(await f.get(f.member, '?projectCode=' + project.code));
      assert.equal(member.personal.total, 0); assert.doesNotMatch(JSON.stringify(member), new RegExp(text));
      const original = (await personal.list({ principalCode: f.owner.code, status: 'all' })).items[0];
      await assert.rejects(personal.edit({ principalCode: f.member.code, source: original.source, expectedRevision: 1, text: 'other' }), { code: 'memory_not_found' });
      const updated = await personal.edit({ principalCode: f.owner.code, source: original.source, expectedRevision: 1, text: '我习惯先说明证据。' });
      await personal.withdraw({ principalCode: f.owner.code, source: original.source, expectedRevision: updated.revision });
      center = data(await f.get(f.owner)); assert.equal(center.personal.active, 0); assert.equal(center.personal.withdrawn, 1); assert.equal(center.personal.total, 1);
    } finally { await f.app.close(); }
  }));

test('the owner can read personal memory while capture is disabled', { skip: !database }, async t => {
  const previous = process.env.TSP_MEMORY_ENABLED;
  process.env.TSP_MEMORY_ENABLED = '0';
  t.after(() => {
    if (previous === undefined) delete process.env.TSP_MEMORY_ENABLED;
    else process.env.TSP_MEMORY_ENABLED = previous;
  });

  await withIntegrityFixture(database, 'memorycenterpaused', async db => {
    const f = await fixture(db);
    try {
      const projectCode = f.projects[0].code;
      const text = '我习惯先核对来源再修改。';
      await createMemorySliceUseCases(db).capture({
        principalCode: f.owner.code, projectCode, sessionId: 'paused-fixture', eventId: 'preference',
        sourceText: text, parts: [{ kind: 'preference', text }],
      });
      assert.equal(data(await f.get(f.owner)).serviceEnabled, false);

      const read = (url, user) => f.app.inject({ method: 'GET', url, headers: user && f.headers.get(user.code) });
      const listUrl = '/memory/personal?status=all';
      const list = data(await read(listUrl, f.owner));
      assert.equal(list.items.length, 1);
      assert.equal(list.items[0].text, text);
      const detailUrl = '/memory/personal/' + list.items[0].source;
      assert.equal(data(await read(detailUrl, f.owner)).text, text);

      assert.equal((await read(listUrl)).statusCode, 401);
      assert.equal((await read(detailUrl)).statusCode, 401);
      assert.deepEqual(data(await read(listUrl, f.member)).items, []);
      assert.equal((await read(detailUrl, f.member)).statusCode, 404);
    } finally { await f.app.close(); }
  });
});

test('public model settings reveal current explicit/default configuration but never keys or endpoints; injected probes are not service calls', async t => {
  const names = ['TSP_MEMORY_PROVIDER', 'TSP_MEMORY_MODEL', 'TSP_MEMORY_BASE_URL', 'TSP_MEMORY_API_KEY'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(() => { for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; } });
  delete process.env.TSP_MEMORY_PROVIDER; delete process.env.TSP_MEMORY_MODEL;
  const defaults = memoryModelStatus(false); assert.equal(defaults.provider, 'ollama'); assert.equal(defaults.providerSource, 'default'); assert.equal(defaults.modelSource, 'default');
  Object.assign(process.env, { TSP_MEMORY_PROVIDER: 'openai', TSP_MEMORY_MODEL: 'officeace/deepseek-v4.1-flash', TSP_MEMORY_BASE_URL: 'http://127.0.0.1:3425/v1', TSP_MEMORY_API_KEY: 'DO_NOT_RETURN_THIS' });
  const before = memoryModelStatus(true).observation;
  await extractMemoryParts('我习惯先核对来源。', async () => Response.json({ choices: [{ message: { content: '{"items":[{"id":0,"label":"preference"}]}' } }] }));
  assert.deepEqual(memoryModelStatus(true).observation, before);
  const current = memoryModelStatus(false); assert.equal(current.providerSource, 'explicit'); assert.equal(current.modelSource, 'explicit');
  assert.equal(current.model, 'officeace/deepseek-v4.1-flash'); assert.equal(current.observation, undefined);
  assert.doesNotMatch(JSON.stringify(current), /DO_NOT_RETURN_THIS|3425|baseUrl|apiKey|sourceText/);
});

test('only actual extractor request boundaries advance process counters; local adoption does not', async t => {
  const originalFetch = globalThis.fetch;
  const keys = ['TSP_MEMORY_PROVIDER', 'TSP_MEMORY_BASE_URL', 'TSP_MEMORY_MODEL'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => { globalThis.fetch = originalFetch; for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } });
  Object.assign(process.env, { TSP_MEMORY_PROVIDER: 'ollama', TSP_MEMORY_BASE_URL: 'http://127.0.0.1:11434', TSP_MEMORY_MODEL: 'fixture-model' });
  const before = memoryModelStatus(true).observation;
  globalThis.fetch = async () => Response.json({ message: { content: '{"items":[{"id":0,"label":"preference"}]}' } });
  await extractMemoryParts('我习惯先检查来源。');
  await extractMemoryParts('就按这个方案做。');
  globalThis.fetch = async () => { throw Error('PRIVATE_NETWORK_ERROR'); };
  await assert.rejects(extractMemoryParts('我习惯先检查来源。'), { code: 'memory_model_unavailable' });
  const after = memoryModelStatus(true).observation;
  assert.equal(after.attempts - before.attempts, 2); assert.equal(after.successes - before.successes, 1); assert.equal(after.errors - before.errors, 1);
  assert.ok(after.lastAttemptAt && after.lastSuccessAt && after.lastErrorAt);
  assert.equal(memoryModelStatus(false).observation, undefined);
  assert.doesNotMatch(JSON.stringify(after), /PRIVATE_NETWORK_ERROR|我习惯|fixture-model|11434/);
});
