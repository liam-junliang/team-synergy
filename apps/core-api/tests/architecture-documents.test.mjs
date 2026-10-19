import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { schema } from '@team-synergy/persistence';
import { buildServer } from '../dist/server.js';
import { closeTestDb, insertProject, insertProjectMember, insertTeam, insertUser, openTestDb } from './test-db.mjs';

const fixtures = [];
async function fixture() {
  const db = await openTestDb();
  const app = await buildServer({ db, logger: false });
  fixtures.push({ db, app });
  const created_at = '2026-10-16T00:00:00Z';
  const team = await insertTeam(db, { name: 'Architecture team', created_at });
  const project = await insertProject(db, { team_id: team.id, name: 'Architecture project', created_at });
  const users = [];
  for (const role of ['owner', 'author', 'reader', 'outsider']) {
    const user = await insertUser(db, { account: `architecture.${role}`, display_name: role, status: 'active', created_at });
    const token = `architecture-${role}-token`;
    await db.insert(schema.devices).values({ principal_id: user.id, device_name: role, credential_hash: createHash('sha256').update(token).digest('hex'), created_at });
    if (role !== 'outsider') await insertProjectMember(db, { project_id: project.id, principal_id: user.id, role: role === 'owner' ? 'owner' : 'member', display_name: role, created_at });
    users.push({ ...user, headers: { authorization: `Bearer ${token}` } });
  }
  return { app, db, owner: users[0], author: users[1], reader: users[2], outsider: users[3], root: `/projects/${project.code}/architecture-documents` };
}
afterEach(async () => { for (const { db, app } of fixtures.splice(0)) { await app.close(); await closeTestDb(db); } });
const payload = { title: '总体架构', content_kind: 'mermaid', source_content: 'flowchart LR\n Client --> API', preview_svg: '<svg xmlns="http://www.w3.org/2000/svg"/>' };

test('architecture HTTP uses authenticated identity, preserves versions and returns 409 on stale edits', async () => {
  const { app, owner, author, reader, outsider, root } = await fixture();
  const created = await app.inject({ method: 'POST', url: root, headers: author.headers, payload: { ...payload, principal_code: owner.code } });
  assert.equal(created.statusCode, 200, created.body);
  const original = created.json().data;
  assert.equal(original.owner_principal_code, author.code, 'body principal cannot impersonate the Owner');
  const url = `/architecture-documents/${original.document_code}`;
  const list = await app.inject({ method: 'GET', url: root, headers: reader.headers });
  assert.equal(list.statusCode, 200, list.body);
  assert.equal(list.json().data[0].can_edit, false);
  assert.equal('source_content' in list.json().data[0], false);
  const revised = await app.inject({ method: 'PATCH', url, headers: owner.headers,
    payload: { title: '部署架构', source_content: 'flowchart LR\n Client --> Gateway', base_revision: 1, change_summary: '加入网关' } });
  assert.equal(revised.statusCode, 200, revised.body);
  assert.equal(revised.json().data.preview_svg, null);
  assert.deepEqual(revised.json().data.revisions[1], original.revisions[0]);
  const stale = await app.inject({ method: 'PATCH', url, headers: author.headers, payload: { base_revision: 1, change_summary: 'stale' } });
  assert.equal(stale.statusCode, 409, stale.body);
  assert.equal(stale.json().error.code, 'architecture_document_revision_conflict');
  const spoof = await app.inject({ method: 'PATCH', url, headers: reader.headers, payload: { base_revision: 2, change_summary: 'spoof', principal_code: owner.code } });
  assert.equal(spoof.statusCode, 403, spoof.body);
  for (const request of [
    { method: 'GET', url }, { method: 'GET', url: root }, { method: 'POST', url: root, payload },
    { method: 'PATCH', url, payload: { base_revision: 2, change_summary: 'denied' } },
  ]) {
    const denied = await app.inject({ ...request, headers: outsider.headers });
    assert.equal(denied.statusCode, 403, denied.body);
    const anonymous = await app.inject({ ...request, ...(request.payload ? { payload: { ...request.payload, principal_code: owner.code } } : {}) });
    assert.equal(anonymous.statusCode, 401, anonymous.body);
  }
});

test('architecture HTTP validates formats and requires an explicit base revision', async () => {
  const { app, owner, root } = await fixture();
  for (const extra of [
    { content_kind: 'drawio', source_content: '<!DOCTYPE mxfile><mxfile/>' },
    { content_kind: 'image', source_content: 'data:image/png;base64,PHN2Zy8+' },
    { preview_svg: '<html/>' },
  ]) {
    const invalid = await app.inject({ method: 'POST', url: root, headers: owner.headers, payload: { ...payload, ...extra } });
    assert.equal(invalid.statusCode, 422, invalid.body);
  }
  const created = await app.inject({ method: 'POST', url: root, headers: owner.headers, payload: { ...payload, content_kind: 'drawio', source_content: '<mxfile><diagram>compressed source</diagram></mxfile>' } });
  assert.equal(created.statusCode, 200, created.body);
  const missingBase = await app.inject({ method: 'PATCH', url: `/architecture-documents/${created.json().data.document_code}`, headers: owner.headers, payload: { change_summary: 'missing base' } });
  assert.equal(missingBase.statusCode, 400, missingBase.body);
});

test('architecture library HTTP shares source versions and rejects generic writes and system-folder pollution', async () => {
  const { app, owner, author, reader, outsider, root } = await fixture();
  const createdResponse = await app.inject({ method: 'POST', url: root, headers: author.headers, payload: { ...payload, notes_markdown: '# Original notes' } });
  assert.equal(createdResponse.statusCode, 200, createdResponse.body);
  const original = createdResponse.json().data;
  const projectRoot = root.replace(/\/architecture-documents$/, '');
  const list = await app.inject({ method: 'GET', url: `${projectRoot}/handoff`, headers: reader.headers });
  assert.equal(list.statusCode, 200, list.body);
  const library = list.json().data;
  assert.deepEqual(library.folders.map(folder => folder.system_role).sort(), ['architecture', 'requirements', 'standards', 'testing']);
  const folder = library.folders.find(item => item.system_role === 'architecture');
  const item = library.documents[0];
  assert.equal(item.kind, 'diagram');
  assert.equal(item.folder_code, folder.folder_code);
  assert.equal(item.source_kind, 'architecture');
  assert.equal(item.source_can_edit, false);
  const revised = await app.inject({ method: 'PATCH', url: `/architecture-documents/${original.document_code}`, headers: author.headers,
    payload: { title: 'Updated architecture', notes_markdown: '# Current notes', base_revision: 1, change_summary: 'Revise notes' } });
  assert.equal(revised.statusCode, 200, revised.body);
  const libraryUrl = `/handoff-documents/${original.document_code}`;
  const detail = await app.inject({ method: 'GET', url: libraryUrl, headers: author.headers });
  assert.equal(detail.statusCode, 200, detail.body);
  assert.equal(detail.json().data.source_can_edit, true);
  assert.deepEqual(detail.json().data.architecture_document, revised.json().data);
  assert.equal(detail.json().data.content, '# Current notes');
  assert.equal(detail.json().data.revisions[1].content, '# Original notes');
  assert.equal(detail.json().data.revisions[1].revision_code, original.revisions[0].revision_code);
  for (const [method, url, body] of [
    ['PATCH', libraryUrl, { title: 'No', content: 'No', change_summary: 'No' }],
    ['POST', `${projectRoot}/handoff/folders`, { name: 'No child', parent_folder_code: folder.folder_code }],
    ['POST', `${projectRoot}/handoff/documents`, { title: 'No generic document', content: 'No', folder_code: folder.folder_code }],
  ]) {
    const denied = await app.inject({ method, url, headers: owner.headers, payload: body });
    assert.equal(denied.statusCode, 403, denied.body);
  }
  const denied = await app.inject({ method: 'GET', url: libraryUrl, headers: outsider.headers });
  assert.equal(denied.statusCode, 403, denied.body);
  assert.doesNotMatch(denied.body, /Original notes|Current notes/);
  const finalSource = await app.inject({ method: 'GET', url: `/architecture-documents/${original.document_code}`, headers: author.headers });
  assert.deepEqual(finalSource.json().data, revised.json().data);
});

test('architecture HTTP accepts source and preview together above the global 8 MiB JSON limit', async () => {
  const { app, owner, root } = await fixture();
  // Escaped quotes increase JSON size while each decoded field remains within its byte limit.
  const large = { ...payload, source_content: '"'.repeat(5 * 1024 * 1024), preview_svg: '<svg>' + 'a'.repeat(1024 * 1024) + '</svg>' };
  const created = await app.inject({ method: 'POST', url: root, headers: owner.headers, payload: large });
  assert.equal(created.statusCode, 200, created.body.slice(0, 200));
  assert.equal(created.json().data.source_content, large.source_content);
  const revised = await app.inject({ method: 'PATCH', url: `/architecture-documents/${created.json().data.document_code}`, headers: owner.headers,
    payload: { ...large, base_revision: 1, change_summary: 'same source' } });
  assert.equal(revised.statusCode, 200, revised.body.slice(0, 200));
});
