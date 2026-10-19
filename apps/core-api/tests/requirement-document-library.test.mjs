import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@team-synergy/persistence';
import { buildServer } from '../dist/server.js';
import { closeTestDb, insertProject, insertProjectMember, insertProjectModule, insertTeam, insertUser, openTestDb, publicCode } from './test-db.mjs';

const fixtures = [];
async function fixture() {
  const db = await openTestDb();
  const app = await buildServer({ db, logger: false });
  fixtures.push({ db, app });
  const created_at = '2026-10-16T00:00:00Z';
  const team = await insertTeam(db, { name: 'Document library team', created_at });
  const project = await insertProject(db, { team_id: team.id, name: 'Document library project', current_snapshot: 1, created_at });
  const module = await insertProjectModule(db, { project_id: project.id, name: 'AUTH', created_at, updated_at: created_at });
  const users = [];
  for (const [index, role] of ['owner', 'member', 'outsider'].entries()) {
    const user = await insertUser(db, { code: publicCode(index + 1), account: `library.${role}`, display_name: role, status: 'active', created_at });
    const token = `library-${role}-token`;
    await db.insert(schema.devices).values({ principal_id: user.id, device_name: role, credential_hash: createHash('sha256').update(token).digest('hex'), created_at });
    if (role !== 'outsider') await insertProjectMember(db, { project_id: project.id, principal_id: user.id, role, display_name: role, created_at });
    users.push({ ...user, headers: { authorization: `Bearer ${token}` } });
  }
  const [owner, member, outsider] = users;
  const root = `/projects/${project.code}`;
  const request = async (method, url, user = owner, payload) => {
    const response = await app.inject({ method, url, headers: user.headers, ...(payload ? { payload } : {}) });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().ok, true, response.body);
    return response.json().data;
  };
  const createRequirement = (user = owner, title = 'Sign-in requirements') => request('POST', `${root}/requirement-documents`, user,
    { module_code: module.code, title, summary: 'Initial summary', content: '# Sign-in\n\nFirst body', keywords: ['authentication'] });
  return { db, app, team, project, module, owner, member, outsider, root, request, createRequirement, created_at };
}

afterEach(async () => { for (const { db, app } of fixtures.splice(0)) { await app.close(); await closeTestDb(db); } });

test('requirement library projections share source identity, current content and immutable revisions after original API edits', async () => {
  const { db, root, project, owner, member, request, createRequirement } = await fixture();
  const created = await createRequirement();
  const sourceUrl = `/requirement-documents/${created.document_code}`;
  const libraryUrl = `/handoff-documents/${created.document_code}`;
  const before = await request('GET', sourceUrl);
  const library = await request('GET', `${root}/handoff`, member);
  const folder = library.folders.find(item => item.system_role === 'requirements');
  assert.equal(folder.name, '需求文档');
  assert.equal(folder.parent_folder_code, null);
  assert.equal(folder.can_edit, false);
  assert.equal(folder.status, 'active');
  assert.equal(library.folders.filter(item => item.system_role === 'requirements').length, 1);
  assert.equal(library.folders.filter(item => item.system_role === 'standards').length, 1);
  assert.equal(library.documents.length, 1);
  const summary = library.documents[0];
  assert.equal(summary.document_code, created.document_code);
  assert.equal(summary.source_kind, 'requirement');
  assert.equal(summary.folder_code, folder.folder_code);
  assert.equal(summary.kind, 'doc');
  assert.equal(summary.current_revision, 1);
  assert.equal(summary.can_edit, false);
  assert.equal(summary.source_can_edit, false);
  assert.equal('content' in summary, false, 'Library listings must not expose full document bodies');

  const revised = await request('PATCH', sourceUrl, owner, { title: 'Revised sign-in', summary: 'Second summary',
    content: '# Revised heading\n\nSearchable-Body-Token', keywords: ['revision-keyword'], change_summary: 'Clarify acceptance' });
  assert.equal(revised.document_code, created.document_code);
  assert.equal(revised.current_revision, 2);
  const source = await request('GET', sourceUrl);
  const projection = await request('GET', libraryUrl);
  assert.equal(projection.document_code, source.document_code);
  assert.equal(projection.project_code, project.code);
  assert.equal(projection.folder_code, folder.folder_code);
  assert.equal(projection.current_revision, source.current_revision);
  assert.equal(projection.content, source.content);
  assert.equal(projection.summary, source.summary);
  assert.equal(projection.title, source.title);
  assert.equal(projection.can_edit, false);
  assert.equal(projection.source_can_edit, true);
  assert.deepEqual(projection.outline, source.outline);
  assert.deepEqual(projection.linked_requirements, source.linked_requirements);
  assert.deepEqual(projection.revisions.map(({ title, ...revision }) => revision), source.revisions);
  assert.deepEqual(source.revisions.map(item => item.revision), [2, 1]);
  assert.deepEqual(source.revisions[1], before.revisions[0], 'The original revision must retain its code and full content');
  assert.notEqual(source.revisions[0].revision_code, source.revisions[1].revision_code);
  for (const query of ['Revised sign-in', 'Second summary', 'Searchable-Body-Token', 'revision-keyword']) {
    const found = await request('GET', `${root}/handoff?q=${encodeURIComponent(query)}`);
    assert.deepEqual(found.documents.map(item => [item.document_code, item.current_revision, item.source_kind]), [[created.document_code, 2, 'requirement']]);
  }
  const obsolete = await request('GET', `${root}/handoff?q=${encodeURIComponent('First body')}`);
  assert.equal(obsolete.documents.length, 0, 'Search uses current requirement content, not superseded revisions');
  const ordinaryCopies = await db.select().from(schema.projectDocuments).where(eq(schema.projectDocuments.project_id, project.id));
  assert.equal(ordinaryCopies.length, 0, 'A library projection must not create a second project-document body');
  const repeated = await request('GET', `${root}/handoff`);
  assert.equal(repeated.folders.find(item => item.system_role === 'requirements').folder_code, folder.folder_code);
});

test('requirement projections preserve original edit permissions and never cross project membership boundaries', async () => {
  const { db, app, root, owner, member, outsider, team, request, createRequirement, created_at } = await fixture();
  const created = await createRequirement(member);
  const detailUrl = `/handoff-documents/${created.document_code}`;
  for (const user of [owner, member]) {
    const library = await request('GET', `${root}/handoff`, user);
    assert.equal(library.documents[0].can_edit, false);
    assert.equal(library.documents[0].source_can_edit, true);
    const detail = await request('GET', detailUrl, user);
    assert.equal(detail.can_edit, false);
    assert.equal(detail.source_can_edit, true);
  }
  for (const url of [`${root}/handoff`, detailUrl]) {
    const anonymous = await app.inject({ method: 'GET', url });
    assert.equal(anonymous.statusCode, 401, anonymous.body);
    assert.equal(anonymous.json().error.code, 'unauthorized');
    assert.doesNotMatch(anonymous.body, /First body|Initial summary/);
    const invalidCredential = await app.inject({ method: 'GET', url, headers: { authorization: 'Bearer invalid-library-token' } });
    assert.equal(invalidCredential.statusCode, 401, invalidCredential.body);
    assert.equal(invalidCredential.json().error.code, 'unauthorized');
    const forbidden = await app.inject({ method: 'GET', url, headers: outsider.headers });
    assert.equal(forbidden.statusCode, 403, forbidden.body);
    assert.equal(forbidden.json().ok, false);
    assert.doesNotMatch(forbidden.body, /First body|Initial summary/);
  }
  const foreignProject = await insertProject(db, { team_id: team.id, name: 'Foreign project', current_snapshot: 0, created_at });
  await insertProjectMember(db, { project_id: foreignProject.id, principal_id: outsider.id, role: 'owner', display_name: 'outsider', created_at });
  const foreignModule = await insertProjectModule(db, { project_id: foreignProject.id, name: 'PRIVATE', created_at, updated_at: created_at });
  const foreign = await request('POST', `/projects/${foreignProject.code}/requirement-documents`, outsider,
    { module_code: foreignModule.code, title: 'Foreign secret', content: 'Foreign body secret' });
  const local = await request('GET', `${root}/handoff`);
  assert.deepEqual(local.documents.map(item => item.document_code), [created.document_code]);
  const foreignDenied = await app.inject({ method: 'GET', url: `/handoff-documents/${foreign.document_code}`, headers: owner.headers });
  assert.equal(foreignDenied.statusCode, 403, foreignDenied.body);
  assert.doesNotMatch(foreignDenied.body, /Foreign body secret/);

  await db.update(schema.requirementDocuments).set({ state: 'archived' }).where(eq(schema.requirementDocuments.code, created.document_code));
  const archived = await request('GET', detailUrl, member);
  assert.equal(archived.status, 'archived');
  assert.equal(archived.source_can_edit, false);
  assert.equal(archived.current_revision, 1);
  assert.equal(archived.content, '# Sign-in\n\nFirst body');
  const archivedList = await request('GET', `${root}/handoff`, member);
  assert.equal(archivedList.documents[0].status, 'archived');
  assert.equal(archivedList.documents[0].source_can_edit, false);
});

test('fixed requirement directory and projected sources reject generic writes without changing source content or homepage bindings', async () => {
  const { app, root, owner, outsider, request, createRequirement } = await fixture();
  const requirement = await createRequirement();
  const sourceUrl = `/requirement-documents/${requirement.document_code}`;
  const original = await request('GET', sourceUrl);
  const library = await request('GET', `${root}/handoff`);
  const folder = library.folders.find(item => item.system_role === 'requirements');
  const ordinaryFolder = await request('POST', `${root}/handoff/folders`, owner, { name: 'Ordinary folder' });
  const ordinary = await request('POST', `${root}/handoff/documents`, owner, { title: 'Ordinary document', content: 'Ordinary body', kind: 'general' });
  await request('PUT', `${root}/home`, owner, { overview_document_code: ordinary.document_code });
  for (const payload of [{ name: 'Renamed' }, { parent_folder_code: ordinaryFolder.folder_code }, { status: 'archived' }]) {
    const rejected = await app.inject({ method: 'PATCH', url: `/handoff-folders/${folder.folder_code}`, headers: owner.headers, payload });
    assert.equal(rejected.statusCode, 422, rejected.body);
    assert.equal(rejected.json().error.code, 'project_document_folder_system');
  }
  for (const [method, url, payload] of [
    ['POST', `${root}/handoff/folders`, { name: 'Polluting child', parent_folder_code: folder.folder_code }],
    ['PATCH', `/handoff-folders/${ordinaryFolder.folder_code}`, { parent_folder_code: folder.folder_code }],
    ['POST', `${root}/handoff/documents`, { folder_code: folder.folder_code, title: 'Polluting document', content: 'Wrong source' }],
    ['PATCH', `/handoff-documents/${ordinary.document_code}`, { folder_code: folder.folder_code, title: 'Ordinary document', content: 'Changed body', change_summary: 'Move' }],
  ]) {
    const rejected = await app.inject({ method, url, headers: owner.headers, payload });
    assert.equal(rejected.statusCode, 403, rejected.body);
    assert.equal(rejected.json().error.code, 'project_document_folder_read_only');
  }
  for (const user of [owner, outsider]) {
    const rejected = await app.inject({ method: 'PATCH', url: `/handoff-documents/${requirement.document_code}`, headers: user.headers,
      payload: { title: 'Overwritten', content: 'Wrong source', change_summary: 'Overwrite' } });
    assert.equal(rejected.statusCode, 403, rejected.body);
    assert.equal(rejected.json().error.code, user === owner ? 'project_document_source_read_only' : 'requirement_document_forbidden');
  }
  const invalidHome = await app.inject({ method: 'PUT', url: `${root}/home`, headers: owner.headers,
    payload: { overview_document_code: requirement.document_code } });
  assert.equal(invalidHome.statusCode, 422, invalidHome.body);
  assert.equal((await request('GET', `${root}/home`)).overview.document_code, ordinary.document_code);
  assert.deepEqual(await request('GET', sourceUrl), original);
  const preservedOrdinary = await request('GET', `/handoff-documents/${ordinary.document_code}`);
  assert.equal(preservedOrdinary.content, 'Ordinary body');
  assert.equal(preservedOrdinary.current_revision, 1);
  assert.equal(preservedOrdinary.folder_code, null);
  const finalLibrary = await request('GET', `${root}/handoff`);
  assert.equal(finalLibrary.folders.length, 5);
  assert.equal(finalLibrary.documents.length, 2);
  assert.equal(finalLibrary.folders.find(item => item.folder_code === folder.folder_code).name, '需求文档');
  assert.equal(finalLibrary.folders.find(item => item.folder_code === ordinaryFolder.folder_code).parent_folder_code, null);
});
