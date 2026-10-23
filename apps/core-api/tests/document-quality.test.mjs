import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@team-synergy/persistence';
import { buildServer } from '../dist/server.js';
import {
  closeTestDb, insertProject, insertProjectMember, insertTeam, insertUser, openTestDb,
} from './test-db.mjs';

const fixtures = [];
const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');
async function fixture() {
  const db = await openTestDb();
  const app = await buildServer({ db, logger: false });
  fixtures.push({ app, db });
  const created_at = '2026-10-21T00:00:00Z';
  const users = {};
  for (const role of ['owner', 'viewer', 'outsider']) {
    const user = await insertUser(db, { account: `document.quality.${role}`, display_name: role, status: 'active', created_at });
    const token = `document-quality-${role}-token`;
    await db.insert(schema.devices).values({ principal_id: user.id, device_name: role, credential_hash: hash(token), created_at });
    users[role] = { ...user, headers: { authorization: `Bearer ${token}` } };
  }
  const team = await insertTeam(db, { name: 'Document quality team', owner_principal_id: users.owner.id, created_at });
  const project = await insertProject(db, { team_id: team.id, owner_principal_id: users.owner.id, member_policy: 'private', name: 'Document quality', created_at });
  for (const role of ['owner', 'viewer']) await insertProjectMember(db, {
    project_id: project.id, principal_id: users[role].id, role, display_name: role, created_at,
  });
  const root = `/projects/${project.code}`;
  const inject = (method, url, actor = users.owner, payload) => app.inject({ method, url,
    ...(actor ? { headers: actor.headers } : {}), ...(payload === undefined ? {} : { payload }) });
  const request = async (...args) => {
    const response = await inject(...args);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().ok, true, response.body);
    return response.json().data;
  };
  const createDocument = payload => request('POST', `${root}/handoff/documents`, users.owner, {
    title: 'Private reference', content: '# Private reference\n\nConfidential original body.', ...payload,
  });
  return { db, app, project, team, root, users, inject, request, createDocument, created_at };
}

afterEach(async () => {
  for (const { app, db } of fixtures.splice(0)) { await app.close(); await closeTestDb(db); }
});

test('quality endpoint preserves authentication and document project boundaries for all sources', async () => {
  const c = await fixture();
  const ordinary = await c.createDocument();
  const requirement = await c.request('POST', `${c.root}/requirement-documents`, c.users.owner, {
    title: 'Private requirement', module_key: 'quality', content: 'Confidential requirement body.',
  });
  const architecture = await c.request('POST', `${c.root}/architecture-documents`, c.users.owner, {
    title: 'Private architecture', content_kind: 'mermaid', source_content: 'flowchart LR\n Browser --> API', notes_markdown: 'Confidential architecture body.',
  });
  const asset = await c.request('POST', `${c.root}/test-assets`, c.users.owner, {
    title: 'Private test guide', content: 'Confidential test body.',
  });
  for (const code of [ordinary.document_code, requirement.document_code, architecture.document_code, asset.code]) {
    const url = `/handoff-documents/${code}/quality?revision=1`;
    for (const [actor, status] of [[null, 401], [c.users.outsider, 403]]) {
      const response = await c.inject('GET', `${url}&principal_code=${c.users.owner.code}&projectCode=${c.project.code}`, actor);
      assert.equal(response.statusCode, status, response.body);
      assert.equal(response.json().ok, false);
      assert.doesNotMatch(response.body, /Confidential/);
    }
    const report = await c.request('GET', url, c.users.viewer);
    assert.equal(report.document_code, code);
    assert.equal(report.project_code, c.project.code);
    assert.equal(report.revision, 1);
  }
  const foreign = await insertProject(c.db, { team_id: c.team.id, owner_principal_id: c.users.outsider.id,
    member_policy: 'private', name: 'Other project', created_at: c.created_at });
  await insertProjectMember(c.db, { project_id: foreign.id, principal_id: c.users.outsider.id, role: 'owner', display_name: 'outsider', created_at: c.created_at });
  const foreignDoc = await c.request('POST', `/projects/${foreign.code}/handoff/documents`, c.users.outsider, { title: 'Foreign secret', content: 'Foreign confidential body.' });
  const denied = await c.inject('GET', `/handoff-documents/${foreignDoc.document_code}/quality?projectCode=${c.project.code}`);
  assert.equal(denied.statusCode, 403, denied.body);
  assert.doesNotMatch(denied.body, /confidential/);
});

test('invalid purpose and revision have stable errors and absent historical revisions never fall back', async () => {
  const c = await fixture(); const document = await c.createDocument();
  const url = `/handoff-documents/${document.document_code}/quality`;
  for (const revision of ['', '0', '-1', '1.5', 'abc', '1e2', '9007199254740992', '1&revision=2']) {
    const response = await c.inject('GET', `${url}?revision=${revision}`);
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().error.code, 'document_quality_revision_invalid');
  }
  for (const purpose of ['', 'invalid', 'requirements&purpose=api']) {
    const response = await c.inject('GET', `${url}?purpose=${purpose}`);
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().error.code, 'document_quality_purpose_invalid');
  }
  const missing = await c.inject('GET', `${url}?revision=999`);
  assert.equal(missing.statusCode, 404, missing.body);
  assert.equal(missing.json().error.code, 'document_quality_revision_not_found');
  const current = await c.request('GET', url);
  assert.equal(current.revision, 1);
});

test('manual content quality binds immutable current and historical text, profile and hash without changing documents', async () => {
  const c = await fixture();
  const first = '# 功能需求规格\n\n## 角色\n\nTODO\n\n## 验收标准\n';
  const document = await c.createDocument({ title: '功能需求规格', content: first });
  const detailUrl = `/handoff-documents/${document.document_code}`;
  const original = await c.request('GET', detailUrl);
  const originalText = original.revisions[0].content;
  const initial = await c.request('GET', `${detailUrl}/quality?revision=1&purpose=requirements`);
  assert.equal(initial.source_kind, 'project');
  assert.equal(initial.purpose_source, 'selected');
  assert.equal(initial.content_sha256, hash(originalText));
  assert.ok(initial.summary.failed > 0);
  assert.ok(initial.summary.needs_review > 0);
  assert.ok(initial.checks.some(item => item.status === 'failed'));
  assert.equal(initial.review.status, 'not_available');
  assert.equal(initial.adoption.status, 'not_evaluated');
  assert.match(initial.checked_at, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  const second = '# 运维手册\n\n该版本仅包含新的部署说明。';
  await c.request('PATCH', detailUrl, c.users.owner, { title: '运维手册', content: second, change_summary: 'Change purpose and body' });
  const currentDocument = await c.request('GET', detailUrl);
  const current = await c.request('GET', `${detailUrl}/quality`);
  assert.equal(current.revision, 2);
  assert.equal(current.purpose_source, 'inferred');
  assert.equal(current.content_sha256, hash(second));
  const historical = await c.request('GET', `${detailUrl}/quality?revision=1`);
  assert.equal(historical.revision, 1);
  assert.equal(historical.purpose, 'requirements');
  assert.equal(historical.content_sha256, hash(originalText));
  assert.notEqual(historical.content_sha256, current.content_sha256);
  const override = await c.request('GET', `${detailUrl}/quality?revision=1&purpose=reference`);
  assert.equal(override.purpose, 'reference');
  assert.equal(override.purpose_source, 'selected');
  assert.equal(override.content_sha256, historical.content_sha256);
  assert.deepEqual(await c.request('GET', detailUrl), currentDocument);
});

test('requirement quality keeps original source identity and reviews tied to the requested revision', async () => {
  const c = await fixture();
  const created = await c.request('POST', `${c.root}/requirement-documents`, c.users.owner, {
    title: 'Requirements r1', module_key: 'quality', content: '# Requirements\n\nThe user can save a draft.',
  });
  const source = `/requirement-documents/${created.document_code}`;
  const quality = `/handoff-documents/${created.document_code}/quality`;
  const before = await c.request('GET', `${quality}?revision=1`);
  assert.equal(before.source_kind, 'requirement');
  assert.equal(before.review.status, 'not_requested');
  const review = await c.request('POST', `${source}/reviews`);
  assert.deepEqual((await c.request('GET', `${quality}?revision=1`)).review, { status: 'open', revision: 1, review_code: review.review_code });
  await c.request('POST', `/requirement-document-reviews/${review.review_code}/close`, c.users.owner, { conclusion: 'passed' });
  await c.request('PATCH', source, c.users.owner, {
    title: 'Requirements r2', content: '# New requirements\n\nDifferent body.', summary: 'Second', change_summary: 'Revise',
  });
  const current = await c.request('GET', quality);
  assert.equal(current.revision, 2);
  assert.deepEqual(current.review, { status: 'not_requested', revision: 2 });
  const previous = await c.request('GET', `${quality}?revision=1`);
  assert.deepEqual(previous.review, { status: 'passed', revision: 1, review_code: review.review_code });
  assert.equal(previous.content_sha256, before.content_sha256);
  assert.match(previous.scope_note, /历史标题/);
  assert.equal(previous.adoption.status, 'not_evaluated');
});

test('architecture quality hashes the selected diagram and markdown separately and never uses the latest graph for history', async () => {
  const c = await fixture();
  const graph1 = 'flowchart LR\n Browser --> API'; const notes1 = '# Context\n\nBrowser calls the API.';
  const created = await c.request('POST', `${c.root}/architecture-documents`, c.users.owner, {
    title: 'Architecture first', content_kind: 'mermaid', source_content: graph1, notes_markdown: notes1,
  });
  const source = `/architecture-documents/${created.document_code}`;
  const graph2 = 'flowchart LR\n Browser --> Gateway --> API'; const notes2 = '# Context\n\nGateway forwards calls.';
  await c.request('PATCH', source, c.users.owner, { base_revision: 1, change_summary: 'Add gateway', source_content: graph2, notes_markdown: notes2 });
  const quality = `/handoff-documents/${created.document_code}/quality`;
  const old = await c.request('GET', `${quality}?revision=1`);
  const current = await c.request('GET', quality);
  assert.equal(old.source_kind, 'architecture'); assert.equal(old.purpose, 'architecture');
  assert.equal(old.content_sha256, hash(notes1)); assert.equal(old.diagram_source_sha256, hash(graph1));
  assert.equal(current.content_sha256, hash(notes2)); assert.equal(current.diagram_source_sha256, hash(graph2));
  assert.equal(old.review.status, 'not_available');
  assert.match(old.scope_note, /图形语义/);
});

test('testing quality checks stored revision markdown and declares unparsed external attachments', async () => {
  const c = await fixture();
  const created = await c.request('POST', `${c.root}/test-assets`, c.users.owner, {
    title: 'Test evidence', content: '# Test plan\n\nRun smoke tests.',
  });
  const source = `/test-assets/${created.code}`;
  await c.request('PATCH', source, c.users.owner, {
    base_revision: 1, change_summary: 'Link report', storage_kind: 'url', url: 'https://example.invalid/no-network', content: 'External report description.',
  });
  const quality = `/handoff-documents/${created.code}/quality`;
  const old = await c.request('GET', `${quality}?revision=1`);
  const current = await c.request('GET', quality);
  assert.equal(old.source_kind, 'testing'); assert.equal(old.purpose, 'testing');
  assert.equal(old.content_sha256, hash('# Test plan\n\nRun smoke tests.'));
  assert.equal(current.content_sha256, hash('External report description.'));
  assert.match(current.scope_note, /未解析、未访问/);
  assert.doesNotMatch(old.scope_note, /未解析、未访问/);
  assert.equal(current.review.status, 'not_available');
  const [saved] = await c.db.select().from(schema.testAssets).where(eq(schema.testAssets.code, created.code));
  assert.equal(saved.current_revision, 2);
});

test('quality GET never initializes library folders or renames ordinary folders when system folders are missing', async () => {
  const c = await fixture();
  const requirement = await c.request('POST', `${c.root}/requirement-documents`, c.users.owner, {
    title: 'Requirements', module_key: 'quality', content: '# Requirements\n\nSave a draft.',
  });
  const architecture = await c.request('POST', `${c.root}/architecture-documents`, c.users.owner, {
    title: 'Architecture', content_kind: 'mermaid', source_content: 'flowchart LR\n Browser --> API', notes_markdown: '# Context\n\nRequest flow.',
  });
  const asset = await c.request('POST', `${c.root}/test-assets`, c.users.owner, {
    title: 'Test plan', content: '# Tests\n\nCheck draft persistence.',
  });
  // Simulate an imported project before its first library visit, with colliding ordinary names.
  await c.db.delete(schema.projectDocumentFolders).where(eq(schema.projectDocumentFolders.project_id, c.project.id));
  await c.db.insert(schema.projectDocumentFolders).values(
    ['项目资料', '项目说明', '项目规范', '需求文档', '架构设计', '测试资料'].map(name => ({
      project_id: c.project.id, name, created_by: c.users.owner.id, created_at: c.created_at, updated_at: c.created_at,
    })),
  );
  const folders = () => c.db.select().from(schema.projectDocumentFolders)
    .where(eq(schema.projectDocumentFolders.project_id, c.project.id)).orderBy(schema.projectDocumentFolders.id);
  const before = await folders();
  for (const code of [requirement.document_code, architecture.document_code, asset.code]) {
    const quality = await c.request('GET', `/handoff-documents/${code}/quality?revision=1`, c.users.viewer);
    assert.equal(quality.document_code, code);
    assert.deepEqual(await folders(), before, 'Quality reads must not create system folders or rename existing folders');
  }
  const normal = await c.request('GET', `/handoff-documents/${requirement.document_code}`, c.users.viewer);
  assert.equal(normal.folder_name, '需求文档', 'Normal library reads retain existing initialization behavior');
  const afterNormalRead = await folders();
  assert.equal(afterNormalRead.filter(folder => folder.system_role !== null).length, 6);
  assert.equal(afterNormalRead.filter(folder => folder.system_role === null && folder.name.includes('（原目录 ')).length, 6);
});
