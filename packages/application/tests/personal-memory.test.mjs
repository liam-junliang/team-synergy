import test from 'node:test';
import assert from 'node:assert/strict';
import * as application from '../dist/index.js';
import { withIntegrityFixture } from '../../../scripts/orphan-fixture.mjs';

const baseUrl = process.env.TSP_TEST_DATABASE_URL;
test('personal-memory management is exported independently of requirement use cases', () => {
  assert.equal(typeof application.createPersonalMemoryUseCases, 'function');
});

async function fixture(db) {
  const q = (text, values = []) => db.$client.query(text, values).then(result => result.rows[0]);
  const project = await q("select * from projects where name='Fixture A'");
  const user = await q("select * from users where account='integrity.fixture'");
  const actor = { projectCode: project.code, principalCode: user.code };
  return { q, project, user, actor, memory: application.createMemorySliceUseCases(db),
    personal: application.createPersonalMemoryUseCases(db) };
}

test('unbound discussions and private preferences retain provenance without inventing requirements', { skip: !baseUrl }, async () =>
  withIntegrityFixture(baseUrl, 'memoryunbound', async db => {
    const { q, actor, memory, personal } = await fixture(db);
    assert.deepEqual(await memory.inspect(actor), {});
    await assert.rejects(memory.inspect({ ...actor, topicCode: '0123456789ABCDEFGHJK' }), { code: 'memory_invalid' });
    const event = { ...actor, sessionId: 'unbound', eventId: 'one', sourceText: '先讨论退款边界。我习惯中文说明。',
      parts: [{ kind: 'discussion', text: '先讨论退款边界。' }, { kind: 'preference', text: '我习惯中文说明。' }] };
    const [a, b] = await Promise.all([memory.capture(event), memory.capture(event)]);
    assert.equal(a.receiptCode, b.receiptCode);
    assert.equal(a.expectedRevision, null); assert.equal(a.expectedHead, null);
    assert.equal((await memory.search({ ...actor, scope: 'project', query: '退款' }))[0].state, 'discussed');
    assert.equal((await memory.brief({ ...actor, scope: 'project' })).length, 1);
    assert.equal((await personal.list({ principalCode: actor.principalCode })).items.length, 1);
    assert.deepEqual(await q('select (select count(*)::int from requirements) requirements,(select count(*)::int from requirement_topics) topics'), { requirements: 0, topics: 0 });
    await assert.rejects(memory.capture({ ...actor, sessionId: 'unbound', eventId: 'adopt', sourceText: '就按这个方案做。', parts: [{ kind: 'adopt', text: '就按这个方案做。' }] }), { code: 'memory_ambiguous' });
    await assert.rejects(memory.capture({ ...event, topicCode: '0123456789ABCDEFGHJK' }), { code: 'memory_invalid' });
    await assert.rejects(memory.capture({ ...event, sourceText: '换掉来源。' }), { code: 'memory_event_conflict' });
  }));

test('personal edits serialize, invalidate old citations and keep immutable provenance; withdrawal can be restored', { skip: !baseUrl }, async () =>
  withIntegrityFixture(baseUrl, 'personalrevision', async db => {
    const { q, actor, memory, personal } = await fixture(db);
    const captured = await memory.capture({ ...actor, sessionId: 'personal', eventId: 'one', sourceText: '我习惯中文说明。', parts: [{ kind: 'preference', text: '我习惯中文说明。' }] });
    const source = captured.items[0].source;
    await q("update memory_projection_jobs set status='processing',generation=4,lease_until=now()+interval '5 minutes',external_ref='old-private-ref'");
    const changes = await Promise.allSettled([
      personal.edit({ principalCode: actor.principalCode, source, expectedRevision: 1, text: '提交说明应使用中文。' }),
      personal.edit({ principalCode: actor.principalCode, source, expectedRevision: 1, text: '提交说明使用双语。' }),
    ]);
    assert.equal(changes.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(changes.find(result => result.status === 'rejected').reason.code, 'memory_revision_conflict');
    const current = await personal.read({ principalCode: actor.principalCode, source });
    assert.equal(current.revision, 2); assert.notEqual(current.revisionSource, source);
    const beforeInvalidTarget = await q('select (select count(*)::int from memory_fragments) fragments,(select sum(generation)::int from memory_projection_jobs) generations');
    for (const operation of [() => personal.read({ principalCode: actor.principalCode, source: current.revisionSource }),
      () => personal.edit({ principalCode: actor.principalCode, source: current.revisionSource, expectedRevision: 2, text: '不得产生假失败。' }),
      () => personal.withdraw({ principalCode: actor.principalCode, source: current.revisionSource, expectedRevision: 2 })]) {
      await assert.rejects(operation(), { code: 'memory_not_found' });
    }
    assert.deepEqual(await q('select (select count(*)::int from memory_fragments) fragments,(select sum(generation)::int from memory_projection_jobs) generations'), beforeInvalidTarget);
    assert.equal(current.history.length, 2); assert.equal(current.history[0].text, '我习惯中文说明。');
    assert.deepEqual(await memory.readSources({ ...actor, sources: [source] }), []);
    assert.deepEqual(await memory.search({ ...actor, scope: 'personal', query: '只有向量可命中的旧词', engineRefs: ['old-private-ref'] }), []);
    assert.equal((await memory.readSources({ ...actor, sources: [current.revisionSource] })).length, 1);
    assert.equal((await memory.replay({ ...actor, sessionId: 'personal', eventId: 'one', sourceText: '我习惯中文说明。' })).items.length, 1);
    const withdrawn = await personal.withdraw({ principalCode: actor.principalCode, source, expectedRevision: 2, reason: '暂不适用' });
    assert.equal(withdrawn.status, 'withdrawn'); assert.equal(withdrawn.revision, 3);
    assert.deepEqual(await memory.brief({ ...actor, scope: 'personal' }), []);
    assert.deepEqual(await memory.readSources({ ...actor, sources: [current.revisionSource] }), []);
    assert.equal((await personal.list({ principalCode: actor.principalCode })).items.length, 0);
    assert.equal((await personal.list({ principalCode: actor.principalCode, status: 'withdrawn' })).items.length, 1);
    const restored = await personal.edit({ principalCode: actor.principalCode, source, expectedRevision: 3, text: '恢复中文提交说明。', reason: '重新启用' });
    assert.equal(restored.revision, 4); assert.equal(restored.status, 'active');
    assert.equal(restored.applicability, 'project'); assert.equal(restored.provenance.eventId, 'one');
    assert.deepEqual(await q("select count(*)::int count from memory_projection_jobs where operation='delete' and status='pending'"), { count: 3 });
    assert.equal((await q('select min(generation)::int generation from memory_projection_jobs where generation>1')).generation, 2);
    assert.equal((await q("select count(*)::int count from memory_projection_jobs where operation='delete' and lease_until is not null")).count, 0);
  }));

test('personal ownership and scope never expand to another member or project', { skip: !baseUrl }, async () =>
  withIntegrityFixture(baseUrl, 'personalscope', async db => {
    const { q, actor, project, memory, personal } = await fixture(db);
    const other = await q("insert into users(account,display_name,created_at) values('other','Other',now()) returning id,code");
    await q("insert into members(project_id,principal_id,role,display_name,created_at) values($1,$2,'member','Other',now())", [project.id, other.id]);
    await assert.rejects(memory.capture({ ...actor, principalCode: other.code, sessionId: 'unbound-member', eventId: 'adopt',
      sourceText: '就按这个方案做。', parts: [{ kind: 'adopt', text: '就按这个方案做。' }] }), { code: 'memory_ambiguous' });
    assert.deepEqual(await q('select (select count(*)::int from memory_capture_receipts) receipts,(select count(*)::int from memory_projection_jobs) jobs'), { receipts: 0, jobs: 0 });
    const capture = await memory.capture({ ...actor, sessionId: 'private', eventId: 'one', sourceText: '只在本项目使用中文。', parts: [{ kind: 'preference', text: '只在本项目使用中文。' }] });
    const source = capture.items[0].source;
    assert.deepEqual((await personal.list({ principalCode: other.code })).items, []);
    for (const operation of [() => personal.read({ principalCode: other.code, source }),
      () => personal.edit({ principalCode: other.code, source, expectedRevision: 1, text: '盗改。' }),
      () => personal.withdraw({ principalCode: other.code, source, expectedRevision: 1 })]) await assert.rejects(operation(), { code: 'memory_not_found' });
    const projectB = await q("select code from projects where name='Fixture B'");
    assert.deepEqual(await memory.brief({ ...actor, projectCode: projectB.code, scope: 'personal' }), []);
    const updated = await personal.edit({ principalCode: actor.principalCode, source, expectedRevision: 1, text: '在所有项目中，我都偏好中文。' });
    assert.equal(updated.applicability, 'project');
    assert.deepEqual(await memory.brief({ ...actor, projectCode: projectB.code, scope: 'personal' }), []);
    const global = await memory.capture({ ...actor, sessionId: 'private', eventId: 'global', sourceText: '在所有项目中我习惯先读摘要。',
      parts: [{ kind: 'preference', text: '在所有项目中我习惯先读摘要。', applicability: 'account' }] });
    const globalEdit = await personal.edit({ principalCode: actor.principalCode, source: global.items[0].source, expectedRevision: 1, text: '先阅读当前背景摘要。' });
    assert.equal(globalEdit.applicability, 'account');
    assert.deepEqual((await memory.brief({ ...actor, projectCode: projectB.code, scope: 'personal' })).map(row => row.text), ['先阅读当前背景摘要。']);
  }));
