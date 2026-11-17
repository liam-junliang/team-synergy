import test from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { schema } from '@team-synergy/persistence';
import { createProjectMaterialQueryUseCases, createProjectDocumentUseCases, createTestingUseCases, reconcileProjectMaterialIndexes, listCurrentProjectMaterialCandidates, readCurrentProjectMaterialCandidate, resolveCurrentProjectMaterialSource, createMemorySliceUseCases } from '../dist/index.js';
import { insertUser, seedWorkspaceProject, useTestDb } from './test-db.mjs';

const fixture = useTestDb(import.meta.url);
async function seed() {
  const db = fixture.db;
  const ctx = await seedWorkspaceProject(db, { users: [
    { key: 'owner', account: 'materials.owner', displayName: 'Owner', projectRole: 'owner', teamRole: 'owner' },
    { key: 'reader', account: 'materials.reader', displayName: 'Reader', projectRole: 'viewer' },
  ] });
  const outsider = await insertUser(db, { account: 'materials.outside', displayName: 'Outside' });
  const time = '2026-11-12T00:00:00Z';
  const [project] = await db.insert(schema.projectDocuments).values({ project_id: ctx.project.id, kind: 'doc', title: '项目退款规则', content: '# 退款\n超过七天人工审核\n尚未实际落实', revision: 2, created_by: ctx.users.owner.id, updated_by: ctx.users.owner.id, created_at: time, updated_at: time }).returning();
  const projectRevisions = await db.insert(schema.projectDocumentRevisions).values([1, 2].map(revision => ({ document_id: project.id, revision, title: '项目退款规则', content: revision === 1 ? '旧版退款不审核' : project.content, change_summary: '规则说明', created_by: ctx.users.owner.id, created_at: time }))).returning();
  const [requirement] = await db.insert(schema.requirementDocuments).values({ project_id: ctx.project.id, module_key: '退款', title: '需求退款条件', owner_principal_id: ctx.users.owner.id, created_at: time, updated_at: time }).returning();
  await db.insert(schema.requirementDocumentRevisions).values({ document_id: requirement.id, revision: 1, summary: '退款需审核', content: '需求：退款超过七天需人工审核', change_summary: '初稿', created_by: ctx.users.owner.id, created_at: time });
  const [architecture] = await db.insert(schema.architectureDocuments).values({ project_id: ctx.project.id, title: '退款流程', summary: '退款服务调用图', content_kind: 'mermaid', owner_principal_id: ctx.users.owner.id, created_at: time, updated_at: time }).returning();
  await db.insert(schema.architectureDocumentRevisions).values({ document_id: architecture.id, revision: 1, title: architecture.title, content_kind: 'mermaid', source_content: 'graph TD\n退款-->人工审核', notes_markdown: '架构说明', change_summary: '初稿', created_by: ctx.users.owner.id, created_at: time });
  const assets = [];
  for (const storage_kind of ['markdown', 'file']) {
    const [asset] = await db.insert(schema.testAssets).values({ project_id: ctx.project.id, title: `退款测试-${storage_kind}`, summary: '验证退款分支', current_revision: 1, owner_principal_id: ctx.users.owner.id, created_at: time, updated_at: time }).returning();
    await db.insert(schema.testAssetRevisions).values({ document_id: asset.id, revision: 1, content_json: JSON.stringify({ title: asset.title, summary: asset.summary, purpose: 'guide', storage_kind, content: storage_kind === 'file' ? '不得搜索附件隐藏词' : '退款测试：超过七天转人工', file: storage_kind === 'file' ? { content_base64: Buffer.from('附件隐藏词').toString('base64'), file_name: 'secret.bin', mime_type: 'application/octet-stream' } : null, url: null, git: null }), change_summary: '初稿', created_by: ctx.users.owner.id, created_at: time });
    assets.push(asset);
  }
  return { db, ...ctx, outsider, projectDocument: project, projectRevisions, requirement, architecture, assets, uc: createProjectMaterialQueryUseCases(db), actor: { projectCode: ctx.project.code, principalCode: ctx.users.reader.code } };
}
function value(result) { assert.equal(result.ok, true, JSON.stringify(result)); return result.data; }

test('four-source catalog is metadata-only, stable, paginated and globbed', async () => {
  const f = await seed();
  const page = value(await f.uc.list({ ...f.actor, limit: 2 }));
  assert.equal(page.items.length, 2); assert.equal(page.truncated, true);
  const all = value(await f.uc.list(f.actor));
  assert.equal(all.items.length, 5);
  assert.ok(all.items.every(row => row.source === row.sourceCitation && row.source === row.revisionCode && row.source !== row.objectCode));
  assert.deepEqual([...new Set(all.items.map(row => row.sourceKind))].sort(), ['architecture', 'project', 'requirement', 'testing']);
  assert.equal(JSON.stringify(all).includes('content_base64'), false);
  assert.equal(all.items.every(row => !('body' in row) && row.summary.length <= 600 && row.title.length <= 256), true);
  const glob = value(await f.uc.glob({ ...f.actor, pattern: 'project/*.md' }));
  assert.deepEqual(glob.items.map(row => row.objectCode), [f.projectDocument.code]);
  const path = glob.items[0].path;
  await f.db.update(schema.projectDocuments).set({ title: '改名' }).where(eq(schema.projectDocuments.id, f.projectDocument.id));
  assert.equal(value(await f.uc.glob({ ...f.actor, pattern: '**/*.md', sourceKinds: ['project'] })).items[0].path, path);
});

test('grep searches all textual sources with line evidence but excludes binary bytes', async () => {
  const f = await seed();
  const found = value(await f.uc.grep({ ...f.actor, pattern: '退款', contextLines: 1 }));
  assert.deepEqual([...new Set(found.matches.map(row => row.sourceKind))].sort(), ['architecture', 'project', 'requirement', 'testing']);
  assert.equal(found.matches.every(row => row.line >= 1 && row.sourceCitation && row.context.length <= 3), true);
  assert.ok(found.matches.every(row => row.source === row.sourceCitation));
  assert.equal(value(await f.uc.grep({ ...f.actor, pattern: '附件隐藏词' })).matches.length, 0);
  assert.equal(found.skippedBinary, 1);
  const limited = value(await f.uc.grep({ ...f.actor, pattern: '退款', limit: 1 }));
  assert.equal(limited.matches.length, 1); assert.equal(limited.truncated, true);
  const invalid = await f.uc.grep({ ...f.actor, pattern: '[', mode: 'regex' });
  assert.equal(invalid.ok, false); assert.equal(invalid.error.code, 'material_invalid_regex');
});

test('current, historical source and line reads preserve versions and worker current fences', async () => {
  const f = await seed();
  const current = value(await f.uc.read({ ...f.actor, sourceKind: 'project', objectCode: f.projectDocument.code, startLine: 2, endLine: 2 }));
  assert.equal(current.body, '超过七天人工审核\n'); assert.equal(current.version.revision, 2); assert.equal(current.range.startLine, 2);
  const historical = value(await f.uc.read({ ...f.actor, sourceCitation: f.projectRevisions[0].code }));
  assert.equal(historical.body, '旧版退款不审核'); assert.equal(historical.current, false); assert.equal(historical.version.revision, 1);
  const candidates = await listCurrentProjectMaterialCandidates(f.db, { projectId: f.project.id });
  const candidate = candidates.find(row => row.objectCode === f.projectDocument.code);
  assert.equal((await readCurrentProjectMaterialCandidate(f.db, candidate.bodyLocator)).body, f.projectDocument.content);
  await f.db.update(schema.projectDocuments).set({ revision: 3 }).where(eq(schema.projectDocuments.id, f.projectDocument.id));
  await assert.rejects(readCurrentProjectMaterialCandidate(f.db, candidate.bodyLocator), { code: 'material_source_stale' });
});

test('query ACL, cross-project sources and archive filtering cannot be bypassed', async () => {
  const f = await seed();
  const denied = await f.uc.list({ ...f.actor, principalCode: f.outsider.code });
  assert.equal(denied.ok, false); assert.equal(denied.error.code, 'project_forbidden');
  const [other] = await f.db.insert(schema.projects).values({ team_id: f.team.id, name: 'Other', created_at: '2026-11-12T00:00:00Z', member_policy: 'private' }).returning();
  await f.db.insert(schema.members).values({ principal_id: f.users.reader.id, project_id: other.id, role: 'viewer', display_name: 'Reader', created_at: 't0' });
  const absent = await f.uc.read({ ...f.actor, projectCode: other.code, sourceCitation: f.projectRevisions[0].code });
  assert.equal(absent.ok, false); assert.equal(absent.error.code, 'material_not_found');
  await f.db.update(schema.projectDocuments).set({ status: 'archived' }).where(eq(schema.projectDocuments.id, f.projectDocument.id));
  assert.equal(value(await f.uc.list(f.actor)).items.some(row => row.objectCode === f.projectDocument.code), false);
  assert.equal(value(await f.uc.list({ ...f.actor, status: 'all' })).items.some(row => row.objectCode === f.projectDocument.code), true);
});

test('all four source locators read original text and binary material stays metadata-only', async () => {
  const f = await seed();
  const catalog = value(await f.uc.list(f.actor));
  for (const row of catalog.items) {
    const read = value(await f.uc.read({ ...f.actor, path: row.path }));
    assert.equal(read.sourceCitation, row.revisionCode); assert.equal(read.current, true);
    assert.equal((await resolveCurrentProjectMaterialSource(f.db, { projectId: f.project.id, sourceCitation: row.revisionCode })).objectCode, row.objectCode);
    if (row.textSearchable) { assert.match(read.body, /退款/); assert.match(read.version.sha256, /^[a-f0-9]{64}$/); }
    else { assert.equal(read.body, null); assert.equal(read.unsupportedReason, 'binary_content'); assert.equal(read.version.sha256, null); }
  }
  await f.db.update(schema.requirementDocuments).set({ state: 'archived' }).where(eq(schema.requirementDocuments.id, f.requirement.id));
  const archived = catalog.items.find(row => row.sourceKind === 'requirement');
  assert.equal(await resolveCurrentProjectMaterialSource(f.db, { projectId: f.project.id, sourceCitation: archived.revisionCode }), null);
});

test('historical architecture and testing types follow the requested revision, and old citations are not current', async () => {
  const f = await seed();
  const original = value(await f.uc.list(f.actor));
  const time = '2026-11-12T01:00:00Z';
  await f.db.insert(schema.architectureDocumentRevisions).values({ document_id: f.architecture.id, revision: 2, title: '新版退款图片', content_kind: 'image', source_content: 'aGVsbG8=', notes_markdown: '图片说明', change_summary: '图片版', created_by: f.users.owner.id, created_at: time });
  await f.db.update(schema.architectureDocuments).set({ current_revision: 2, content_kind: 'image' }).where(eq(schema.architectureDocuments.id, f.architecture.id));
  const asset = f.assets[0];
  await f.db.insert(schema.testAssetRevisions).values({ document_id: asset.id, revision: 2, content_json: JSON.stringify({ title: '新版附件', summary: '附件版', storage_kind: 'file', content: '', file: { content_base64: 'aGVsbG8=' } }), change_summary: '附件版', created_by: f.users.owner.id, created_at: time });
  await f.db.update(schema.testAssets).set({ current_revision: 2 }).where(eq(schema.testAssets.id, asset.id));
  for (const sourceKind of ['architecture', 'testing']) {
    const old = original.items.find(row => row.sourceKind === sourceKind && row.textSearchable);
    const read = value(await f.uc.read({ ...f.actor, sourceKind, objectCode: old.objectCode, revision: 1 }));
    assert.equal(read.current, false); assert.equal(read.textSearchable, true); assert.notEqual(read.contentType, 'binary'); assert.match(read.body, /退款/);
    assert.equal(read.sourceCitation, old.revisionCode);
    assert.equal(await resolveCurrentProjectMaterialSource(f.db, { projectId: f.project.id, sourceCitation: old.revisionCode }), null);
    assert.equal(value(await f.uc.read({ ...f.actor, sourceKind, objectCode: old.objectCode })).body, null);
  }
});

test('read character pagination preserves surrogate boundaries and source bytes', async () => {
  const f = await seed();
  const body = '甲😀乙\n中文退款';
  await f.db.update(schema.projectDocumentRevisions).set({ content: body }).where(eq(schema.projectDocumentRevisions.code, f.projectRevisions[1].code));
  let offset = 0, rebuilt = '';
  do {
    const read = value(await f.uc.read({ ...f.actor, sourceCitation: f.projectRevisions[1].code, offset, limit: 2 }));
    rebuilt += read.body; offset = read.range.nextOffset;
  } while (offset !== null);
  assert.equal(rebuilt, body);
  assert.equal((await f.uc.read({ ...f.actor, sourceCitation: f.projectRevisions[1].code, offset: 2 })).error.code, 'material_range_invalid');
});

async function indexFixture(f) {
  const candidates = await listCurrentProjectMaterialCandidates(f.db, { projectId: f.project.id });
  const rows = [];
  for (const candidate of candidates) {
    const [index] = await f.db.insert(schema.projectMaterialIndexVersions).values({ project_id: f.project.id, source_kind: candidate.sourceKind,
      object_code: candidate.objectCode, revision: candidate.revision, revision_code: candidate.revisionCode, metadata_hash: candidate.metadataHash,
      source_citation: candidate.sourceCitation, path: candidate.path, title: candidate.title, summary: candidate.summary, summary_origin: candidate.summaryOrigin, text_searchable: candidate.textSearchable }).returning()
      .catch(error => { throw new Error('fixture insert: ' + String(error.cause?.code) + ' ' + String(error.cause?.constraint) + ' ' + String(error.cause?.message)); });
    const externalRef = 'wiki:fixture/wiki/sources/tsp-material-' + index.code;
    await f.db.insert(schema.memoryProjectionJobs).values({ material_index_id: index.id, engine: 'tencent', status: 'synced', external_ref: externalRef });
    rows.push({ index, candidate, externalRef });
  }
  return { rows, memory: createMemorySliceUseCases(f.db) };
}
test('semantic engine index hits become four-source bounded cards with original revision citations', async () => {
  const f = await seed(), { rows, memory } = await indexFixture(f);
  const target = rows.find(row => row.candidate.sourceKind === 'requirement');
  const semantic = await memory.search({ ...f.actor, scope: 'project', query: '并不存在的跨语言语义提问', engineRefs: [target.externalRef] });
  assert.equal(semantic.length, 1); assert.equal(semantic[0].sourceKind, 'project_material');
  assert.equal(semantic[0].materialSourceKind, 'requirement'); assert.equal(semantic[0].source, target.candidate.revisionCode);
  assert.notEqual(semantic[0].source, target.index.code); assert.deepEqual(semantic[0].locator, { sourceCitation: target.candidate.revisionCode });
  assert.equal(semantic[0].state, 'documented'); assert.ok(semantic[0].text.length <= 857);
  assert.equal(semantic[0].text.includes('需求：退款超过七天需人工审核'), false, 'memory returns metadata, not the original body');
  const sources = await memory.readSources({ ...f.actor, sources: rows.map(row => row.candidate.revisionCode) });
  assert.equal(sources.length, 5); assert.equal(sources.every(row => row.sourceKind === 'project_material'), true);
  assert.deepEqual([...new Set(sources.map(row => row.materialSourceKind))].sort(), ['architecture', 'project', 'requirement', 'testing']);
  assert.deepEqual(await memory.search({ ...f.actor, scope: 'personal', query: '退款', engineRefs: [target.externalRef] }), []);
  const brief = await memory.brief({ ...f.actor, scope: 'project' });
  assert.ok(brief.every(row => row.sourceKind !== 'project_material' || row.evidenceStatus.includes('read_project_material')));
  const stored = value(await f.uc.read({ ...f.actor, sourceCitation: target.candidate.sourceCitation }));
  // read callers use the public locator, not internal worker project IDs.
  assert.equal(stored.current, true);
});

test('late semantic results, metadata drift and non-upsert projection states cannot revive old material cards', async () => {
  const f = await seed(), { rows, memory } = await indexFixture(f);
  const target = rows.find(row => row.candidate.sourceKind === 'requirement');
  await f.db.update(schema.memoryProjectionJobs).set({ status: 'pending' }).where(eq(schema.memoryProjectionJobs.material_index_id, target.index.id));
  assert.deepEqual(await memory.search({ ...f.actor, scope: 'project', query: '不存在的语义', engineRefs: [target.externalRef] }), []);
  await f.db.update(schema.memoryProjectionJobs).set({ status: 'synced', operation: 'delete' }).where(eq(schema.memoryProjectionJobs.material_index_id, target.index.id));
  assert.deepEqual(await memory.search({ ...f.actor, scope: 'project', query: '不存在的语义', engineRefs: [target.externalRef] }), []);
  await f.db.update(schema.memoryProjectionJobs).set({ operation: 'upsert' }).where(eq(schema.memoryProjectionJobs.material_index_id, target.index.id));
  await f.db.insert(schema.requirementDocumentRevisions).values({ document_id: f.requirement.id, revision: 2, summary: '新版退款规则', content: '新版原文', change_summary: '修改', created_by: f.users.owner.id, created_at: '2026-11-12T02:00:00Z' });
  await f.db.update(schema.requirementDocuments).set({ current_revision: 2 }).where(eq(schema.requirementDocuments.id, f.requirement.id));
  assert.deepEqual(await memory.readSources({ ...f.actor, sources: [target.candidate.revisionCode] }), []);
  assert.deepEqual(await memory.search({ ...f.actor, scope: 'project', query: '不存在的语义', engineRefs: [target.externalRef] }), []);
  const project = rows.find(row => row.candidate.sourceKind === 'project');
  await f.db.update(schema.projectDocuments).set({ title: '变化后的目录标题' }).where(eq(schema.projectDocuments.id, f.projectDocument.id));
  assert.deepEqual(await memory.readSources({ ...f.actor, sources: [project.candidate.revisionCode] }), []);
  await assert.rejects(memory.readSources({ ...f.actor, principalCode: f.outsider.code, sources: [project.candidate.revisionCode] }), { code: 'project_forbidden' });
});

test('document discovery follows test-asset purpose while exact execution sources and immutable files remain readable', async () => {
  const f = await seed(), rows = [];
  for (const purpose of ['guide', 'environment', 'script', 'data', 'report']) {
    const file = { file_name: '验收矩阵.zip', mime_type: 'application/zip', content_base64: Buffer.from('original ZIP bytes').toString('base64') };
    const content = { title: '验收矩阵-' + purpose, summary: '用途分流回归', purpose,
      storage_kind: purpose === 'data' ? 'file' : 'markdown', content: purpose === 'data' ? '' : '分类回归：' + purpose,
      file: purpose === 'data' ? file : null, url: null, git: null };
    const [asset] = await f.db.insert(schema.testAssets).values({ project_id: f.project.id, title: content.title,
      summary: content.summary, current_revision: 1, owner_principal_id: f.users.owner.id, created_at: 't0', updated_at: 't0' }).returning();
    const [revision] = await f.db.insert(schema.testAssetRevisions).values({ document_id: asset.id, revision: 1,
      content_json: JSON.stringify(content), change_summary: '分类初稿', created_by: f.users.owner.id, created_at: 't0' }).returning();
    rows.push({ asset, revision, included: ['guide', 'environment'].includes(purpose), content });
  }
  const actor = { projectCode: f.project.code, principalCode: f.users.reader.code };
  const library = value(await createProjectDocumentUseCases(f.db).listLibrary(actor));
  const listed = value(await f.uc.list({ ...actor, query: '验收矩阵' }));
  const globbed = value(await f.uc.glob({ ...actor, pattern: 'testing/**' }));
  const grepped = value(await f.uc.grep({ ...actor, pattern: '分类回归' }));
  const candidates = await listCurrentProjectMaterialCandidates(f.db, { projectId: f.project.id });
  for (const row of rows) {
    for (const list of [library.documents.map(d => d.document_code), globbed.items.map(d => d.objectCode),
      candidates.map(d => d.objectCode)]) assert.equal(list.includes(row.asset.code), row.included, row.content.purpose);
    assert.equal(listed.items.some(item => item.objectCode === row.asset.code), row.included, row.content.purpose);
    assert.equal(grepped.matches.some(item => item.objectCode === row.asset.code), row.included, row.content.purpose);
    const direct = value(await f.uc.read({ ...actor, sourceCitation: row.revision.code }));
    assert.equal(direct.sourceCitation, row.revision.code);
    assert.equal(direct.current, row.included);
    assert.equal(direct.body, row.content.storage_kind === 'file' ? null : row.content.content);
    const compatibility = value(await createProjectDocumentUseCases(f.db).getDocument(row.asset.code, actor.principalCode));
    assert.deepEqual(compatibility.testing_asset.file, row.content.file);
    const [preserved] = await f.db.select().from(schema.testAssetRevisions).where(eq(schema.testAssetRevisions.id, row.revision.id));
    assert.deepEqual(preserved, row.revision);
  }
  const report = rows.find(row => row.content.purpose === 'report');
  const before = report.revision;
  const [index] = await f.db.insert(schema.projectMaterialIndexVersions).values({ project_id: f.project.id,
    source_kind: 'testing', object_code: report.asset.code, revision: 1, revision_code: before.code, metadata_hash: 'a'.repeat(64),
    source_citation: before.code, path: 'testing/' + report.asset.code + '.md', title: report.asset.title,
    summary: report.content.summary, summary_origin: 'authored', text_searchable: true }).returning();
  await f.db.insert(schema.memoryProjectionJobs).values({ material_index_id: index.id, engine: 'tencent', status: 'synced', external_ref: 'old-report-card' });
  const memory = createMemorySliceUseCases(f.db);
  assert.deepEqual(await memory.search({ ...actor, scope: 'project', query: '不存在的词', engineRefs: ['old-report-card'] }), []);
  assert.equal(await resolveCurrentProjectMaterialSource(f.db, { projectId: f.project.id, sourceCitation: before.code }), null);
});

test('purpose revision withdraws automatic indexes and late memory hits while both original revisions stay readable', async () => {
  const f = await seed(), testing = createTestingUseCases(f.db);
  const actor = { projectCode: f.project.code, principalCode: f.users.owner.code };
  const guide = value(await testing.createAsset({ ...actor, input: { title: '说明原件',
    purpose: 'guide', storage_kind: 'markdown', content: '# 原始策略' } }));
  await f.db.transaction(tx => reconcileProjectMaterialIndexes(tx, f.project.id));
  const [indexed] = await f.db.select().from(schema.projectMaterialIndexVersions).where(eq(schema.projectMaterialIndexVersions.object_code, guide.code));
  const before = value(await f.uc.read({ ...actor, sourceKind: 'testing', objectCode: guide.code }));
  const candidate = (await listCurrentProjectMaterialCandidates(f.db, { projectId: f.project.id })).find(row => row.objectCode === guide.code);
  await f.db.update(schema.memoryProjectionJobs).set({ status: 'synced', external_ref: 'old-purpose-index' })
    .where(eq(schema.memoryProjectionJobs.material_index_id, indexed.id));
  const [originalJob] = await f.db.select().from(schema.memoryProjectionJobs).where(eq(schema.memoryProjectionJobs.material_index_id, indexed.id));
  const report = value(await testing.reviseAsset({ code: guide.code, principalCode: actor.principalCode,
    input: { base_revision: 1, change_summary: '改为当次执行报告', purpose: 'report', content: '# 单次执行结果' } }));
  assert.equal(value(await f.uc.list(actor)).items.some(row => row.objectCode === guide.code), false);
  assert.equal((await createMemorySliceUseCases(f.db).readSources({ ...actor, sources: [before.sourceCitation] })).length, 0);
  await assert.rejects(readCurrentProjectMaterialCandidate(f.db, candidate.bodyLocator), { code: 'material_source_stale' });
  assert.equal(value(await f.uc.read({ ...actor, sourceCitation: before.sourceCitation })).body, '# 原始策略');
  assert.equal(value(await f.uc.read({ ...actor, sourceCitation: report.revision_code })).body, '# 单次执行结果');
  await f.db.transaction(tx => reconcileProjectMaterialIndexes(tx, f.project.id));
  const [retired] = await f.db.select().from(schema.projectMaterialIndexVersions).where(eq(schema.projectMaterialIndexVersions.id, indexed.id));
  const [cleanup] = await f.db.select().from(schema.memoryProjectionJobs).where(eq(schema.memoryProjectionJobs.material_index_id, indexed.id));
  assert.equal(retired.active, false);
  assert.equal(cleanup.operation, 'delete');
  assert.equal(cleanup.status, 'pending');
  assert.equal(cleanup.external_ref, 'old-purpose-index');
  assert.equal(cleanup.generation, originalJob.generation + 1);
  assert.deepEqual(value(await testing.getAsset(guide.code, actor.principalCode)).revisions[1], guide.revisions[0]);
  const restored = value(await testing.reviseAsset({ code: guide.code, principalCode: actor.principalCode,
    input: { base_revision: 2, change_summary: '抽出环境说明', purpose: 'environment', content: '# 可复用环境' } }));
  await f.db.transaction(tx => reconcileProjectMaterialIndexes(tx, f.project.id));
  const current = value(await f.uc.list(actor)).items.find(row => row.objectCode === guide.code);
  assert.equal(current.sourceCitation, restored.revision_code);
  assert.equal(current.revision, 3);
});
