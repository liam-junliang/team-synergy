import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@team-synergy/persistence';
import { buildServer } from '../dist/server.js';
import { closeTestDb, insertProject, insertProjectMember, insertTeam, insertUser, openTestDb, publicCode } from './test-db.mjs';

const fixtures = [];
async function fixture() {
  const db = await openTestDb();
  const app = await buildServer({ db, logger: false });
  fixtures.push({ db, app });
  const created_at = '2026-10-15T00:00:00Z';
  const team = await insertTeam(db, { name: 'Home team', created_at });
  const project = await insertProject(db, { team_id: team.id, name: 'Home project', current_snapshot: 1, created_at });
  const users = [];
  for (const [index, role] of ['owner', 'member', 'outsider'].entries()) {
    const user = await insertUser(db, { code: publicCode(index + 1), account: `home.${role}`, display_name: role, status: 'active', created_at });
    const token = `home-${role}-token`;
    await db.insert(schema.devices).values({ principal_id: user.id, device_name: role, credential_hash: createHash('sha256').update(token).digest('hex'), created_at });
    if (role !== 'outsider') await insertProjectMember(db, { project_id: project.id, principal_id: user.id, role, display_name: role, created_at });
    users.push({ ...user, headers: { authorization: `Bearer ${token}` } });
  }
  const [owner, member, outsider] = users;
  const root = `/projects/${project.code}`;
  const createDocument = async (title, folder_code) => {
    const response = await app.inject({ method: 'POST', url: `${root}/handoff/documents`, headers: owner.headers, payload: { title, content: `${title} body`, kind: 'general', folder_code } });
    assert.equal(response.statusCode, 200, response.body);
    return response.json().data;
  };
  return { db, app, owner, member, outsider, project, team, root, createDocument };
}
afterEach(async () => { for (const { db, app } of fixtures.splice(0)) { await app.close(); await closeTestDb(db); } });

test('project home member roster includes real accounts for project members only', async () => {
  const { app, owner, member, outsider, root } = await fixture();
  const response = await app.inject({ method: 'GET', url: `${root}/members`, headers: member.headers });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json().data.map(item => ({ code: item.user_code, account: item.account })).sort((a, b) => a.account.localeCompare(b.account)),
    [owner, member].map(user => ({ code: user.code, account: user.account })).sort((a, b) => a.account.localeCompare(b.account)));
  const forbidden = await app.inject({ method: 'GET', url: `${root}/members`, headers: outsider.headers });
  assert.equal(forbidden.statusCode, 403, forbidden.body);
});

test('project home HTTP enforces identity, membership and Owner binding with safe empty state', async () => {
  const { app, owner, member, outsider, root, project, createDocument } = await fixture();
  const anonymous = await app.inject({ method: 'GET', url: `${root}/home` });
  assert.equal(anonymous.statusCode, 401, anonymous.body);
  const forged = await app.inject({ method: 'PUT', url: `${root}/home`, payload: { principal_code: owner.code, overview_document_code: null } });
  assert.equal(forged.statusCode, 401, forged.body);
  const empty = await app.inject({ method: 'GET', url: `${root}/home`, headers: member.headers });
  assert.equal(empty.statusCode, 200, empty.body);
  const standardsFolderCode = empty.json().data.standards_folder_code;
  assert.match(standardsFolderCode, /^[0-9A-HJKMNP-TV-Z]{20}$/);
  assert.deepEqual(empty.json().data, { project_code: project.code, can_edit: false, overview: null, guide: null, standards: [], standards_folder_code: standardsFolderCode });
  const unrelated = await createDocument('Regular handoff');
  const overview = await createDocument('Overview');
  const forbidden = await app.inject({ method: 'PUT', url: `${root}/home`, headers: member.headers, payload: { overview_document_code: unrelated.document_code } });
  assert.equal(forbidden.statusCode, 403, forbidden.body);
  const outside = await app.inject({ method: 'GET', url: `${root}/home`, headers: outsider.headers });
  assert.equal(outside.statusCode, 403, outside.body);
  const bound = await app.inject({ method: 'PUT', url: `${root}/home`, headers: owner.headers, payload: { overview_document_code: overview.document_code } });
  assert.equal(bound.statusCode, 200, bound.body);
  assert.equal(bound.json().data.overview.content, 'Overview body');
  const read = await app.inject({ method: 'GET', url: `${root}/home`, headers: member.headers });
  assert.equal(read.json().data.overview.document_code, overview.document_code);
  assert.equal(read.json().data.overview.can_edit, false);
  const legacy = await app.inject({ method: 'GET', url: `${root}/document`, headers: member.headers });
  assert.equal(legacy.json().data.document_code, overview.document_code);
});

test('project home HTTP supports independent updates and rejects bad or cross-project references atomically', async () => {
  const { db, app, owner, team, root, createDocument } = await fixture();
  const guide = await createDocument('Guide');
  const overview = await createDocument('Overview');
  const empty = await app.inject({ method: 'GET', url: `${root}/home`, headers: owner.headers });
  const standards = await createDocument('Standards', empty.json().data.standards_folder_code);
  const results = await Promise.all([
    app.inject({ method: 'PUT', url: `${root}/home`, headers: owner.headers, payload: { guide_document_code: guide.document_code } }),
    app.inject({ method: 'PUT', url: `${root}/home`, headers: owner.headers, payload: { overview_document_code: overview.document_code } }),
  ]);
  results.forEach(result => assert.equal(result.statusCode, 200, result.body));
  const read = await app.inject({ method: 'GET', url: `${root}/home`, headers: owner.headers });
  assert.equal(read.json().data.guide.document_code, guide.document_code);
  assert.equal(read.json().data.overview.document_code, overview.document_code);
  assert.equal(read.json().data.standards[0].document_code, standards.document_code);
  for (const payload of [{}, { guide_document_code: '' }, { standards_document_code: 1 }, { overview_document_code: [] }, { overview_document_code: 'bad' }, { unknown_document_code: null }]) {
    const response = await app.inject({ method: 'PUT', url: `${root}/home`, headers: owner.headers, payload });
    assert.equal(response.statusCode, 422, response.body);
  }
  const retired = await app.inject({ method: 'PUT', url: `${root}/home`, headers: owner.headers,
    payload: { overview_document_code: null, standards_document_code: standards.document_code } });
  assert.equal(retired.statusCode, 422, retired.body);
  assert.equal(retired.json().error.code, 'project_home_standards_managed');
  assert.match(retired.json().error.message, /固定.*项目规范.*目录/);
  const preserved = await app.inject({ method: 'GET', url: `${root}/home`, headers: owner.headers });
  assert.equal(preserved.json().data.overview.document_code, overview.document_code);
  const other = await insertProject(db, { team_id: team.id, name: 'Other project', current_snapshot: 0, created_at: 't0' });
  const [foreign] = await db.insert(schema.projectDocuments).values({ project_id: other.id, title: 'Other project secret', content: 'private', created_by: owner.id,
    updated_by: owner.id, created_at: 't0', updated_at: 't0' }).returning();
  const invalid = await app.inject({ method: 'PUT', url: `${root}/home`, headers: owner.headers, payload: { guide_document_code: null, overview_document_code: foreign.code } });
  assert.equal(invalid.statusCode, 422, invalid.body);
  const unchanged = await app.inject({ method: 'GET', url: `${root}/home`, headers: owner.headers });
  assert.equal(unchanged.json().data.guide.document_code, guide.document_code);
  const cleared = await app.inject({ method: 'PUT', url: `${root}/home`, headers: owner.headers, payload: { guide_document_code: null } });
  assert.equal(cleared.statusCode, 200, cleared.body);
  assert.equal(cleared.json().data.guide, null);
  assert.equal(cleared.json().data.standards[0].document_code, standards.document_code);
});

test('project standards HTTP preserves old nested documents while rejecting new subfolders and system directory mutation', async () => {
  const { db, project, app, owner, member, outsider, root, createDocument } = await fixture();
  const library = await app.inject({ method: 'GET', url: `${root}/handoff`, headers: member.headers });
  assert.equal(library.statusCode, 200, library.body);
  const standardsFolder = library.json().data.folders.find(folder => folder.system_role === 'standards');
  assert.equal(standardsFolder.name, '项目规范');
  assert.equal(standardsFolder.can_edit, false);
  assert.equal(standardsFolder.parent_folder_code, null);
  const childResponse = await app.inject({ method: 'POST', url: `${root}/handoff/folders`, headers: member.headers,
    payload: { name: 'Web', parent_folder_code: standardsFolder.folder_code } });
  assert.equal(childResponse.statusCode, 403, childResponse.body);
  assert.equal(childResponse.json().error.code, 'project_document_folder_read_only');
  const [storedRoot] = await db.select().from(schema.projectDocumentFolders).where(eq(schema.projectDocumentFolders.code, standardsFolder.folder_code));
  const [storedChild] = await db.insert(schema.projectDocumentFolders).values({ project_id: project.id, parent_id: storedRoot.id,
    name: 'Web', created_by: member.id, created_at: 'old', updated_at: 'old' }).returning();
  const child = { ...storedChild, folder_code: storedChild.code };
  const direct = await createDocument('A core', standardsFolder.folder_code);
  const nested = await createDocument('B Web', child.folder_code);
  await createDocument('Ordinary unrelated document');
  for (const payload of [{ name: 'Renamed' }, { parent_folder_code: child.folder_code }, { status: 'archived' }]) {
    const response = await app.inject({ method: 'PATCH', url: `/handoff-folders/${standardsFolder.folder_code}`, headers: owner.headers, payload });
    assert.equal(response.statusCode, 422, response.body);
    assert.equal(response.json().error.code, 'project_document_folder_system');
  }
  const forbidden = await app.inject({ method: 'GET', url: `${root}/home`, headers: outsider.headers });
  assert.equal(forbidden.statusCode, 403, forbidden.body);
  const home = await app.inject({ method: 'GET', url: `${root}/home`, headers: member.headers });
  assert.equal(home.statusCode, 200, home.body);
  assert.equal(home.json().data.standards_folder_code, standardsFolder.folder_code);
  assert.deepEqual(home.json().data.standards.map(document => [document.document_code, document.content, document.revision]),
    [[direct.document_code, 'A core body', 1], [nested.document_code, 'B Web body', 1]]);
  const archived = await app.inject({ method: 'PATCH', url: `/handoff-folders/${child.folder_code}`, headers: member.headers, payload: { status: 'archived' } });
  assert.equal(archived.statusCode, 200, archived.body);
  const afterArchive = await app.inject({ method: 'GET', url: `${root}/home`, headers: member.headers });
  assert.deepEqual(afterArchive.json().data.standards.map(document => document.document_code), [direct.document_code]);
  const ordinary = await app.inject({ method: 'GET', url: `/handoff-documents/${nested.document_code}`, headers: member.headers });
  assert.equal(ordinary.json().data.current_revision, 1);
});

test('project home HTTP legacy writes never overwrite an arbitrary library document and archive links become empty', async () => {
  const { app, owner, db, root, createDocument } = await fixture();
  const unrelated = await createDocument('Unrelated');
  const empty = await app.inject({ method: 'GET', url: `${root}/document`, headers: owner.headers });
  assert.equal(empty.json().data.document_code, null);
  const saved = await app.inject({ method: 'PUT', url: `${root}/document`, headers: owner.headers, payload: { title: 'Dedicated overview', content: 'Overview body' } });
  assert.equal(saved.statusCode, 200, saved.body);
  const overview = saved.json().data;
  assert.notEqual(overview.document_code, unrelated.document_code);
  const [original] = await db.select().from(schema.projectDocuments).where(eq(schema.projectDocuments.code, unrelated.document_code));
  assert.equal(original.content, 'Unrelated body');
  const archived = await app.inject({ method: 'PATCH', url: `/handoff-documents/${overview.document_code}`, headers: owner.headers,
    payload: { title: overview.title, content: overview.content, status: 'archived', change_summary: 'Archive' } });
  assert.equal(archived.statusCode, 200, archived.body);
  const home = await app.inject({ method: 'GET', url: `${root}/home`, headers: owner.headers });
  assert.equal(home.json().data.overview, null);
  const invalid = await app.inject({ method: 'PUT', url: `${root}/home`, headers: owner.headers, payload: { overview_document_code: overview.document_code } });
  assert.equal(invalid.statusCode, 422, invalid.body);
  const rejectRevive = await app.inject({ method: 'PUT', url: `${root}/document`, headers: owner.headers, payload: { title: overview.title, content: 'Replacement' } });
  assert.equal(rejectRevive.statusCode, 422, rejectRevive.body);
});
