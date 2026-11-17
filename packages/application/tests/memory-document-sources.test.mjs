import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMemorySliceUseCases, createProjectDocumentUseCases, createProjectMaterialQueryUseCases } from '../dist/index.js';
import { withIntegrityFixture } from '../../../scripts/orphan-fixture.mjs';

const baseUrl = process.env.TSP_TEST_DATABASE_URL;
const unwrap = result => { assert.equal(result.ok, true, result.error?.code ?? 'Expected a successful document operation'); return result.data; };
async function setup(db) {
  const q = (text, values = []) => db.$client.query(text, values).then(result => result.rows);
  const [project] = await q("select * from projects where name='Fixture A'");
  const [other] = await q("select * from projects where name='Fixture B'");
  const [user] = await q("select * from users where account='integrity.fixture'");
  return { q, project, other, user, actor: { projectCode: project.code, principalCode: user.code },
    docs: createProjectDocumentUseCases(db), memory: createMemorySliceUseCases(db) };
}

test('native project documents are immediately current memory with bounded previews and lossless paged originals', { skip: !baseUrl }, async () =>
  withIntegrityFixture(baseUrl, 'memorydocumentreads', async db => {
    const { q, actor, other, docs, memory } = await setup(db);
    const content = '# 账号隔离背景\n\n' + '缓存与权限的回归条件需要核对😀。\n'.repeat(400) + '\n文末特殊验收标记：红杉终验。';
    const created = unwrap(await docs.createDocument({ ...actor, kind: 'doc', title: '项目隔离背景', content }));
    const current = unwrap(await docs.getDocument(created.document_code, actor.principalCode));
    const source = current.revisions[0].revision_code;
    assert.deepEqual(await memory.search({ ...actor, scope: 'project', query: '红杉终验' }), []);
    const grep = unwrap(await createProjectMaterialQueryUseCases(db).grep({ ...actor, pattern: '红杉终验' }));
    assert.equal(grep.matches[0].sourceCitation, source);
    const result = await memory.search({ ...actor, scope: 'project', query: '项目隔离背景' });
    const evidence = result.find(row => row.source === source);
    assert.equal(evidence.sourceKind, 'project_material');
    assert.equal(evidence.state, 'documented');
    assert.ok(evidence.text.length <= 900);
    assert.deepEqual(evidence.locator, { sourceCitation: source });
    assert.equal(evidence.summaryOrigin, 'authored');
    assert.ok((await memory.brief({ ...actor, scope: 'project' })).some(row => row.source === source));
    assert.deepEqual(await memory.search({ ...actor, scope: 'personal', query: '红杉终验' }), []);
    assert.deepEqual(await memory.readSources({ ...actor, projectCode: other.code, sources: [source] }), []);
    await assert.rejects(memory.readDocument({ ...actor, projectCode: other.code, source }), { code: 'memory_source_unavailable' });
    const pages = [];
    let offset = 0;
    do {
      const page = await memory.readDocument({ ...actor, source, offset, limit: 131 });
      assert.ok(page.text.length <= 131);
      assert.doesNotMatch(page.text, /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);
      pages.push(page.text); offset = page.range.nextOffset;
    } while (offset !== null);
    assert.equal(pages.join(''), current.content);
    const located = await memory.readDocument({ ...actor, source, query: '红杉终验', limit: 500 });
    assert.match(located.text, /红杉终验/u);
    assert.ok(located.range.offset > 1600);
    assert.match((await memory.readDocument({ ...actor, source, query: '红杉终验', limit: 16 })).text, /红杉终验/u);
    await assert.rejects(memory.readDocument({ ...actor, source, query: '红杉终验', limit: 2 }), { code: 'memory_invalid' });
    await assert.rejects(memory.readDocument({ ...actor, source, offset: 0, query: '红杉' }), { code: 'memory_invalid' });
    assert.equal((await q("select count(*)::int as count from memory_projection_jobs where status='synced'"))[0].count, 0);
  }));

test('document find can locate a final occurrence without repeatedly returning the introductory mention', { skip: !baseUrl }, async () =>
  withIntegrityFixture(baseUrl, 'memorydocumentfind', async db => {
    const { actor, docs, memory } = await setup(db);
    const created = unwrap(await docs.createDocument({ ...actor, kind: 'doc', title: '验收规则',
      content: '介绍：验收标记记录在文末。\n' + '背景与验证条件。\n'.repeat(600) + '\n最终验收标记：青杉。' }));
    const native = unwrap(await docs.getDocument(created.document_code, actor.principalCode));
    const source = native.revisions[0].revision_code;
    const first = await memory.readDocument({ ...actor, source, query: '验收标记', limit: 100 });
    const last = await memory.readDocument({ ...actor, source, query: '验收标记', occurrence: 'last', limit: 100 });
    assert.equal(first.range.offset, 0);
    assert.ok(last.range.offset > 4000);
    assert.match(last.text, /最终验收标记：青杉/u);
    await assert.rejects(memory.readDocument({ ...actor, source, occurrence: 'last' }), { code: 'memory_invalid' });
  }));

test('native large titles remain intact while every memory presentation has a bounded labeled title', { skip: !baseUrl }, async () =>
  withIntegrityFixture(baseUrl, 'memorydocumenttitles', async db => {
    const { actor, docs, memory } = await setup(db);
    const title = '项目标题😀'.repeat(2000) + '尾部标题检索';
    const created = unwrap(await docs.createDocument({ ...actor, kind: 'doc', title, content: '完整原文。' }));
    const native = unwrap(await docs.getDocument(created.document_code, actor.principalCode));
    assert.equal(native.title, title);
    const source = native.revisions[0].revision_code;
    assert.deepEqual(await memory.search({ ...actor, scope: 'project', query: '尾部标题检索' }), []);
    const search = await memory.search({ ...actor, scope: 'project', query: '项目标题' });
    const rows = [search[0], (await memory.brief({ ...actor, scope: 'project' }))[0],
      (await memory.readSources({ ...actor, sources: [source] }))[0], await memory.readDocument({ ...actor, source })];
    for (const row of rows) {
      assert.ok(row.title.length <= 256);
      assert.equal(row.titleTruncated, true);
      assert.doesNotMatch(row.title, /[\uD800-\uDBFF]$/u);
      assert.ok(row.text.includes('完整原文。'));
      assert.equal(row.text.includes('尾部标题检索'), false);
    }
  }));

test('old indexed revisions and archived sources never return as current project memory', { skip: !baseUrl }, async () =>
  withIntegrityFixture(baseUrl, 'memorydocumentversions', async db => {
    const { q, actor, docs, memory } = await setup(db);
    const created = unwrap(await docs.createDocument({ ...actor, kind: 'doc', title: '部署规则', content: '旧版要求：等待五秒。' }));
    const first = unwrap(await docs.getDocument(created.document_code, actor.principalCode));
    const old = first.revisions[0].revision_code;
    await q(`update memory_projection_jobs j set status='synced',external_ref='wiki:stale/source'
      from project_document_revisions r where j.project_document_revision_id=r.id and r.code=$1`, [old]);
    const edit = { documentCode: created.document_code, principalCode: actor.principalCode, title: '部署规则',
      changeSummary: 'Updated policy', content: '新版要求：等待八秒。' };
    unwrap(await docs.reviseDocument({ ...edit, baseRevision: 1 }));
    assert.deepEqual(await memory.search({ ...actor, scope: 'project', query: '旧版', engineRefs: ['wiki:stale/source'] }), []);
    assert.deepEqual(await memory.readSources({ ...actor, sources: [old] }), []);
    await assert.rejects(memory.readDocument({ ...actor, source: old }), { code: 'memory_source_unavailable' });
    const current = (await memory.search({ ...actor, scope: 'project', query: '八秒' }))[0];
    assert.equal(current.sourceRevision, 2);
    unwrap(await docs.reviseDocument({ ...edit, baseRevision: 2, status: 'archived' }));
    assert.deepEqual(await memory.brief({ ...actor, scope: 'project' }), []);
    assert.deepEqual(await memory.readSources({ ...actor, sources: [current.source] }), []);
    unwrap(await docs.reviseDocument({ ...edit, baseRevision: 3, status: 'active' }));
    const restored = (await memory.search({ ...actor, scope: 'project', query: '八秒' }))[0];
    assert.equal(restored.sourceRevision, 4);
    assert.notEqual(restored.source, current.source);
    await q("update projects set status='archived' where code=$1", [actor.projectCode]);
    assert.deepEqual(await memory.readSources({ ...actor, sources: [restored.source] }), []);
    await q("update projects set status='active' where code=$1", [actor.projectCode]);
    await q('update users set pending_deletion=true where code=$1', [actor.principalCode]);
    await assert.rejects(memory.readDocument({ ...actor, source: restored.source }), { code: 'project_forbidden' });
  }));
